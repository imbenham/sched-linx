// Server actions for the visualizer + future UI surfaces. The underscore
// in `_actions/` is a Next.js convention for private folders — excluded
// from routing. The 'use server' directive at the top of this file makes
// every export a server action with auto-generated client stubs.

'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { getDatabase } from '@/src/db/client';
import { applyReshuffle, cancelBooking, loadSchedulingContext, SchedulingContext } from '@/src/db/repository';
import { seedScenario } from '@/src/db/seed';
import { providers } from '@/src/db/schema';
import {
  scheduleAppointment,
  type ScheduleResult,
} from '@/src/scheduling/scheduleAppointment';
import type {
  BookingRequest,
  Instant,
  Location,
  LocationSchedule,
  Provider,
  ProviderId,
  ProviderSchedule,
  Room,
  Service,
  ServiceId,
  ServiceRoomRequirement,
  Slot,
  SlotId,
} from '@/src/model';
import {
  proposeReshuffle,
  type ProposeReshuffleContext,
  type ReshuffleProposal,
} from '@/src/scheduling/proposeReshuffle';
import type {
  AnonymousCalendarCellState,
  CalendarCellState,
  TimeSlot,
} from '@/app/_types';

const SCENARIOS_PATH = '/scenarios';
const HOME_PATH = '/';

// Revalidate everything that might surface this scenario's data. The path
// for a specific scenario lives under /scenarios/<scenarioN>, but we don't
// thread the route through actions — revalidating the parent /scenarios
// segment busts caches for all child segments under it.
const revalidateAll = () => {
  revalidatePath(SCENARIOS_PATH);
  revalidatePath(HOME_PATH);
};

export async function scheduleAppointmentAction(
  request: BookingRequest,
  scenarioTag?: string,
): Promise<ScheduleResult> {
  const db = await getDatabase();
  const result = await scheduleAppointment(db, request, scenarioTag);
  if (result.kind === 'direct') revalidateAll();
  return result;
}

export async function applyReshuffleAction(
  proposal: ReshuffleProposal,
  scenarioTag?: string,
): Promise<{ slotId: string }> {
  const db = await getDatabase();
  const { newSlot } = await applyReshuffle(db, proposal, scenarioTag);
  revalidateAll();
  return { slotId: newSlot.id };
}

export async function resetScenarioAction(scenarioTag?: string): Promise<void> {
  const db = await getDatabase();
  await seedScenario(db, scenarioTag ? { tag: scenarioTag } : {});
  revalidateAll();
}

export async function cancelBookingAction(slotId: string): Promise<void> {
  const db = await getDatabase();
  await cancelBooking(db, slotId as SlotId);
  revalidateAll();
}


// Resolve the set of rooms a service is eligible for, mirroring the
// matrix's logic in generateSlots: if no requirement rows are defined for
// the service, "any room" is fine; otherwise filter to rooms whose type
// matches one of the listed roomTypes (OR semantics — see
// servicesRoomRequirements docs in the schema).
function eligibleRoomsFor(
  service: Service,
  rooms: Room[],
  requirements: ServiceRoomRequirement[],
): Room[] {
  const reqRows = requirements.filter((rr) => rr.serviceId === service.id);
  if (reqRows.length === 0) return rooms;
  return rooms.filter((r) =>
    reqRows.some((rr) => rr.roomType === r.type),
  );
}

interface CellStateInput {
  providerId: string;
  cellIsoStart: string;
  service: Service;
  schedules: ProviderSchedule[];
  pinnedSlots: Slot[];
  rooms: Room[];
  servicesRoomRequirements: ServiceRoomRequirement[];
}

// The cell represents a coordinate on the grid (provider, time). Whether
// a booking would actually fit there depends on a duration-aligned check:
// the schedule must cover the FULL service duration starting at the
// cell, and no pin (on either the provider axis OR the room axis) can
// overlap the [cellStart, cellStart + duration) window.
//
// Provider conflict surfaces the blocking pin (so the UI can show the
// service name / cancel button). Room conflict is reported as a generic
// 'no-room' — multiple pins may be involved, so there isn't a single
// "the blocking booking" to point at.
function cellState(input: CellStateInput): CalendarCellState {
  const {
    providerId,
    cellIsoStart,
    service,
    schedules,
    pinnedSlots,
    rooms,
    servicesRoomRequirements,
  } = input;
  const cellStartMs = Date.parse(cellIsoStart);
  const bookingEndMs = cellStartMs + service.durationMinutes * 60_000;

  // At least one of the provider's schedule rows must cover the full
  // booking duration. A provider may have many schedule rows (one per
  // day of week is a common shape); checking only the first one would
  // mark the calendar out-of-schedule for every day past whichever row
  // happened to be first.
  const covered = schedules.some(
    (s) =>
      s.providerId === providerId &&
      Date.parse(s.start) <= cellStartMs &&
      Date.parse(s.end) >= bookingEndMs,
  );
  if (!covered) {
    return { kind: 'out-of-schedule' };
  }

  // Provider-axis conflict. If THIS cell is the exact start of the busy
  // slot we render the booking details + cancel button; if the cell is
  // covered by (or would extend into) a different busy slot, render
  // plain "unavailable" with the appropriate reason.
  const providerOverlap = pinnedSlots.find(
    (p) =>
      p.providerId === providerId &&
      Date.parse(p.start) < bookingEndMs &&
      Date.parse(p.end) > cellStartMs,
  );
  if (providerOverlap) {
    const overlapStart = Date.parse(providerOverlap.start);
    if (overlapStart === cellStartMs) {
      return { kind: 'busy-start', booking: providerOverlap };
    }
    if (overlapStart < cellStartMs) {
      return { kind: 'unavailable', reason: 'covered', booking: providerOverlap };
    }
    return { kind: 'unavailable', reason: 'would-overlap', booking: providerOverlap };
  }

  // Room-axis conflict. The cell only fits if at least one room eligible
  // for this service is free over the whole booking window. "Eligible
  // but all blocked" and "no eligible rooms at all" collapse to the same
  // user-facing state — neither path leads to a feasible booking.
  if (service.requiresRoom) {
    const eligible = eligibleRoomsFor(service, rooms, servicesRoomRequirements);
    if (eligible.length === 0) {
      return { kind: 'unavailable', reason: 'no-room' };
    }
    const anyFree = eligible.some(
      (r) =>
        !pinnedSlots.some(
          (p) =>
            p.roomId === r.id &&
            Date.parse(p.start) < bookingEndMs &&
            Date.parse(p.end) > cellStartMs,
        ),
    );
    if (!anyFree) {
      return { kind: 'unavailable', reason: 'no-room' };
    }
  }

  return { kind: 'available' };
}

// Cell-state for location-scheduled services (services.requiresProvider
// = false). No providers, no reshuffle — three guards checked directly
// against the pinnedSlots list:
//   1. Location schedule covers the booking window at all.
//   2. Concurrent-booking count is below capacity.
//   3. If the service requires a room, at least one eligible room is free.
interface LocationCellStateInput {
  service: Service;
  cellIsoStart: string;
  locations: Location[];
  locationSchedules: LocationSchedule[];
  pinnedSlots: Slot[];
  rooms: Room[];
  servicesRoomRequirements: ServiceRoomRequirement[];
}

function locationAnonymousState(
  input: LocationCellStateInput,
): AnonymousCalendarCellState {
  const {
    service,
    cellIsoStart,
    locations,
    locationSchedules,
    pinnedSlots,
    rooms,
    servicesRoomRequirements,
  } = input;
  const cellStartMs = Date.parse(cellIsoStart);
  const bookingEndMs = cellStartMs + service.durationMinutes * 60_000;

  // Iterate locations. Find a schedule row that covers the full window
  // and has capacity set; check its capacity against overlapping pins.
  let anyInSchedule = false;
  for (const location of locations) {
    const covering = locationSchedules.find(
      (ls) =>
        ls.locationId === location.id &&
        ls.capacity != null &&
        Date.parse(ls.start) <= cellStartMs &&
        Date.parse(ls.end) >= bookingEndMs,
    );
    if (!covering) continue;
    anyInSchedule = true;

    const overlappingHere = pinnedSlots.filter(
      (p) =>
        p.locationId === location.id &&
        Date.parse(p.start) < bookingEndMs &&
        Date.parse(p.end) > cellStartMs,
    ).length;
    if (overlappingHere >= covering.capacity!) continue;

    if (service.requiresRoom) {
      const eligible = eligibleRoomsFor(service, rooms, servicesRoomRequirements);
      if (eligible.length === 0) continue;
      const anyFree = eligible.some(
        (r) =>
          !pinnedSlots.some(
            (p) =>
              p.roomId === r.id &&
              Date.parse(p.start) < bookingEndMs &&
              Date.parse(p.end) > cellStartMs,
          ),
      );
      if (!anyFree) continue;
    }

    // Surface how many bookings have already landed at this specific
    // location + window. Only meaningful for the scoped-single-location
    // case; when multiple locations are considered together, "how many
    // are booked" is ambiguous — omit the count in that case.
    const bookedCount =
      locations.length === 1 ? overlappingHere : undefined;
    return { kind: 'available', bookedCount };
  }

  return { kind: anyInSchedule ? 'unavailable' : 'out-of-day' };
}

interface AnonymousStateInput {
  service: Service;
  cellIsoStart: string;
  cadenceMinutes: number;
  qualifiedProviders: Provider[];
  schedulingContext: SchedulingContext;
}

function anonymousState(input: AnonymousStateInput): AnonymousCalendarCellState {
  const { service, cellIsoStart, cadenceMinutes, qualifiedProviders, schedulingContext } = input;
  const {
    qualifications,
    schedules,
    pinnedSlots,
    services,
    rooms = [],
    servicesRoomRequirements = [],
  } = schedulingContext;

  let anyInSchedule = false;
  for (const provider of qualifiedProviders) {
    const state = cellState({
      providerId: provider.id,
      cellIsoStart,
      service,
      schedules,
      pinnedSlots,
      rooms,
      servicesRoomRequirements,
    });
    if (state.kind === 'out-of-schedule') continue;
    anyInSchedule = true;
    if (state.kind === 'available') return { kind: 'available' };
  }
  const statusLabel = anyInSchedule ? 'unavailable' : 'out-of-day';

  if (statusLabel === 'unavailable') {
    const bookingRequest: BookingRequest = {
      serviceId: service.id,
      window: {
        start: cellIsoStart as Instant,
        end: new Date(
          Date.parse(cellIsoStart) + service.durationMinutes * 60_000,
        ).toISOString() as Instant,
      },
      granularityMinutes: cadenceMinutes,
    };
    // Forward rooms + requirements so the reshuffle proposer can find
    // room-aware alternatives. Without them, a reshuffle that would
    // resolve a room conflict (rather than a provider conflict) gets
    // missed.
    const reshuffleContext: ProposeReshuffleContext = {
      services,
      qualifications,
      schedules,
      pinnedSlots,
      rooms,
      servicesRoomRequirements,
    };

    const proposal = proposeReshuffle(bookingRequest, reshuffleContext);
    if (proposal) {
      return { kind: 'unavailable-reshufflable', proposal };
    }
  }

  return { kind: statusLabel };
}

// Fallback range used when no schedules cover the requested day (e.g.,
// scenario data is sparse). Real scenarios derive the range from the
// selected location's schedules in computeDayHourRange below.
const DEFAULT_DAY_START_HOUR = 8;
const DEFAULT_DAY_END_HOUR = 17;

// Snap to a full-day render (0-24) when the derived operating window
// covers this many hours or more. Anchors the "close to 24h" case from
// the product spec: 20+ operating hours reads as effectively 24/7.
const FULL_DAY_SNAP_HOURS = 20;

// Buffer added to either side of the derived operating window.
const HOUR_BUFFER = 1;

const pad = (n: number): string => String(n).padStart(2, '0');

// Resolve a local wall-clock time (in `tz`) to a UTC Instant. Uses
// Intl.DateTimeFormat to compute the tz offset at that instant, then
// adjusts. Correct for standard offsets and DST-in-effect times; a
// wall-clock during a DST fall-back hour maps to one of two possible
// UTC instants and this picks the earlier — acceptable for a demo.
// tz undefined → treat the wall-clock as UTC (legacy behavior).
function localToUtcIso(
  dateYMD: string,
  hour: number,
  minute: number,
  tz: string | undefined,
): string {
  if (!tz) {
    return `${dateYMD}T${pad(hour)}:${pad(minute)}:00.000Z`;
  }
  const [y, m, d] = dateYMD.split('-').map(Number);
  const guessMs = Date.UTC(y!, m! - 1, d!, hour, minute);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(guessMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asZonedMs = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') === 24 ? 0 : get('hour'),
    get('minute'),
  );
  const offset = asZonedMs - guessMs;
  return new Date(guessMs - offset).toISOString();
}

// Derive the local-hour range to render on `date` from schedules that
// overlap the target day. Adds a buffer on each side and snaps to a
// full-day view when the operating window is 20+ hours. If no schedules
// overlap, falls back to the DEFAULT_ constants so sparse scenarios
// still render something.
function computeDayHourRange(
  date: string,
  tz: string | undefined,
  schedules: { start: string; end: string }[],
): { startHour: number; endHour: number } {
  const dayStartMs = Date.parse(localToUtcIso(date, 0, 0, tz));
  const dayEndMs = Date.parse(localToUtcIso(date, 24, 0, tz));
  const toHourOfDay = (iso: string): number => {
    const ms = Date.parse(iso);
    if (ms <= dayStartMs) return 0;
    if (ms >= dayEndMs) return 24;
    return (ms - dayStartMs) / (60 * 60 * 1000);
  };

  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const s of schedules) {
    const sMs = Date.parse(s.start);
    const eMs = Date.parse(s.end);
    if (eMs <= dayStartMs || sMs >= dayEndMs) continue;
    minStart = Math.min(minStart, Math.floor(toHourOfDay(s.start)));
    maxEnd = Math.max(maxEnd, Math.ceil(toHourOfDay(s.end)));
  }

  if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd)) {
    return { startHour: DEFAULT_DAY_START_HOUR, endHour: DEFAULT_DAY_END_HOUR };
  }

  const buffered = {
    startHour: Math.max(0, minStart - HOUR_BUFFER),
    endHour: Math.min(24, maxEnd + HOUR_BUFFER),
  };
  if (buffered.endHour - buffered.startHour >= FULL_DAY_SNAP_HOURS) {
    return { startHour: 0, endHour: 24 };
  }
  return buffered;
}

const buildTimeSlots = (
  date: string,
  cadenceMinutes: number,
  tz: string | undefined,
  startHour: number,
  endHour: number,
): TimeSlot[] => {
  const slots: TimeSlot[] = [];
  for (let h = startHour; h < endHour; h++) {
    for (let m = 0; m < 60; m += cadenceMinutes) {
      slots.push({
        label: `${pad(h)}:${pad(m)}`,
        isoStart: localToUtcIso(date, h, m, tz),
      });
    }
  }
  return slots;
};


interface CalendarCellsInput {
  date: string;
  serviceId: string;
  cadenceMinutes: number;
  mode: 'anonymous' | 'known';
  /** IANA timezone identifier used to interpret `date` and generate
   *  slots at the practice's local wall-clock times. Omit for UTC. */
  timezone?: string;
  /** When set, hour-range derivation and (for provider-mode) provider
   *  filtering are scoped to this location's schedules. Unset = derive
   *  from every schedule that overlaps the day. */
  locationId?: string;
  /** Scenario tag — scopes the underlying DB reads so cross-scenario data
   *  doesn't leak into one calendar. Omit to load the whole DB. */
  scenarioTag?: string;
}

export interface AnonymousCalendarCell {
  timeslot: TimeSlot;
  state: AnonymousCalendarCellState;
}

export interface KnownProviderCalendarCell {
  timeslot: TimeSlot;
  state: CalendarCellState;
}

interface CalendarCellsOutputAnonymous {
  mode: 'anonymous';
  cells: AnonymousCalendarCell[];
}

interface CalendarCellsOutputKnownProviders {
  mode: 'known';
  cellsByProvider: Record<string, KnownProviderCalendarCell[]>;
}

export type CalendarCells = CalendarCellsOutputAnonymous | CalendarCellsOutputKnownProviders;

export async function loadCalendarCellsAction(input: CalendarCellsInput): Promise<CalendarCells> {
  const {
    date,
    serviceId,
    cadenceMinutes,
    mode,
    timezone,
    locationId,
    scenarioTag,
  } = input;
  const db = await getDatabase();

  // loadSchedulingContext gives us canonical Service / ProviderQualification /
  // ProviderSchedule / Slot (busy-only) — same shapes the algorithm uses.
  // providers aren't in SchedulingContext (the algorithm doesn't need them),
  // so we fetch that table separately and lift it to canonical Provider[]
  // here at the Drizzle boundary.
  const [ctx, rawProviders] = await Promise.all([
    loadSchedulingContext(db, scenarioTag),
    db
      .select()
      .from(providers)
      .where(scenarioTag ? eq(providers.tag, scenarioTag) : undefined),
  ]);
  const allProviders: Provider[] = rawProviders.map((p) => ({
    id: p.id as ProviderId,
    name: p.name,
  }));

  // Pool the schedules that could shape the operating window on this
  // day: location schedules and provider schedules alike. Location
  // narrows the pool when set; otherwise everything at the practice
  // contributes.
  const scheduleSources: { start: string; end: string }[] = [
    ...(ctx.locationSchedules ?? []).filter(
      (s) => !locationId || s.locationId === locationId,
    ),
    ...(ctx.schedules ?? []).filter(
      (s) => !locationId || s.locationId === locationId,
    ),
  ];
  const { startHour, endHour } = computeDayHourRange(
    date,
    timezone,
    scheduleSources,
  );
  const timeslots = buildTimeSlots(
    date,
    cadenceMinutes,
    timezone,
    startHour,
    endHour,
  );
  const selectedService = ctx.services.find((s) => s.id === serviceId);

  // No matching service in this scenario's data — fall back to a blank
  // grid. Previously this branch silently produced cells with duration=0
  // (because durationMinutes ?? 0 defaulted there), which mostly looked
  // empty by coincidence. Being explicit is friendlier to the UI.
  if (!selectedService) {
    if (mode === 'anonymous') return { mode: 'anonymous', cells: [] };
    return { mode: 'known', cellsByProvider: {} };
  }

  const rooms = ctx.rooms ?? [];
  const servicesRoomRequirements = ctx.servicesRoomRequirements ?? [];
  const locations = ctx.locations ?? [];
  const locationSchedules = ctx.locationSchedules ?? [];

  if (mode === 'anonymous') {
    // Location-scheduled services (services.requiresProvider = false)
    // don't have a provider axis. Use the location-based cell state
    // instead — capacity + optional room contention.
    if (!selectedService.requiresProvider) {
      // Restrict cell-state evaluation to the selected location, if
      // any. Booking respects `request.locationId` (via
      // pickByLocationCapacity), so the cell must too — otherwise a
      // cell could read "book" because *some* other location has
      // capacity at that time, and the click would then come back
      // infeasible when the booking is restricted to a location
      // without a matching window.
      const scopedLocations = locationId
        ? locations.filter((l) => l.id === locationId)
        : locations;
      const cells: AnonymousCalendarCell[] = timeslots.map((timeslot) => ({
        timeslot,
        state: locationAnonymousState({
          service: selectedService,
          cellIsoStart: timeslot.isoStart,
          locations: scopedLocations,
          locationSchedules,
          pinnedSlots: ctx.pinnedSlots,
          rooms,
          servicesRoomRequirements,
        }),
      }));
      return { mode: 'anonymous', cells };
    }

    const qualifiedProviderIds = new Set<string>(
      ctx.qualifications
        .filter((q) => q.serviceId === serviceId)
        .map((q) => q.providerId),
    );
    const qualifiedProviders = allProviders.filter((p) =>
      qualifiedProviderIds.has(p.id),
    );

    const cells: AnonymousCalendarCell[] = timeslots.map((timeslot) => ({
      timeslot,
      state: anonymousState({
        service: selectedService,
        cellIsoStart: timeslot.isoStart,
        cadenceMinutes,
        qualifiedProviders,
        schedulingContext: ctx,
      }),
    }));
    return { mode: 'anonymous', cells };
  }

  // Known mode is provider-based only. Location-scheduled services
  // have no provider axis, so we return an empty grid; the calendar UI
  // should default location-scheduled scenarios to anonymous mode.
  if (!selectedService.requiresProvider) {
    return { mode: 'known', cellsByProvider: {} };
  }

  const cellsByProvider: Record<string, KnownProviderCalendarCell[]> = {};
  for (const provider of allProviders) {
    cellsByProvider[provider.id] = timeslots.map((timeslot) => ({
      timeslot,
      state: cellState({
        providerId: provider.id,
        cellIsoStart: timeslot.isoStart,
        service: selectedService,
        schedules: ctx.schedules,
        pinnedSlots: ctx.pinnedSlots,
        rooms,
        servicesRoomRequirements,
      }),
    }));
  }
  return { mode: 'known', cellsByProvider };
}

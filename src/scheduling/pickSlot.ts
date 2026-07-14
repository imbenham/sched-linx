// Top-level slot picker. Dispatches on `service.requiresProvider`:
//
//   provider-scheduled  → matrix-based path (pickByProviderMatrix). This is
//                         the historical DLX flow: enumerate candidates,
//                         build the exact-cover matrix, walk request-column
//                         rows, pick the first that doesn't strand any
//                         existing pin.
//
//   location-scheduled  → direct capacity + optional room-conflict check
//                         (pickByLocationCapacity). No matrix. Location
//                         capacity is enforced by counting overlapping
//                         pinned bookings; room contention (only when the
//                         service also requires a room) is enforced by
//                         filtering eligible rooms against pinned
//                         holdings. Same room-availability semantics as
//                         the matrix's room-interval source uses, so a
//                         mixed practice's provider- and location-based
//                         paths compete for shared rooms consistently.
//
// Return type carries an optional `providerId` — undefined for location-
// scheduled picks — reflecting the honest shape of what got assigned.

import { cover, uncover, type ColumnHeader } from '../dlx';
import {
  buildSchedulingMatrix,
  type SchedulingBooking,
} from './buildSchedulingMatrix';
import {
  eligibleRoomsFor,
  generateSlots,
  type GenerateSlotsContext,
} from './generateSlots';
import type {
  BookingRequest,
  Instant,
  Location,
  LocationSchedule,
  ProviderId,
  Room,
  Slot,
  SlotCandidate,
} from '../model';

const DEFAULT_GRANULARITY_MINUTES = 15;
const MS_PER_MINUTE = 60_000;
const REQUEST_BOOKING_ID = '__request__';

const toEpoch = (i: Instant): number => Date.parse(i);
const fromEpoch = (ms: number): Instant =>
  new Date(ms).toISOString() as Instant;

// Picker context = generator context + the slots currently busy. Each
// pinned slot becomes a single-candidate booking (for the matrix path)
// or a linear overlap check (for the location-capacity path).
export interface PickSlotContext extends GenerateSlotsContext {
  pinnedSlots: Slot[];
}

export interface PickResult {
  // Undefined for location-scheduled picks.
  providerId?: ProviderId;
  slot: SlotCandidate;
}

// True iff a pinned slot for the given roomId overlaps [start, end).
// Half-open interval semantics so touching-but-not-overlapping bookings
// (10:00-10:30 and 10:30-11:00 in the same room) coexist correctly.
function isRoomBusyInWindow(
  pinnedSlots: Slot[],
  roomId: string,
  startMs: number,
  endMs: number,
): boolean {
  return pinnedSlots.some(
    (p) =>
      p.roomId === roomId &&
      toEpoch(p.start) < endMs &&
      toEpoch(p.end) > startMs,
  );
}

export function pickSlot(
  request: BookingRequest,
  ctx: PickSlotContext,
): PickResult | null {
  const service = ctx.services.find((s) => s.id === request.serviceId);
  if (!service) return null;
  return service.requiresProvider
    ? pickByProviderMatrix(request, ctx)
    : pickByLocationCapacity(request, service.durationMinutes, ctx);
}

// ─── Provider-scheduled path (existing matrix logic) ────────────────────────

const slotToCandidate = (s: Slot): SlotCandidate => ({
  providerId: s.providerId,
  locationId: s.locationId,
  serviceId: s.serviceId,
  start: s.start,
  end: s.end,
  roomId: s.roomId,
});

function pickByProviderMatrix(
  request: BookingRequest,
  ctx: PickSlotContext,
): PickResult | null {
  const candidates = generateSlots(request, ctx);
  if (candidates.length === 0) return null;

  const bookings: SchedulingBooking[] = [
    ...ctx.pinnedSlots.map(
      (s): SchedulingBooking => ({
        bookingId: `pinned:${s.id}`,
        candidates: [slotToCandidate(s)],
      }),
    ),
    { bookingId: REQUEST_BOOKING_ID, candidates },
  ];

  const { matrix } = buildSchedulingMatrix({ bookings });

  const reqCol = matrix.columnsByName.get(`booking:${REQUEST_BOOKING_ID}`);
  if (!reqCol || reqCol.size === 0) return null;

  cover(reqCol);
  try {
    let rowIdx = 0;
    for (let r = reqCol.down; r !== reqCol; r = r.down, rowIdx++) {
      for (let j = r.right; j !== r; j = j.right) cover(j.column);

      let orphans = 0;
      for (
        let c = matrix.root.right as ColumnHeader;
        c !== matrix.root;
        c = c.right as ColumnHeader
      ) {
        if (c.size === 0) orphans++;
      }

      for (let j = r.left; j !== r; j = j.left) uncover(j.column);

      if (orphans === 0) {
        const chosen = candidates[rowIdx]!;
        // Provider-scheduled path always populates providerId on
        // candidates; the assertion is safe here.
        return { providerId: chosen.providerId!, slot: chosen };
      }
    }
  } finally {
    uncover(reqCol);
  }

  return null;
}

// ─── Location-scheduled path (direct capacity + optional room check) ────────
//
// Iterates candidate time windows across the request's [start, end) at
// the resolved cadence. For each window, gathers every location whose
// schedule covers the window, whose capacity is unfilled, and (if the
// service requires a room) that has an eligible room free. The routing
// strategy picks the winner among feasible options. Earliest window
// with any feasible option wins.
//
// request.locationId acts as a hard pre-filter — set → one location
// only, unset → all locations are candidates.

interface FeasibleOption {
  location: Location;
  schedule: LocationSchedule; // guaranteed to have a set capacity
  overlapCount: number;
  roomId?: string;
}

// Selection heuristic among feasible (location, window) options.
// Deliberately pluggable so practices with different priorities can
// swap in a different rule (fewest-bookings, fill-first, etc.) without
// touching the picker's inner loop. Only default implementation ships
// today; a future config knob would live on locations or services.
type RoutingStrategy = (options: FeasibleOption[]) => FeasibleOption;

const pickByMostHeadroom: RoutingStrategy = (options) => {
  let best = options[0]!;
  let bestHeadroom = best.schedule.capacity! - best.overlapCount;
  for (let i = 1; i < options.length; i++) {
    const opt = options[i]!;
    const headroom = opt.schedule.capacity! - opt.overlapCount;
    // Strict `>` preserves insertion-order tiebreak.
    if (headroom > bestHeadroom) {
      best = opt;
      bestHeadroom = headroom;
    }
  }
  return best;
};

function pickByLocationCapacity(
  request: BookingRequest,
  durationMinutes: number,
  ctx: PickSlotContext,
): PickResult | null {
  const service = ctx.services.find((s) => s.id === request.serviceId);
  if (!service) return null;

  // Hard pre-filter: if the caller specified a location, only that one
  // is a candidate.
  const allLocations = ctx.locations ?? [];
  const locations = request.locationId
    ? allLocations.filter((l) => l.id === request.locationId)
    : allLocations;
  if (locations.length === 0) return null;

  const locationSchedules = ctx.locationSchedules ?? [];

  // Cadence precedence (prototype posture): request.granularityMinutes
  // wins, then service.bookingCadenceMinutes, then default. See
  // generateSlots for the rationale on this ordering.
  const cadenceMinutes =
    request.granularityMinutes ??
    service.bookingCadenceMinutes ??
    DEFAULT_GRANULARITY_MINUTES;
  const granularityMs = cadenceMinutes * MS_PER_MINUTE;
  const durationMs = durationMinutes * MS_PER_MINUTE;

  const requestStart = toEpoch(request.window.start);
  const requestEnd = toEpoch(request.window.end);

  const wantsRoom = service.requiresRoom === true;
  const eligibleRooms: Room[] = wantsRoom
    ? eligibleRoomsFor(
        request.serviceId,
        ctx.rooms ?? [],
        ctx.servicesRoomRequirements ?? [],
      )
    : [];
  if (wantsRoom && eligibleRooms.length === 0) return null;

  // Walk candidate time windows across the whole request window. For
  // each window, collect every location that could take it, then let
  // the routing strategy pick. Earliest window with any option wins.
  const firstStart =
    Math.ceil(requestStart / granularityMs) * granularityMs;

  for (
    let start = firstStart;
    start + durationMs <= requestEnd;
    start += granularityMs
  ) {
    const end = start + durationMs;
    const feasibleAtWindow: FeasibleOption[] = [];

    for (const location of locations) {
      // Find the schedule row covering this window with capacity set.
      // Boundary-spanning windows fail the coverage check (fine for
      // shift boundaries aligned to cadence).
      const covering = locationSchedules.find(
        (ls) =>
          ls.locationId === location.id &&
          ls.capacity != null &&
          toEpoch(ls.start) <= start &&
          toEpoch(ls.end) >= end,
      );
      if (!covering) continue;

      const overlapCount = ctx.pinnedSlots.filter(
        (p) =>
          p.locationId === location.id &&
          toEpoch(p.start) < end &&
          toEpoch(p.end) > start,
      ).length;
      if (overlapCount >= covering.capacity!) continue;

      let chosenRoomId: string | undefined;
      if (wantsRoom) {
        const free = eligibleRooms.find(
          (r) => !isRoomBusyInWindow(ctx.pinnedSlots, r.id, start, end),
        );
        if (!free) continue;
        chosenRoomId = free.id;
      }

      feasibleAtWindow.push({
        location,
        schedule: covering,
        overlapCount,
        roomId: chosenRoomId,
      });
    }

    if (feasibleAtWindow.length === 0) continue;

    const chosen = pickByMostHeadroom(feasibleAtWindow);
    return {
      slot: {
        providerId: undefined,
        locationId: chosen.location.id,
        serviceId: request.serviceId,
        start: fromEpoch(start),
        end: fromEpoch(end),
        roomId: chosen.roomId as SlotCandidate['roomId'],
      },
    };
  }

  return null;
}

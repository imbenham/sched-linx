import { search } from '../dlx';
import {
  buildSchedulingMatrix,
  type SchedulingBooking,
} from './buildSchedulingMatrix';
import { generateSlots, type GenerateSlotsContext } from './generateSlots';
import type {
  BookingRequest,
  Instant,
  ProviderId,
  Slot,
  SlotCandidate,
  SlotId,
} from '../model';

export interface ProposeReshuffleContext extends GenerateSlotsContext {
  pinnedSlots: Slot[];
}

export interface ReshuffleMovedPin {
  /** The currently-busy slot whose provider would change. */
  slotId: SlotId;
  fromProviderId: ProviderId;
  toProviderId: ProviderId;
}

export interface ReshuffleProposal {
  newAssignment: { providerId: ProviderId; slot: SlotCandidate };
  /** Empty when a cover exists without reshuffling any pin (i.e. equivalent
   *  to a successful pickProvider). */
  movedPins: ReshuffleMovedPin[];
}

const NEW_REQUEST_BOOKING_ID = '__new_request__';

const toEpoch = (i: Instant): number => Date.parse(i);

// Per the pinned-slot stability constraint, only providerId is
// reshuffle-eligible for a busy slot. Derive alternative candidates for
// a pin = same (start, end, locationId, serviceId), any qualified
// provider whose schedule covers the slot's time window at the slot's
// location. The pin's current provider is included first so DLX
// naturally prefers "no move" when both arrangements are feasible (rows
// in a column are walked in insertion order).
function alternativesForPin(
  pin: Slot,
  ctx: GenerateSlotsContext,
): SlotCandidate[] {
  const qualifiedProviders = new Set(
    ctx.qualifications
      .filter((q) => q.serviceId === pin.serviceId)
      .map((q) => q.providerId),
  );

  const pinStart = toEpoch(pin.start);
  const pinEnd = toEpoch(pin.end);

  const availableProviders = new Set<ProviderId>();
  for (const schedule of ctx.schedules) {
    if (!qualifiedProviders.has(schedule.providerId)) continue;
    if (schedule.locationId !== pin.locationId) continue;
    if (toEpoch(schedule.start) > pinStart) continue;
    if (toEpoch(schedule.end) < pinEnd) continue;
    availableProviders.add(schedule.providerId);
  }

  // Reshuffle only applies to provider-scheduled pins; a location-
  // scheduled pin has no provider and this function shouldn't be called
  // on one. Non-null assertion is safe under that contract.
  const pinProviderId = pin.providerId!;
  const ordered: ProviderId[] = [pinProviderId];
  for (const p of availableProviders) {
    if (p !== pinProviderId) ordered.push(p);
  }

  // Room stays with the pin when the provider changes — same stability
  // contract as time/location/service. Without preserving roomId here,
  // the moved-pin row would lose its room cells, the matrix wouldn't see
  // the pin's room occupation, and the reshuffler could "solve" by
  // double-booking a room.
  return ordered.map((providerId) => ({
    providerId,
    locationId: pin.locationId,
    serviceId: pin.serviceId,
    start: pin.start,
    end: pin.end,
    roomId: pin.roomId,
  }));
}

// Propose a reshuffle that accommodates `request` by potentially moving
// pinned bookings (busy slots) to alternative providers. Per the v1
// domain constraint, only providerId is reshuffle-eligible — time,
// location, service stay fixed for every pin. Returns null when no
// feasible cover exists even with reshuffling.
//
// Returns a proposal — does NOT mutate state. Empty `movedPins` means a
// cover was found without moving any pin (equivalent to a successful
// pickProvider call).
export function proposeReshuffle(
  request: BookingRequest,
  ctx: ProposeReshuffleContext,
): ReshuffleProposal | null {
  const newCandidates = generateSlots(request, ctx);
  if (newCandidates.length === 0) return null;

  const pinBookings = ctx.pinnedSlots.map((pin) => ({
    booking: {
      bookingId: `pin:${pin.id}`,
      candidates: alternativesForPin(pin, ctx),
    } satisfies SchedulingBooking,
    pin,
  }));

  const bookings: SchedulingBooking[] = [
    ...pinBookings.map((p) => p.booking),
    { bookingId: NEW_REQUEST_BOOKING_ID, candidates: newCandidates },
  ];

  const { matrix, resolveRow } = buildSchedulingMatrix({ bookings });

  const solutions = search(matrix);
  if (solutions.length === 0) return null;

  const cover = solutions[0]!;
  const pinByBookingId = new Map(
    pinBookings.map((p) => [p.booking.bookingId, p.pin] as const),
  );

  let newAssignment: { providerId: ProviderId; slot: SlotCandidate } | null =
    null;
  const movedPins: ReshuffleMovedPin[] = [];

  for (const rowId of cover) {
    const resolved = resolveRow(rowId);
    if (!resolved) continue;
    const { bookingId, slot } = resolved;
    if (bookingId === NEW_REQUEST_BOOKING_ID) {
      // Reshuffle only runs on provider-scheduled requests; slot has a
      // providerId here.
      newAssignment = { providerId: slot.providerId!, slot };
      continue;
    }
    const pin = pinByBookingId.get(bookingId);
    if (!pin) continue;
    if (slot.providerId !== pin.providerId) {
      movedPins.push({
        slotId: pin.id,
        // Both are provider-scheduled per the reshuffle contract.
        fromProviderId: pin.providerId!,
        toProviderId: slot.providerId!,
      });
    }
  }

  if (!newAssignment) return null;
  return { newAssignment, movedPins };
}

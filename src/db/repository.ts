// The persistence bridge between Drizzle (rows of plain strings) and the
// canonical scheduling functions (branded types, nested shapes). This is
// the only module that knows BOTH the DB schema and the model brands;
// every other layer talks canonical types only.
//
// Slot-as-booking model: a persisted Slot with status='busy' is an active
// booking (a "pin" to the matrix); status='canceled' is history. Free
// slot inventory isn't pre-materialized; we only persist slots that
// represent bookings. Reshuffle uses cancel-old + create-new to preserve
// append-only history via the status column.

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Database } from './client';
import {
  locations,
  locationSchedules,
  providerQualifications,
  providerSchedules,
  rooms,
  services,
  servicesRoomRequirements,
  slots,
} from './schema';
import type {
  Instant,
  Location,
  LocationId,
  LocationSchedule,
  LocationScheduleId,
  ProviderId,
  ProviderScheduleId,
  RoomId,
  ServiceId,
  Slot,
  SlotCandidate,
  SlotId,
} from '../model';
import type { GenerateSlotsContext } from '../scheduling/generateSlots';
import type { ReshuffleProposal } from '../scheduling/proposeReshuffle';

// Single shape that satisfies both PickProviderContext and
// ProposeReshuffleContext. Pinned slots are persisted slots with
// status='busy'; canceled and (hypothetical) free slots don't pin.
export interface SchedulingContext extends GenerateSlotsContext {
  pinnedSlots: Slot[];

}

const newSlotId = (): SlotId => randomUUID();

// Bulk-load everything the scheduling layer needs in one round trip.
// Returns canonical types. Pinned slots = persisted slots with
// status='busy' — the matrix never sees canceled or free rows.
export async function loadSchedulingContext(
  db: Database,
  tag?: string,
): Promise<SchedulingContext> {
  // todo: use relations rather than so many separate queries.
  const [
    svcRows,
    qualRows,
    schedRows,
    roomRows,
    roomRequirementRows,
    busySlots,
    locationRows,
    locationScheduleRows,
  ] = await Promise.all([
    db.select().from(services).where(tag ? eq(services.tag, tag) : undefined),
    db.select().from(providerQualifications).where(tag ? eq(providerQualifications.tag, tag) : undefined),
    db.select().from(providerSchedules).where(tag ? eq(providerSchedules.tag, tag) : undefined),
    db.select().from(rooms).where(tag ? eq(rooms.tag, tag) : undefined),
    db.select().from(servicesRoomRequirements).where(tag ? eq(servicesRoomRequirements.tag, tag) : undefined),
    db
      .select()
      .from(slots)
      .where(
        tag
          ? and(eq(slots.status, 'busy'), eq(slots.tag, tag))
          : eq(slots.status, 'busy'),
      ),
    db.select().from(locations).where(tag ? eq(locations.tag, tag) : undefined),
    db.select().from(locationSchedules).where(tag ? eq(locationSchedules.tag, tag) : undefined),
  ]);

  return {
    services: svcRows.map((s) => ({
      id: s.id,
      name: s.name,
      durationMinutes: s.durationMinutes,
      requiresProvider: s.requiresProvider,
      requiresRoom: s.requiresRoom,
      bookingCadenceMinutes: s.bookingCadenceMinutes ?? undefined,
    })),
    qualifications: qualRows.map((q) => ({
      providerId: q.providerId,
      serviceId: q.serviceId,
    })),
    schedules: schedRows.map((s) => ({
      id: s.id,
      providerId: s.providerId,
      locationId: s.locationId,
      start: s.start,
      end: s.end,
    })),
    rooms: roomRows.map((r) => ({
      id: r.id,
      name: r.name,
      locationId: r.locationId,
      type: r.type,
    })),
    servicesRoomRequirements: roomRequirementRows.map((rr) => ({
      serviceId: rr.serviceId,
      roomType: rr.roomType,
    })),
    pinnedSlots: busySlots.map((s) => ({
      id: s.id,
      // Location-scheduled bookings persist with provider_id = null.
      providerId: s.providerId ?? undefined,
      locationId: s.locationId,
      serviceId: s.serviceId,
      start: s.start,
      end: s.end,
      status: 'busy',
      // Without copying roomId here, room-occupied pins enter the matrix
      // without their room cells — the matrix can't see them holding a
      // room and would happily double-book.
      roomId: s.roomId ?? undefined,
    })),
    locations: locationRows.map(
      (l): Location => ({
        id: l.id,
        name: l.name,
        timezone: l.timezone ?? undefined,
      }),
    ),
    locationSchedules: locationScheduleRows.map(
      (ls): LocationSchedule => ({
        id: ls.id,
        locationId: ls.locationId,
        start: ls.start,
        end: ls.end,
        capacity: ls.capacity ?? undefined,
      }),
    ),
  };
}

// Atomically persist a chosen Slot as a booking (status='busy'). Used
// after a successful pickProvider call (or as the new-assignment step
// inside applyReshuffle). `tag` is the scenario tag so the inserted row
// stays scoped to the scenario that triggered the booking.
export async function applyAssignment(
  db: Database,
  slot: SlotCandidate,
  tag?: string,
): Promise<{ slot: Slot }> {
  const id = newSlotId();
  const row: Slot = {
    id,
    providerId: slot.providerId,
    locationId: slot.locationId,
    serviceId: slot.serviceId,
    start: slot.start,
    end: slot.end,
    status: 'busy',
    roomId: slot.roomId,
  };
  await db.insert(slots).values({ ...row, tag });
  return { slot: row };
}

export interface AppliedReshuffle {
  /** The new booking created for the request. */
  newSlot: Slot;
  /** For each pin that moved: the original slot was canceled, the new
   *  slot is the post-move booking. Original slot rows are preserved
   *  with status='canceled' so the history is queryable. */
  movedBookings: Array<{
    canceledSlotId: SlotId;
    newSlotId: SlotId;
  }>;
}

// Materialize a ReshuffleProposal into actual mutations. Cancel-old +
// create-new pattern: for each movedPin we set the original slot's
// status to 'canceled' and insert a new slot with the new providerId
// (same time/location/service) at status='busy'. Then we insert the
// new assignment's slot at status='busy'. Append-only history is
// preserved via the canceled rows.
//
// Pre-condition: the proposal was just produced by proposeReshuffle
// against this same DB state. If the world has shifted (e.g. the slot
// was already canceled), the integrity checks below throw and the
// transaction rolls back.
export async function applyReshuffle(
  db: Database,
  proposal: ReshuffleProposal,
  tag?: string,
): Promise<AppliedReshuffle> {
  return db.transaction(async (tx) => {
    const moved: AppliedReshuffle['movedBookings'] = [];

    for (const movedPin of proposal.movedPins) {
      const [currentSlot] = await tx
        .select()
        .from(slots)
        .where(and(eq(slots.id, movedPin.slotId), eq(slots.status, 'busy')));
      if (!currentSlot) {
        throw new Error(
          `applyReshuffle: busy slot ${movedPin.slotId} not found (it may have been canceled or never existed); proposal is stale`,
        );
      }
      if (currentSlot.providerId !== movedPin.fromProviderId) {
        throw new Error(
          `applyReshuffle: slot ${movedPin.slotId} is no longer with provider ${movedPin.fromProviderId} (now ${currentSlot.providerId}); proposal is stale`,
        );
      }

      await tx
        .update(slots)
        .set({ status: 'canceled' })
        .where(eq(slots.id, movedPin.slotId));

      const toSlotId = newSlotId();
      await tx.insert(slots).values({
        id: toSlotId,
        providerId: movedPin.toProviderId,
        locationId: currentSlot.locationId,
        serviceId: currentSlot.serviceId,
        start: currentSlot.start,
        end: currentSlot.end,
        status: 'busy',
        // Room + tag ride with the pin when its provider changes — same
        // stability contract as time/location/service. See proposeReshuffle
        // for the matching alternativesForPin invariant.
        roomId: currentSlot.roomId,
        tag: currentSlot.tag,
      });

      moved.push({
        canceledSlotId: currentSlot.id,
        newSlotId: toSlotId,
      });
    }

    const newSlotIdVal = newSlotId();
    const newSlotRow: Slot = {
      id: newSlotIdVal,
      providerId: proposal.newAssignment.slot.providerId,
      locationId: proposal.newAssignment.slot.locationId,
      serviceId: proposal.newAssignment.slot.serviceId,
      start: proposal.newAssignment.slot.start,
      end: proposal.newAssignment.slot.end,
      status: 'busy',
      roomId: proposal.newAssignment.slot.roomId,
    };
    await tx.insert(slots).values({ ...newSlotRow, tag });

    return {
      newSlot: newSlotRow,
      movedBookings: moved,
    };
  });
}

// Cancel a booking by setting its slot's status to 'canceled'. The slot
// row stays in the database; only matter to the matrix (which filters
// by status='busy') is that it no longer participates as a pin.
// Idempotent: canceling an already-canceled or unknown slot is a no-op.
export async function cancelBooking(
  db: Database,
  slotId: SlotId,
): Promise<void> {
  await db
    .update(slots)
    .set({ status: 'canceled' })
    .where(eq(slots.id, slotId));
}

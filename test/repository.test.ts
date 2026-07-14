import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  createDatabase,
  type Database,
} from '../src/db/client.js';
import {
  locations,
  providerQualifications,
  providers,
  providerSchedules,
  rooms,
  services,
  servicesRoomRequirements,
  slots,
} from '../src/db/schema.js';
import {
  applyAssignment,
  applyReshuffle,
  cancelBooking,
  loadSchedulingContext,
} from '../src/db/repository.js';
import { pickSlot } from '../src/scheduling/pickSlot.js';
import { proposeReshuffle } from '../src/scheduling/proposeReshuffle.js';
import type {
  BookingRequest,
  Instant,
  ProviderId,
  ServiceId,
  SlotId,
} from '../src/model.js';
import type { ReshuffleProposal } from '../src/scheduling/proposeReshuffle.js';

// Seed a minimal but workable corpus: Alice + Bob both qualified for
// checkup + consult, both with full-morning schedules at one clinic.
async function seedBaseline(db: Database): Promise<void> {
  await db.insert(providers).values([
    { id: 'alice', name: 'Alice' },
    { id: 'bob', name: 'Bob' },
  ]);
  await db.insert(services).values([
    { id: 'checkup', name: 'Checkup', durationMinutes: 30 },
    { id: 'consult', name: 'Consult', durationMinutes: 30 },
  ]);
  await db.insert(locations).values({ id: 'clinic', name: 'Main Clinic' });
  await db.insert(providerQualifications).values([
    { providerId: 'alice', serviceId: 'checkup' },
    { providerId: 'alice', serviceId: 'consult' },
    { providerId: 'bob', serviceId: 'checkup' },
    { providerId: 'bob', serviceId: 'consult' },
  ]);
  await db.insert(providerSchedules).values([
    {
      id: 's-alice',
      providerId: 'alice',
      locationId: 'clinic',
      start: '2026-05-25T09:00:00.000Z',
      end: '2026-05-25T12:00:00.000Z',
    },
    {
      id: 's-bob',
      providerId: 'bob',
      locationId: 'clinic',
      start: '2026-05-25T09:00:00.000Z',
      end: '2026-05-25T12:00:00.000Z',
    },
  ]);
  await db.insert(rooms).values([
    { id: 'room-1', name: 'Room 1', locationId: 'clinic', type: 'exam' },
    { id: 'room-2', name: 'Room 2', locationId: 'clinic', type: 'exam' },
    { id: 'room-3', name: 'Room 3', locationId: 'clinic', type: 'prenatal' },
  ]);
 
  await db.insert(servicesRoomRequirements).values([
    { serviceId: 'checkup', roomType: 'prenatal' },
    { serviceId: 'consult', roomType: 'exam'},
    { serviceId: 'consult', roomType: 'prenatal' },
  ]);
}

const inst = (s: string): Instant => s as Instant;

const request = (
  serviceId: string,
  windowStart: string,
  windowEnd: string,
): BookingRequest => ({
  serviceId: serviceId as ServiceId,
  window: { start: inst(windowStart), end: inst(windowEnd) },
});

describe('loadSchedulingContext', () => {
  let db: Database;
  beforeEach(async () => {
    db = await createDatabase();
    await applyMigrations(db);
  });

  it('returns empty arrays for an empty database', async () => {
    const ctx = await loadSchedulingContext(db);
    expect(ctx.services).toEqual([]);
    expect(ctx.qualifications).toEqual([]);
    expect(ctx.schedules).toEqual([]);
    expect(ctx.pinnedSlots).toEqual([]);
    expect(ctx.rooms).toEqual([]);
    expect(ctx.servicesRoomRequirements).toEqual([]);
  });

  it('returns seeded entities with branded shapes and no pinned slots', async () => {
    await seedBaseline(db);
    const ctx = await loadSchedulingContext(db);
    expect(ctx.services).toHaveLength(2);
    expect(ctx.qualifications).toHaveLength(4);
    expect(ctx.schedules).toHaveLength(2);
    expect(ctx.pinnedSlots).toEqual([]);
    expect(ctx.rooms).toHaveLength(3);
    expect(ctx.servicesRoomRequirements).toHaveLength(3);
    // Spot-check brand-cast shape.
    const alice = ctx.schedules.find((s) => s.providerId === 'alice')!;
    expect(alice.start).toBe('2026-05-25T09:00:00.000Z');
    expect(alice.locationId).toBe('clinic');
  });

  it('only returns busy slots as pinned (canceled and free filtered out)', async () => {
    await seedBaseline(db);
    await db.insert(slots).values([
      {
        id: 'busy-1',
        providerId: 'alice',
        locationId: 'clinic',
        serviceId: 'checkup',
        start: '2026-05-25T09:00:00.000Z',
        end: '2026-05-25T09:30:00.000Z',
        status: 'busy',
      },
      {
        id: 'canceled-1',
        providerId: 'bob',
        locationId: 'clinic',
        serviceId: 'checkup',
        start: '2026-05-25T10:00:00.000Z',
        end: '2026-05-25T10:30:00.000Z',
        status: 'canceled',
      },
      {
        id: 'free-1',
        providerId: 'alice',
        locationId: 'clinic',
        serviceId: 'consult',
        start: '2026-05-25T11:00:00.000Z',
        end: '2026-05-25T11:30:00.000Z',
        status: 'free',
      }
    ]);

    const ctx = await loadSchedulingContext(db);
    expect(ctx.pinnedSlots).toHaveLength(1);
    const [pin] = ctx.pinnedSlots;
    expect(pin!.id).toBe('busy-1');
    expect(pin!.status).toBe('busy');
  });
});

describe('applyAssignment', () => {
  let db: Database;
  beforeEach(async () => {
    db = await createDatabase();
    await applyMigrations(db);
    await seedBaseline(db);
  });

  it('inserts a busy slot from a candidate', async () => {
    const result = await applyAssignment(db, {
      providerId: 'alice' as ProviderId,
      locationId: 'clinic' as never,
      serviceId: 'checkup' as ServiceId,
      start: inst('2026-05-25T09:00:00.000Z'),
      end: inst('2026-05-25T09:30:00.000Z'),
    });
    expect(result.slot.id).toBeTruthy();
    expect(result.slot.status).toBe('busy');

    const dbSlot = await db
      .select()
      .from(slots)
      .where(eq(slots.id, result.slot.id));
    expect(dbSlot[0]?.providerId).toBe('alice');
    expect(dbSlot[0]?.status).toBe('busy');
  });

  it('produces distinct ids across successive calls', async () => {
    const a = await applyAssignment(db, {
      providerId: 'alice' as ProviderId,
      locationId: 'clinic' as never,
      serviceId: 'checkup' as ServiceId,
      start: inst('2026-05-25T09:00:00.000Z'),
      end: inst('2026-05-25T09:30:00.000Z'),
    });
    const b = await applyAssignment(db, {
      providerId: 'bob' as ProviderId,
      locationId: 'clinic' as never,
      serviceId: 'checkup' as ServiceId,
      start: inst('2026-05-25T09:30:00.000Z'),
      end: inst('2026-05-25T10:00:00.000Z'),
    });
    expect(a.slot.id).not.toBe(b.slot.id);
  });
});

describe('applyReshuffle', () => {
  let db: Database;
  beforeEach(async () => {
    db = await createDatabase();
    await applyMigrations(db);
    await seedBaseline(db);
  });

  it('creates only the new assignment when there are no moves', async () => {
    const proposal: ReshuffleProposal = {
      newAssignment: {
        providerId: 'alice' as ProviderId,
        slot: {
          providerId: 'alice' as ProviderId,
          locationId: 'clinic' as never,
          serviceId: 'checkup' as ServiceId,
          start: inst('2026-05-25T09:00:00.000Z'),
          end: inst('2026-05-25T09:30:00.000Z'),
        },
      },
      movedPins: [],
    };
    const applied = await applyReshuffle(db, proposal);
    expect(applied.movedBookings).toEqual([]);
    const allSlots = await db.select().from(slots);
    expect(allSlots).toHaveLength(1);
    expect(allSlots[0]?.status).toBe('busy');
  });

  it('round-trips a happy reshuffle end to end via proposeReshuffle', async () => {
    // Pin is Bob's CHECKUP at 9-9:30; new request is a CONSULT only Bob can do.
    await db.insert(slots).values({
      id: 'pin-bob-checkup',
      providerId: 'bob',
      locationId: 'clinic',
      serviceId: 'checkup',
      start: '2026-05-25T09:00:00.000Z',
      end: '2026-05-25T09:30:00.000Z',
      status: 'busy',
    });
    // Restrict consult qualification to Bob only.
    await db
      .delete(providerQualifications)
      .where(eq(providerQualifications.providerId, 'alice'));
    await db.insert(providerQualifications).values({
      providerId: 'alice',
      serviceId: 'checkup',
    });

    const ctx = await loadSchedulingContext(db);
    const req = request(
      'consult',
      '2026-05-25T09:00:00.000Z',
      '2026-05-25T09:30:00.000Z',
    );
    // pickSlot should fail (Bob is the only consult provider, pinned).
    expect(pickSlot(req, ctx)).toBeNull();

    const proposal = proposeReshuffle(req, ctx);
    expect(proposal).not.toBeNull();
    expect(proposal!.newAssignment.providerId).toBe('bob');
    expect(proposal!.movedPins).toHaveLength(1);
    expect(proposal!.movedPins[0]!.slotId).toBe('pin-bob-checkup');
    expect(proposal!.movedPins[0]!.toProviderId).toBe('alice');

    const applied = await applyReshuffle(db, proposal!);
    expect(applied.movedBookings).toHaveLength(1);
    expect(applied.movedBookings[0]!.canceledSlotId).toBe('pin-bob-checkup');

    // After apply: the original slot is canceled, plus a new busy slot
    // for Alice's checkup AND a new busy slot for Bob's consult.
    const reloaded = await loadSchedulingContext(db);
    expect(reloaded.pinnedSlots).toHaveLength(2); // both new busy slots
    const aliceCheckup = reloaded.pinnedSlots.find(
      (p) => p.providerId === 'alice' && p.serviceId === 'checkup',
    );
    const bobConsult = reloaded.pinnedSlots.find(
      (p) => p.providerId === 'bob' && p.serviceId === 'consult',
    );
    expect(aliceCheckup).toBeDefined();
    expect(bobConsult).toBeDefined();

    // Original slot is still in DB as canceled (append-only history).
    const allRows = await db.select().from(slots);
    expect(allRows).toHaveLength(3); // original-canceled + 2 new-busy
    const original = allRows.find((s) => s.id === 'pin-bob-checkup');
    expect(original?.status).toBe('canceled');
  });

  it('rolls back and throws when the proposal references a missing slot', async () => {
    const proposal: ReshuffleProposal = {
      newAssignment: {
        providerId: 'alice' as ProviderId,
        slot: {
          providerId: 'alice' as ProviderId,
          locationId: 'clinic' as never,
          serviceId: 'checkup' as ServiceId,
          start: inst('2026-05-25T09:00:00.000Z'),
          end: inst('2026-05-25T09:30:00.000Z'),
        },
      },
      movedPins: [
        {
          slotId: 'slot-ghost' as SlotId,
          fromProviderId: 'bob' as ProviderId,
          toProviderId: 'alice' as ProviderId,
        },
      ],
    };
    await expect(applyReshuffle(db, proposal)).rejects.toThrow(/slot-ghost/);
    // Nothing should have landed.
    const allRows = await db.select().from(slots);
    expect(allRows).toEqual([]);
  });
});

describe('cancelBooking', () => {
  let db: Database;
  beforeEach(async () => {
    db = await createDatabase();
    await applyMigrations(db);
    await seedBaseline(db);
  });

  it('sets the slot status to canceled but keeps the row', async () => {
    await db.insert(slots).values({
      id: 'slot-tocancel',
      providerId: 'alice',
      locationId: 'clinic',
      serviceId: 'checkup',
      start: '2026-05-25T09:00:00.000Z',
      end: '2026-05-25T09:30:00.000Z',
      status: 'busy',
    });

    await cancelBooking(db, 'slot-tocancel' as SlotId);

    const rows = await db
      .select()
      .from(slots)
      .where(eq(slots.id, 'slot-tocancel'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('canceled');
  });

  it('is a no-op for an unknown slot id', async () => {
    await expect(
      cancelBooking(db, 'slot-never-existed' as SlotId),
    ).resolves.toBeUndefined();
  });
});

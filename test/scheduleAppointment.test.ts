import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  applyMigrations,
  createDatabase,
  type Database,
} from '../src/db/client.js';
import { seedScenario } from '../src/db/seed.js';
import {
  locations,
  providerQualifications,
  providers,
  providerSchedules,
  services,
  slots,
} from '../src/db/schema.js';
import { scheduleAppointment } from '../src/scheduling/scheduleAppointment.js';
import type {
  BookingRequest,
  Instant,
  ServiceId,
} from '../src/model.js';

const FIXED_DATE = '2026-06-08';
const inst = (s: string): Instant => s as Instant;
const request = (
  serviceId: string,
  startHour: number,
  endHour: number,
): BookingRequest => ({
  serviceId: serviceId as ServiceId,
  window: {
    start: inst(`${FIXED_DATE}T${String(startHour).padStart(2, '0')}:00:00.000Z`),
    end: inst(`${FIXED_DATE}T${String(endHour).padStart(2, '0')}:00:00.000Z`),
  },
});

describe('scheduleAppointment against the seeded scenario', () => {
  let db: Database;
  beforeEach(async () => {
    db = await createDatabase();
    await applyMigrations(db);
    await seedScenario(db, { date: FIXED_DATE });
  });

  it('returns kind=direct when pickProvider succeeds (9am checkup → Hawkeye)', async () => {
    const result = await scheduleAppointment(db, request('checkup', 9, 10));
    expect(result.kind).toBe('direct');
    if (result.kind === 'direct') {
      expect(result.assignment.providerId).toBe('hawkeye');
      expect(result.assignment.slot.start).toBe(`${FIXED_DATE}T09:00:00.000Z`);
      expect(result.assignment.booking.id).toBeTruthy();
      expect(result.assignment.booking.status).toBe('busy');
    }
  });

  it('persists the new busy slot on the direct path', async () => {
    const before = await db
      .select()
      .from(slots)
      .where(eq(slots.status, 'busy'));
    await scheduleAppointment(db, request('checkup', 9, 10));
    const after = await db
      .select()
      .from(slots)
      .where(eq(slots.status, 'busy'));
    expect(after.length).toBe(before.length + 1);
  });

  it('returns kind=infeasible when no provider or reshuffle works (10am imaging)', async () => {
    const result = await scheduleAppointment(db, request('imaging', 10, 11));
    expect(result.kind).toBe('infeasible');
    // Nothing new persisted.
    const busyAfter = await db
      .select()
      .from(slots)
      .where(eq(slots.status, 'busy'));
    expect(busyAfter).toHaveLength(4);
  });
});

describe('scheduleAppointment in a reshuffle-needed scenario', () => {
  // Custom mini-fixture: Alice qualified for checkup only, Bob qualified
  // for both. Bob is pinned at 9–9:30 for a checkup. A tight-window
  // consult request at 9–9:30 can only be served by Bob; reshuffle moves
  // Bob's checkup pin to Alice so Bob is free for the new consult.
  let db: Database;
  beforeEach(async () => {
    db = await createDatabase();
    await applyMigrations(db);

    await db.insert(locations).values({ id: 'clinic', name: 'Clinic' });
    await db.insert(providers).values([
      { id: 'alice', name: 'Alice' },
      { id: 'bob', name: 'Bob' },
    ]);
    await db.insert(services).values([
      { id: 'checkup', name: 'Checkup', durationMinutes: 30, requiresRoom: false },
      { id: 'consult', name: 'Consult', durationMinutes: 30, requiresRoom: false },
    ]);
    await db.insert(providerQualifications).values([
      { providerId: 'alice', serviceId: 'checkup' },
      { providerId: 'bob', serviceId: 'checkup' },
      { providerId: 'bob', serviceId: 'consult' },
    ]);
    await db.insert(providerSchedules).values([
      {
        id: 'sched-alice',
        providerId: 'alice',
        locationId: 'clinic',
        start: `${FIXED_DATE}T08:00:00.000Z`,
        end: `${FIXED_DATE}T17:00:00.000Z`,
      },
      {
        id: 'sched-bob',
        providerId: 'bob',
        locationId: 'clinic',
        start: `${FIXED_DATE}T08:00:00.000Z`,
        end: `${FIXED_DATE}T17:00:00.000Z`,
      },
    ]);
    await db.insert(slots).values({
      id: 'pin-bob-9',
      providerId: 'bob',
      locationId: 'clinic',
      serviceId: 'checkup',
      start: `${FIXED_DATE}T09:00:00.000Z`,
      end: `${FIXED_DATE}T09:30:00.000Z`,
      status: 'busy',
    });
  });

  it('returns kind=proposal when reshuffle is needed; does NOT persist', async () => {
    const before = await db
      .select()
      .from(slots)
      .where(eq(slots.status, 'busy'));
    // Tight window so the only candidate is Bob 9-9:30 — wider would let
    // pickProvider land on Bob's later slot and bypass reshuffle.
    const tightRequest: BookingRequest = {
      serviceId: 'consult' as ServiceId,
      window: {
        start: inst(`${FIXED_DATE}T09:00:00.000Z`),
        end: inst(`${FIXED_DATE}T09:30:00.000Z`),
      },
    };
    const result = await scheduleAppointment(db, tightRequest);
    expect(result.kind).toBe('proposal');
    if (result.kind === 'proposal') {
      expect(result.proposal.newAssignment.providerId).toBe('bob');
      expect(result.proposal.movedPins).toHaveLength(1);
      expect(result.proposal.movedPins[0]!.fromProviderId).toBe('bob');
      expect(result.proposal.movedPins[0]!.toProviderId).toBe('alice');
      expect(result.proposal.movedPins[0]!.slotId).toBe('pin-bob-9');
    }
    const after = await db
      .select()
      .from(slots)
      .where(eq(slots.status, 'busy'));
    expect(after.length).toBe(before.length);
  });
});

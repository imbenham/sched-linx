import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  createDatabase,
  type Database,
} from '../src/db/client.js';
import { loadSchedulingContext } from '../src/db/repository.js';
import { seedScenario } from '../src/db/seed.js';
import { pickSlot } from '../src/scheduling/pickSlot.js';
import { proposeReshuffle } from '../src/scheduling/proposeReshuffle.js';
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

describe('seedScenario', () => {
  let db: Database;
  beforeEach(async () => {
    db = await createDatabase();
    await applyMigrations(db);
  });

  it('populates the scenario into an empty database', async () => {
    await seedScenario(db, { date: FIXED_DATE });
    const ctx = await loadSchedulingContext(db);
    expect(ctx.services).toHaveLength(3);
    // 6 base qualifications + Hauser/imaging (added when useRooms=true).
    expect(ctx.qualifications).toHaveLength(7);
    // 3 base schedules + Hauser's morning shift.
    expect(ctx.schedules).toHaveLength(4);
    expect(ctx.pinnedSlots).toHaveLength(4);
    expect(ctx.rooms).toHaveLength(2);
    expect(ctx.servicesRoomRequirements).toHaveLength(1);
  });

  it('is idempotent — reseeding wipes and repopulates', async () => {
    await seedScenario(db, { date: FIXED_DATE });
    const first = await loadSchedulingContext(db);
    await seedScenario(db, { date: FIXED_DATE });
    const second = await loadSchedulingContext(db);
    expect(second.services).toEqual(first.services);
    expect(second.qualifications).toEqual(first.qualifications);
    expect(second.pinnedSlots).toHaveLength(first.pinnedSlots.length);
  });

  it('produces a scenario where 10am imaging is infeasible (Carol is pinned)', async () => {
    await seedScenario(db, { date: FIXED_DATE });
    const ctx = await loadSchedulingContext(db);
    // Carol is the only imaging-qualified provider and she's pinned at
    // 10:00; a new imaging request for 10–11 should have no candidate.
    const result = pickSlot(request('imaging', 10, 11), ctx);
    expect(result).toBeNull();
    // Even reshuffle can't help — there are no alternative imaging
    // providers to move Carol to.
    expect(proposeReshuffle(request('imaging', 10, 11), ctx)).toBeNull();
  });

  it('produces a scenario where 9am checkup picks Hawkeye (Nick is pinned)', async () => {
    await seedScenario(db, { date: FIXED_DATE });
    const ctx = await loadSchedulingContext(db);
    // Nick has the 9am checkup pin; Hawkeye is qualified for checkup and
    // is free. Picker should land on Hawkeye 9:00.
    const result = pickSlot(request('checkup', 9, 10), ctx);
    expect(result).not.toBeNull();
    expect(result!.providerId).toBe('hawkeye');
    expect(result!.slot.start).toBe(`${FIXED_DATE}T09:00:00.000Z`);
  });
});

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  createDatabase,
  type Database,
} from '../src/db/client.js';
import {
  providers,
  providerQualifications,
  providerSchedules,
  services,
  slots,
  locations,
} from '../src/db/schema.js';

describe('db setup', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createDatabase();
    await applyMigrations(db);
  });

  it('round-trips a provider through insert and select', async () => {
    await db.insert(providers).values({ id: 'alice', name: 'Alice' });
    const rows = await db.select().from(providers);
    expect(rows).toEqual([{ id: 'alice', name: 'Alice', tag: null }]);
  });

  it('supports the full entity graph with foreign keys', async () => {
    // Walk through every table in insertion order to validate the FK
    // graph and column shapes against the generated migration. Patients
    // and appointments were removed when the model collapsed to
    // slot-as-booking; the slot's status column carries the lifecycle.
    await db.insert(providers).values({ id: 'alice', name: 'Alice' });
    await db
      .insert(services)
      .values({ id: 'checkup', name: 'Checkup', durationMinutes: 30 });
    await db.insert(locations).values({ id: 'clinic', name: 'Main Clinic' });

    await db
      .insert(providerQualifications)
      .values({ providerId: 'alice', serviceId: 'checkup' });
    await db.insert(providerSchedules).values({
      id: 'sched-1',
      providerId: 'alice',
      locationId: 'clinic',
      start: '2026-05-25T09:00:00.000Z',
      end: '2026-05-25T17:00:00.000Z',
    });
    await db.insert(slots).values({
      id: 'slot-1',
      providerId: 'alice',
      locationId: 'clinic',
      serviceId: 'checkup',
      start: '2026-05-25T09:00:00.000Z',
      end: '2026-05-25T09:30:00.000Z',
      status: 'busy',
    });

    const slot = await db.select().from(slots).where(eq(slots.id, 'slot-1'));
    expect(slot[0]?.start).toBe('2026-05-25T09:00:00.000Z');
    expect(slot[0]?.end).toBe('2026-05-25T09:30:00.000Z');
    expect(slot[0]?.status).toBe('busy');
  });

  it('enforces foreign-key integrity', async () => {
    // Slot must reference an existing provider, location, and service.
    await expect(
      db.insert(slots).values({
        id: 'slot-bad',
        providerId: 'ghost-provider',
        locationId: 'ghost-location',
        serviceId: 'ghost-service',
        start: '2026-05-25T09:00:00.000Z',
        end: '2026-05-25T09:30:00.000Z',
      }),
    ).rejects.toThrow();
  });

  it('enforces composite primary key on provider_qualifications', async () => {
    await db.insert(providers).values({ id: 'alice', name: 'Alice' });
    await db
      .insert(services)
      .values({ id: 'checkup', name: 'Checkup', durationMinutes: 30 });
    await db
      .insert(providerQualifications)
      .values({ providerId: 'alice', serviceId: 'checkup' });
    await expect(
      db
        .insert(providerQualifications)
        .values({ providerId: 'alice', serviceId: 'checkup' }),
    ).rejects.toThrow();
  });
});

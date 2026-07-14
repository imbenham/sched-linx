import { eq, asc } from 'drizzle-orm';
import { getDatabase } from '@/src/db/client';
import { locations, locationSchedules, services } from '@/src/db/schema';
import { seedUrgentCareScenario } from '@/src/db/seed';
import { getVisitorTag } from '@/src/visitor';
import { Calendar } from '@/app/_components/Calendar';
import type { Location, LocationId, Service, ServiceId } from '@/src/model';

export const dynamic = 'force-dynamic';

const SCENARIO_BASE = 'scenario4';

export default async function Scenario4() {
  const SCENARIO_TAG = await getVisitorTag(SCENARIO_BASE);
  const db = await getDatabase();

  // Seed only when this scenario's data is missing.
  const existing = await db
    .select()
    .from(locations)
    .where(eq(locations.tag, SCENARIO_TAG));
  if (existing.length === 0) {
    await seedUrgentCareScenario(db, { tag: SCENARIO_TAG });
  }

  const [allServices, allLocationSchedules, allLocations] = await Promise.all([
    db.select().from(services).where(eq(services.tag, SCENARIO_TAG)),
    db
      .select()
      .from(locationSchedules)
      .where(eq(locationSchedules.tag, SCENARIO_TAG))
      .orderBy(asc(locationSchedules.start)),
    db.select().from(locations).where(eq(locations.tag, SCENARIO_TAG)),
  ]);

  const formatHHMM = (iso: string) => iso.slice(11, 16);

  // Anchor the calendar to the seed's date. Location schedules are the
  // source of truth here rather than provider schedules.
  const locationRow = existing[0] ?? (
    await db
      .select()
      .from(locations)
      .where(eq(locations.tag, SCENARIO_TAG))
  )[0];

  // Derive the date from any seeded pin (or fall back to today). The
  // seed writes at `at(hour)` so the ISO string's date portion matches
  // the seed's `date` option.
  const allSlots = await db.query.slots.findMany({
    where: eq((await import('@/src/db/schema')).slots.tag, SCENARIO_TAG),
    limit: 1,
  });
  const calendarDate =
    allSlots[0]?.start.slice(0, 10) ??
    new Date().toISOString().slice(0, 10);

  return (
    <article className="prose prose-slate lg:prose-lg">
      <h1>Scenario 4 — pure urgent care (location-scheduled)</h1>
      <p className="my-2 max-w-3xl">
        A walk-in clinic paradigm. There are no scheduled providers, no
        rooms modeled, and no per-slot assignment logic. Instead, the
        location has a nominal <em>concurrent capacity</em> (how many
        simultaneous visits the front desk will accept at once), and
        availability is a direct count against pinned bookings — the
        entire scheduling calculus fits on one axis.
      </p>
      <p className="my-2 max-w-3xl">
        This is the smallest sched-linx scenario, and deliberately so.
        The interesting bit is what <em>doesn't</em> happen — no matrix
        cover, no reshuffle, no provider iteration. When capacity is the
        only real constraint, a linear count is the right tool.
        Scenario 5 is where the substrate earns its keep, when urgent
        care shares physical rooms with provider-based specialty visits.
      </p>
      <p className="my-2 max-w-3xl">
        This seed also demonstrates the <em>booking cadence</em>{' '}
        primitive: the urgent care service has a 15-minute duration but
        a 10-minute cadence, letting six starts happen per hour with
        peak concurrency of two. "1.5 average concurrent patients" —
        the KPI a practice manager might quote — falls out as an
        emergent average of duration ÷ cadence; the scheduler only ever
        enforces the integer concurrent-capacity ceiling and the
        cadence-aligned start positions.
      </p>
      <p className="my-2 max-w-3xl">
        Notice the fully-booked bands (10:00 and 14:00 are engineered
        to hit or exceed capacity in the seed — clicking there should
        surface an <em>infeasible</em> result).
      </p>

      <details className="my-2">
        <summary className="cursor-pointer text-sm text-gray-700">
          Location details (reference)
        </summary>
        <table className="table-auto border-collapse border border-gray-400 mt-2">
          <thead>
            <tr>
              <th className="border border-gray-300 px-4 py-2 text-left">Field</th>
              <th className="border border-gray-300 px-4 py-2 text-left">Value</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border border-gray-300 px-4 py-2">Location</td>
              <td className="border border-gray-300 px-4 py-2">
                {locationRow?.name ?? '—'}
              </td>
            </tr>
            <tr>
              <td className="border border-gray-300 px-4 py-2">Shifts</td>
              <td className="border border-gray-300 px-4 py-2">
                <ul className="list-disc list-inside">
                  {allLocationSchedules.map((ls) => (
                    <li key={ls.id}>
                      {formatHHMM(ls.start)}–{formatHHMM(ls.end)} · capacity{' '}
                      {ls.capacity ?? '—'}
                    </li>
                  ))}
                </ul>
              </td>
            </tr>
            <tr>
              <td className="border border-gray-300 px-4 py-2">Service</td>
              <td className="border border-gray-300 px-4 py-2">
                {allServices[0]?.name} (
                duration={allServices[0]?.durationMinutes} min,
                {' '}
                cadence={allServices[0]?.bookingCadenceMinutes ?? '—'} min,
                {' '}
                requiresProvider={String(allServices[0]?.requiresProvider)},
                {' '}
                requiresRoom={String(allServices[0]?.requiresRoom)})
              </td>
            </tr>
          </tbody>
        </table>
      </details>

      <Calendar
        scenarioTag={SCENARIO_TAG}
        initialDate={calendarDate}
        initialMode="anonymous"
        services={allServices.map(
          (s): Service => ({
            id: s.id,
            name: s.name,
            durationMinutes: s.durationMinutes,
            requiresProvider: s.requiresProvider,
            requiresRoom: s.requiresRoom,
            bookingCadenceMinutes: s.bookingCadenceMinutes ?? undefined,
          }),
        )}
        providers={[]}
        qualifications={[]}
        locations={allLocations.map(
          (l): Location => ({
            id: l.id,
            name: l.name,
            timezone: l.timezone ?? undefined,
          }),
        )}
      />
    </article>
  );
}

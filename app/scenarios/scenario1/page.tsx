import { eq } from 'drizzle-orm';
import { getDatabase } from '@/src/db/client';
import {
  providers,
  providerQualifications,
  providerSchedules,
  services,
} from '@/src/db/schema';
import { seedScenario } from '@/src/db/seed';
import { getVisitorTag } from '@/src/visitor';
import { Calendar } from '@/app/_components/Calendar';
import type {
  Provider,
  ProviderId,
  ProviderQualification,
  Service,
  ServiceId,
} from '@/src/model';

// Each scenario page reads live DB state per render — prerendering it
// makes no sense (every render is unique) and forces pglite to boot
// during the build pipeline, which can crash under concurrent build
// workers / when the dev server is also holding the local-db lock.
export const dynamic = 'force-dynamic';

const SCENARIO_BASE = 'scenario1';

export default async function Scenario1() {
  // Per-visitor tag so one visitor's booking doesn't pollute another's
  // view. Middleware guarantees the cookie exists by the time we get here.
  const SCENARIO_TAG = await getVisitorTag(SCENARIO_BASE);
  const db = await getDatabase();

  // Seed only if this scenario's data is missing — otherwise every render
  // would wipe any booking the user just created. Other scenarios' data
  // is unaffected (the seed is tag-scoped).
  const existing = await db
    .select()
    .from(providers)
    .where(eq(providers.tag, SCENARIO_TAG));
  if (existing.length === 0) {
    await seedScenario(db, { tag: SCENARIO_TAG, useRooms: false });
  }

  const [allServices, allProviders, allSchedules, allQualifications, providersWithDetails] =
    await Promise.all([
      db.select().from(services).where(eq(services.tag, SCENARIO_TAG)),
      db.select().from(providers).where(eq(providers.tag, SCENARIO_TAG)),
      db.select().from(providerSchedules).where(eq(providerSchedules.tag, SCENARIO_TAG)),
      db.select().from(providerQualifications).where(eq(providerQualifications.tag, SCENARIO_TAG)),
      db.query.providers.findMany({
        where: eq(providers.tag, SCENARIO_TAG),
        with: { qualifications: { with: { service: true } } },
      }),
    ]);

  // Anchor the calendar to whatever date the schedule data lives on,
  // not "today" — otherwise the grid silently drifts past the seed once
  // UTC midnight rolls over and every cell renders as out-of-schedule.
  const calendarDate =
    allSchedules[0]?.start.slice(0, 10) ??
    new Date().toISOString().slice(0, 10);

  return (
    <article className="prose prose-slate lg:prose-lg">
      <h1>Scenario 1 — three-provider practice (no rooms)</h1>
      <p className="my-2 max-w-3xl">
        In this scenario, a simple 3-provider practice offers 3 service
        types. Each provider is qualified for some services but not all,
        and each works the main clinic 8am–5pm UTC. No room constraints
        are modeled — services are eligible for any qualified provider
        whose schedule covers the requested time.
      </p>
      <p className="my-2 max-w-3xl">
        By "anonymous booking" I mean a flow that derives appointment
        windows from provider availability but doesn't surface which
        provider backs which slot. The patient picks a time; the system
        silently assigns the provider when the booking is made. This is
        common for urgent care and consumer-facing booking flows where
        speed beats provider choice.
      </p>
      <p className="my-2 max-w-3xl">
        "Known provider" surfaces the underlying provider for each cell —
        OneMedical is the well-known example. The same scheduling logic
        backs both; the differentiation is purely presentational. Toggle
        between modes to see the same constraint set rendered two ways.
      </p>
      <p className="my-2 max-w-3xl">
        Pick a service, then click an open (green) cell to book it — or
        click the × on a busy (rose) cell to cancel.
      </p>

      <details className="my-2">
        <summary className="cursor-pointer text-sm text-gray-700">
          Provider qualifications (reference)
        </summary>
        <table className="table-auto border-collapse border border-gray-400 mt-2">
          <thead>
            <tr>
              <th className="border border-gray-300 px-4 py-2">Provider</th>
              {allServices.map((service) => (
                <th key={service.id} className="border border-gray-300 px-4 py-2">
                  {service.name} ({service.durationMinutes} min)
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {providersWithDetails.map((row) => (
              <tr key={row.id}>
                <td className="border border-gray-300 px-4 py-2">{row.name}</td>
                {allServices.map((service) => (
                  <td
                    key={service.id}
                    className="border border-gray-300 px-4 py-2 text-center"
                  >
                    <input
                      type="checkbox"
                      checked={row.qualifications.some(
                        (q) => q.service?.id === service.id,
                      )}
                      readOnly
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <Calendar
        scenarioTag={SCENARIO_TAG}
        initialDate={calendarDate}
        services={allServices.map(
          (s): Service => ({
            id: s.id as ServiceId,
            name: s.name,
            durationMinutes: s.durationMinutes,
            requiresProvider: s.requiresProvider,
            requiresRoom: s.requiresRoom,
            bookingCadenceMinutes: s.bookingCadenceMinutes ?? undefined,
          }),
        )}
        providers={allProviders.map(
          (p): Provider => ({
            id: p.id as ProviderId,
            name: p.name,
          }),
        )}
        qualifications={allQualifications.map(
          (q): ProviderQualification => ({
            providerId: q.providerId as ProviderId,
            serviceId: q.serviceId as ServiceId,
          }),
        )}
      />
    </article>
  );
}

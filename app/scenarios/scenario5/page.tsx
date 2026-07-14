import { eq } from 'drizzle-orm';
import { getDatabase } from '@/src/db/client';
import {
  locations,
  locationSchedules,
  providers,
  providerQualifications,
  rooms,
  services,
  slots,
} from '@/src/db/schema';
import { seedMixedScenario } from '@/src/db/seed';
import { getVisitorTag } from '@/src/visitor';
import { Calendar } from '@/app/_components/Calendar';
import type {
  Location,
  LocationId,
  Provider,
  ProviderId,
  ProviderQualification,
  Room,
  RoomId,
  Service,
  ServiceId,
} from '@/src/model';

export const dynamic = 'force-dynamic';

const SCENARIO_BASE = 'scenario5';

export default async function Scenario5() {
  const SCENARIO_TAG = await getVisitorTag(SCENARIO_BASE);
  const db = await getDatabase();

  const existing = await db
    .select()
    .from(locations)
    .where(eq(locations.tag, SCENARIO_TAG));
  if (existing.length === 0) {
    await seedMixedScenario(db, { tag: SCENARIO_TAG });
  }

  const [
    allServices,
    allProviders,
    allRooms,
    allQualifications,
    providersWithDetails,
    anySlot,
    allLocations,
    allLocationSchedules,
  ] = await Promise.all([
    db.select().from(services).where(eq(services.tag, SCENARIO_TAG)),
    db.select().from(providers).where(eq(providers.tag, SCENARIO_TAG)),
    db.select().from(rooms).where(eq(rooms.tag, SCENARIO_TAG)),
    db.select().from(providerQualifications).where(eq(providerQualifications.tag, SCENARIO_TAG)),
    db.query.providers.findMany({
      where: eq(providers.tag, SCENARIO_TAG),
      with: { qualifications: { with: { service: true } } },
    }),
    db
      .select()
      .from(slots)
      .where(eq(slots.tag, SCENARIO_TAG))
      .limit(1),
    db
      .select()
      .from(locations)
      .where(eq(locations.tag, SCENARIO_TAG)),
    db
      .select()
      .from(locationSchedules)
      .where(eq(locationSchedules.tag, SCENARIO_TAG)),
  ]);

  const calendarDate =
    anySlot[0]?.start.slice(0, 10) ??
    new Date().toISOString().slice(0, 10);

  return (
    <article className="prose prose-slate lg:prose-lg">
      <h1>Scenario 5 — mixed practice (urgent care + specialty sharing rooms)</h1>
      <p className="my-2 max-w-3xl">
        The compelling case for the substrate. A single practice offers
        both walk-in urgent care <em>and</em> scheduled specialty visits.
        Urgent care is location-scheduled (no assigned provider, gated
        by capacity + room availability); specialty is provider-scheduled
        (matrix picks a qualified provider whose schedule and room fit).
        Two paradigms, one shared physical room pool.
      </p>
      <p className="my-2 max-w-3xl">
        The interesting story: <strong>rooms link the two paradigms</strong>.
        Urgent care is eligible for both dedicated urgent-care rooms
        <em>and</em> shared exam rooms. Specialty consults use only the
        exam rooms. When specialty is holding an exam room, the effective
        urgent care capacity drops even though the nominal number hasn't
        changed. That contention gets caught because both paths speak the
        same "is this room busy in this window?" language.
      </p>
      <p className="my-2 max-w-3xl">
        Try selecting the urgent care service and looking at 10:15 — the
        seed has three urgent walk-ins already holding all urgent-care-
        eligible rooms while both exam rooms are held by 10:00-consults.
        Every eligible room is taken, so a new urgent walk-in for 10:15
        should surface as infeasible. Then switch to a specialty consult
        and observe that 11am works — the earlier exam-room holds have
        just ended.
      </p>
      <p className="my-2 max-w-3xl">
        Provider-scheduled services (Consult, Imaging) support the
        known-provider mode too — you can toggle to see how the same
        constraint set renders per-provider.
      </p>

      <details className="my-2">
        <summary className="cursor-pointer text-sm text-gray-700">
          Practice at a glance (reference)
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
                {allLocations[0]?.name}
                {allLocationSchedules.length > 0 && (
                  <span>
                    {' '}(nominal capacity{' '}
                    {allLocationSchedules[0]?.capacity ?? '—'})
                  </span>
                )}
              </td>
            </tr>
            <tr>
              <td className="border border-gray-300 px-4 py-2">Rooms</td>
              <td className="border border-gray-300 px-4 py-2">
                {allRooms
                  .map((r) => `${r.name} (${r.type})`)
                  .join(', ')}
              </td>
            </tr>
            <tr>
              <td className="border border-gray-300 px-4 py-2">Services</td>
              <td className="border border-gray-300 px-4 py-2">
                <ul className="list-disc list-inside">
                  {allServices.map((s) => (
                    <li key={s.id}>
                      <strong>{s.name}</strong> ({s.durationMinutes} min,{' '}
                      {s.requiresProvider ? 'provider-scheduled' : 'location-scheduled'}
                      )
                    </li>
                  ))}
                </ul>
              </td>
            </tr>
          </tbody>
        </table>
      </details>

      <details className="my-2">
        <summary className="cursor-pointer text-sm text-gray-700">
          Specialty provider qualifications (reference)
        </summary>
        <table className="table-auto border-collapse border border-gray-400 mt-2">
          <thead>
            <tr>
              <th className="border border-gray-300 px-4 py-2">Provider</th>
              {allServices
                .filter((s) => s.requiresProvider)
                .map((service) => (
                  <th key={service.id} className="border border-gray-300 px-4 py-2">
                    {service.name}
                  </th>
                ))}
            </tr>
          </thead>
          <tbody>
            {providersWithDetails.map((row) => (
              <tr key={row.id}>
                <td className="border border-gray-300 px-4 py-2">{row.name}</td>
                {allServices
                  .filter((s) => s.requiresProvider)
                  .map((service) => (
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
        providers={allProviders.map(
          (p): Provider => ({
            id: p.id,
            name: p.name,
          }),
        )}
        qualifications={allQualifications.map(
          (q): ProviderQualification => ({
            providerId: q.providerId,
            serviceId: q.serviceId,
          }),
        )}
        rooms={allRooms.map(
          (r): Room => ({
            id: r.id,
            name: r.name,
            locationId: r.locationId,
            type: r.type,
          }),
        )}
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

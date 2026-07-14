import { eq } from 'drizzle-orm';
import { getDatabase } from '@/src/db/client';
import {
  providers,
  providerQualifications,
  providerSchedules,
  rooms,
  services,
  servicesRoomRequirements,
} from '@/src/db/schema';
import { seedMixedModalityScenario } from '@/src/db/seed';
import { getVisitorTag } from '@/src/visitor';
import { Calendar } from '@/app/_components/Calendar';
import type {
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

const SCENARIO_BASE = 'scenario3';

export default async function Scenario3() {
  const SCENARIO_TAG = await getVisitorTag(SCENARIO_BASE);
  const db = await getDatabase();

  const existing = await db
    .select()
    .from(providers)
    .where(eq(providers.tag, SCENARIO_TAG));
  if (existing.length === 0) {
    await seedMixedModalityScenario(db, { tag: SCENARIO_TAG });
  }

  const [
    allServices,
    allProviders,
    allSchedules,
    allQualifications,
    allRooms,
    allRoomRequirements,
    providersWithDetails,
  ] = await Promise.all([
    db.select().from(services).where(eq(services.tag, SCENARIO_TAG)),
    db.select().from(providers).where(eq(providers.tag, SCENARIO_TAG)),
    db.select().from(providerSchedules).where(eq(providerSchedules.tag, SCENARIO_TAG)),
    db.select().from(providerQualifications).where(eq(providerQualifications.tag, SCENARIO_TAG)),
    db.select().from(rooms).where(eq(rooms.tag, SCENARIO_TAG)),
    db.select().from(servicesRoomRequirements).where(eq(servicesRoomRequirements.tag, SCENARIO_TAG)),
    db.query.providers.findMany({
      where: eq(providers.tag, SCENARIO_TAG),
      with: { qualifications: { with: { service: true } } },
    }),
  ]);

  const calendarDate =
    allSchedules[0]?.start.slice(0, 10) ??
    new Date().toISOString().slice(0, 10);

  const roomReqsByService = new Map<string, string[]>();
  for (const rr of allRoomRequirements) {
    const prior = roomReqsByService.get(rr.serviceId) ?? [];
    prior.push(rr.roomType);
    roomReqsByService.set(rr.serviceId, prior);
  }

  return (
    <article className="prose prose-slate lg:prose-lg">
      <h1>Scenario 3 — mixed-modality practice (telehealth + in-person)</h1>
      <p className="my-2 max-w-3xl">
        A primary care practice that offers both <em>video visits</em> and{' '}
        <em>office visits</em>. Every provider can handle either — the split
        isn't "who does what," it's "what does the service need." Video
        visits require only a provider; office visits require a provider{' '}
        <em>and</em> an exam room. Same DLX substrate, one axis toggled.
      </p>
      <p className="my-2 max-w-3xl">
        The interesting story lands at <strong>11:00</strong>: the seed pins
        Dr. Hibbert and Dr. Crusher into office visits that occupy both exam
        rooms. An office visit at 11:00 becomes infeasible — Dr. Cox is
        free, but there's no room for him to see a patient in person. Switch
        to Video visit and 11:00 with Dr. Cox books immediately. Rooms
        constrain in-person delivery; telehealth is unaffected because the
        service declares it doesn't need one.
      </p>
      <p className="my-2 max-w-3xl">
        Under the hood, the matrix builder emits room-column rows for
        services with <code>requiresRoom=true</code> and skips them for
        <code>requiresRoom=false</code>. The scheduler doesn't know or care
        which service is "telehealth" — delivery mode is entirely a
        property expressed through the primitives.
      </p>
      <p className="my-2 max-w-3xl">
        Pick a service, then click an open (green) cell to book — or click
        the × on a busy (rose) cell to cancel and watch the constraint
        landscape shift.
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

      <details className="my-2">
        <summary className="cursor-pointer text-sm text-gray-700">
          Rooms and service requirements (reference)
        </summary>
        <div className="mt-2 grid gap-4 md:grid-cols-2">
          <table className="table-auto border-collapse border border-gray-400">
            <thead>
              <tr>
                <th className="border border-gray-300 px-4 py-2 text-left">Room</th>
                <th className="border border-gray-300 px-4 py-2 text-left">Type</th>
              </tr>
            </thead>
            <tbody>
              {allRooms.map((r) => (
                <tr key={r.id}>
                  <td className="border border-gray-300 px-4 py-2">{r.name}</td>
                  <td className="border border-gray-300 px-4 py-2">{r.type}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="table-auto border-collapse border border-gray-400">
            <thead>
              <tr>
                <th className="border border-gray-300 px-4 py-2 text-left">Service</th>
                <th className="border border-gray-300 px-4 py-2 text-left">
                  Requires room
                </th>
                <th className="border border-gray-300 px-4 py-2 text-left">
                  Eligible room types
                </th>
              </tr>
            </thead>
            <tbody>
              {allServices.map((s) => {
                const types = roomReqsByService.get(s.id);
                return (
                  <tr key={s.id}>
                    <td className="border border-gray-300 px-4 py-2">{s.name}</td>
                    <td className="border border-gray-300 px-4 py-2">
                      {s.requiresRoom ? 'yes' : 'no'}
                    </td>
                    <td className="border border-gray-300 px-4 py-2">
                      {types && types.length > 0 ? types.join(', ') : '— any —'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>

      <Calendar
        scenarioTag={SCENARIO_TAG}
        initialDate={calendarDate}
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
      />
    </article>
  );
}

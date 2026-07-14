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
import { seedScenario } from '@/src/db/seed';
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

const SCENARIO_BASE = 'scenario2';

export default async function Scenario2() {
  const SCENARIO_TAG = await getVisitorTag(SCENARIO_BASE);
  const db = await getDatabase();

  const existing = await db
    .select()
    .from(providers)
    .where(eq(providers.tag, SCENARIO_TAG));
  if (existing.length === 0) {
    await seedScenario(db, { tag: SCENARIO_TAG, useRooms: true });
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

  // Map serviceId → list of eligible room-type strings, for the
  // requirements table below the qualifications block.
  const roomReqsByService = new Map<string, string[]>();
  for (const rr of allRoomRequirements) {
    const prior = roomReqsByService.get(rr.serviceId) ?? [];
    prior.push(rr.roomType);
    roomReqsByService.set(rr.serviceId, prior);
  }

  return (
    <article className="prose prose-slate lg:prose-lg">
      <h1>Scenario 2 — practice with room constraints</h1>
      <p className="my-2 max-w-3xl">
        Similar to scenario 1, but the practice now models
        physical rooms as a scheduling constraint. The clinic has one
        exam room and one imaging room; the imaging service requires the
        imaging room specifically, while checkup and consult don't care
        about room type (and in this seed, are configured as not requiring
        a room at all). To demonstrate the room constraint, a new provider
        with imaging qualifications is added. Book an imaging appointment
        with either imaging provider and you'll see the room constraint in action: a
        parallel unavailable chunk will appear in the other provider's column, 
        capturing the fact that the imaging room is already in use.
      </p>
      <p className="my-2 max-w-3xl">
      </p>
      <p className="my-2 max-w-3xl">
        The interesting bit: the room constraint is enforced by adding a
        second axis to the same DLX matrix that already enforces provider
        intervals — no algorithm changes. A booking that allocates a room
        prevents any other booking from claiming that room at an
        overlapping time, in the same way that a busy provider prevents
        another booking from using the same provider in an overlap.
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

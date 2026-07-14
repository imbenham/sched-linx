// Post-commit view for an agentic-onboarding scenario. Renders the same
// Calendar component the hand-authored scenarios use, scoped to the
// setup's tag. Generic over what the model actually recorded: pure
// urgent-care, pure specialty, or mixed.

import { eq, asc } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDatabase } from '@/src/db/client';
import {
  agenticSetups,
  locations,
  locationSchedules,
  providers,
  providerQualifications,
  rooms,
  services,
  slots,
} from '@/src/db/schema';
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

interface PageProps {
  params: Promise<{ tag: string }>;
}

export default async function AgenticScenario({ params }: PageProps) {
  const { tag } = await params;
  const db = await getDatabase();

  const [setup] = await db
    .select()
    .from(agenticSetups)
    .where(eq(agenticSetups.tag, tag));
  if (!setup) notFound();

  const [
    allServices,
    allProviders,
    allRooms,
    allQualifications,
    allLocations,
    allLocationSchedules,
    firstSlot,
  ] = await Promise.all([
    db.select().from(services).where(eq(services.tag, tag)),
    db.select().from(providers).where(eq(providers.tag, tag)),
    db.select().from(rooms).where(eq(rooms.tag, tag)),
    db.select().from(providerQualifications).where(eq(providerQualifications.tag, tag)),
    db.select().from(locations).where(eq(locations.tag, tag)),
    db
      .select()
      .from(locationSchedules)
      .where(eq(locationSchedules.tag, tag))
      .orderBy(asc(locationSchedules.start)),
    db.select().from(slots).where(eq(slots.tag, tag)).limit(1),
  ]);

  // If the model recorded location schedules, that's the anchor date;
  // else the first pinned slot; else today. All three fall through to
  // the calendar's date picker anyway.
  const calendarDate =
    allLocationSchedules[0]?.start.slice(0, 10) ??
    firstSlot[0]?.start.slice(0, 10) ??
    new Date().toISOString().slice(0, 10);

  // Open on anonymous mode when the scenario has any location-scheduled
  // service — otherwise the known-provider view is more natural.
  const anyLocationScheduled = allServices.some((s) => !s.requiresProvider);
  const initialMode: 'known' | 'anonymous' = anyLocationScheduled
    ? 'anonymous'
    : 'known';

  return (
    <article className="prose prose-slate lg:prose-lg">
      <div className="not-prose mb-4">
        <Link
          href={`/agentic-onboarding/${setup.id}`}
          className="text-sm text-blue-700 hover:underline"
        >
          ← Back to onboarding session
        </Link>
      </div>

      <h1>{setup.title ?? 'Agentic scenario'}</h1>
      {setup.useCaseSummary && (
        <p className="my-2 max-w-3xl">{setup.useCaseSummary}</p>
      )}
      <p className="text-sm text-zinc-600 not-prose font-mono">
        Committed from onboarding session {setup.id.slice(0, 8)} · tag:{' '}
        <span className="font-mono">{tag}</span>
      </p>

      <Calendar
        scenarioTag={tag}
        initialDate={calendarDate}
        initialMode={initialMode}
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
        rooms={allRooms.map(
          (r): Room => ({
            id: r.id as RoomId,
            name: r.name,
            locationId: r.locationId as LocationId,
            type: r.type,
          }),
        )}
        locations={allLocations.map(
          (l): Location => ({
            id: l.id as LocationId,
            name: l.name,
            timezone: l.timezone ?? undefined,
          }),
        )}
      />
    </article>
  );
}

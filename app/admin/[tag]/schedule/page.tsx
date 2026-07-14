// Admin schedule editor — the working surface for a practice manager
// after an agentic setup has been committed. Loads all schedule-adjacent
// data for a scenario tag and hands it to the client editor, which owns
// the day-of-week UI and dispatches to the save actions.

import { asc, eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDatabase } from '@/src/db/client';
import {
  agenticSetups,
  locationSchedules,
  locations as locationsTable,
  providers,
  providerSchedules,
  services,
} from '@/src/db/schema';
import { ScheduleEditor } from './_components/ScheduleEditor';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ tag: string }>;
}

export default async function AdminScheduleEditor({ params }: PageProps) {
  const { tag } = await params;
  const db = await getDatabase();

  const [setup] = await db
    .select()
    .from(agenticSetups)
    .where(eq(agenticSetups.tag, tag));
  if (!setup) notFound();

  const [
    allLocations,
    allProviders,
    allServices,
    allLocSchedules,
    allProviderSchedules,
  ] = await Promise.all([
    db
      .select()
      .from(locationsTable)
      .where(eq(locationsTable.tag, tag))
      .orderBy(asc(locationsTable.name)),
    db
      .select()
      .from(providers)
      .where(eq(providers.tag, tag))
      .orderBy(asc(providers.name)),
    db.select().from(services).where(eq(services.tag, tag)),
    db
      .select()
      .from(locationSchedules)
      .where(eq(locationSchedules.tag, tag))
      .orderBy(asc(locationSchedules.start)),
    db
      .select()
      .from(providerSchedules)
      .where(eq(providerSchedules.tag, tag))
      .orderBy(asc(providerSchedules.start)),
  ]);

  // Which sections of the editor are meaningful for this scenario:
  // location capacity only matters when a service actually books
  // against it (requiresProvider=false); provider shifts only matter
  // when at least one service is provider-scheduled AND providers
  // exist. Signals flow from the recorded services rather than from
  // whether schedule rows happen to exist.
  const showLocationCapacity = allServices.some((s) => !s.requiresProvider);
  const showProviderShifts =
    allProviders.length > 0 && allServices.some((s) => s.requiresProvider);

  return (
    <article className="max-w-5xl">
      <div className="mb-4 text-sm text-blue-700">
        <Link
          href={`/agentic-onboarding/${setup.id}`}
          className="hover:underline"
        >
          ← Back to onboarding session
        </Link>
      </div>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold">
          {setup.title ?? 'Schedule editor'}
        </h1>
        <p className="text-sm text-zinc-600 mt-1">
          Adjust location and provider schedules for this scenario. Changes are
          saved directly to the scenario's data — the calendar reflects them
          on next load.
        </p>
        <div className="mt-2 text-sm text-zinc-600 font-mono">
          tag: {tag}
        </div>
      </header>

      <ScheduleEditor
        tag={tag}
        showLocationCapacity={showLocationCapacity}
        showProviderShifts={showProviderShifts}
        locations={allLocations.map((l) => ({
          id: l.id,
          name: l.name,
          timezone: l.timezone ?? undefined,
        }))}
        providers={allProviders.map((p) => ({ id: p.id, name: p.name }))}
        locationSchedules={allLocSchedules.map((s) => ({
          id: s.id,
          locationId: s.locationId,
          start: s.start,
          end: s.end,
          capacity: s.capacity,
        }))}
        providerSchedules={allProviderSchedules.map((s) => ({
          id: s.id,
          providerId: s.providerId,
          locationId: s.locationId,
          start: s.start,
          end: s.end,
        }))}
      />

      <div className="mt-8 pt-4 border-t border-zinc-200">
        <Link
          href={`/scenarios/agentic/${tag}`}
          className="inline-block px-4 py-2 bg-emerald-600 text-white rounded hover:bg-emerald-700"
        >
          Open calendar →
        </Link>
        <span className="ml-3 text-sm text-zinc-500">
          Once the schedule looks right, open the calendar to see it in action.
        </span>
      </div>
    </article>
  );
}

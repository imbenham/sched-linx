// Server actions for the admin schedule editor.
//
// Editor shape (v0): pick a location, pick a day-of-week, edit that
// day's location schedules AND the provider schedules for providers
// working at that location on that day. Save actions replace-in-place
// the scoped rows in one transaction.
//
// "Replace-in-place" semantics: the client submits the desired state
// for the (tag, locationId, dayOfWeek) slice; the server deletes every
// existing row matching that slice and inserts the submitted rows.
// Client-generated stable IDs let subsequent loads round-trip cleanly.
// Simpler to reason about than a diff-and-upsert path, and the slice is
// small enough that the extra churn doesn't matter for a prototype.

'use server';

import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { getDatabase } from '@/src/db/client';
import {
  locationSchedules,
  locations as locationsTable,
  providerSchedules,
} from '@/src/db/schema';

// ─── tz helpers ──────────────────────────────────────────────────────────────
// Duplicated (small, well-scoped) from app/_actions/scheduling.ts to keep
// each 'use server' file self-contained per the project's single-file
// preference. If this footprint grows we'll factor it out.

const pad = (n: number): string => String(n).padStart(2, '0');

function localToUtcIso(
  dateYMD: string,
  hour: number,
  minute: number,
  tz: string | undefined,
): string {
  if (!tz) return `${dateYMD}T${pad(hour)}:${pad(minute)}:00.000Z`;
  const [y, m, d] = dateYMD.split('-').map(Number);
  const guessMs = Date.UTC(y!, m! - 1, d!, hour, minute);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(guessMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asZonedMs = Date.UTC(
    g('year'),
    g('month') - 1,
    g('day'),
    g('hour') === 24 ? 0 : g('hour'),
    g('minute'),
  );
  const offset = asZonedMs - guessMs;
  return new Date(guessMs - offset).toISOString();
}

// Local Y-M-D (in tz) for a given Instant. Used to derive day-of-week.
function localYmdInTz(iso: string, tz: string | undefined): string {
  if (!tz) return iso.slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}`;
}

// 0-6 (0=Sunday, matching Date.getUTCDay()). Computed from local Y-M-D.
function dayOfWeekInTz(iso: string, tz: string | undefined): number {
  const [y, m, d] = localYmdInTz(iso, tz).split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

// Given a reference date (e.g. one already in the DB) and a target
// day-of-week, return the concrete Y-M-D of that DOW in the same week.
// Week runs Sunday–Saturday to match JS Date semantics.
function ymdForDayOfWeek(referenceYmd: string, targetDow: number): string {
  const [y, m, d] = referenceYmd.split('-').map(Number);
  const refDate = new Date(Date.UTC(y!, m! - 1, d!));
  const refDow = refDate.getUTCDay();
  const delta = targetDow - refDow;
  refDate.setUTCDate(refDate.getUTCDate() + delta);
  return refDate.toISOString().slice(0, 10);
}

// Local Y-M-D of an already-recorded schedule in the (tag, locationId)
// scope — used as the reference week for materializing new rows. Falls
// back to today if nothing has been recorded yet.
async function getReferenceYmdForScope(
  tag: string,
  locationId: string,
  tz: string | undefined,
): Promise<string> {
  const db = await getDatabase();
  const rows = await db
    .select({ start: locationSchedules.start })
    .from(locationSchedules)
    .where(
      and(eq(locationSchedules.tag, tag), eq(locationSchedules.locationId, locationId)),
    );
  const provRows = await db
    .select({ start: providerSchedules.start })
    .from(providerSchedules)
    .where(
      and(eq(providerSchedules.tag, tag), eq(providerSchedules.locationId, locationId)),
    );
  const all = [...rows, ...provRows].map((r) => r.start).sort();
  const anchor = all[0] ?? new Date().toISOString();
  return localYmdInTz(anchor, tz);
}

// Concrete Y-M-D of the target day-of-week within the scope's
// reference week. Used to date new schedule rows.
async function anchorYmdForScope(
  tag: string,
  locationId: string,
  tz: string | undefined,
  targetDow: number,
): Promise<string> {
  const ref = await getReferenceYmdForScope(tag, locationId, tz);
  return ymdForDayOfWeek(ref, targetDow);
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LocationScheduleRowInput {
  // Client-supplied id; may be an existing row's id or a fresh UUID for
  // newly-added rows. Server preserves ids on the round-trip.
  id: string;
  startLocal: string; // "HH:MM"
  endLocal: string;   // "HH:MM"
  capacity: number | null;
}

export interface ProviderScheduleRowInput {
  id: string;
  providerId: string;
  startLocal: string;
  endLocal: string;
}

interface SaveScopeInput {
  tag: string;
  locationId: string;
  dayOfWeek: number;
  timezone: string | undefined;
}

export interface SaveLocationSchedulesInput extends SaveScopeInput {
  rows: LocationScheduleRowInput[];
}

export interface SaveProviderSchedulesInput extends SaveScopeInput {
  rows: ProviderScheduleRowInput[];
}

interface CopyScopeInput {
  tag: string;
  locationId: string;
  sourceDayOfWeek: number;
  targetDaysOfWeek: number[];
  timezone: string | undefined;
}

export interface CopyLocationSchedulesInput extends CopyScopeInput {
  rows: LocationScheduleRowInput[];
}

export interface CopyProviderSchedulesInput extends CopyScopeInput {
  rows: ProviderScheduleRowInput[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseHM(hm: string): { hour: number; minute: number } {
  const [h, m] = hm.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h! < 0 || m! < 0 || h! > 24 || m! > 59) {
    throw new Error(`Invalid time "${hm}"`);
  }
  return { hour: h!, minute: m! };
}

// Windows that end at "00:00" or "24:00" mean midnight-at-the-end-of-day.
// Wrap to the next date at 00:00 so the resulting Instant is > start.
function materializeWindow(
  ymd: string,
  startHM: string,
  endHM: string,
  tz: string | undefined,
): { startIso: string; endIso: string } {
  const s = parseHM(startHM);
  const e = parseHM(endHM);
  const startIso = localToUtcIso(ymd, s.hour, s.minute, tz);
  // "End before or equal to start" means the window rolls over midnight —
  // add a day. This lets a schedule "2pm to midnight" express as 14:00 → 00:00.
  const endsNextDay =
    e.hour < s.hour || (e.hour === s.hour && e.minute <= s.minute);
  if (endsNextDay) {
    const [y, m, d] = ymd.split('-').map(Number);
    const next = new Date(Date.UTC(y!, m! - 1, d! + 1));
    const nextYmd = next.toISOString().slice(0, 10);
    return {
      startIso,
      endIso: localToUtcIso(nextYmd, e.hour, e.minute, tz),
    };
  }
  return {
    startIso,
    endIso: localToUtcIso(ymd, e.hour, e.minute, tz),
  };
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export async function saveLocationSchedules(
  input: SaveLocationSchedulesInput,
): Promise<void> {
  const { tag, locationId, dayOfWeek, timezone, rows } = input;
  const db = await getDatabase();

  // Sanity-check the location belongs to this tag before we start
  // mutating — better than silently writing orphans if the caller mixed
  // up ids across tags.
  const [loc] = await db
    .select()
    .from(locationsTable)
    .where(and(eq(locationsTable.id, locationId), eq(locationsTable.tag, tag)));
  if (!loc) throw new Error(`Location ${locationId} not found in scenario ${tag}`);

  const anchorYmd = await anchorYmdForScope(tag, locationId, timezone, dayOfWeek);

  const materialized = rows.map((r) => {
    const { startIso, endIso } = materializeWindow(
      anchorYmd,
      r.startLocal,
      r.endLocal,
      timezone,
    );
    return {
      id: r.id || randomUUID(),
      locationId,
      start: startIso,
      end: endIso,
      capacity: r.capacity,
      tag,
    };
  });

  await db.transaction(async (tx) => {
    // Delete every row for this scope. `scope` = (tag, locationId,
    // day-of-week-in-tz). SQL can't easily filter by day-of-week-in-tz,
    // so fetch, filter in TS, then delete by id.
    const existing = await tx
      .select({ id: locationSchedules.id, start: locationSchedules.start })
      .from(locationSchedules)
      .where(
        and(
          eq(locationSchedules.tag, tag),
          eq(locationSchedules.locationId, locationId),
        ),
      );
    const idsInScope = existing
      .filter((r) => dayOfWeekInTz(r.start, timezone) === dayOfWeek)
      .map((r) => r.id);
    if (idsInScope.length > 0) {
      await tx
        .delete(locationSchedules)
        .where(inArray(locationSchedules.id, idsInScope));
    }
    if (materialized.length > 0) {
      await tx.insert(locationSchedules).values(materialized);
    }
  });

  // Every scenario surface that reads location schedules — refresh them.
  revalidatePath(`/admin/${tag}/schedule`);
  revalidatePath(`/scenarios/agentic/${tag}`);
}

// Save the source day's rows AND replicate them onto each target day
// in one transaction. Fresh UUIDs per target-day copy so we don't hit
// PK collisions when the same source row lands on multiple days. The
// source day is treated as a save target too — the caller can hand off
// unsaved client edits and copy them out in one round trip.
export async function copyLocationSchedulesToDays(
  input: CopyLocationSchedulesInput,
): Promise<void> {
  const { tag, locationId, sourceDayOfWeek, targetDaysOfWeek, timezone, rows } =
    input;
  if (targetDaysOfWeek.length === 0) {
    throw new Error('At least one target day is required');
  }

  const db = await getDatabase();
  const [loc] = await db
    .select()
    .from(locationsTable)
    .where(and(eq(locationsTable.id, locationId), eq(locationsTable.tag, tag)));
  if (!loc) throw new Error(`Location ${locationId} not found in scenario ${tag}`);

  const referenceYmd = await getReferenceYmdForScope(tag, locationId, timezone);
  const allDays = Array.from(new Set([sourceDayOfWeek, ...targetDaysOfWeek]));

  const materializedByDay = allDays.map((dow) => {
    const anchor = ymdForDayOfWeek(referenceYmd, dow);
    return {
      dow,
      rows: rows.map((r) => {
        const { startIso, endIso } = materializeWindow(
          anchor,
          r.startLocal,
          r.endLocal,
          timezone,
        );
        return {
          id: randomUUID(),
          locationId,
          start: startIso,
          end: endIso,
          capacity: r.capacity,
          tag,
        };
      }),
    };
  });

  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: locationSchedules.id, start: locationSchedules.start })
      .from(locationSchedules)
      .where(
        and(
          eq(locationSchedules.tag, tag),
          eq(locationSchedules.locationId, locationId),
        ),
      );
    for (const { dow, rows: matRows } of materializedByDay) {
      const idsInScope = existing
        .filter((r) => dayOfWeekInTz(r.start, timezone) === dow)
        .map((r) => r.id);
      if (idsInScope.length > 0) {
        await tx
          .delete(locationSchedules)
          .where(inArray(locationSchedules.id, idsInScope));
      }
      if (matRows.length > 0) {
        await tx.insert(locationSchedules).values(matRows);
      }
    }
  });

  revalidatePath(`/admin/${tag}/schedule`);
  revalidatePath(`/scenarios/agentic/${tag}`);
}

export async function saveProviderSchedules(
  input: SaveProviderSchedulesInput,
): Promise<void> {
  const { tag, locationId, dayOfWeek, timezone, rows } = input;
  const db = await getDatabase();

  const [loc] = await db
    .select()
    .from(locationsTable)
    .where(and(eq(locationsTable.id, locationId), eq(locationsTable.tag, tag)));
  if (!loc) throw new Error(`Location ${locationId} not found in scenario ${tag}`);

  const anchorYmd = await anchorYmdForScope(tag, locationId, timezone, dayOfWeek);

  const materialized = rows.map((r) => {
    const { startIso, endIso } = materializeWindow(
      anchorYmd,
      r.startLocal,
      r.endLocal,
      timezone,
    );
    return {
      id: r.id || randomUUID(),
      providerId: r.providerId,
      locationId,
      start: startIso,
      end: endIso,
      tag,
    };
  });

  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: providerSchedules.id, start: providerSchedules.start })
      .from(providerSchedules)
      .where(
        and(
          eq(providerSchedules.tag, tag),
          eq(providerSchedules.locationId, locationId),
        ),
      );
    const idsInScope = existing
      .filter((r) => dayOfWeekInTz(r.start, timezone) === dayOfWeek)
      .map((r) => r.id);
    if (idsInScope.length > 0) {
      await tx
        .delete(providerSchedules)
        .where(inArray(providerSchedules.id, idsInScope));
    }
    if (materialized.length > 0) {
      await tx.insert(providerSchedules).values(materialized);
    }
  });

  revalidatePath(`/admin/${tag}/schedule`);
  revalidatePath(`/scenarios/agentic/${tag}`);
}

// Same shape as copyLocationSchedulesToDays but for provider shifts.
// providerId is preserved per-row — copying "Alice 9-5" to Wednesday
// means Alice works 9-5 on Wednesday too.
export async function copyProviderSchedulesToDays(
  input: CopyProviderSchedulesInput,
): Promise<void> {
  const { tag, locationId, sourceDayOfWeek, targetDaysOfWeek, timezone, rows } =
    input;
  if (targetDaysOfWeek.length === 0) {
    throw new Error('At least one target day is required');
  }

  const db = await getDatabase();
  const [loc] = await db
    .select()
    .from(locationsTable)
    .where(and(eq(locationsTable.id, locationId), eq(locationsTable.tag, tag)));
  if (!loc) throw new Error(`Location ${locationId} not found in scenario ${tag}`);

  const referenceYmd = await getReferenceYmdForScope(tag, locationId, timezone);
  const allDays = Array.from(new Set([sourceDayOfWeek, ...targetDaysOfWeek]));

  const materializedByDay = allDays.map((dow) => {
    const anchor = ymdForDayOfWeek(referenceYmd, dow);
    return {
      dow,
      rows: rows.map((r) => {
        const { startIso, endIso } = materializeWindow(
          anchor,
          r.startLocal,
          r.endLocal,
          timezone,
        );
        return {
          id: randomUUID(),
          providerId: r.providerId,
          locationId,
          start: startIso,
          end: endIso,
          tag,
        };
      }),
    };
  });

  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: providerSchedules.id, start: providerSchedules.start })
      .from(providerSchedules)
      .where(
        and(
          eq(providerSchedules.tag, tag),
          eq(providerSchedules.locationId, locationId),
        ),
      );
    for (const { dow, rows: matRows } of materializedByDay) {
      const idsInScope = existing
        .filter((r) => dayOfWeekInTz(r.start, timezone) === dow)
        .map((r) => r.id);
      if (idsInScope.length > 0) {
        await tx
          .delete(providerSchedules)
          .where(inArray(providerSchedules.id, idsInScope));
      }
      if (matRows.length > 0) {
        await tx.insert(providerSchedules).values(matRows);
      }
    }
  });

  revalidatePath(`/admin/${tag}/schedule`);
  revalidatePath(`/scenarios/agentic/${tag}`);
}

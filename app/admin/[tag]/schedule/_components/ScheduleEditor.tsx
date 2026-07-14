// Client-side schedule editor. Client state owns the in-flight edits;
// clicking "Save" per section flushes that section's rows for the
// current (location, day-of-week) slice to the DB via a server action.
//
// v0 shape: one location + one day-of-week visible at a time. Copy-
// forward / week-template affordances live in a later slice.

'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  copyLocationSchedulesToDays,
  copyProviderSchedulesToDays,
  saveLocationSchedules,
  saveProviderSchedules,
  type LocationScheduleRowInput,
  type ProviderScheduleRowInput,
} from '@/app/_actions/admin';
import { CopyToDaysWidget } from './CopyToDaysWidget';

interface AdminLocation {
  id: string;
  name: string;
  timezone?: string;
}

interface AdminProvider {
  id: string;
  name: string;
}

interface AdminLocationSchedule {
  id: string;
  locationId: string;
  start: string;
  end: string;
  capacity: number | null;
}

interface AdminProviderSchedule {
  id: string;
  providerId: string;
  locationId: string;
  start: string;
  end: string;
}

interface ScheduleEditorProps {
  tag: string;
  // Section visibility flags. Derived by the server component from the
  // scenario's services: location capacity is only meaningful when a
  // service actually books against it; provider shifts only when a
  // provider-scheduled service exists AND providers are defined.
  showLocationCapacity: boolean;
  showProviderShifts: boolean;
  locations: AdminLocation[];
  providers: AdminProvider[];
  locationSchedules: AdminLocationSchedule[];
  providerSchedules: AdminProviderSchedule[];
}

// Sunday-first to match Date.getDay() but display Monday-first (the way
// scheduling humans think about a work-week).
const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

// Client-side tz helpers. Mirror the server-side conversions closely so
// times round-trip visibly.

function localHmInTz(iso: string, tz: string | undefined): string {
  if (!tz) return iso.slice(11, 16);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hh === '24' ? '00' : hh}:${mm}`;
}

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

function dayOfWeekInTz(iso: string, tz: string | undefined): number {
  const [y, m, d] = localYmdInTz(iso, tz).split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

// Client row shape: local HH:MM strings, editable inline. `id` is
// preserved from load; a fresh UUID gets assigned to new rows.
interface LocalLocationRow {
  id: string;
  startLocal: string;
  endLocal: string;
  capacity: number | null;
}

interface LocalProviderRow {
  id: string;
  providerId: string;
  startLocal: string;
  endLocal: string;
}

function makeId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `new-${Math.random().toString(36).slice(2)}`;
}

export function ScheduleEditor({
  tag,
  showLocationCapacity,
  showProviderShifts,
  locations,
  providers,
  locationSchedules,
  providerSchedules,
}: ScheduleEditorProps) {
  const router = useRouter();
  const [selectedLocationId, setSelectedLocationId] = useState<string>(
    locations[0]?.id ?? '',
  );
  const [selectedDow, setSelectedDow] = useState<number>(1); // Monday by default

  const selectedLocation = locations.find((l) => l.id === selectedLocationId);
  const tz = selectedLocation?.timezone;

  // Rebuild the visible rows whenever the slice or the underlying data
  // changes. Uses the loaded schedule rows to seed client state.
  const visibleLocationRows: LocalLocationRow[] = useMemo(() => {
    return locationSchedules
      .filter(
        (s) =>
          s.locationId === selectedLocationId &&
          dayOfWeekInTz(s.start, tz) === selectedDow,
      )
      .map((s) => ({
        id: s.id,
        startLocal: localHmInTz(s.start, tz),
        endLocal: localHmInTz(s.end, tz),
        capacity: s.capacity,
      }));
  }, [locationSchedules, selectedLocationId, selectedDow, tz]);

  const visibleProviderRows: LocalProviderRow[] = useMemo(() => {
    return providerSchedules
      .filter(
        (s) =>
          s.locationId === selectedLocationId &&
          dayOfWeekInTz(s.start, tz) === selectedDow,
      )
      .map((s) => ({
        id: s.id,
        providerId: s.providerId,
        startLocal: localHmInTz(s.start, tz),
        endLocal: localHmInTz(s.end, tz),
      }));
  }, [providerSchedules, selectedLocationId, selectedDow, tz]);

  // Client copies. Reseed when the slice changes.
  const [locRows, setLocRows] = useState<LocalLocationRow[]>(visibleLocationRows);
  const [provRows, setProvRows] = useState<LocalProviderRow[]>(visibleProviderRows);
  const [sliceKey, setSliceKey] = useState<string>('');
  const currentSliceKey = `${selectedLocationId}::${selectedDow}`;
  if (sliceKey !== currentSliceKey) {
    setLocRows(visibleLocationRows);
    setProvRows(visibleProviderRows);
    setSliceKey(currentSliceKey);
  }

  const [locError, setLocError] = useState<string | null>(null);
  const [provError, setProvError] = useState<string | null>(null);
  const [savingLoc, startSaveLoc] = useTransition();
  const [savingProv, startSaveProv] = useTransition();
  const [copyingLoc, startCopyLoc] = useTransition();
  const [copyingProv, startCopyProv] = useTransition();

  // Which days-of-week already have rows for the current location.
  // Sourced from persisted state (props), not client state, so the
  // "has data" badge reflects what would actually be overwritten.
  const locationDaysWithData = useMemo(() => {
    const s = new Set<number>();
    for (const r of locationSchedules) {
      if (r.locationId !== selectedLocationId) continue;
      s.add(dayOfWeekInTz(r.start, tz));
    }
    return s;
  }, [locationSchedules, selectedLocationId, tz]);

  const providerDaysWithData = useMemo(() => {
    const s = new Set<number>();
    for (const r of providerSchedules) {
      if (r.locationId !== selectedLocationId) continue;
      s.add(dayOfWeekInTz(r.start, tz));
    }
    return s;
  }, [providerSchedules, selectedLocationId, tz]);

  const handleSaveLocation = () => {
    if (!selectedLocationId) return;
    setLocError(null);
    // Validate rows before firing off the transaction.
    for (const r of locRows) {
      if (!/^\d{2}:\d{2}$/.test(r.startLocal) || !/^\d{2}:\d{2}$/.test(r.endLocal)) {
        setLocError('All times must be in HH:MM format.');
        return;
      }
      if (r.capacity != null && (!Number.isInteger(r.capacity) || r.capacity < 0)) {
        setLocError('Capacity must be a non-negative integer, or blank.');
        return;
      }
    }
    startSaveLoc(async () => {
      try {
        await saveLocationSchedules({
          tag,
          locationId: selectedLocationId,
          dayOfWeek: selectedDow,
          timezone: tz,
          rows: locRows.map(
            (r): LocationScheduleRowInput => ({
              id: r.id,
              startLocal: r.startLocal,
              endLocal: r.endLocal,
              capacity: r.capacity,
            }),
          ),
        });
        router.refresh();
      } catch (err) {
        setLocError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const validateLocRows = (): string | null => {
    for (const r of locRows) {
      if (!/^\d{2}:\d{2}$/.test(r.startLocal) || !/^\d{2}:\d{2}$/.test(r.endLocal)) {
        return 'All times must be in HH:MM format.';
      }
      if (r.capacity != null && (!Number.isInteger(r.capacity) || r.capacity < 0)) {
        return 'Capacity must be a non-negative integer, or blank.';
      }
    }
    return null;
  };

  const handleCopyLocation = (targetDows: number[]) => {
    if (!selectedLocationId) return;
    setLocError(null);
    const invalid = validateLocRows();
    if (invalid) {
      setLocError(invalid);
      return;
    }
    startCopyLoc(async () => {
      try {
        await copyLocationSchedulesToDays({
          tag,
          locationId: selectedLocationId,
          sourceDayOfWeek: selectedDow,
          targetDaysOfWeek: targetDows,
          timezone: tz,
          rows: locRows.map(
            (r): LocationScheduleRowInput => ({
              id: r.id,
              startLocal: r.startLocal,
              endLocal: r.endLocal,
              capacity: r.capacity,
            }),
          ),
        });
        router.refresh();
      } catch (err) {
        setLocError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const handleSaveProvider = () => {
    if (!selectedLocationId) return;
    setProvError(null);
    for (const r of provRows) {
      if (!r.providerId) {
        setProvError('Every row needs a provider selected.');
        return;
      }
      if (!/^\d{2}:\d{2}$/.test(r.startLocal) || !/^\d{2}:\d{2}$/.test(r.endLocal)) {
        setProvError('All times must be in HH:MM format.');
        return;
      }
    }
    startSaveProv(async () => {
      try {
        await saveProviderSchedules({
          tag,
          locationId: selectedLocationId,
          dayOfWeek: selectedDow,
          timezone: tz,
          rows: provRows.map(
            (r): ProviderScheduleRowInput => ({
              id: r.id,
              providerId: r.providerId,
              startLocal: r.startLocal,
              endLocal: r.endLocal,
            }),
          ),
        });
        router.refresh();
      } catch (err) {
        setProvError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const validateProvRows = (): string | null => {
    for (const r of provRows) {
      if (!r.providerId) return 'Every row needs a provider selected.';
      if (!/^\d{2}:\d{2}$/.test(r.startLocal) || !/^\d{2}:\d{2}$/.test(r.endLocal)) {
        return 'All times must be in HH:MM format.';
      }
    }
    return null;
  };

  const handleCopyProvider = (targetDows: number[]) => {
    if (!selectedLocationId) return;
    setProvError(null);
    const invalid = validateProvRows();
    if (invalid) {
      setProvError(invalid);
      return;
    }
    startCopyProv(async () => {
      try {
        await copyProviderSchedulesToDays({
          tag,
          locationId: selectedLocationId,
          sourceDayOfWeek: selectedDow,
          targetDaysOfWeek: targetDows,
          timezone: tz,
          rows: provRows.map(
            (r): ProviderScheduleRowInput => ({
              id: r.id,
              providerId: r.providerId,
              startLocal: r.startLocal,
              endLocal: r.endLocal,
            }),
          ),
        });
        router.refresh();
      } catch (err) {
        setProvError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  // Build the "other days" list for the copy widget. Uses the
  // Monday-first display order so the checkboxes read naturally.
  const otherDaysFor = (
    daysWithData: Set<number>,
  ): { dow: number; label: string; hasData: boolean }[] =>
    DISPLAY_ORDER.filter((d) => d !== selectedDow).map((dow) => ({
      dow,
      label: DAY_NAMES[dow]!,
      hasData: daysWithData.has(dow),
    }));

  const updateLocRow = (i: number, patch: Partial<LocalLocationRow>) => {
    setLocRows((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  const removeLocRow = (i: number) => {
    setLocRows((rows) => rows.filter((_, j) => j !== i));
  };
  const addLocRow = () => {
    setLocRows((rows) => [
      ...rows,
      { id: makeId(), startLocal: '09:00', endLocal: '17:00', capacity: 1 },
    ]);
  };

  const updateProvRow = (i: number, patch: Partial<LocalProviderRow>) => {
    setProvRows((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  const removeProvRow = (i: number) => {
    setProvRows((rows) => rows.filter((_, j) => j !== i));
  };
  const addProvRow = () => {
    setProvRows((rows) => [
      ...rows,
      {
        id: makeId(),
        providerId: providers[0]?.id ?? '',
        startLocal: '09:00',
        endLocal: '17:00',
      },
    ]);
  };

  if (!selectedLocation) {
    return (
      <div className="italic text-zinc-500">
        No locations recorded for this scenario yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-4">
        {locations.length > 1 && (
          <label className="flex items-center gap-2">
            <span className="text-sm font-medium">Location:</span>
            <select
              value={selectedLocationId}
              onChange={(e) => setSelectedLocationId(e.target.value)}
              className="border border-zinc-300 rounded px-2 py-1"
            >
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.timezone ? ` (${l.timezone})` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {locations.length === 1 && (
          <div className="text-sm text-zinc-700">
            <span className="font-medium">{selectedLocation.name}</span>{' '}
            {tz && <span className="text-zinc-500">({tz})</span>}
          </div>
        )}

        <div
          role="radiogroup"
          aria-label="Day of week"
          className="inline-flex rounded-full bg-zinc-100 p-0.5 border border-zinc-300"
        >
          {DISPLAY_ORDER.map((dow) => (
            <button
              key={dow}
              type="button"
              role="radio"
              aria-checked={selectedDow === dow}
              onClick={() => setSelectedDow(dow)}
              className={`px-3 py-1 text-sm rounded-full ${
                selectedDow === dow
                  ? 'bg-white text-zinc-900 font-medium shadow-sm'
                  : 'text-zinc-600 hover:text-zinc-900'
              }`}
            >
              {DAY_NAMES[dow]!.slice(0, 3)}
            </button>
          ))}
        </div>
      </div>

      {/* Location schedule section — only meaningful when a service
          books against location capacity. */}
      {showLocationCapacity && (
      <section className="border border-zinc-300 rounded p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-lg font-semibold m-0">Location capacity</h2>
            <p className="text-xs text-zinc-600">
              Windows where {selectedLocation.name} accepts location-scheduled
              bookings on {DAY_NAMES[selectedDow]}. Times are local
              {tz ? ` (${tz})` : ' (UTC)'}.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <CopyToDaysWidget
              sourceLabel={DAY_NAMES[selectedDow]!}
              otherDays={otherDaysFor(locationDaysWithData)}
              onApply={handleCopyLocation}
              applying={copyingLoc}
              disabled={savingLoc}
            />
            <button
              type="button"
              onClick={handleSaveLocation}
              disabled={savingLoc || copyingLoc}
              className="px-4 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {savingLoc ? 'Saving…' : 'Save location schedule'}
            </button>
          </div>
        </div>

        {locRows.length === 0 ? (
          <p className="italic text-sm text-zinc-500 mb-3">
            No windows for {DAY_NAMES[selectedDow]}. Add one to open bookings.
          </p>
        ) : (
          <table className="w-full text-sm mb-3">
            <thead>
              <tr className="text-left text-xs text-zinc-500 uppercase">
                <th className="py-1 pr-2">Start</th>
                <th className="py-1 pr-2">End</th>
                <th className="py-1 pr-2">Capacity</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {locRows.map((row, i) => (
                <tr key={row.id}>
                  <td className="py-1 pr-2">
                    <input
                      type="time"
                      value={row.startLocal}
                      onChange={(e) => updateLocRow(i, { startLocal: e.target.value })}
                      className="border border-zinc-300 rounded px-2 py-0.5"
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <input
                      type="time"
                      value={row.endLocal}
                      onChange={(e) => updateLocRow(i, { endLocal: e.target.value })}
                      className="border border-zinc-300 rounded px-2 py-0.5"
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <input
                      type="number"
                      min={0}
                      value={row.capacity ?? ''}
                      onChange={(e) => {
                        const v = e.target.value;
                        updateLocRow(i, {
                          capacity: v === '' ? null : parseInt(v, 10),
                        });
                      }}
                      className="w-20 border border-zinc-300 rounded px-2 py-0.5"
                    />
                  </td>
                  <td className="py-1 text-right">
                    <button
                      type="button"
                      onClick={() => removeLocRow(i)}
                      className="text-xs text-red-700 hover:underline"
                    >
                      remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <button
          type="button"
          onClick={addLocRow}
          className="text-sm text-blue-700 hover:underline"
        >
          + Add window
        </button>

        {locError && (
          <div className="mt-2 text-sm text-red-700">{locError}</div>
        )}
      </section>
      )}

      {/* Provider schedule section — only meaningful when a
          provider-scheduled service exists and providers are recorded. */}
      {showProviderShifts && (
        <section className="border border-zinc-300 rounded p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-lg font-semibold m-0">Provider shifts</h2>
              <p className="text-xs text-zinc-600">
                Windows when specific providers are working at{' '}
                {selectedLocation.name} on {DAY_NAMES[selectedDow]}. Times are
                local{tz ? ` (${tz})` : ' (UTC)'}.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <CopyToDaysWidget
                sourceLabel={DAY_NAMES[selectedDow]!}
                otherDays={otherDaysFor(providerDaysWithData)}
                onApply={handleCopyProvider}
                applying={copyingProv}
                disabled={savingProv}
              />
              <button
                type="button"
                onClick={handleSaveProvider}
                disabled={savingProv || copyingProv}
                className="px-4 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {savingProv ? 'Saving…' : 'Save provider shifts'}
              </button>
            </div>
          </div>

          {provRows.length === 0 ? (
            <p className="italic text-sm text-zinc-500 mb-3">
              No provider shifts for {DAY_NAMES[selectedDow]}. Add one to
              schedule a provider here.
            </p>
          ) : (
            <table className="w-full text-sm mb-3">
              <thead>
                <tr className="text-left text-xs text-zinc-500 uppercase">
                  <th className="py-1 pr-2">Provider</th>
                  <th className="py-1 pr-2">Start</th>
                  <th className="py-1 pr-2">End</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {provRows.map((row, i) => (
                  <tr key={row.id}>
                    <td className="py-1 pr-2">
                      <select
                        value={row.providerId}
                        onChange={(e) =>
                          updateProvRow(i, { providerId: e.target.value })
                        }
                        className="border border-zinc-300 rounded px-2 py-0.5"
                      >
                        {providers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        type="time"
                        value={row.startLocal}
                        onChange={(e) =>
                          updateProvRow(i, { startLocal: e.target.value })
                        }
                        className="border border-zinc-300 rounded px-2 py-0.5"
                      />
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        type="time"
                        value={row.endLocal}
                        onChange={(e) =>
                          updateProvRow(i, { endLocal: e.target.value })
                        }
                        className="border border-zinc-300 rounded px-2 py-0.5"
                      />
                    </td>
                    <td className="py-1 text-right">
                      <button
                        type="button"
                        onClick={() => removeProvRow(i)}
                        className="text-xs text-red-700 hover:underline"
                      >
                        remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <button
            type="button"
            onClick={addProvRow}
            className="text-sm text-blue-700 hover:underline"
          >
            + Add provider shift
          </button>

          {provError && (
            <div className="mt-2 text-sm text-red-700">{provError}</div>
          )}
        </section>
      )}
    </div>
  );
}

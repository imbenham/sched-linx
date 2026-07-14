// Client component: the calendar view of the schedule. Lives at the app
// tree's _components folder so any scenario page (or other UI surface)
// can reuse it without dragging routing along.
//
// Server-side `loadCalendarCellsAction` owns cell-state computation;
// Calendar's job is just (a) collect inputs (service, mode, cadence,
// date), (b) fetch cells when those change, (c) render the result, and
// (d) propagate the scenarioTag down to every action so the underlying
// DB reads/writes stay scoped to one scenario.
//
// The discriminated-union result from scheduleAppointmentAction still
// maps to the result panel below the grid:
//   direct      → success banner; grid refreshes; cell turns busy
//   proposal    → reshuffle banner with Approve / Reject
//   infeasible  → friendly "no can do" banner
//
// Time math is in UTC throughout — the action and the canonical Instant
// brand both speak UTC. Display formatting could later convert to the
// viewer's local timezone; for now everything reads as UTC.

'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import {
  AnonymousCalendarCell,
  applyReshuffleAction,
  cancelBookingAction,
  KnownProviderCalendarCell,
  loadCalendarCellsAction,
  scheduleAppointmentAction,
  type CalendarCells,
} from '@/app/_actions/scheduling';
import type { ScheduleResult } from '@/src/scheduling/scheduleAppointment';
import type {
  Instant,
  Location,
  LocationId,
  Provider,
  ProviderId,
  ProviderQualification,
  Room,
  Service,
  ServiceId,
} from '@/src/model';
import type { ReshuffleProposal } from '@/src/scheduling/proposeReshuffle';

interface CalendarProps {
  /** YYYY-MM-DD in UTC. Seeds the date state; the user can navigate to
   *  other dates via the date input in the toolbar without re-rendering
   *  the parent. */
  initialDate: string;
  services: Service[];
  providers: Provider[];
  qualifications: ProviderQualification[];
  /** Scenario tag — every server-action call from this Calendar carries
   *  it so all reads + writes stay scoped to the scenario's data. Omit
   *  for un-scoped usage (legacy, dev). */
  scenarioTag?: string;
  /** Optional rooms catalog. When provided, busy cells and the success
   *  banner display the room name alongside service + time. Scenarios
   *  without rooms (scenario 1) can leave this undefined. */
  rooms?: Room[];
  /** Optional locations catalog. When provided, the success banner
   *  and reshuffle modal display the location name — useful for
   *  multi-location practices where routing decides which clinic a
   *  walk-in lands at. Parallel to the rooms prop. */
  locations?: Location[];
  /** Initial view mode. Defaults to 'known'. Scenarios whose services are
   *  primarily location-scheduled (no provider axis) should pass
   *  'anonymous' so the calendar opens on a mode where it can actually
   *  render available cells. */
  initialMode?: 'known' | 'anonymous';
}

const DEFAULT_CADENCE_MINUTES = 15;
const CADENCE_OPTIONS = [5, 10, 15, 30, 60] as const;

// Format an ISO Instant as HH:MM in the given timezone. Undefined tz
// falls back to UTC to preserve the calendar's historical behavior for
// scenarios that haven't recorded a timezone.
const formatTime = (iso: string, tz: string | undefined): string => {
  if (!tz) return new Date(iso).toISOString().slice(11, 16);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hh === '24' ? '00' : hh}:${mm}`;
};

const isoPlusMinutes = (iso: string, minutes: number): string =>
  new Date(Date.parse(iso) + minutes * 60_000).toISOString();

export function Calendar({
  initialDate,
  services,
  providers,
  qualifications,
  scenarioTag,
  rooms,
  locations,
  initialMode,
}: CalendarProps) {
  const [selectedServiceId, setSelectedServiceId] = useState<string>(
    services[0]?.id ?? '',
  );
  const [mode, setMode] = useState<'known' | 'anonymous'>(initialMode ?? 'known');
  const [cadenceMinutes, setCadenceMinutes] = useState<number>(
    DEFAULT_CADENCE_MINUTES,
  );
  const [date, setDate] = useState<string>(initialDate);
  // The location the user is currently viewing. Drives the timezone
  // used to interpret `date` and render slot labels, and (when set)
  // constrains booking requests to this location. Undefined = "let
  // routing decide" — the default for scenarios with no location or
  // one location.
  const [selectedLocationId, setSelectedLocationId] = useState<
    string | undefined
  >(locations && locations.length > 0 ? locations[0]!.id : undefined);
  const selectedLocation = locations?.find((l) => l.id === selectedLocationId);
  const timezone = selectedLocation?.timezone;
  const [calendarCells, setCalendarCells] = useState<CalendarCells | null>(
    null,
  );
  const [result, setResult] = useState<ScheduleResult | null>(null);
  const [reshuffleModal, setReshuffleModal] = useState<ReshuffleProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const selectedService = services.find((s) => s.id === selectedServiceId);

  // Fetch cells whenever the inputs change. The action is the single
  // source of truth for cell state; the client is just a presenter.
  useEffect(() => {
    if (!selectedServiceId) return;
    startTransition(async () => {
      try {
        const next = await loadCalendarCellsAction({
          date,
          serviceId: selectedServiceId,
          cadenceMinutes,
          mode,
          timezone,
          locationId: selectedLocationId,
          scenarioTag,
        });
        setCalendarCells(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }, [
    date,
    selectedServiceId,
    cadenceMinutes,
    mode,
    timezone,
    selectedLocationId,
    scenarioTag,
  ]);

  // Re-fetch after a mutation so the grid reflects the new state.
  // revalidatePath in the actions refreshes the server-rendered page, but
  // Calendar holds the cell data in client state — we have to trigger
  // the refetch ourselves.
  const refreshCells = () => {
    if (!selectedServiceId) return;
    startTransition(async () => {
      try {
        const next = await loadCalendarCellsAction({
          date,
          serviceId: selectedServiceId,
          cadenceMinutes,
          mode,
          timezone,
          locationId: selectedLocationId,
          scenarioTag,
        });
        setCalendarCells(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  // Determines which columns to render in known mode. The action returns
  // a row per provider (qualified or not); we filter here so the table
  // only shows providers who can actually perform the selected service.
  const qualifiedProviders = useMemo(() => {
    if (!selectedService) return [];
    const qualifiedIds = new Set(
      qualifications
        .filter((q) => q.serviceId === selectedService.id)
        .map((q) => q.providerId),
    );
    return providers.filter((p) => qualifiedIds.has(p.id));
  }, [providers, qualifications, selectedService]);

  const serviceName = (id: string): string =>
    services.find((s) => s.id === id)?.name ?? id;
  const providerName = (id: string): string =>
    providers.find((p) => p.id === id)?.name ?? id;
  const roomName = (id: string): string =>
    rooms?.find((r) => r.id === id)?.name ?? id;
  const locationName = (id: string): string =>
    locations?.find((l) => l.id === id)?.name ?? id;

  // Location suffix for banners: shown when we have a locations catalog
  // to resolve against. Multi-location routing is invisible without it.
  const locationSuffix = (locationId: string): string =>
    locations ? ` at ${locationName(locationId)}` : '';

  // Pull the row-ordered timeslots out of the action result. For known
  // mode, every qualified provider's column has the same timeslot
  // ordering (the action builds them all from the same buildTimeSlots
  // pass), so any provider's column will do.
  const knownTimeslots =
    calendarCells?.mode === 'known' && qualifiedProviders[0]
      ? calendarCells.cellsByProvider[qualifiedProviders[0].id]?.map(
          (c) => c.timeslot,
        ) ?? []
      : [];

  const handleCellClick = (cell: AnonymousCalendarCell | KnownProviderCalendarCell, providerId?: string) => {
    const { timeslot, state } = cell;
    // Reshufflable cells already have the proposal precomputed by the
    // server — short-circuit into the modal flow instead of going through
    // a full scheduleAppointmentAction round trip.
    if (state.kind === 'unavailable-reshufflable') {
      setError(null);
      setResult(null);
      setReshuffleModal(state.proposal);
      return;
    }
    if (!selectedService) return;
    setError(null);
    setResult(null);
    const start = timeslot.isoStart as Instant;
    const end = isoPlusMinutes(
      timeslot.isoStart,
      selectedService.durationMinutes,
    ) as Instant;
    startTransition(async () => {
      try {
        const r = await scheduleAppointmentAction(
          {
            serviceId: selectedService.id as ServiceId,
            ...(mode === 'known'
              ? { providerId: providerId as ProviderId }
              : {}),
            ...(selectedLocationId
              ? { locationId: selectedLocationId as LocationId }
              : {}),
            window: { start, end },
            granularityMinutes: cadenceMinutes,
          },
          scenarioTag,
        );
        // Route proposal results through the modal — same chrome as the
        // precomputed-reshufflable click. Direct + infeasible stay on the
        // result banner.
        if (r.kind === 'proposal') {
          setReshuffleModal(r.proposal);
        } else {
          setResult(r);
          if (r.kind === 'direct') refreshCells();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const handleApproveReshuffleModal = () => {
    const proposal = reshuffleModal;
    if (!proposal) return;
    setError(null);
    startTransition(async () => {
      try {
        await applyReshuffleAction(proposal, scenarioTag);
        setReshuffleModal(null);
        refreshCells();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const handleCancel = (slotId: string) => {
    setError(null);
    startTransition(async () => {
      try {
        await cancelBookingAction(slotId);
        refreshCells();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  if (!selectedService) {
    return <div className="my-4 italic">No services defined.</div>;
  }

  return (
    <div className="my-4">
      <div className="flex items-center gap-4 mb-3 flex-wrap">
        <label className="flex items-center gap-2">
          <span className="font-medium">Service:</span>
          <select
            value={selectedServiceId}
            onChange={(e) => {
              setSelectedServiceId(e.target.value);
              setResult(null);
              setError(null);
            }}
            className="border border-gray-300 px-2 py-1 rounded"
          >
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.durationMinutes} min)
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">Mode:</span>
          <div
            role="radiogroup"
            aria-label="Booking mode"
            className="inline-flex rounded-full bg-gray-100 p-0.5 border border-gray-300"
          >
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'known'}
              onClick={() => {
                setMode('known');
                setResult(null);
                setError(null);
              }}
              className={`px-3 py-1 text-sm rounded-full transition-colors ${
                mode === 'known'
                  ? 'bg-white text-gray-900 font-medium shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Known provider
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'anonymous'}
              onClick={() => {
                setMode('anonymous');
                setResult(null);
                setError(null);
              }}
              className={`px-3 py-1 text-sm rounded-full transition-colors ${
                mode === 'anonymous'
                  ? 'bg-white text-gray-900 font-medium shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Anonymous
            </button>
          </div>
        </div>

        <label className="flex items-center gap-2">
          <span className="font-medium text-sm">Cadence:</span>
          <select
            value={cadenceMinutes}
            onChange={(e) => {
              setCadenceMinutes(parseInt(e.target.value, 10));
              setResult(null);
              setError(null);
            }}
            className="border border-gray-300 px-2 py-1 rounded"
          >
            {CADENCE_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
        </label>

        {locations && locations.length > 1 && (
          <label className="flex items-center gap-2">
            <span className="font-medium text-sm">Location:</span>
            <select
              value={selectedLocationId ?? ''}
              onChange={(e) => {
                setSelectedLocationId(e.target.value || undefined);
                setResult(null);
                setError(null);
              }}
              className="border border-gray-300 px-2 py-1 rounded"
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

        <label className="flex items-center gap-2">
          <span className="font-medium text-sm">Date:</span>
          <input
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setResult(null);
              setError(null);
            }}
            className="border border-gray-300 px-2 py-1 rounded"
          />
          <span className="text-xs text-gray-500">
            ({timezone ?? 'UTC'})
          </span>
        </label>
      </div>

      {calendarCells === null ? (
        <div className="my-4 italic text-gray-500">Loading calendar…</div>
      ) : calendarCells.mode === 'known' ? (
        <table className="table-auto border-collapse border border-gray-400 w-full">
          <thead>
            <tr className="bg-gray-100">
              <th className="border border-gray-300 px-3 py-2 text-left w-20">
                Time
              </th>
              {qualifiedProviders.map((p) => (
                <th
                  key={p.id}
                  className="border border-gray-300 px-3 py-2 text-left"
                >
                  {p.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {knownTimeslots.map((slot, rowIdx) => (
              <tr key={slot.label}>
                <td className="border border-gray-300 px-3 py-1 text-sm font-mono text-gray-600">
                  {slot.label}
                </td>
                {qualifiedProviders.map((p) => {
                  const cell = calendarCells.cellsByProvider[p.id]?.[rowIdx];
                  const state = cell?.state;
                  if (!state || state.kind === 'out-of-schedule') {
                    return (
                      <td
                        key={p.id}
                        className="border border-gray-300 px-2 py-1 bg-gray-100"
                      />
                    );
                  }
                  if (state.kind === 'busy-start') {
                    return (
                      <td
                        key={p.id}
                        className="border border-gray-300 px-2 py-1 bg-rose-200 text-rose-900 text-xs"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span>
                            <span className="font-medium">
                              {serviceName(state.booking.serviceId)}
                            </span>
                            <span className="ml-1 text-rose-700">
                              ({formatTime(state.booking.start, timezone)}–
                              {formatTime(state.booking.end, timezone)})
                            </span>
                            {state.booking.roomId && rooms ? (
                              <span className="ml-1 text-rose-700">
                                · {roomName(state.booking.roomId)}
                              </span>
                            ) : null}
                          </span>
                          <button
                            onClick={() => handleCancel(state.booking.id)}
                            disabled={pending}
                            className="text-rose-900 hover:text-rose-600 disabled:opacity-50"
                            title="Cancel booking"
                            type="button"
                          >
                            ×
                          </button>
                        </div>
                      </td>
                    );
                  }
                  if (state.kind === 'unavailable') {
                    const title =
                      state.reason === 'no-room'
                        ? 'No eligible room is free at this time'
                        : state.reason === 'covered'
                          ? `Covered by ${serviceName(state.booking.serviceId)} at ${formatTime(state.booking.start, timezone)}`
                          : `Booking here would overlap a ${serviceName(state.booking.serviceId)} at ${formatTime(state.booking.start, timezone)}`;
                    return (
                      <td
                        key={p.id}
                        className="border border-gray-300 px-2 py-1 bg-rose-100"
                        title={title}
                      />
                    );
                  }
                  return (
                    <td
                      key={p.id}
                      className="border border-gray-300 px-2 py-1 bg-emerald-50 hover:bg-emerald-200 cursor-pointer text-xs text-emerald-900"
                      onClick={() => handleCellClick(cell, p.id)}
                    >
                      {pending ? '…' : 'book'}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table className="table-auto border-collapse border border-gray-400 w-full max-w-md">
          <thead>
            <tr className="bg-gray-100">
              <th className="border border-gray-300 px-3 py-2 text-left w-20">
                Time
              </th>
              <th className="border border-gray-300 px-3 py-2 text-left">
                Availability
              </th>
            </tr>
          </thead>
          <tbody>
            {calendarCells.cells.map((cell) => (
              <tr key={cell.timeslot.label}>
                <td className="border border-gray-300 px-3 py-1 text-sm font-mono text-gray-600">
                  {cell.timeslot.label}
                </td>
                <AnonymousCellContent
                  key={cell.timeslot.isoStart}
                  cell={cell}
                  pending={pending}
                  unavailableLabel={
                    selectedService?.requiresProvider === false
                      ? 'At capacity'
                      : 'No qualified provider free'
                  }
                  handleCellClick={handleCellClick}
                />
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {error && (
        <div className="mt-4 p-3 border border-red-300 bg-red-50 rounded text-red-800">
          Error: {error}
        </div>
      )}

      {result?.kind === 'direct' && (
        <div className="mt-4 p-3 border border-green-300 bg-green-50 rounded text-green-800 flex items-center justify-between">
          <span>
            Booked{' '}
            {result.assignment.providerId
              ? providerName(result.assignment.providerId)
              : 'walk-in slot'}{' '}
            for {serviceName(result.assignment.slot.serviceId)} at{' '}
            {formatTime(result.assignment.slot.start, timezone)}–
            {formatTime(result.assignment.slot.end, timezone)}
            {result.assignment.slot.roomId && rooms
              ? ` in ${roomName(result.assignment.slot.roomId)}`
              : ''}
            {locationSuffix(result.assignment.slot.locationId)}
            .
          </span>
          <button
            onClick={() => setResult(null)}
            className="text-green-900 hover:text-green-600"
            type="button"
          >
            ×
          </button>
        </div>
      )}

      {result?.kind === 'infeasible' && (
        <div className="mt-4 p-3 border border-yellow-300 bg-yellow-50 rounded text-yellow-900 flex items-center justify-between">
          <span>
            Can't be scheduled at that time
            {selectedService?.requiresProvider
              ? ' — no qualified provider is free and no reshuffle of existing bookings would open it up.'
              : ' — no capacity available at this location and time.'}
          </span>
          <button
            onClick={() => setResult(null)}
            className="text-yellow-900 hover:text-yellow-600"
            type="button"
          >
            ×
          </button>
        </div>
      )}

      {reshuffleModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setReshuffleModal(null)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="reshuffle-modal-title"
        >
          <div
            className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full m-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-2">
              <h2 id="reshuffle-modal-title" className="text-lg font-bold text-blue-900">
                Reshuffle available
              </h2>
              <button
                onClick={() => setReshuffleModal(null)}
                disabled={pending}
                className="text-gray-500 hover:text-gray-900 disabled:opacity-50 -mt-1"
                type="button"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <p className="text-sm text-gray-700 mb-3">
              No qualified provider is directly free at this time, but moving
              some existing bookings would open one up:
            </p>
            <ul className="list-disc list-inside text-sm mb-4 text-blue-900">
              {reshuffleModal.movedPins.map((m) => (
                <li key={m.slotId}>
                  Move existing booking: provider{' '}
                  {providerName(m.fromProviderId)} →{' '}
                  {providerName(m.toProviderId)}
                </li>
              ))}
              <li>
                Assign new booking to{' '}
                {providerName(reshuffleModal.newAssignment.providerId)} at{' '}
                {formatTime(reshuffleModal.newAssignment.slot.start, timezone)}
                {reshuffleModal.newAssignment.slot.roomId && rooms
                  ? ` in ${roomName(reshuffleModal.newAssignment.slot.roomId)}`
                  : ''}
                {locationSuffix(reshuffleModal.newAssignment.slot.locationId)}
                .
              </li>
            </ul>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setReshuffleModal(null)}
                disabled={pending}
                className="px-4 py-1 bg-gray-300 rounded hover:bg-gray-400 disabled:opacity-50"
                type="button"
              >
                Cancel
              </button>
              <button
                onClick={handleApproveReshuffleModal}
                disabled={pending}
                className="px-4 py-1 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
                type="button"
              >
                {pending ? 'Applying…' : 'Approve'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const AnonymousCellContent: React.FC<{
  cell: AnonymousCalendarCell;
  pending: boolean;
  unavailableLabel: string;
  handleCellClick: (
    cell: AnonymousCalendarCell | KnownProviderCalendarCell,
    providerId?: string,
  ) => void;
}> = ({ cell, pending, unavailableLabel, handleCellClick }) => {
  const { state } = cell;
  switch (state.kind) {
    case 'available': {
      const booked = state.bookedCount ?? 0;
      return (
        <td
          className="border border-gray-300 px-2 py-1 bg-emerald-50 hover:bg-emerald-200 cursor-pointer text-xs text-emerald-900"
          onClick={() => handleCellClick(cell)}
        >
          {pending
            ? '…'
            : booked > 0
              ? `Booked ×${booked} · book more`
              : 'book'}
        </td>
      );
    }
    case 'unavailable':
      return (
        <td className="border border-gray-300 px-2 py-1 bg-rose-100 text-xs text-rose-700">
          {unavailableLabel}
        </td>
      );
    case 'out-of-day':
      return <td className="border border-gray-300 px-2 py-1 bg-gray-100" />;
    case 'unavailable-reshufflable':
      return (
        <td
          className="border border-gray-300 px-2 py-1 bg-yellow-100 hover:bg-yellow-200 cursor-pointer text-xs text-yellow-700"
          onClick={() => handleCellClick(cell)}
        >
          No qualified provider free - Reshuffle available
        </td>
      );
  }
};

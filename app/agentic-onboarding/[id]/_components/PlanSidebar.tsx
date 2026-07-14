// Live view of the seed plan the assistant has recorded so far. Grouped
// by entity so the demo audience can watch the plan accrete as the
// conversation progresses. Also surfaces flag_unsupported entries so
// primitives-gap tradeoffs stay visible.

'use client';

import type { SeedPlan } from '@/app/_actions/agentic';

interface PlanSidebarProps {
  plan: SeedPlan;
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section className="border-b border-zinc-200 pb-2 last:border-b-0">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-1">
        {title} <span className="text-zinc-400">({count})</span>
      </h3>
      <ul className="text-sm space-y-0.5">{children}</ul>
    </section>
  );
}

function formatHours(startIso: string, endIso: string): string {
  const s = startIso.slice(11, 16);
  const e = endIso.slice(11, 16);
  const d = startIso.slice(0, 10);
  return `${d} ${s}–${e}`;
}

export function PlanSidebar({ plan }: PlanSidebarProps) {
  const nothingRecorded =
    plan.locations.length === 0 &&
    plan.services.length === 0 &&
    plan.providers.length === 0 &&
    plan.unsupported.length === 0;

  const locationName = (id: string) =>
    plan.locations.find((l) => l.id === id)?.name ?? id.slice(0, 6);
  const serviceName = (id: string) =>
    plan.services.find((s) => s.id === id)?.name ?? id.slice(0, 6);
  const providerName = (id: string) =>
    plan.providers.find((p) => p.id === id)?.name ?? id.slice(0, 6);

  return (
    <aside className="border border-zinc-300 rounded p-3 bg-white space-y-3 max-h-[calc(60vh+80px)] overflow-y-auto">
      <div className="text-sm font-semibold text-zinc-900">Recorded plan</div>
      {nothingRecorded && (
        <p className="text-xs italic text-zinc-500">
          Nothing recorded yet. As the assistant learns about your practice,
          entities will appear here.
        </p>
      )}

      <Section title="Locations" count={plan.locations.length}>
        {plan.locations.map((l) => (
          <li key={l.id}>
            {l.name}{' '}
            <span className="text-xs text-zinc-500">
              ({l.timezone ?? 'no timezone'})
            </span>
          </li>
        ))}
      </Section>

      <Section title="Location schedules" count={plan.locationSchedules.length}>
        {plan.locationSchedules.map((s) => (
          <li key={s.id}>
            <span className="font-mono text-xs text-zinc-600">
              {locationName(s.locationId)}
            </span>{' '}
            · {formatHours(s.start, s.end)}
            {s.capacity !== undefined && (
              <span className="text-zinc-500"> · cap {s.capacity}</span>
            )}
          </li>
        ))}
      </Section>

      <Section title="Services" count={plan.services.length}>
        {plan.services.map((s) => (
          <li key={s.id}>
            {s.name}{' '}
            <span className="text-zinc-500 text-xs">
              ({s.durationMinutes}m,{' '}
              {s.requiresProvider ? 'provider-scheduled' : 'location-scheduled'}
              {s.bookingCadenceMinutes
                ? `, cadence ${s.bookingCadenceMinutes}m`
                : ''}
              {s.requiresRoom ? ', needs room' : ''})
            </span>
          </li>
        ))}
      </Section>

      <Section title="Providers" count={plan.providers.length}>
        {plan.providers.map((p) => (
          <li key={p.id}>{p.name}</li>
        ))}
      </Section>

      <Section title="Qualifications" count={plan.qualifications.length}>
        {plan.qualifications.map((q, i) => (
          <li key={i} className="text-xs">
            {providerName(q.providerId)} → {serviceName(q.serviceId)}
          </li>
        ))}
      </Section>

      <Section title="Provider schedules" count={plan.providerSchedules.length}>
        {plan.providerSchedules.map((s) => (
          <li key={s.id} className="text-xs">
            {providerName(s.providerId)} @ {locationName(s.locationId)} ·{' '}
            {formatHours(s.start, s.end)}
          </li>
        ))}
      </Section>

      <Section title="Rooms" count={plan.rooms.length}>
        {plan.rooms.map((r) => (
          <li key={r.id}>
            {r.name}{' '}
            <span className="text-xs text-zinc-500">
              ({r.type} @ {locationName(r.locationId)})
            </span>
          </li>
        ))}
      </Section>

      <Section
        title="Room requirements"
        count={plan.serviceRoomRequirements.length}
      >
        {plan.serviceRoomRequirements.map((r, i) => (
          <li key={i} className="text-xs">
            {serviceName(r.serviceId)} needs {r.roomType}
          </li>
        ))}
      </Section>

      <Section title="Pinned slots" count={plan.pinnedSlots.length}>
        {plan.pinnedSlots.map((p) => (
          <li key={p.id} className="text-xs">
            {serviceName(p.serviceId)} · {formatHours(p.start, p.end)}
          </li>
        ))}
      </Section>

      {plan.unsupported.length > 0 && (
        <section className="pt-2 border-t border-amber-300">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-700 mb-1">
            Unsupported ({plan.unsupported.length})
          </h3>
          <ul className="text-sm space-y-2">
            {plan.unsupported.map((u, i) => (
              <li
                key={i}
                className={`px-2 py-1 rounded text-xs ${
                  u.severity === 'blocking'
                    ? 'bg-red-50 border border-red-200 text-red-900'
                    : 'bg-amber-50 border border-amber-200 text-amber-900'
                }`}
              >
                <span className="font-semibold uppercase text-[10px]">
                  {u.severity}
                </span>
                <div>{u.description}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

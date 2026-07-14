// Index page for agentic-onboarding. Shows past setups (newest first)
// and a button to start a new one. Server-rendered; the start button
// is a tiny client component that invokes the createSetup server
// action and pushes to the new setup's detail route.

import Link from 'next/link';
import { listSetups } from '@/app/_actions/agentic';
import { ExportSetupButton } from './_components/ExportSetupButton';
import { ReadOnlyBanner } from './_components/ReadOnlyBanner';
import { StartSetupButton } from './_components/StartSetupButton';

export const dynamic = 'force-dynamic';

const STATUS_LABELS: Record<string, string> = {
  'in-progress': 'In progress',
  committed: 'Committed',
  abandoned: 'Abandoned',
};

const STATUS_BADGE_CLASSES: Record<string, string> = {
  'in-progress': 'bg-amber-100 text-amber-900',
  committed: 'bg-emerald-100 text-emerald-900',
  abandoned: 'bg-zinc-100 text-zinc-700',
};

function formatDate(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export default async function AgenticOnboardingIndex() {
  const setups = await listSetups();

  return (
    <article className="prose prose-slate lg:prose-lg max-w-3xl">
      <h1>Agentic onboarding</h1>
      <p>
        Describe your practice in plain language; an LLM-driven assistant
        gathers what it needs, then drafts a sched-linx scenario seeded with
        providers, services, rooms, and schedules that match your context.
        Each setup is preserved so you can review the conversation, jump to
        the resulting scenario, or replay the session for a live demo.
      </p>

      <ReadOnlyBanner />

      <div className="my-6">
        <StartSetupButton />
      </div>

      <h2>Past setups</h2>
      {setups.length === 0 ? (
        <p className="italic text-zinc-500">
          No setups yet. Click <em>Start a new setup</em> above.
        </p>
      ) : (
        <ul className="not-prose space-y-2 my-4">
          {setups.map((s) => (
            <li
              key={s.id}
              className="border border-zinc-300 rounded p-3 flex items-center gap-3 justify-between"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Link
                    href={`/agentic-onboarding/${s.id}`}
                    className="font-medium text-blue-700 hover:underline"
                  >
                    {s.title ?? 'Untitled setup'}
                  </Link>
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${STATUS_BADGE_CLASSES[s.status] ?? 'bg-zinc-100'}`}
                  >
                    {STATUS_LABELS[s.status] ?? s.status}
                  </span>
                </div>
                <div className="text-xs text-zinc-600 mt-1 font-mono">
                  tag: {s.tag} · created {formatDate(s.createdAt)}
                </div>
              </div>
              <div className="flex items-center gap-3 whitespace-nowrap">
                {s.status === 'committed' && (
                  <>
                    <Link
                      href={`/admin/${s.tag}/schedule`}
                      className="text-sm text-blue-700 hover:underline"
                    >
                      Manage schedule →
                    </Link>
                    <Link
                      href={`/scenarios/agentic/${s.tag}`}
                      className="text-sm text-blue-700 hover:underline"
                    >
                      Open calendar →
                    </Link>
                  </>
                )}
                <ExportSetupButton setupId={s.id} tag={s.tag} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

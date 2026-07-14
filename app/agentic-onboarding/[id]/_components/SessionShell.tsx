// Client wrapper that owns the mutable state for a single onboarding
// session: the seed plan (mutated by tool calls during the conversation)
// and the setup title (set by finalize_plan). Holds Chat on the left and
// PlanSidebar on the right, and exposes the commit button once the plan
// looks committable.

'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  commitSetup,
  type DialogMessage,
  type SeedPlan,
} from '@/app/_actions/agentic';
import { Chat } from './Chat';
import { PlanSidebar } from './PlanSidebar';

interface SessionShellProps {
  setupId: string;
  tag: string;
  initialTitle: string | null;
  initialDialog: DialogMessage[];
  initialPlan: SeedPlan;
  planSnapshots: SeedPlan[];
  status: string;
}

// The commit gate. A plan is committable once it has at least one
// location and one service; anything less won't produce anything the
// calendar can render. The model's finalize_plan signal is a stronger
// hint, but we let the user commit earlier if they want to poke at
// intermediate state.
function isCommittable(plan: SeedPlan): boolean {
  return plan.locations.length > 0 && plan.services.length > 0;
}

export function SessionShell({
  setupId,
  tag,
  initialTitle,
  initialDialog,
  initialPlan,
  planSnapshots,
  status: initialStatus,
}: SessionShellProps) {
  const router = useRouter();
  const [plan, setPlan] = useState<SeedPlan>(initialPlan);
  // Populated by Chat while replay is active; null when replay is off.
  // Sidebar reads this if set so the plan appears to grow alongside the
  // conversation instead of showing the final state throughout.
  const [replayPlan, setReplayPlan] = useState<SeedPlan | null>(null);
  const [title, setTitle] = useState<string | null>(initialTitle);
  const [status, setStatus] = useState<string>(initialStatus);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [committing, startCommit] = useTransition();

  const committable = useMemo(() => isCommittable(plan), [plan]);
  const alreadyCommitted = status === 'committed';
  const displayedPlan = replayPlan ?? plan;

  const handleCommit = () => {
    if (!committable || committing || alreadyCommitted) return;
    setCommitError(null);
    startCommit(async () => {
      try {
        await commitSetup(setupId);
        // Route straight into the schedule editor — the practice
        // manager's real work starts there, and the calendar is a
        // downstream view they can open once the schedule looks right.
        router.push(`/admin/${tag}/schedule`);
      } catch (err) {
        setCommitError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {title && (
        <div className="text-sm text-zinc-700 italic">
          Working title: <span className="font-medium not-italic">{title}</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_320px] gap-4">
        <Chat
          setupId={setupId}
          initialDialog={initialDialog}
          status={status}
          onPlanChange={(nextPlan, nextTitle) => {
            setPlan(nextPlan);
            if (nextTitle) setTitle(nextTitle);
          }}
          planSnapshots={planSnapshots}
          onReplayPlanChange={setReplayPlan}
        />
        <PlanSidebar plan={displayedPlan} />
      </div>

      <div className="flex items-center gap-3">
        {alreadyCommitted ? (
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-300 rounded px-3 py-1">
              Committed. Tag: <span className="font-mono">{tag}</span>
            </span>
            <button
              type="button"
              onClick={() => router.push(`/admin/${tag}/schedule`)}
              className="px-4 py-1 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Manage schedule →
            </button>
            <button
              type="button"
              onClick={() => router.push(`/scenarios/agentic/${tag}`)}
              className="px-4 py-1 bg-emerald-600 text-white rounded hover:bg-emerald-700"
            >
              Open calendar →
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              disabled={!committable || committing}
              onClick={handleCommit}
              className="px-4 py-2 bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
              title={
                committable
                  ? 'Seed the scenario into the database'
                  : 'Record at least one location and one service first'
              }
            >
              {committing ? 'Committing…' : 'Commit scenario'}
            </button>
            <span className="text-xs text-zinc-500">
              {committable
                ? 'Enough recorded to seed a scenario. Commit anytime.'
                : 'Not yet committable — need at least one location and one service.'}
            </span>
          </>
        )}
      </div>

      {commitError && (
        <div className="px-3 py-2 border border-red-300 bg-red-50 rounded text-red-800 text-sm">
          Commit failed: {commitError}
        </div>
      )}
    </div>
  );
}

// Detail page for a single agentic-onboarding session. Server-renders
// the metadata and hands the mutable state (dialog + seed plan) to a
// client shell that manages both the chat and the plan sidebar.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSetup } from '@/app/_actions/agentic';
import { ReadOnlyBanner } from '../_components/ReadOnlyBanner';
import { EditableTitle } from './_components/EditableTitle';
import { SessionShell } from './_components/SessionShell';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function AgenticSetupDetail({ params }: PageProps) {
  const { id } = await params;
  const setup = await getSetup(id);
  if (!setup) notFound();

  return (
    <article className="max-w-5xl">
      <div className="mb-4">
        <Link
          href="/agentic-onboarding"
          className="text-sm text-blue-700 hover:underline"
        >
          ← Back to setups
        </Link>
      </div>

      <ReadOnlyBanner />

      <header className="mb-6">
        <EditableTitle setupId={setup.id} initialTitle={setup.title} />
        <div className="text-sm text-zinc-600 mt-1 font-mono">
          tag: {setup.tag} · status: {setup.status}
        </div>
        {setup.useCaseSummary && (
          <p className="mt-2 text-sm text-zinc-700 max-w-2xl">
            {setup.useCaseSummary}
          </p>
        )}
      </header>

      <SessionShell
        setupId={setup.id}
        tag={setup.tag}
        initialTitle={setup.title}
        initialDialog={setup.dialog}
        initialPlan={setup.seedPlan}
        planSnapshots={setup.planSnapshots}
        status={setup.status}
      />
    </article>
  );
}

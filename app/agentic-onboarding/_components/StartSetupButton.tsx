'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createSetup } from '@/app/_actions/agentic';
import { isAgenticReadOnly } from '@/src/env';

export function StartSetupButton() {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  // Hidden entirely in read-only mode. The banner on the page already
  // explains why and directs the visitor to fork the repo, so a
  // disabled button would be redundant noise.
  if (isAgenticReadOnly()) return null;

  return (
    <button
      type="button"
      onClick={() => {
        startTransition(async () => {
          const { id } = await createSetup();
          router.push(`/agentic-onboarding/${id}`);
        });
      }}
      disabled={pending}
      className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
    >
      {pending ? 'Starting…' : 'Start a new setup'}
    </button>
  );
}

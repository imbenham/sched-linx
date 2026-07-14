// Per-row export trigger for the setups list. Calls the exportSetup
// server action, wraps the returned fixture in a Blob, and triggers a
// browser download. The resulting JSON is the shape the deploy's
// build-time seed script consumes to preload demos.

'use client';

import { useState, useTransition } from 'react';
import { exportSetup } from '@/app/_actions/agentic';

interface ExportSetupButtonProps {
  setupId: string;
  tag: string;
}

export function ExportSetupButton({ setupId, tag }: ExportSetupButtonProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleExport = () => {
    setError(null);
    startTransition(async () => {
      try {
        const fixture = await exportSetup(setupId);
        const blob = new Blob([JSON.stringify(fixture, null, 2)], {
          type: 'application/json',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `sched-linx-${tag}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <div className="flex flex-col items-end">
      <button
        type="button"
        onClick={handleExport}
        disabled={pending}
        className="text-sm text-blue-700 hover:underline disabled:opacity-50"
        title="Download this setup as a JSON fixture"
      >
        {pending ? 'Exporting…' : 'Export ↓'}
      </button>
      {error && (
        <span className="text-xs text-red-700 mt-0.5">{error}</span>
      )}
    </div>
  );
}

// Click-to-edit title for an onboarding session. Users can rename a
// setup at any point during the conversation so the setup list stays
// readable. The LLM's `finalize_plan` still sets the title on commit,
// but a user rename takes precedence if it happens after — most-recent
// write wins, which is what a human editor would expect.

'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { updateSetupTitle } from '@/app/_actions/agentic';
import { isAgenticReadOnly } from '@/src/env';

interface EditableTitleProps {
  setupId: string;
  initialTitle: string | null;
}

const PLACEHOLDER = 'Untitled setup';

export function EditableTitle({ setupId, initialTitle }: EditableTitleProps) {
  const router = useRouter();
  const [title, setTitle] = useState<string | null>(initialTitle);
  const readOnly = isAgenticReadOnly();
  if (readOnly) {
    // Render a plain title with no rename affordance. Server also
    // rejects updateSetupTitle in this mode.
    return (
      <h1
        className={`text-2xl font-semibold m-0 ${
          title ? 'text-zinc-900' : 'italic text-zinc-500'
        }`}
      >
        {title ?? PLACEHOLDER}
      </h1>
    );
  }
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const beginEdit = () => {
    setDraft(title ?? '');
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setDraft('');
    setError(null);
  };

  const save = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setError('Title cannot be empty.');
      return;
    }
    if (trimmed === title) {
      cancel();
      return;
    }
    startSave(async () => {
      try {
        await updateSetupTitle(setupId, trimmed);
        setTitle(trimmed);
        setEditing(false);
        setError(null);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  if (editing) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                save();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              }
            }}
            disabled={saving}
            maxLength={120}
            className="text-2xl font-semibold border border-zinc-300 rounded px-2 py-0.5 flex-1 disabled:opacity-50"
            placeholder={PLACEHOLDER}
          />
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={cancel}
            disabled={saving}
            className="px-3 py-1 text-sm text-zinc-600 hover:text-zinc-900 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
        {error && <div className="text-sm text-red-700">{error}</div>}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={beginEdit}
      className="group flex items-center gap-2 text-left"
      title="Click to rename"
    >
      <h1
        className={`text-2xl font-semibold m-0 ${
          title ? 'text-zinc-900' : 'italic text-zinc-500'
        }`}
      >
        {title ?? PLACEHOLDER}
      </h1>
      <span className="text-xs text-zinc-400 opacity-0 group-hover:opacity-100 transition-opacity">
        (click to rename)
      </span>
    </button>
  );
}

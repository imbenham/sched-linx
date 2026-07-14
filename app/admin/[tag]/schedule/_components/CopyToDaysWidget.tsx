// Small popover widget: pick target days-of-week to copy the current
// day's schedule to, with a destructive-action warning for target days
// that already have data. Reused by both the location capacity and
// provider shift sections.

'use client';

import { useState } from 'react';

interface DayOption {
  dow: number;      // 0-6, Date.getDay() convention
  label: string;    // "Mon", "Tue", ...
  hasData: boolean; // true when the target day already has rows in the DB
}

interface CopyToDaysWidgetProps {
  sourceLabel: string;              // e.g. "Monday", used in the button text
  otherDays: DayOption[];           // the six non-source days
  onApply: (targetDows: number[]) => void;
  applying: boolean;
  disabled?: boolean;
}

export function CopyToDaysWidget({
  sourceLabel,
  otherDays,
  onApply,
  applying,
  disabled,
}: CopyToDaysWidgetProps) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);

  const daysWithData = otherDays.filter(
    (d) => selected.has(d.dow) && d.hasData,
  );

  const closeAndReset = () => {
    setOpen(false);
    setSelected(new Set());
    setConfirming(false);
  };

  const toggle = (dow: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(dow)) next.delete(dow);
      else next.add(dow);
      return next;
    });
    setConfirming(false);
  };

  const handleApply = () => {
    if (selected.size === 0) return;
    if (daysWithData.length > 0 && !confirming) {
      setConfirming(true);
      return;
    }
    onApply(Array.from(selected));
    closeAndReset();
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled || applying}
        className="px-3 py-1 text-sm border border-zinc-300 rounded hover:bg-zinc-50 disabled:opacity-50"
        title={`Copy ${sourceLabel}'s schedule to other days`}
      >
        Copy to…
      </button>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={closeAndReset}
        className="px-3 py-1 text-sm border border-zinc-400 rounded bg-zinc-100"
      >
        Copy to…
      </button>
      <div className="absolute right-0 mt-1 z-10 bg-white border border-zinc-300 rounded shadow-lg p-3 w-72">
        <div className="text-xs font-medium text-zinc-700 mb-2">
          Copy {sourceLabel}'s schedule to:
        </div>
        <ul className="space-y-1 mb-3">
          {otherDays.map((d) => (
            <li key={d.dow}>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={selected.has(d.dow)}
                  onChange={() => toggle(d.dow)}
                  disabled={applying}
                />
                <span>{d.label}</span>
                {d.hasData && (
                  <span
                    className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-1"
                    title="This day already has a schedule that would be overwritten."
                  >
                    has data
                  </span>
                )}
              </label>
            </li>
          ))}
        </ul>

        {confirming && daysWithData.length > 0 && (
          <div className="mb-3 p-2 border border-red-300 bg-red-50 rounded text-xs text-red-900">
            <div className="font-semibold mb-1">Overwrite existing data?</div>
            <div>
              {daysWithData.map((d) => d.label).join(', ')} already{' '}
              {daysWithData.length === 1 ? 'has' : 'have'} a schedule. Copying
              will replace it.
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 justify-end">
          <button
            type="button"
            onClick={closeAndReset}
            disabled={applying}
            className="px-2 py-1 text-xs text-zinc-600 hover:text-zinc-900 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={selected.size === 0 || applying}
            className={`px-3 py-1 text-xs rounded text-white disabled:opacity-50 ${
              confirming && daysWithData.length > 0
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {applying
              ? 'Applying…'
              : confirming && daysWithData.length > 0
                ? 'Overwrite'
                : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Client-side chat surface for the agentic-onboarding session.
//
// Renders text blocks as speech bubbles. Tool activity from an assistant
// turn is collapsed into a single italic summary line ("Recorded 3
// locations, 2 services") — the sidebar shows the concrete outcome, so
// the chat doesn't need per-call chips. Optimistically appends the
// user's message, then swaps in the authoritative dialog the server
// action returns.
//
// Also supports a "replay" mode for demos: the dialog empties, and the
// user drives it forward one turn at a time (or auto-plays at a fixed
// cadence). Between a user message and the next assistant turn, a
// "thinking…" placeholder is shown so the pacing feels live.

'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  sendUserMessage,
  type DialogMessage,
  type SeedPlan,
  type StoredContentBlock,
} from '@/app/_actions/agentic';
import { isAgenticReadOnly } from '@/src/env';

interface ChatProps {
  setupId: string;
  initialDialog: DialogMessage[];
  status: string;
  onPlanChange?: (plan: SeedPlan, title: string | null) => void;
  // Optional per-turn plan snapshots for replay mode. Length must be
  // initialDialog.length + 1 (snapshot[i] = plan after dialog[0..i-1]).
  // Chat surfaces the appropriate snapshot via onReplayPlanChange as
  // the user advances through the replay.
  planSnapshots?: SeedPlan[];
  onReplayPlanChange?: (plan: SeedPlan | null) => void;
}

// Session is read-only when its status has moved past in-progress OR
// when the deploy is running in agentic-read-only mode. Either way,
// input is hidden; only the replay controls remain.
const isReadOnly = (status: string) =>
  status !== 'in-progress' || isAgenticReadOnly();

function formatTime(iso: string): string {
  return new Date(iso).toISOString().slice(11, 19) + ' UTC';
}

function extractText(blocks: StoredContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<StoredContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// Human labels for each tool. Grouped by verb (recorded/removed/flagged/
// finalized) and by human-facing noun so a burst of tool calls collapses
// into a compact line the user can actually parse.
const TOOL_LABELS: Record<
  string,
  { verb: 'recorded' | 'removed' | 'flagged' | 'finalized'; noun: string }
> = {
  add_location: { verb: 'recorded', noun: 'location' },
  remove_location: { verb: 'removed', noun: 'location' },
  set_location_timezone: { verb: 'recorded', noun: 'location timezone' },
  add_location_schedule: { verb: 'recorded', noun: 'location schedule' },
  remove_location_schedule: { verb: 'removed', noun: 'location schedule' },
  add_service: { verb: 'recorded', noun: 'service' },
  remove_service: { verb: 'removed', noun: 'service' },
  add_service_room_requirement: {
    verb: 'recorded',
    noun: 'room requirement',
  },
  remove_service_room_requirement: {
    verb: 'removed',
    noun: 'room requirement',
  },
  add_provider: { verb: 'recorded', noun: 'provider' },
  remove_provider: { verb: 'removed', noun: 'provider' },
  add_qualification: { verb: 'recorded', noun: 'qualification' },
  remove_qualification: { verb: 'removed', noun: 'qualification' },
  add_provider_schedule: { verb: 'recorded', noun: 'provider schedule' },
  remove_provider_schedule: { verb: 'removed', noun: 'provider schedule' },
  add_room: { verb: 'recorded', noun: 'room' },
  remove_room: { verb: 'removed', noun: 'room' },
  add_pinned_slot: { verb: 'recorded', noun: 'pinned slot' },
  remove_pinned_slot: { verb: 'removed', noun: 'pinned slot' },
  flag_unsupported: { verb: 'flagged', noun: 'unsupported detail' },
  finalize_plan: { verb: 'finalized', noun: 'plan' },
};

function pluralize(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`;
}

function joinCounts(counts: Map<string, number>): string {
  const parts = Array.from(counts.entries()).map(
    ([noun, n]) => `${n} ${pluralize(noun, n)}`,
  );
  if (parts.length <= 1) return parts.join('');
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

// Turn the tool_use blocks from an assistant turn into 0..N summary
// lines. One line per verb, collapsing multiple calls of the same kind
// into "3 locations, 2 services".
function summarizeToolCalls(blocks: StoredContentBlock[]): string[] {
  const added = new Map<string, number>();
  const removed = new Map<string, number>();
  let flagged = 0;
  let finalized = false;
  for (const b of blocks) {
    if (b.type !== 'tool_use') continue;
    const label = TOOL_LABELS[b.name];
    if (!label) continue;
    switch (label.verb) {
      case 'recorded':
        added.set(label.noun, (added.get(label.noun) ?? 0) + 1);
        break;
      case 'removed':
        removed.set(label.noun, (removed.get(label.noun) ?? 0) + 1);
        break;
      case 'flagged':
        flagged++;
        break;
      case 'finalized':
        finalized = true;
        break;
    }
  }
  const lines: string[] = [];
  if (added.size) lines.push(`Recorded ${joinCounts(added)}.`);
  if (removed.size) lines.push(`Removed ${joinCounts(removed)}.`);
  if (flagged)
    lines.push(
      `Flagged ${flagged} ${pluralize('unsupported detail', flagged)}.`,
    );
  if (finalized) lines.push(`Marked the plan ready to commit.`);
  return lines;
}

// Auto-play interval when the user hits Play in replay mode. Long
// enough to read the freshly-revealed message, short enough that the
// demo doesn't drag.
const REPLAY_INTERVAL_MS = 5500;

export function Chat({
  setupId,
  initialDialog,
  status,
  onPlanChange,
  planSnapshots,
  onReplayPlanChange,
}: ChatProps) {
  const [dialog, setDialog] = useState<DialogMessage[]>(initialDialog);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Replay mode: hides the input and only shows the first N displayed
  // messages. Advancing past a user turn shows a "thinking…" bubble
  // until the next click / auto-advance reveals the assistant reply.
  const [replayMode, setReplayMode] = useState(false);
  const [replayCount, setReplayCount] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [dialog.length, replayCount, replayMode]);

  const readOnly = isReadOnly(status);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || pending || readOnly) return;
    setError(null);
    const optimistic: DialogMessage[] = [
      ...dialog,
      {
        role: 'user',
        content: [{ type: 'text', text: trimmed }],
        timestamp: new Date().toISOString(),
      },
    ];
    setDialog(optimistic);
    setInput('');
    startTransition(async () => {
      try {
        const { dialog: authoritative, seedPlan, title } = await sendUserMessage(
          setupId,
          trimmed,
        );
        setDialog(authoritative);
        onPlanChange?.(seedPlan, title);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setDialog((prev) => prev.slice(0, -1));
        setInput(trimmed);
      }
    });
  };

  // Suppress purely-synthetic tool-result user turns, then coalesce
  // any runs of consecutive tool-only assistant turns into one virtual
  // message. The model often chunks its tool calls across several
  // response iterations (each still stop_reason='tool_use'), which
  // otherwise renders as a stack of near-identical "Recorded N ..."
  // lines. Merging combines their counts into a single summary.
  const hasText = (msg: DialogMessage): boolean =>
    msg.content.some((b) => b.type === 'text' && b.text.trim() !== '');
  const displayDialog: DialogMessage[] = [];
  // For each displayDialog entry, remember the highest raw-dialog index
  // that contributed to it (either by pushing or by merging in). Skipped
  // user messages don't merge, so their tool_result-only content doesn't
  // "belong" to any display entry; the snapshot index still advances
  // through them naturally on the plan-snapshots array.
  const displayToLastRaw: number[] = [];
  for (let rawIdx = 0; rawIdx < dialog.length; rawIdx++) {
    const msg = dialog[rawIdx]!;
    if (msg.role === 'user' && !hasText(msg)) continue;
    const prev = displayDialog[displayDialog.length - 1];
    // A tool-only assistant turn is a continuation of the previous
    // assistant burst — pull its tool_uses onto whatever came before
    // (whether that turn had text or not). This keeps preambles like
    // "Let me add all the windows now:" attached to a single aggregated
    // "Recorded N ..." summary instead of splitting across turns.
    const shouldMerge =
      msg.role === 'assistant' &&
      !hasText(msg) &&
      prev &&
      prev.role === 'assistant';
    if (shouldMerge) {
      prev.content = [...prev.content, ...msg.content];
      prev.timestamp = msg.timestamp;
      displayToLastRaw[displayToLastRaw.length - 1] = rawIdx;
    } else {
      displayDialog.push({ ...msg, content: [...msg.content] });
      displayToLastRaw.push(rawIdx);
    }
  }

  // In replay mode, only show the first `replayCount` messages. The
  // full displayDialog stays computed above so counters and controls
  // always know the true total.
  const visibleDialog = replayMode
    ? displayDialog.slice(0, replayCount)
    : displayDialog;
  const replayAtEnd = replayMode && replayCount >= displayDialog.length;
  // Show a "thinking…" placeholder when we've just revealed a user
  // turn and the next queued turn is from the assistant — makes the
  // pacing feel like the model is composing a reply.
  const showReplayThinking =
    replayMode &&
    !replayAtEnd &&
    visibleDialog[visibleDialog.length - 1]?.role === 'user' &&
    displayDialog[replayCount]?.role === 'assistant';

  const enterReplay = () => {
    setReplayMode(true);
    setReplayCount(0);
    setReplayPlaying(false);
  };
  const exitReplay = () => {
    setReplayMode(false);
    setReplayPlaying(false);
    setReplayCount(0);
  };
  const advanceReplay = () => {
    setReplayCount((c) => Math.min(c + 1, displayDialog.length));
  };
  const resetReplay = () => {
    setReplayCount(0);
    setReplayPlaying(false);
  };

  useEffect(() => {
    if (!replayPlaying) return;
    if (replayCount >= displayDialog.length) {
      setReplayPlaying(false);
      return;
    }
    // First reveal fires immediately on Play — waiting a full interval
    // for an empty screen feels broken. Subsequent reveals pace normally.
    const delay = replayCount === 0 ? 0 : REPLAY_INTERVAL_MS;
    const t = setTimeout(() => {
      setReplayCount((c) => Math.min(c + 1, displayDialog.length));
    }, delay);
    return () => clearTimeout(t);
  }, [replayPlaying, replayCount, displayDialog.length]);

  // Push the plan snapshot that matches the currently-revealed display
  // count. When replay is off, null clears any override so the parent
  // falls back to the true plan. Guarded on planSnapshots being present
  // so the callback stays a no-op in scenarios that don't use replay.
  useEffect(() => {
    if (!onReplayPlanChange) return;
    if (!replayMode || !planSnapshots || planSnapshots.length === 0) {
      onReplayPlanChange(null);
      return;
    }
    if (replayCount === 0) {
      onReplayPlanChange(planSnapshots[0] ?? null);
      return;
    }
    const lastRaw = displayToLastRaw[replayCount - 1];
    if (lastRaw === undefined) return;
    const snap = planSnapshots[lastRaw + 1] ?? planSnapshots[planSnapshots.length - 1];
    onReplayPlanChange(snap ?? null);
    // displayToLastRaw is stable-shaped for a given dialog; we don't
    // want it in the dependency array or the effect fires every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayMode, replayCount, planSnapshots, onReplayPlanChange]);

  return (
    <div className="flex flex-col gap-4">
      {/* Replay controls — off by default; enter Replay to demo the
          conversation turn by turn without the LLM re-running. */}
      <div className="flex items-center gap-2 text-sm">
        {!replayMode ? (
          <button
            type="button"
            onClick={enterReplay}
            disabled={displayDialog.length === 0}
            className="px-3 py-1 border border-zinc-300 rounded hover:bg-zinc-50 disabled:opacity-50"
            title="Replay this conversation turn-by-turn for a demo"
          >
            ▶ Replay
          </button>
        ) : (
          <>
            <span className="font-mono text-xs text-zinc-600">
              {replayCount} / {displayDialog.length}
            </span>
            <button
              type="button"
              onClick={advanceReplay}
              disabled={replayAtEnd || replayPlaying}
              className="px-3 py-1 border border-zinc-300 rounded hover:bg-zinc-50 disabled:opacity-50"
            >
              Next →
            </button>
            <button
              type="button"
              onClick={() => setReplayPlaying((p) => !p)}
              disabled={replayAtEnd}
              className="px-3 py-1 border border-zinc-300 rounded hover:bg-zinc-50 disabled:opacity-50"
            >
              {replayPlaying ? '⏸ Pause' : '⏵ Play'}
            </button>
            <button
              type="button"
              onClick={resetReplay}
              className="px-3 py-1 border border-zinc-300 rounded hover:bg-zinc-50"
            >
              ↺ Reset
            </button>
            <button
              type="button"
              onClick={exitReplay}
              className="ml-auto px-3 py-1 border border-zinc-300 rounded hover:bg-zinc-50"
            >
              Exit replay
            </button>
          </>
        )}
      </div>

      <div className="border border-zinc-300 rounded p-4 min-h-[400px] max-h-[60vh] overflow-y-auto bg-zinc-50">
        {visibleDialog.length === 0 ? (
          <p className="italic text-zinc-500">
            {replayMode
              ? 'Press Next or Play to start the replay.'
              : 'No messages yet. Send a first message below to start the conversation — describe your practice or just say hi to get started.'}
          </p>
        ) : (
          <ul className="space-y-4">
            {visibleDialog.map((msg, i) => {
              const text = extractText(msg.content);
              const toolSummary =
                msg.role === 'assistant' ? summarizeToolCalls(msg.content) : [];
              return (
                <li
                  key={i}
                  className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
                >
                  <div className="text-xs text-zinc-500 mb-1 font-mono">
                    {msg.role} · {formatTime(msg.timestamp)}
                  </div>
                  {text && (
                    <div
                      className={`px-3 py-2 rounded-lg max-w-[85%] prose prose-sm max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-headings:mt-2 prose-headings:mb-1 prose-code:before:content-none prose-code:after:content-none ${
                        msg.role === 'user'
                          ? 'bg-blue-100 text-blue-950 prose-strong:text-blue-950'
                          : 'bg-white border border-zinc-300 text-zinc-900'
                      }`}
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {text}
                      </ReactMarkdown>
                    </div>
                  )}
                  {toolSummary.length > 0 && (
                    <div className="mt-1 max-w-[85%] text-xs italic text-zinc-500">
                      {toolSummary.map((line, j) => (
                        <div key={j}>{line}</div>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
            {(pending || showReplayThinking) && (
              <li className="flex flex-col items-start">
                <div className="text-xs text-zinc-500 mb-1 font-mono">
                  assistant · thinking…
                </div>
                <div className="px-3 py-2 rounded-lg bg-white border border-zinc-300 italic text-zinc-500">
                  …
                </div>
              </li>
            )}
          </ul>
        )}
        <div ref={bottomRef} />
      </div>

      {error && (
        <div className="px-3 py-2 border border-red-300 bg-red-50 rounded text-red-800 text-sm">
          {error}
        </div>
      )}

      {replayMode ? null : readOnly ? (
        <div className="italic text-zinc-500 text-sm">
          This setup is {status}; the conversation is read-only.
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
            placeholder="Describe your practice, ask a question, or respond to the assistant…"
            disabled={pending}
            rows={3}
            className="flex-1 border border-zinc-300 rounded px-3 py-2 text-sm disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={pending || !input.trim()}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 self-end"
          >
            {pending ? 'Sending…' : 'Send'}
          </button>
        </form>
      )}
    </div>
  );
}


// Server component that renders a "this is a live demo, fork on
// GitHub to run it yourself" banner when NEXT_PUBLIC_AGENTIC_READONLY
// is set. Returns null in interactive (dev / fork-with-key) mode so
// it costs nothing outside the deploy.

import { githubUrl, isAgenticReadOnly } from '@/src/env';

export function ReadOnlyBanner() {
  if (!isAgenticReadOnly()) return null;
  return (
    <div className="not-prose my-4 p-4 border border-amber-300 bg-amber-50 rounded text-sm text-amber-900">
      <div className="font-semibold mb-1">Live demo mode</div>
      <p>
        New agentic conversations and messages are disabled on this deploy
        to protect the shared Anthropic key. The pre-loaded sessions below
        are viewable in full and can be replayed turn-by-turn for a live
        demo feel.
      </p>
      <p className="mt-2">
        Want to run this end-to-end?{' '}
        <a
          href={githubUrl()}
          target="_blank"
          rel="noreferrer noopener"
          className="underline font-medium"
        >
          Fork on GitHub
        </a>{' '}
        and add your own <code>ANTHROPIC_API_KEY</code>.
      </p>
    </div>
  );
}

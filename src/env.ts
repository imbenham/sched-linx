// Small env-flag helpers used by both server actions and client
// components. Values are read from `process.env` at each call so
// per-request env changes (Vercel preview vs. prod) surface correctly
// rather than being frozen at module-import time.

// True when the deployed instance shouldn't run live Anthropic calls —
// no new agentic conversations, no new messages on existing ones.
// Pre-seeded transcripts remain viewable + replayable. Set
// `NEXT_PUBLIC_AGENTIC_READONLY=1` on the Vercel project to enable.
export function isAgenticReadOnly(): boolean {
  return process.env.NEXT_PUBLIC_AGENTIC_READONLY === '1';
}

// GitHub URL surfaced in the read-only banner so visitors know where
// to fork. Falls back to the canonical repo URL if the env var isn't
// set — override with `NEXT_PUBLIC_GITHUB_URL` for staging/fork demos.
export function githubUrl(): string {
  return (
    process.env.NEXT_PUBLIC_GITHUB_URL ?? 'https://github.com/imbenham/sched-linx'
  );
}

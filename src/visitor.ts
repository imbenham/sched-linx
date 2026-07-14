// Visitor-scoped tag prefixes. Every visitor gets a `visitor_uuid`
// cookie (set by middleware.ts); this module composes it into the tags
// used by scenario reads/writes so one visitor's bookings and admin
// edits don't pollute another visitor's view.
//
// Pre-seeded agentic sessions keep their global `agentic-<id>` tag and
// are NOT visitor-scoped — every visitor sees the same demo transcripts.
// Only scenarios 1–5 and any freshly-created (post-cookie) content go
// through this helper.

import { cookies } from 'next/headers';
import { VISITOR_COOKIE_NAME } from './visitor-cookie';

// Fallback used when the middleware hasn't run yet (test scripts,
// standalone tools calling server code without an HTTP request). All
// such callers share a single "anon" bucket, which is acceptable
// because they aren't real visitors.
const ANON = 'anon';

export async function getVisitorId(): Promise<string> {
  const c = await cookies();
  return c.get(VISITOR_COOKIE_NAME)?.value ?? ANON;
}

// Compose a per-visitor tag from a stable base identifier (e.g.
// "scenario1", "scenario3"). Uses the first 8 chars of the uuid so the
// tag stays reasonably short while remaining collision-free at any
// realistic traffic level.
export async function getVisitorTag(base: string): Promise<string> {
  const id = await getVisitorId();
  return `v-${id.slice(0, 8)}-${base}`;
}

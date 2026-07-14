// Ensures every visitor has a stable `visitor_uuid` cookie. The uuid
// is used by src/visitor.ts to build per-visitor tag prefixes so one
// visitor's scenario bookings and admin edits don't pollute another's
// view on the deployed site. Runs at the edge before any route handler.
//
// Cookie handling:
//   - Missing (first visit or expired) → mint a fresh uuid.
//   - Present → keep the same uuid but refresh the maxAge, so active
//     use rolls the expiration forward instead of aging out at a fixed
//     date. Regular users effectively never lose their scope.
//
// On first visit the cookie isn't in the request yet at read time — so
// alongside setting the response cookie for the browser to persist, we
// also mutate the request cookies. That way `cookies()` calls in the
// server components rendering this same request see the fresh uuid
// instead of falling back to a shared "anon" scope.

import { NextResponse, type NextRequest } from 'next/server';
import { VISITOR_COOKIE_NAME } from '@/src/visitor-cookie';

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 year, rolling

export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  const existing = request.cookies.get(VISITOR_COOKIE_NAME)?.value;
  const uuid = existing ?? crypto.randomUUID();
  if (!existing) {
    request.cookies.set(VISITOR_COOKIE_NAME, uuid);
  }
  response.cookies.set(VISITOR_COOKIE_NAME, uuid, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}

// Skip Next.js internals and any explicitly static/health endpoints.
// Everything else — pages, server actions, route handlers — goes
// through the visitor-uuid check.
export const config = {
  matcher: '/((?!_next/static|_next/image|favicon.ico|api/health).*)',
};

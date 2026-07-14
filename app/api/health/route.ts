// Smoke endpoint — confirms the Next.js route-handler pipeline is wired
// up correctly. Not load-bearing for the scheduling product; tests that
// exercise this verify that our app/ layout + tsconfig + route shape
// hangs together.

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return NextResponse.json({ status: 'ok' });
}

import { describe, expect, it } from 'vitest';
import { GET } from '../app/api/health/route.js';

// The handler is just an exported async function; we can invoke it
// directly without spinning up the full Next server. This validates the
// route shape and the next/server import path without paying for a dev
// server boot.

describe('GET /api/health', () => {
  it('returns ok', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body).toEqual({ status: 'ok' });
  });
});

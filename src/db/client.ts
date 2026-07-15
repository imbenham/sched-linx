// Drizzle client factory. v1 uses pglite (embedded Postgres-in-WASM) — no
// Docker, no external server. The connection ergonomics match a regular
// postgres.js setup, so swapping to a real Postgres later is a one-import
// change in this file (plus the migrator path) and the rest of the
// codebase is untouched.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from './schema';
import { restoreAgenticFixture, type AgenticFixture } from './seed';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

// Create a fresh Drizzle/pglite client. Pass a directory path for
// file-backed persistence (dev), or omit for an in-memory instance
// (tests) — each call to createDatabase() with no arg yields an
// independent, ephemeral database.
export async function createDatabase(
  dataDir?: string | undefined,
): Promise<Database> {
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  return drizzle(pg, { schema });
}

// Apply all generated migrations to the given database. Reads from the
// `drizzle/` folder produced by `npm run db:generate`. Call once during
// app bootstrap and once per test setup.
export async function applyMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: './drizzle' });
}

// HMR-safe singleton for use from Next.js route handlers and server
// actions. Caches the migrated DB instance on globalThis so Next's
// dev-mode module re-evaluation doesn't recreate the database (and lose
// all state) on every save. Tests should keep using createDatabase()
// directly to get fresh, isolated instances.
type GlobalWithDb = typeof globalThis & {
  __schedLinxDb?: Promise<Database>;
};

export function getDatabase(dataDir?: string): Promise<Database> {
  const g = globalThis as GlobalWithDb;
  if (!g.__schedLinxDb) {
    g.__schedLinxDb = (async () => {
      const db = await createDatabase(await resolveDataDir(dataDir));
      await applyMigrations(db);
      // Re-hydrate the demo transcripts on every cold start. Cheap for
      // a small fixture set; skipped when running dev/test where the
      // file-backed DB already holds prior state.
      if (process.env.NODE_ENV === 'production') {
        await hydrateAgenticFixtures(db);
      }
      return db;
    })().catch((err) => {
      // Clear the singleton so the next call retries instead of returning
      // the cached rejection forever.
      delete g.__schedLinxDb;
      throw err;
    });
  }
  return g.__schedLinxDb;
}

// Storage-mode resolution.
//
//   Dev / test: `./local-db` (persists across HMR, easy to inspect).
//   Prod (Vercel serverless): `undefined` → in-memory pglite.
//     File-backed pglite on serverless is brittle (WASM binary
//     resolution, /tmp permissions, cold-start filesystem quirks). An
//     in-memory instance sidesteps all of that; the tradeoff is a
//     fresh DB on every cold start, so migrations + fixture restore
//     run each time. Both are cheap enough (~100ms combined for our
//     fixture set) that this is the right posture for a demo deploy.
//     Per-visitor state is cookie-tagged, so the ephemerality doesn't
//     leak across users.
async function resolveDataDir(explicit?: string): Promise<string | undefined> {
  if (explicit) return explicit;
  if (process.env.NODE_ENV !== 'production') return './local-db';
  return undefined;
}

// Load every JSON fixture in `.data/` and restore it into `db`. Called
// once per cold start in production. Silently skips a missing folder
// (fresh clone without any seeded transcripts).
async function hydrateAgenticFixtures(db: Database): Promise<void> {
  const dir = path.join(process.cwd(), '.data');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const raw = await readFile(path.join(dir, entry), 'utf8');
    const fixture = JSON.parse(raw) as AgenticFixture;
    await restoreAgenticFixture(db, fixture);
  }
}


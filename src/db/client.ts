// Drizzle client factory. v1 uses pglite (embedded Postgres-in-WASM) — no
// Docker, no external server. The connection ergonomics match a regular
// postgres.js setup, so swapping to a real Postgres later is a one-import
// change in this file (plus the migrator path) and the rest of the
// codebase is untouched.

import { access, cp } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from './schema';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

// Create a fresh Drizzle/pglite client. Pass a directory path for
// file-backed persistence (dev), or omit for an in-memory instance
// (tests) — each call to createDatabase() with no arg yields an
// independent, ephemeral database.
export async function createDatabase(dataDir?: string): Promise<Database> {
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
      const dir = dataDir ?? (await resolveDataDir());
      const db = await createDatabase(dir);
      await applyMigrations(db);
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

// Where the singleton lands its data.
//
//   Dev / test: `./local-db` (persists across HMR, easy to inspect).
//   Prod (Vercel serverless): `/tmp/sched-linx-db`. On cold start we
//     seed /tmp from the bundled reference DB (built by
//     `scripts/build-ref-db.ts`, included in the function bundle via
//     next.config's outputFileTracingIncludes) so visitors land on a
//     DB pre-loaded with demo transcripts. /tmp is the only writable
//     path on Vercel and is scoped to a single warm function instance,
//     so subsequent requests to the same warm instance see mutations —
//     but they don't survive instance recycling. That's expected: per-
//     visitor state is tag-scoped via cookies, and demo transcripts
//     are always available because they get re-hydrated from ref-db
//     on the next cold start.
async function resolveDataDir(): Promise<string> {
  if (process.env.NODE_ENV !== 'production') return './local-db';
  const target = '/tmp/sched-linx-db';
  const exists = await access(target)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    const source = path.join(process.cwd(), 'ref-db');
    // The bundled ref-db might be absent if a build stage omitted it;
    // pglite will handle a missing target by creating an empty dir,
    // so we swallow ENOENT here and let migrations run against a
    // fresh DB instead of hard-failing the request.
    try {
      await cp(source, target, { recursive: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return target;
}


// Build-time seed for the deployed reference DB.
//
// Creates ./ref-db (a fresh pglite data directory), applies all
// migrations, and restores every agentic fixture found in .data/*.json.
// The resulting directory is bundled into the Next function output via
// outputFileTracingIncludes in next.config.mjs, then copied to /tmp on
// each Vercel cold start (see src/db/client.ts) so visitors land on a
// DB pre-loaded with the demo transcripts.
//
// Only agentic fixtures live in ref-db. Numbered scenarios (1–5) are
// per-visitor and seed themselves on-demand via getVisitorTag() the
// first time a visitor opens the page. That keeps the reference DB
// small and the isolation clean.

import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { applyMigrations, createDatabase } from '../src/db/client';
import { restoreAgenticFixture, type AgenticFixture } from '../src/db/seed';

const REF_DIR = './ref-db';
const FIXTURE_DIR = './.data';

async function main(): Promise<void> {
  await rm(REF_DIR, { recursive: true, force: true });
  console.log(`Cleared ${REF_DIR}`);

  const db = await createDatabase(REF_DIR);
  await applyMigrations(db);
  console.log(`Migrated fresh pglite at ${REF_DIR}`);

  let restored = 0;
  const entries = await readdir(FIXTURE_DIR).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const filePath = path.join(FIXTURE_DIR, entry);
    const raw = await readFile(filePath, 'utf8');
    const fixture = JSON.parse(raw) as AgenticFixture;
    await restoreAgenticFixture(db, fixture);
    restored++;
    console.log(`Restored ${entry}`);
  }

  if (restored === 0) {
    console.log(
      `No fixtures found in ${FIXTURE_DIR}. Reference DB has schema only.`,
    );
  } else {
    console.log(`Reference DB ready: ${restored} fixture(s) restored.`);
  }
}

main().catch((err) => {
  console.error('build-ref-db failed:', err);
  process.exit(1);
});

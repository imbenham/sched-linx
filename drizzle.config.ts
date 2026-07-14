import { defineConfig } from 'drizzle-kit';

// drizzle-kit reads this to know where the schema lives and where to
// emit migration SQL. We only use `generate` (writes SQL into ./drizzle)
// — migrations are applied programmatically by applyMigrations() in
// src/db/client.ts, not via `drizzle-kit migrate`.
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  driver: 'pglite',
  dbCredentials: {
    url: './local-db',
  },
});

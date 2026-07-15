/** @type {import('next').NextConfig} */
const nextConfig = {
  // pglite is a WASM module — keep it out of the client bundle entirely
  // and let the Node runtime resolve it natively in route handlers.
  serverExternalPackages: ['@electric-sql/pglite'],
  // Files read at runtime but not statically imported by any module.
  // Next's file-tracing doesn't detect them, so we opt them in explicitly.
  //   drizzle/**  — migrations SQL, read by applyMigrations at cold start
  //   .data/**    — pre-seeded agentic transcripts hydrated on cold start
  outputFileTracingIncludes: {
    '/**': ['./drizzle/**', './.data/**'],
  },
};

export default nextConfig;

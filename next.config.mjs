/** @type {import('next').NextConfig} */
const nextConfig = {
  // pglite is a WASM module — keep it out of the client bundle entirely
  // and let the Node runtime resolve it natively in route handlers.
  serverExternalPackages: ['@electric-sql/pglite'],
  // Bundle the pre-seeded reference DB into every function's file
  // tracing output. On Vercel cold start, getDatabase() copies this
  // directory to /tmp so visitors land on a DB pre-loaded with the
  // demo transcripts. Built by `npm run build:refdb` before `next build`.
  outputFileTracingIncludes: {
    '/**': ['./ref-db/**'],
  },
};

export default nextConfig;

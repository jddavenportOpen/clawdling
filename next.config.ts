import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output → a self-contained .next/standalone/server.js with only
  // the traced runtime deps. This is the unit the Docker image ships and runs.
  output: 'standalone',
  // The /docs route reads markdown from the top-level `docs/` directory at
  // runtime via `fs` (see src/app/api/docs/[...slug]/route.ts). Next.js only
  // bundles files into a serverless function that it can statically trace as
  // a dependency — a `path.join(process.cwd(), 'docs')` read is NOT traced,
  // so without this the directory is absent at runtime and every doc read
  // 404s. Explicitly include it in the docs route's function bundle so the
  // markdown ships with the deployment.
  //
  // Route key uses escaped brackets per Next's own docs example — the key
  // is compiled as a picomatch glob, where unescaped `[...]` would be a
  // character class.
  outputFileTracingIncludes: {
    "/api/docs/\\[\\.\\.\\.slug\\]": ["./docs/**/*"],
    // src/config/domains.ts reads profiles/<ADJUTANT_PROFILE>/domains.yaml at
    // boot; trace it into the domains route so the standalone build ships it.
    // (If absent at runtime, the loader falls back to the compiled starter rows.)
    "/api/domains": ["./profiles/**/*"],
  },
};

export default nextConfig;

# ═══════════════════════════════════════════════════════════════════════════
# Clawdling — production image.
#
# Self-host-in-a-box:
#   docker run -e ANTHROPIC_API_KEY=sk-ant-... -p 3000:3000 -v clawdling-data:/data clawdling
# boots a working single-user cockpit backed by a local store on the mounted
# /data volume. Override ADJUTANT_AUTH / ADJUTANT_STATE to change auth/storage.
# Builds on Linux (Node 24), sidestepping the macOS-only static-prerender quirk.
# ═══════════════════════════════════════════════════════════════════════════

# ── Build stage ─────────────────────────────────────────────────────────────
FROM node:24-slim AS builder
WORKDIR /app

# Deps first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
# Build-time mode so the data-layer factories return the local (no-op-at-build)
# adapter instead of createClient('') throwing during static generation.
# Runtime env (via `docker run -e`) selects the real mode.
ENV ADJUTANT_STATE=local
ENV NEXTAUTH_SECRET=build-time-placeholder
RUN npm run build

# ── Runtime stage ───────────────────────────────────────────────────────────
FROM node:24-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Self-host-in-a-box defaults. Override these via `docker run -e`
# (e.g. ADJUTANT_AUTH=magic-link, ADJUTANT_STATE=supabase).
ENV ADJUTANT_ENGINE=sdk
ENV ADJUTANT_STATE=local
ENV ADJUTANT_AUTH=single
ENV ADJUTANT_STATE_ROOT=/data
ENV ADJUTANT_PROFILE=starter
# Single-auth does not rely on this for security (no real sessions issued);
# set a per-instance secret when running in magic-link mode.
ENV NEXTAUTH_SECRET=change-me-per-instance

RUN groupadd -r app && useradd -r -g app -d /app app

# Standalone server + its traced deps, static assets, and public files.
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# The starter profile (domains.yaml + agent prompts) is read at boot by
# src/config/domains.ts; the standalone trace doesn't include it, so copy it in.
COPY --from=builder /app/profiles ./profiles

# Per-tenant state volume mount point.
RUN mkdir -p /data && chown -R app:app /data /app
VOLUME /data
USER app

EXPOSE 3000

# Healthcheck hits the public /login page (200 = the server is up and serving).
# Uses Node's global fetch (Node 24) so no curl/wget is needed in the slim image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

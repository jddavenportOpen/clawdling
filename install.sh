#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Clawdling — self-host installer.
#
#   git clone <repo> clawdling && cd clawdling
#   ./install.sh
#   make run        # → http://localhost:3000
#
# Boots a single-user localhost cockpit backed by a local JSON store, driven by
# the Anthropic API with your own key. No Supabase, no magic-link, no spine.
#
# Idempotent: safe to re-run. It never overwrites an existing .env, and the only
# network access it makes is `npm ci` to install dependencies.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

cd "$(dirname "$0")"

say()  { printf '\033[1;36m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

say "Clawdling — self-host install"

# ── 1. Node present + correct version ───────────────────────────────────────
# The engine requires Node 24. Node 26 has a known Next.js prerender build
# failure (see README); we warn loudly but let the install proceed so `make run`
# (dev mode) still works.
if ! command -v node >/dev/null 2>&1; then
  die "Node.js not found. Install Node 24 (https://nodejs.org or 'nvm install 24') and re-run."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 24 ]; then
  die "Node $(node -v) detected; Clawdling needs Node 24+. Install it (e.g. 'nvm install 24 && nvm use 24') and re-run."
fi
if [ "$NODE_MAJOR" -ge 26 ]; then
  warn "──────────────────────────────────────────────────────────────────────"
  warn "WARNING: Node $(node -v) detected. Node 26 has a KNOWN Next.js prerender"
  warn "build failure. 'make run' (dev mode) works, but 'npm run build' may fail."
  warn "Recommended: 'nvm install 24 && nvm use 24' (the pinned version, .nvmrc)."
  warn "──────────────────────────────────────────────────────────────────────"
else
  say "Node $(node -v) OK"
fi

# ── 2. .env from template (never clobber an existing one) ───────────────────
if [ -f .env ]; then
  say ".env already exists — leaving it untouched."
else
  [ -f .env.example ] || die ".env.example is missing. Run this from the repo root (where install.sh lives)."
  cp .env.example .env
  say "Created .env from template."

  # Generate a NEXTAUTH_SECRET (required by NextAuth's module init even in
  # single/local mode, where the auth flow is bypassed).
  if command -v openssl >/dev/null 2>&1; then
    SECRET="$(openssl rand -base64 32)"
  else
    SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
  fi
  tmp="$(mktemp)"; sed "s#^NEXTAUTH_SECRET=.*#NEXTAUTH_SECRET=${SECRET}#" .env > "$tmp" && mv "$tmp" .env

  # Prompt for the one required value: the Anthropic key. Skippable.
  KEY="${ANTHROPIC_API_KEY:-}"
  if [ -z "$KEY" ]; then
    printf 'Paste your Anthropic API key (sk-ant-api03-...), or press Enter to add it later: '
    read -r KEY || true
  fi
  if [ -n "$KEY" ]; then
    tmp="$(mktemp)"; sed "s#^ANTHROPIC_API_KEY=.*#ANTHROPIC_API_KEY=${KEY}#" .env > "$tmp" && mv "$tmp" .env
    say "Anthropic key saved to .env"
  else
    warn "No key set. Add ANTHROPIC_API_KEY to .env before 'make run', or chat will not reply."
    warn "Every model call meters against YOUR key — get one at https://console.anthropic.com."
  fi
fi

# ── 3. Dependencies (the only network access) ───────────────────────────────
say "Installing dependencies (npm ci)..."
if [ ! -f package-lock.json ]; then
  die "package-lock.json is missing — cannot run a reproducible 'npm ci'. Are you in the repo root?"
fi
if ! npm ci; then
  die "npm ci failed. Check your Node version ($(node -v)) and network, then re-run ./install.sh."
fi

# ── 4. Local state dir ──────────────────────────────────────────────────────
STATE_ROOT="$(grep -E '^ADJUTANT_STATE_ROOT=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]')"
STATE_ROOT="${STATE_ROOT:-./.adjutant}"
mkdir -p "${STATE_ROOT}/db" || die "Could not create the state dir '${STATE_ROOT}/db'. Check permissions on the repo."
say "Local state dir ready: ${STATE_ROOT}/db"

# ── 5. Port 3000 pre-flight (warn only) ─────────────────────────────────────
PORT_BUSY=""
if command -v lsof >/dev/null 2>&1; then
  lsof -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1 && PORT_BUSY=1
elif command -v ss >/dev/null 2>&1; then
  ss -ltn 2>/dev/null | grep -q ':3000 ' && PORT_BUSY=1
fi
if [ -n "$PORT_BUSY" ]; then
  warn "Port 3000 is already in use. Free it, or run on another port: 'PORT=3001 make run'."
fi

say ""
say "Done. Start the cockpit with:"
say "   make run      # → http://localhost:3000"

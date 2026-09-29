#!/usr/bin/env bash
# run-bridge.sh - start the Clawdling PTY bridge from the same .env the cockpit reads.
#
#   make bridge            (or: bash scripts/run-bridge.sh)
#
# The cockpit (Next) and the bridge must hold the same BRIDGE_SECRET. Next loads
# .env by itself; the bridge reads only its environment. So this loads the
# bridge's OWN knobs from .env (BRIDGE_*, CLAWDLING_*, ADJUTANT_PROFILE) and the
# secret lives in exactly one place. A variable already exported in your shell
# wins over .env, which is also how Next behaves.
#
# Nothing else in .env is loaded, on purpose. The bridge hands its environment
# to every `claude` pane, and Claude Code prefers ANTHROPIC_API_KEY over your
# subscription login: loading the chat key would silently move every pane onto
# pay-per-use API billing (and hand the chat key, NEXTAUTH_SECRET, Google
# secrets to whatever a pane runs).
#
# The listen port comes from BRIDGE_URL (the address the cockpit dials), so the
# two cannot drift apart. BRIDGE_PORT overrides it.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    case "$key" in ''|*[!A-Za-z0-9_]*) continue ;; esac
    case "$key" in BRIDGE_*|CLAWDLING_*|ADJUTANT_PROFILE) ;; *) continue ;; esac
    [ -n "$val" ] || continue            # an empty value never clobbers a real one
    [ -z "${!key+x}" ] || continue       # your shell wins over .env
    case "$val" in
      \"*\") val="${val#\"}"; val="${val%\"}" ;;
      \'*\') val="${val#\'}"; val="${val%\'}" ;;
    esac
    case "$val" in '~/'*) val="$HOME/${val#\~/}" ;; esac
    export "$key=$val"
  done < .env
fi

if [ -z "${BRIDGE_SECRET:-}" ]; then
  echo "BRIDGE_SECRET is empty. install.sh writes one into .env; if yours predates that," >&2
  echo "run 'openssl rand -hex 32' and paste the result after BRIDGE_SECRET= in .env." >&2
  exit 1
fi

port="${BRIDGE_PORT:-}"
if [ -z "$port" ]; then
  hostport="${BRIDGE_URL:-http://localhost:8787}"
  hostport="${hostport#*://}"
  hostport="${hostport%%/*}"
  case "$hostport" in *:*) port="${hostport##*:}" ;; esac
  case "$port" in ''|*[!0-9]*) port=8787 ;; esac
fi

py="${PYTHON:-}"
if [ -z "$py" ]; then
  if [ -x .venv/bin/python ]; then py=.venv/bin/python; else py=python3; fi
fi
if ! "$py" -c 'import uvicorn, fastapi' >/dev/null 2>&1; then
  echo "The bridge's Python dependencies are not installed. Run: make bridge-install" >&2
  exit 1
fi

exec "$py" -m uvicorn bridge.main:app --host "${BRIDGE_HOST:-127.0.0.1}" --port "$port"

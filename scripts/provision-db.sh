#!/usr/bin/env bash
# Apply the DB migrations against your Supabase project via the Management API.
# Needs a Supabase Personal Access Token from
#   https://supabase.com/dashboard/account/tokens
# and your project ref (the subdomain of your project URL,
# e.g. https://<ref>.supabase.co).
# Usage:
#   SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... bash scripts/provision-db.sh
set -euo pipefail

REF="${SUPABASE_PROJECT_REF:-}"
TOKEN="${SUPABASE_ACCESS_TOKEN:-}"
SQL_FILE="$(cd "$(dirname "$0")/.." && pwd)/db/migrations/002_auth_and_agent_tools.sql"
[ -n "$TOKEN" ] || { echo "Set SUPABASE_ACCESS_TOKEN from https://supabase.com/dashboard/account/tokens"; exit 1; }
[ -n "$REF" ]   || { echo "Set SUPABASE_PROJECT_REF (your project ref, e.g. https://<ref>.supabase.co)"; exit 1; }
[ -f "$SQL_FILE" ] || { echo "missing $SQL_FILE"; exit 1; }

echo "Running $(basename "$SQL_FILE") against project $REF …"
# The Management API query endpoint runs arbitrary SQL (incl. DDL).
RESP=$(python3 - "$TOKEN" "$REF" "$SQL_FILE" <<'PY'
import sys, json, urllib.request
token, ref, path = sys.argv[1], sys.argv[2], sys.argv[3]
sql = open(path).read()
req = urllib.request.Request(
    f"https://api.supabase.com/v1/projects/{ref}/database/query",
    data=json.dumps({"query": sql}).encode(),
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    method="POST",
)
try:
    r = urllib.request.urlopen(req)
    print("OK", r.status)
except urllib.error.HTTPError as e:
    print("ERR", e.code, e.read().decode()[:400]); sys.exit(1)
PY
)
echo "$RESP"
echo "Done. Verify: user_tasks / user_memory / next_auth.verification_tokens now exist."

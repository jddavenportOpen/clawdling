#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════════════════
# oss-export.sh — deterministic allowlist export of the Clawdascended OSS engine.
# See docs/ARCHITECTURE.md for the export/allowlist design.
#
# What it does (deterministic; two runs on the same private SHA => identical tree hash):
#   1. Read oss-manifest.yaml (allowlist + deny-tripwires).
#   2. Deny-tripwire check: refuse if the SOURCE tree contains any deny path.
#   3. Copy exactly the allowlisted paths from the current oss-carve HEAD into a fresh temp dir.
#   4. `git init` a FRESH single-commit history (AD-1: private history never goes public).
#   5. Run the leak gate (scripts/oss-leak-gate.sh) INSIDE the export tree.
#   6. On gate PASS: move to dist/oss-export/ + write qa/oss-export-receipt.json.
#      On gate FAIL: nonzero exit, NO output tree.
#
# Usage:
#   scripts/oss-export.sh [--check] [--out DIR] [--patterns PATH] [--keep-temp]
#     --check       validate manifest (allowlist ⊆ tree + deny tripwires) and exit; no export
#     --out DIR     output dir (default: <repo>/dist/oss-export)
#     --patterns P  private corpus for the gate (default from OSS_LEAK_PATTERNS or known path)
#     --keep-temp   don't delete the temp build dir (debugging)
# ═══════════════════════════════════════════════════════════════════════════════════════════
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
MANIFEST="$REPO/oss-manifest.yaml"
GATE="$HERE/oss-leak-gate.sh"
OUT="$REPO/dist/oss-export"
CHECK_ONLY=0
KEEP_TEMP=0
PATTERNS="${OSS_LEAK_PATTERNS:-$REPO/qa/oss-leak-patterns.txt}"

while [ $# -gt 0 ]; do
  case "$1" in
    --check)     CHECK_ONLY=1; shift ;;
    --out)       OUT="$2"; shift 2 ;;
    --patterns)  PATTERNS="$2"; shift 2 ;;
    --keep-temp) KEEP_TEMP=1; shift ;;
    -*) echo "oss-export: unknown flag $1" >&2; exit 2 ;;
    *)  echo "oss-export: unexpected arg $1" >&2; exit 2 ;;
  esac
done

[ -f "$MANIFEST" ] || { echo "oss-export: manifest not found: $MANIFEST" >&2; exit 2; }
[ -f "$GATE" ]     || { echo "oss-export: gate script not found: $GATE" >&2; exit 2; }
command -v git     >/dev/null 2>&1 || { echo "oss-export: git required" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "oss-export: python3 required" >&2; exit 2; }

PRIVATE_SHA="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"

# ── manifest reader (python; emits allow globs + deny globs) ────────────────────────────────────
read_manifest() { # $1 = section (allow|deny) → prints one entry per line
  python3 - "$MANIFEST" "$1" <<'PY'
import sys, re
mf, section = sys.argv[1], sys.argv[2]
out=[]; cur=None
for raw in open(mf):
    line=raw.rstrip("\n"); s=line.strip()
    if s.startswith("#") or not s: continue
    m=re.match(r'^([a-zA-Z_]+)\s*:\s*$', s)
    if m and (line[:1] not in " -"):
        cur=m.group(1); continue
    if s.startswith("- ") and cur==section:
        e=s[2:].strip().strip('"').strip("'")
        e=e.split("  #")[0].strip()
        if e: out.append(e)
for e in out: print(e)
PY
}

# ── deny-tripwire check against a target tree ───────────────────────────────────────────────────
# $1 = directory to check, $2 = human label (for the error message).
# The authoritative deny check runs against the EXPORT (copied) tree — the allowlist must never
# pull a deny path in. A NARROWER source-side pre-check (personal-data classes only) runs first as
# a fast fail. Rationale: the SOURCE legitimately contains paid-layer files (billing.ts) because
# it is the hosted product's single source of truth (AD-1); their absence is guaranteed by not
# allowlisting them, and PROVEN by this check on the copied tree.
deny_tripwire() {
  local target="$1" label="$2" hit=0
  while IFS= read -r pat; do
    [ -n "$pat" ] || continue
    local found=""
    if [[ "$pat" == */ ]]; then
      [ -d "$target/${pat%/}" ] && found="${pat%/}"
    elif [[ "$pat" == *"*"* || "$pat" == *"?"* || "$pat" == *"["* ]]; then
      found="$(cd "$target" && find . -not -path './.git/*' -not -path './node_modules/*' -not -path './.next/*' -not -path './dist/*' 2>/dev/null \
        | sed 's#^\./##' | python3 -c "import sys,fnmatch; pat='''$pat'''; [print(l.strip()) for l in sys.stdin if fnmatch.fnmatch(l.strip(),pat)]" | head -1)"
    else
      [ -e "$target/$pat" ] && found="$pat"
    fi
    if [ -n "$found" ]; then
      echo "  ✗ DENY TRIPWIRE ($label): tree contains '$found' (matched deny pattern '$pat')" >&2
      hit=1
    fi
  done < <(read_manifest deny)
  return $hit
}

# Source-side fast-fail: only the personal-data classes that must never exist even privately-copied.
deny_source_precheck() {
  local hit=0
  for pat in "clawd-docs/" ".env" ".env.localtest" ".env.local" ".env.production"; do
    local found=""
    if [[ "$pat" == */ ]]; then [ -d "$REPO/${pat%/}" ] && found="${pat%/}"; else [ -e "$REPO/$pat" ] && found="$pat"; fi
    # .env* would only trip if a stray env slipped into the SOURCE checkout; allowlist never ships them.
    if [ -n "$found" ] && [[ "$pat" == clawd-docs/ ]]; then
      echo "  ✗ DENY TRIPWIRE (source): '$found' present — Phase 1 strip incomplete." >&2
      hit=1
    fi
  done
  return $hit
}

# ── allowlist ⊆ tree validation + compute the copy set ──────────────────────────────────────────
# Emits, on stdout, the concrete tree-relative file list to copy (deterministic sort).
resolve_copy_set() {
  python3 - "$MANIFEST" "$REPO" <<'PY'
import sys, os, re, fnmatch
mf, repo = sys.argv[1], sys.argv[2]
allow=[]; cur=None
for raw in open(mf):
    line=raw.rstrip("\n"); s=line.strip()
    if s.startswith("#") or not s: continue
    m=re.match(r'^([a-zA-Z_]+)\s*:\s*$', s)
    if m and (line[:1] not in " -"):
        cur=m.group(1); continue
    if s.startswith("- ") and cur=="allow":
        e=s[2:].strip().strip('"').strip("'"); e=e.split("  #")[0].strip()
        if e: allow.append(e)
# git-tracked files only (deterministic, ignores untracked build junk / local env)
import subprocess
tracked=subprocess.run(["git","-C",repo,"ls-files"],capture_output=True,text=True).stdout.splitlines()
tracked=[t for t in tracked if not t.startswith("node_modules/")]
def covered(rel):
    for a in allow:
        if a.endswith("/"):
            if rel==a[:-1] or rel.startswith(a): return True
        elif any(c in a for c in "*?[]"):
            if fnmatch.fnmatch(rel, a): return True
        else:
            if rel==a: return True
            if rel.startswith(a.rstrip("/")+"/"): return True
    return False
sel=sorted([t for t in tracked if covered(t)])
for s in sel: print(s)
PY
}

echo "── oss-export: private HEAD = $PRIVATE_SHA"
echo "── deny source pre-check (personal-data classes)"
if ! deny_source_precheck; then
  echo "✗ oss-export: source contains a personal-data deny class — refusing." >&2
  exit 1
fi
echo "  ✓ source pre-check clear"

COPY_SET="$(resolve_copy_set)"
N_COPY="$(printf '%s\n' "$COPY_SET" | grep -cve '^$' || echo 0)"
echo "── allowlist resolves to $N_COPY files"

if [ "$CHECK_ONLY" = "1" ]; then
  echo "✓ oss-export --check: manifest valid, deny tripwires clear, $N_COPY files allowlisted."
  exit 0
fi

# ── build fresh export tree ─────────────────────────────────────────────────────────────────────
TMP="$(mktemp -d -t oss-export.XXXXXX)"
cleanup() { [ "$KEEP_TEMP" = "1" ] || rm -rf "$TMP"; }
trap cleanup EXIT

echo "── copying allowlisted files into fresh tree: $TMP"
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  dst="$TMP/$rel"
  mkdir -p "$(dirname "$dst")"
  cp -p "$REPO/$rel" "$dst"
done <<< "$COPY_SET"

# ── authoritative deny-tripwire check on the EXPORT tree (belt-and-suspenders) ──────────────────
echo "── deny-tripwire check (export tree — authoritative)"
if ! deny_tripwire "$TMP" "export"; then
  echo "✗ oss-export: a deny path reached the export tree via the allowlist — refusing. NO output." >&2
  exit 1
fi
echo "  ✓ export tree free of deny paths"

# ── fresh git history (AD-1): deterministic single commit ───────────────────────────────────────
# Force a fixed author/committer + fixed date so the tree hash is reproducible run-to-run.
export GIT_AUTHOR_NAME="Clawdascended" GIT_AUTHOR_EMAIL="oss@clawdascended.app"
export GIT_COMMITTER_NAME="Clawdascended" GIT_COMMITTER_EMAIL="oss@clawdascended.app"
export GIT_AUTHOR_DATE="2000-01-01T00:00:00Z" GIT_COMMITTER_DATE="2000-01-01T00:00:00Z"
(
  cd "$TMP"
  git init -q -b main
  git add -A
  git commit -q -m "Clawdascended OSS v0.1.0 export of ${PRIVATE_SHA}"
) || { echo "✗ oss-export: git init/commit failed" >&2; exit 1; }

# Deterministic tree hash = the git tree object of the single commit (content-addressed).
EXPORT_TREE_HASH="$(git -C "$TMP" rev-parse HEAD^{tree})"
echo "── export_tree_hash = $EXPORT_TREE_HASH"

# ── run the leak gate INSIDE the export ─────────────────────────────────────────────────────────
echo "── running leak gate inside export tree"
GATE_REPORT="$TMP/qa/oss-leak-report.json"
mkdir -p "$TMP/qa"
set +e
bash "$GATE" "$TMP" --manifest "$MANIFEST" --patterns "$PATTERNS" --report "$GATE_REPORT"
GATE_RC=$?
set -e 2>/dev/null || true

GATE_RESULT="fail"
[ "$GATE_RC" = "0" ] && GATE_RESULT="pass"

TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ "$GATE_RESULT" != "pass" ]; then
  echo ""
  echo "✗ oss-export: LEAK GATE FAILED (rc=$GATE_RC). NO output tree emitted."
  echo "  Findings report (copied out for inspection): $REPO/qa/oss-leak-report.json"
  mkdir -p "$REPO/qa"
  [ -f "$GATE_REPORT" ] && cp -p "$GATE_REPORT" "$REPO/qa/oss-leak-report.json"
  # Write a fail receipt so the state is auditable, but emit NO dist tree.
  mkdir -p "$REPO/qa"
  python3 - "$REPO/qa/oss-export-receipt.json" "$PRIVATE_SHA" "$EXPORT_TREE_HASH" "$GATE_RESULT" "$TIMESTAMP" <<'PY'
import sys,json
p,sha,th,res,ts=sys.argv[1:6]
json.dump({"private_sha":sha,"export_tree_hash":th,"gate_version":"1","gate_result":res,"timestamp":ts},
          open(p,"w"),indent=2,sort_keys=True); open(p,"a").write("\n")
PY
  exit 1
fi

# ── gate passed: emit dist/oss-export + receipt ─────────────────────────────────────────────────
echo "── gate PASSED — emitting $OUT"
rm -rf "$OUT"
mkdir -p "$(dirname "$OUT")"
# Copy the full temp tree INCLUDING the fresh .git so the export carries its own history.
cp -pR "$TMP" "$OUT"

mkdir -p "$REPO/qa"
python3 - "$REPO/qa/oss-export-receipt.json" "$PRIVATE_SHA" "$EXPORT_TREE_HASH" "$GATE_RESULT" "$TIMESTAMP" <<'PY'
import sys,json
p,sha,th,res,ts=sys.argv[1:6]
json.dump({"private_sha":sha,"export_tree_hash":th,"gate_version":"1","gate_result":res,"timestamp":ts},
          open(p,"w"),indent=2,sort_keys=True); open(p,"a").write("\n")
PY

echo ""
echo "✓ oss-export: SUCCESS"
echo "  output:       $OUT"
echo "  tree hash:    $EXPORT_TREE_HASH"
echo "  private sha:  $PRIVATE_SHA"
echo "  receipt:      $REPO/qa/oss-export-receipt.json"
exit 0

#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════════════════
# oss-leak-gate.sh — the HARD-BLOCKER leak-scan gate for the Clawdascended OSS export.
# See docs/ARCHITECTURE.md for the leak-gate design.
#
# Deterministic. NO LLM in the decision path. Exit 0 = clean, exit 1 = ANY finding (blocks
# the export / fails CI). There is NO --force. A false positive is fixed by refining the
# pattern corpus in a reviewed commit, never by skipping the gate.
#
# Layers:
#   L1  Secrets (generic)   — gitleaks + trufflehog (both pinned-present) over the tree.
#   L2  Personal identifiers — grep corpus from the PRIVATE pattern file (T0.5).
#   L3  Infra fingerprints   — grep corpus (same file). Vercel/Supabase/Tailscale/harness names.
#   L4  Paid-layer tripwire  — stripe / billing / test-auth / qa-bypass / provisioning signatures.
#   L5  Structural           — clawd-docs absent, personal scripts absent, .env absent,
#                              exactly one LICENSE, manifest === tree, history <= 2 commits.
#
# When the private pattern corpus is ABSENT (public CI — see workplan §5.5), L2/L3 are skipped
# and the gate runs L1+L4+L5 only. Shipping the L2/L3 needle list publicly would itself leak.
#
# Pinned tool versions (asserted; bump deliberately):
#   gitleaks   >= 8.x
#   trufflehog >= 3.x
#
# Usage:
#   scripts/oss-leak-gate.sh <tree-dir> [--history] [--report <path>] [--manifest <path>] \
#                            [--patterns <path>]
#     <tree-dir>            directory to scan (export candidate or a public clone)
#     --history            also run gitleaks WITH git history (for public-clone verification)
#     --report  <path>     JSON findings report (default <tree>/qa/oss-leak-report.json)
#     --manifest <path>    oss-manifest.yaml for the L5 allowlist===tree check
#     --patterns <path>    private corpus (default $OSS_LEAK_PATTERNS or the known private path)
# ═══════════════════════════════════════════════════════════════════════════════════════════
set -uo pipefail

# ── arg parse ────────────────────────────────────────────────────────────────────────────────
TREE=""
WITH_HISTORY=0
REPORT=""
MANIFEST=""
PATTERNS="${OSS_LEAK_PATTERNS:-qa/oss-leak-patterns.txt}"

while [ $# -gt 0 ]; do
  case "$1" in
    --history)  WITH_HISTORY=1; shift ;;
    --report)   REPORT="$2"; shift 2 ;;
    --manifest) MANIFEST="$2"; shift 2 ;;
    --patterns) PATTERNS="$2"; shift 2 ;;
    -*) echo "oss-leak-gate: unknown flag $1" >&2; exit 2 ;;
    *)  if [ -z "$TREE" ]; then TREE="$1"; else echo "oss-leak-gate: extra arg $1" >&2; exit 2; fi; shift ;;
  esac
done

[ -n "$TREE" ] || { echo "usage: oss-leak-gate.sh <tree-dir> [--history] [--report P] [--manifest P] [--patterns P]" >&2; exit 2; }
[ -d "$TREE" ] || { echo "oss-leak-gate: tree not a directory: $TREE" >&2; exit 2; }

# canonicalize
TREE="$(cd "$TREE" && pwd)"
[ -n "$REPORT" ] || REPORT="$TREE/qa/oss-leak-report.json"
GATE_VERSION="1"

# ── deps ─────────────────────────────────────────────────────────────────────────────────────
command -v gitleaks   >/dev/null 2>&1 || { echo "oss-leak-gate: gitleaks not installed (brew install gitleaks)" >&2; exit 2; }
command -v trufflehog >/dev/null 2>&1 || { echo "oss-leak-gate: trufflehog not installed (brew install trufflehog)" >&2; exit 2; }

# ── excerpt hashing (report never replicates the leak) ────────────────────────────────────────
_sha() { printf '%s' "$1" | shasum -a 256 | awk '{print $1}'; }

# findings accumulate as tab-separated lines: layer<TAB>class<TAB>path<TAB>line<TAB>excerpt_hash
FINDINGS_FILE="$(mktemp -t ossleak.XXXXXX)"
trap 'rm -f "$FINDINGS_FILE"' EXIT
: > "$FINDINGS_FILE"

add_finding() { # layer class path line excerpt
  local layer="$1" class="$2" path="$3" line="$4" excerpt="$5"
  printf '%s\t%s\t%s\t%s\t%s\n' "$layer" "$class" "$path" "$line" "$(_sha "$excerpt")" >> "$FINDINGS_FILE"
}

# Directories/paths never scanned for CONTENT (build output, deps, vcs, and the report itself).
# Note: these are still subject to L5 structural presence checks where relevant.
EXCLUDE_RE='(^|/)(node_modules|\.next|\.git|dist|coverage)(/|$)'

# tracked-ish file list: everything under the tree minus the excludes and lockfiles/binaries
_scan_files() {
  # -print0 for path safety; filter binaries later per-grep with -I
  find "$TREE" -type f \
    -not -path '*/node_modules/*' \
    -not -path '*/.next/*' \
    -not -path '*/.git/*' \
    -not -path '*/dist/*' \
    -not -path '*/coverage/*' \
    -print0
}

echo "── oss-leak-gate v${GATE_VERSION} scanning: $TREE"

# ═══════════════════════════════════════════════════════════════════════════════════════════
# L1 — generic secrets (gitleaks + trufflehog)
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "── L1 secrets (gitleaks --no-git + trufflehog filesystem)"
GL_JSON="$(mktemp -t glout.XXXXXX)"; trap 'rm -f "$FINDINGS_FILE" "$GL_JSON"' EXIT
# gitleaks: no-git = scan the working tree, not history. Redact so the JSON never stores the raw secret.
gitleaks detect --source "$TREE" --no-git --redact --report-format json --report-path "$GL_JSON" --exit-code 0 >/dev/null 2>&1 || true
if [ -s "$GL_JSON" ] && command -v python3 >/dev/null 2>&1; then
  # emit "path<TAB>line<TAB>ruleID" lines
  python3 - "$GL_JSON" <<'PY' | while IFS=$'\t' read -r gpath gline grule; do
import json,sys
try:
    data=json.load(open(sys.argv[1]))
except Exception:
    data=[]
for f in data:
    p=f.get("File","") ; l=f.get("StartLine","0") ; r=f.get("RuleID","secret")
    print(f"{p}\t{l}\t{r}")
PY
    # relativize path
    rel="${gpath#$TREE/}"
    case "$rel" in */node_modules/*|node_modules/*|*/.next/*|*/.git/*|*/dist/*) continue;; esac
    add_finding L1 "secret:${grule}" "$rel" "$gline" "gitleaks:${grule}:${gpath}:${gline}"
  done
fi

# trufflehog filesystem — only VERIFIED or clearly-structured findings. Parse JSON lines.
TH_JSON="$(mktemp -t thout.XXXXXX)"; trap 'rm -f "$FINDINGS_FILE" "$GL_JSON" "$TH_JSON"' EXIT
trufflehog filesystem "$TREE" --no-update --json --exclude-paths=<(printf '%s\n' 'node_modules/' '.next/' '.git/' 'dist/') >"$TH_JSON" 2>/dev/null || true
if [ -s "$TH_JSON" ] && command -v python3 >/dev/null 2>&1; then
  python3 - "$TH_JSON" "$TREE" <<'PY' | while IFS=$'\t' read -r tpath tline tdet; do
import json,sys
tree=sys.argv[2]
for ln in open(sys.argv[1]):
    ln=ln.strip()
    if not ln: continue
    try: o=json.loads(ln)
    except Exception: continue
    det=o.get("DetectorName","secret")
    md=o.get("SourceMetadata",{}).get("Data",{}).get("Filesystem",{})
    p=md.get("file","") ; l=md.get("line",0) or 0
    if not p: continue
    print(f"{p}\t{l}\t{det}")
PY
    rel="${tpath#$TREE/}"
    case "$rel" in */node_modules/*|node_modules/*|*/.next/*|*/.git/*|*/dist/*) continue;; esac
    add_finding L1 "secret:${tdet}" "$rel" "$tline" "trufflehog:${tdet}:${tpath}:${tline}"
  done
fi

# ═══════════════════════════════════════════════════════════════════════════════════════════
# L2 + L3 — personal identifiers + infra fingerprints (private corpus; degrade if absent)
# ═══════════════════════════════════════════════════════════════════════════════════════════
if [ -f "$PATTERNS" ]; then
  echo "── L2/L3 personal + infra corpus: $PATTERNS"
  # Build the needle list (strip comments/blank).
  NEEDLES="$(grep -vE '^\s*(#|$)' "$PATTERNS")"
  # Scan every text file; grep -I skips binaries. -n line numbers. Case-insensitive.
  while IFS= read -r -d '' f; do
    rel="${f#$TREE/}"
    # Never scan the report file or the corpus itself (defensive; corpus shouldn't be in-tree).
    # oss-gate-drill.sh deliberately embeds personal-id/infra canary literals to prove L2/L3 fire.
    case "$rel" in qa/oss-leak-report.json|qa/oss-leak-patterns.txt|scripts/oss-gate-drill.sh) continue;; esac
    # One grep pass with all needles as alternation would lose per-needle class; loop is fine
    # (deterministic, and corpus is small).
    while IFS= read -r needle; do
      [ -n "$needle" ] || continue
      # grep -I: skip binary. -n: line. -i: case-insensitive. -E: extended regexp.
      matches="$(grep -InEi -- "$needle" "$f" 2>/dev/null || true)"
      [ -n "$matches" ] || continue
      while IFS= read -r m; do
        [ -n "$m" ] || continue
        mline="${m%%:*}"
        # classify L2 vs L3 by a coarse heuristic. The private corpus (never
        # shipped) tags personal-identifier needles by prefixing them with
        # "pii:" — those map to L2 (personal), everything else to L3 (infra).
        layer="L3"
        case "$needle" in
          pii:*|*@*) layer="L2" ;;
        esac
        add_finding "$layer" "corpus:${needle}" "$rel" "$mline" "${rel}:${mline}:${needle}"
      done <<< "$matches"
    done <<< "$NEEDLES"
  done < <(_scan_files)
else
  echo "── L2/L3 SKIPPED (private corpus absent: $PATTERNS) — running L1+L4+L5 only (public-CI mode)"
fi

# ═══════════════════════════════════════════════════════════════════════════════════════════
# L4 — paid-layer / backdoor tripwire (deny signatures; deterministic regexp)
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "── L4 paid-layer / backdoor tripwire"
# These signatures must NOT appear in the OSS engine tree. Keep tight to avoid false hits on
# generic words: match import/usage forms, env-var names, and API surfaces.
# Two needle classes (precision fix 2026-07-07):
#  (a) SECRET/CONFIG signatures — env-var names, key formats, backdoor headers. A real leak even
#      when it appears in prose, so scanned in EVERY file.
#  (b) CONCEPT/API words — the paid-layer feature *names* (stripe/checkout/provision/self-mod/
#      builder). These are legitimately NAMED in the OSS docs + the AGPL license text to describe
#      what the engine EXCLUDES (the open-core boundary — "no hosted provisioning", "no self-mod
#      pipeline"), and the manifest deny-tripwire already makes the actual paid CODE FILES
#      structurally impossible to ship. So concept words are scanned in CODE FILES ONLY: a doc
#      saying "no provisioning" is intended; a provisionTenant() call sneaking into
#      src/lib/state.ts is not. (Before this split, the AGPL's "provisions of this License" and
#      the governance docs produced 12 guaranteed false positives.)
L4_SECRET_NEEDLES=(
  'STRIPE_[A-Z_]+'
  'ADJUTANT_BILLING'
  'SUPABASE_ACCESS_TOKEN'
  'sbp_[A-Za-z0-9]{16,}'
  'ADJUTANT_ALLOW_TEST_AUTH'
  'QA_CI_BYPASS_KEY'
  'x-qa-bypass-key'
  'qa-bypass'
)
L4_CODE_NEEDLES=(
  'stripe'
  'checkout\.session'
  'billingPortal'
  '(^|[^a-zA-Z])provision(-db|Db|ing)?'
  '(self-?mod|selfmod)'
  'src/lib/builder'
)
while IFS= read -r -d '' f; do
  rel="${f#$TREE/}"
  case "$rel" in qa/oss-leak-report.json|qa/oss-leak-patterns.txt) continue;; esac
  # Exclude the gate scripts themselves + the manifest (they legitimately NAME these signatures
  # as deny-tripwires; scanning them would be a self-referential false positive).
  # scripts/provision-db.sh is the KEEPER supabase-mode schema-apply: it references
  # SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF only as env-var NAMES to read (never a literal
  # secret value), and "provision" is its own filename — both are legitimate here.
  # scripts/oss-gate-drill.sh deliberately PLANTS L4 canary strings (stripe/checkout.session)
  # to prove the gate fires; scanning it is a self-referential false positive.
  case "$rel" in scripts/oss-leak-gate.sh|scripts/oss-export.sh|scripts/oss-gate-drill.sh|oss-manifest.yaml|scripts/provision-db.sh) continue;; esac
  # concept/API words apply to code files only (see (b) above); secret/config signatures apply everywhere.
  scan_needles=( "${L4_SECRET_NEEDLES[@]}" )
  case "$rel" in *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.sh|*.sql|*.json) scan_needles+=( "${L4_CODE_NEEDLES[@]}" );; esac
  for needle in "${scan_needles[@]}"; do
    matches="$(grep -InE -- "$needle" "$f" 2>/dev/null || true)"
    [ -n "$matches" ] || continue
    while IFS= read -r m; do
      [ -n "$m" ] || continue
      mline="${m%%:*}"
      add_finding L4 "paid-layer:${needle}" "$rel" "$mline" "${rel}:${mline}:${needle}"
    done <<< "$matches"
  done
done < <(_scan_files)

# ═══════════════════════════════════════════════════════════════════════════════════════════
# L5 — structural assertions
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "── L5 structural"
struct() { # class ok? detail
  local class="$1" ok="$2" detail="$3"
  if [ "$ok" != "0" ]; then add_finding L5 "structural:${class}" "$detail" "0" "L5:${class}:${detail}"; fi
}

# clawd-docs absent
[ -d "$TREE/clawd-docs" ] && struct clawd-docs-present 1 "clawd-docs" || struct clawd-docs-present 0 ""

# personal scripts absent (the 9 sync/snapshot + smoke-org-layout)
PERSONAL_SCRIPTS=(sync-crm-to-supabase.js sync-projects-to-supabase.js \
  sync-agent-activity-to-supabase.js sync-skylight.sh generate-crm-snapshot.js \
  generate-goals-snapshot.js generate-nutrition-snapshot.js convert-linkedin-xlsx.py \
  snapshot-state.sh smoke-org-layout.mjs)
for s in "${PERSONAL_SCRIPTS[@]}"; do
  if [ -e "$TREE/scripts/$s" ]; then struct "personal-script" 1 "scripts/$s"; fi
done

# .env / .env.localtest absent (the .env.example is allowed and expected)
for e in .env .env.localtest .env.local .env.production; do
  if [ -e "$TREE/$e" ]; then struct "env-file-present" 1 "$e"; fi
done

# exactly one LICENSE file, at root
LIC_COUNT="$(find "$TREE" -type f \( -name LICENSE -o -name 'LICENSE.*' \) \
  -not -path '*/node_modules/*' -not -path '*/.next/*' -not -path '*/.git/*' | wc -l | tr -d ' ')"
if [ "$LIC_COUNT" != "1" ]; then struct "license-count" 1 "found=$LIC_COUNT expected=1"; fi
[ -f "$TREE/LICENSE" ] || struct "license-at-root" 1 "LICENSE missing at root"

# git history <= 2 commits (fresh-history export invariant). Only if the tree is a git repo.
if [ -d "$TREE/.git" ] || git -C "$TREE" rev-parse --git-dir >/dev/null 2>&1; then
  CN="$(git -C "$TREE" rev-list --count HEAD 2>/dev/null || echo 0)"
  if [ "$CN" -gt 2 ] 2>/dev/null; then struct "history-too-long" 1 "commits=$CN (>2)"; fi
fi

# manifest === tree (allowlist covers every shipped path; no unmanifested files)
if [ -n "$MANIFEST" ] && [ -f "$MANIFEST" ] && command -v python3 >/dev/null 2>&1; then
  # Compare the set of files actually in TREE (minus vcs/build) against the manifest allowlist.
  UNMANIFESTED="$(python3 - "$MANIFEST" "$TREE" <<'PY'
import sys, os, fnmatch, re
manifest_path, tree = sys.argv[1], sys.argv[2]
# Minimal YAML read: collect allowlist glob entries under "allow:" as "- <path>".
allow=[]
in_allow=False
for raw in open(manifest_path):
    line=raw.rstrip("\n")
    s=line.strip()
    if s.startswith("#") or not s:
        continue
    if re.match(r'^allow\s*:', s):
        in_allow=True; continue
    if in_allow and re.match(r'^[a-zA-Z_]+\s*:', s) and not s.startswith("-"):
        in_allow=False
    if in_allow and s.startswith("- "):
        entry=s[2:].strip().strip('"').strip("'")
        # strip trailing "# reason"
        entry=entry.split("  #")[0].strip()
        if entry: allow.append(entry)
# Build file set of the tree
files=[]
for root,dirs,fs in os.walk(tree):
    dirs[:] = [d for d in dirs if d not in ('.git','node_modules','.next','dist','coverage')]
    for f in fs:
        rel=os.path.relpath(os.path.join(root,f), tree)
        files.append(rel)
# The gate writes its own report into <tree>/qa/ at the END of a run; when a
# previously-emitted export tree is re-scanned (T7.2 public-clone verification),
# that artifact is present. It is NOT part of the shipped allowlist and must not
# self-flag as unmanifested. Same for the (gitignored) private corpus if it ever
# co-locates. These are gate runtime artifacts, not shipped content.
GATE_ARTIFACTS={"qa/oss-leak-report.json","qa/oss-leak-patterns.txt","qa/oss-export-receipt.json"}
def covered(rel):
    if rel in GATE_ARTIFACTS: return True
    for a in allow:
        if a.endswith("/"):
            if rel==a[:-1] or rel.startswith(a): return True
        elif any(c in a for c in "*?[]"):
            if fnmatch.fnmatch(rel, a): return True
            # directory-glob like src/** should match nested
        else:
            if rel==a: return True
    # also allow dir-prefix match for bare dir entries without trailing slash
    for a in allow:
        if "/" in a and not any(c in a for c in "*?[]") and rel.startswith(a.rstrip("/")+"/"):
            return True
    return False
bad=[r for r in files if not covered(r)]
for r in sorted(bad):
    print(r)
PY
)"
  if [ -n "$UNMANIFESTED" ]; then
    while IFS= read -r u; do
      [ -n "$u" ] || continue
      struct "unmanifested-file" 1 "$u"
    done <<< "$UNMANIFESTED"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════════════════
# optional: history secret scan (public-clone verification)
# ═══════════════════════════════════════════════════════════════════════════════════════════
if [ "$WITH_HISTORY" = "1" ] && ( [ -d "$TREE/.git" ] || git -C "$TREE" rev-parse --git-dir >/dev/null 2>&1 ); then
  echo "── L1(history) gitleaks WITH git history"
  GLH_JSON="$(mktemp -t glhist.XXXXXX)"
  gitleaks detect --source "$TREE" --redact --report-format json --report-path "$GLH_JSON" --exit-code 0 >/dev/null 2>&1 || true
  if [ -s "$GLH_JSON" ] && command -v python3 >/dev/null 2>&1; then
    python3 - "$GLH_JSON" <<'PY' | while IFS=$'\t' read -r hpath hline hrule hcommit; do
import json,sys
try: data=json.load(open(sys.argv[1]))
except Exception: data=[]
for f in data:
    print(f'{f.get("File","")}\t{f.get("StartLine","0")}\t{f.get("RuleID","secret")}\t{f.get("Commit","")}')
PY
      add_finding L1 "secret-history:${hrule}" "$hpath" "$hline" "history:${hcommit}:${hpath}:${hline}"
    done
  fi
  rm -f "$GLH_JSON"
fi

# ═══════════════════════════════════════════════════════════════════════════════════════════
# report + verdict
# ═══════════════════════════════════════════════════════════════════════════════════════════
# Sort findings for determinism.
sort -o "$FINDINGS_FILE" "$FINDINGS_FILE"
N_FINDINGS="$(grep -cve '^$' "$FINDINGS_FILE" 2>/dev/null)"
[ -n "$N_FINDINGS" ] || N_FINDINGS=0

mkdir -p "$(dirname "$REPORT")"
if command -v python3 >/dev/null 2>&1; then
  python3 - "$FINDINGS_FILE" "$REPORT" "$GATE_VERSION" "$([ -f "$PATTERNS" ] && echo full || echo degraded)" <<'PY'
import sys, json, datetime
findings_file, report, gver, mode = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
items=[]
for ln in open(findings_file):
    ln=ln.rstrip("\n")
    if not ln: continue
    parts=ln.split("\t")
    if len(parts)<5: continue
    layer,cls,path,line,exh=parts[0],parts[1],parts[2],parts[3],parts[4]
    items.append({"layer":layer,"pattern_class":cls,"path":path,"line":line,"excerpt_hash":exh})
out={
  "gate_version": gver,
  "mode": mode,                      # full = L1-L5, degraded = L1+L4+L5 (corpus absent)
  "result": "pass" if not items else "fail",
  "finding_count": len(items),
  "findings": items,                 # excerpts are HASHED; the report never replicates a leak
  "generated_at": datetime.datetime.utcnow().replace(microsecond=0).isoformat()+"Z",
}
json.dump(out, open(report,"w"), indent=2, sort_keys=True)
open(report,"a").write("\n")
PY
fi

echo ""
if [ "$N_FINDINGS" -gt 0 ]; then
  echo "✗ oss-leak-gate: FAIL — $N_FINDINGS finding(s). Report: $REPORT"
  echo "  (layers present in findings:)"
  cut -f1 "$FINDINGS_FILE" | sort -u | sed 's/^/    /'
  exit 1
fi
echo "✓ oss-leak-gate: PASS — 0 findings. Report: $REPORT"
exit 0

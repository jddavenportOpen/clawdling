// ═══════════════════════════════════════════════════════════════════════════
// SpawnLockClassWide.test.tsx — the W8 CLASS-WIDE spawn-lock guard.
//
// THE BUG CLASS (JD's locked model): the ONLY picker-spawnable agents are CEO +
// projects. NewSessionPicker with mode='all' re-exposes ad-hoc Claude + the 8
// spawnable domains + 11 specialists + "Launch all 8 domains". Every call-site
// that forgets `mode` (when the old default was 'all') re-opened the leak:
//   W6 locked the rail (ThreadSidebar).
//   W7 locked the 2 pickers in ChatGrid.
//   Re-QA found a THIRD: NewSessionCta (the empty-grid "+ New session" CTA).
//
// ChatGridSpawnLock.test.tsx only covered ChatGrid — a per-file guard that the
// bug class kept slipping past. This guard is CLASS-WIDE. It does not render any
// one component; it statically inspects the SOURCE so a NEW unlocked call-site
// added ANYWHERE in src/ fails CI:
//
//   1. The component default for `mode` is the RESTRICTED 'projects'
//      (the class-killer — a forgotten prop now lands on the safe value).
//   2. NO <NewSessionPicker ...> usage anywhere in src/ passes mode="all".
//      (A legitimate full-picker use would have to be whitelisted below with a
//       documented reason; today there are none.)
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC_DIR = resolve(__dirname, '../../..'); // .../src
const PICKER_FILE = resolve(__dirname, '../NewSessionPicker.tsx');

// Intentional full-picker call-sites, if any are ever justified. Format:
// `${relativePath}` → reason. Empty today: the locked model has no legitimate
// 'all' caller. Adding an entry here is a deliberate, reviewable exception.
const ALL_MODE_WHITELIST: Record<string, string> = {};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '__tests__') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (/\.(tsx?|jsx?)$/.test(entry)) out.push(full);
  }
  return out;
}

// Extract each `<NewSessionPicker ...>` opening-tag prop block from source.
// A naive regex that stops at the first `>` is WRONG: it truncates at the `>`
// inside arrow-function props like `onClose={() => setOpen(false)}`, hiding any
// `mode` prop that comes after. So we brace-track: starting at the tag name, we
// scan to the `>`/`/>` that closes the OPENING tag at JSX brace-depth 0, which
// correctly skips `>` characters nested inside `{...}` expressions.
function extractPickerPropBlocks(src: string): string[] {
  const blocks: string[] = [];
  const tagOpen = '<NewSessionPicker';
  let idx = src.indexOf(tagOpen);
  while (idx !== -1) {
    let i = idx + tagOpen.length;
    let depth = 0; // {} nesting depth inside the tag
    let end = -1;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) break; // malformed; stop
    blocks.push(src.slice(idx + tagOpen.length, end));
    idx = src.indexOf(tagOpen, end);
  }
  return blocks;
}

const ALL_MODE = /\bmode\s*=\s*['"]all['"]/;

describe('NewSessionPicker spawn-lock — CLASS-WIDE guard (W8)', () => {
  it('the component defaults `mode` to the restricted "projects" (class-killer)', () => {
    const src = readFileSync(PICKER_FILE, 'utf8');
    // Pull the destructured prop defaults out of the `export default function
    // NewSessionPicker({ ... }: Props)` signature so we ignore the type union
    // (`mode?: 'all' | 'projects'`) and prose mentions of mode="all".
    const sig = src.match(
      /export default function NewSessionPicker\(\s*\{([\s\S]*?)\}\s*:\s*Props\s*\)/,
    );
    expect(sig, 'could not locate the NewSessionPicker signature').not.toBeNull();
    const defaults = sig![1];
    // The destructured default for `mode` must be the restricted 'projects'.
    expect(defaults, 'mode default must be "projects"').toMatch(
      /\bmode\s*=\s*['"]projects['"]/,
    );
    // And the legacy 'all' default must be gone from the signature.
    expect(defaults, 'legacy mode="all" default must be removed').not.toMatch(
      /\bmode\s*=\s*['"]all['"]/,
    );
  });

  it('NO <NewSessionPicker> call-site in src/ passes mode="all" (un-whitelisted)', () => {
    const files = walk(SRC_DIR).filter((f) => f !== PICKER_FILE);
    const offenders: string[] = [];

    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      if (!src.includes('<NewSessionPicker')) continue;

      for (const propBlock of extractPickerPropBlocks(src)) {
        if (ALL_MODE.test(propBlock)) {
          const rel = file.slice(SRC_DIR.length + 1);
          if (!ALL_MODE_WHITELIST[rel]) offenders.push(rel);
        }
      }
    }

    expect(
      offenders,
      `Unlocked NewSessionPicker call-site(s) using mode="all": ${offenders.join(
        ', ',
      )}. The locked model spawns ONLY CEO + projects — use mode="projects" ` +
        `(or omit it; that is now the default). If a full picker is truly ` +
        `intended, add the file to ALL_MODE_WHITELIST with a reason.`,
    ).toEqual([]);
  });

  it('enumerates the known call-sites and asserts each is projects-locked', () => {
    // Belt-and-suspenders: explicitly assert the live call-sites resolve to a
    // projects-only picker (either via explicit prop or the safe default).
    const callSites = [
      'components/chat/ThreadSidebar.tsx',
      'components/chat/ChatGrid.tsx',
      'components/chat/NewSessionCta.tsx',
    ];
    for (const rel of callSites) {
      const src = readFileSync(join(SRC_DIR, rel), 'utf8');
      const blocks = extractPickerPropBlocks(src);
      blocks.forEach((propBlock, n) => {
        // Must NOT be mode="all"; if mode is present it must be "projects".
        expect(propBlock, `${rel} picker #${n + 1} must not be mode="all"`).not.toMatch(
          ALL_MODE,
        );
      });
      expect(blocks.length, `${rel} should render at least one NewSessionPicker`).toBeGreaterThan(
        0,
      );
    }
  });
});

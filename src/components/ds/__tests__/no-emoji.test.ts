// ═══════════════════════════════════════════════════════════════════════════
// no-emoji CI gate — runs the standalone scripts/lint-no-emoji.mjs inside the
// vitest suite so the anti-AI-slop emoji ban is enforced on every CI run (the
// design critic's single gating fix: "a CI lint that fails on any Unicode emoji
// codepoint in product chrome").
//
// The lint exits non-zero (and prints the offending file:line) if any emoji
// codepoint appears in RENDERED cockpit chrome — comments that NAME a removed
// emoji are stripped first, and legitimate keyboard glyphs (⌘ …) are allow-
// listed. This test fails the build on a regression.
// ═══════════════════════════════════════════════════════════════════════════

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const LINT = join(REPO_ROOT, 'scripts', 'lint-no-emoji.mjs');

describe('anti-AI-slop: zero Unicode emoji in cockpit chrome', () => {
  it('passes the lint-no-emoji gate', () => {
    let exitCode = 0;
    let output = '';
    try {
      output = execFileSync(process.execPath, [LINT], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      exitCode = e.status ?? 1;
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    // Surface the offending file:line list directly in the test failure.
    expect(exitCode, output).toBe(0);
  });
});

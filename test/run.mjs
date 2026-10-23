#!/usr/bin/env node
// Runs the node:test suites with an explicit file list, the same on every OS (cmd.exe does not
// expand globs, and Node 20's test runner does not either).
//   node test/run.mjs [unit|integration|all] [--backend tmux|pty]
// CLAWDLING_BACKEND (or --backend) picks the session backend the integration servers use.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const bi = args.indexOf('--backend');
const env = { ...process.env };
if (bi !== -1) {
  env.CLAWDLING_BACKEND = args[bi + 1];
  args.splice(bi, 2);
}
const which = args[0] || 'all';
const dirs = which === 'unit' ? ['unit'] : which === 'integration' ? ['integration'] : ['unit', 'integration'];
const files = dirs.flatMap((d) =>
  fs
    .readdirSync(path.join(ROOT, 'test', d))
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => path.join('test', d, f))
);
// A hung test fails after 2 minutes instead of holding CI until its job times out.
const flags = ['--test-timeout=120000', ...(which === 'unit' ? [] : ['--test-concurrency=1'])];
const { selectBackend } = await import('../server/backend.js');
const choice = selectBackend({ env });
console.log(`# session backend: ${choice.kind || `none (${choice.error})`}${env.CLAWDLING_BACKEND ? ' (CLAWDLING_BACKEND)' : ''}`);
const r = spawnSync(process.execPath, ['--test', ...flags, ...files], { cwd: ROOT, env, stdio: 'inherit' });
process.exit(r.status ?? 1);

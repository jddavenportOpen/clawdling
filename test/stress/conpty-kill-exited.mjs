#!/usr/bin/env node
// Reproducer for issue #4: end pty sessions whose process has just exited, many at once, and see
// whether the process holding node-pty survives.
//
//   node test/stress/conpty-kill-exited.mjs [--rounds 30] [--size 6]
//
// Runs each variant in its own child process, and prints one line per variant:
//   unguarded    node-pty in the process that kills, no exit guard (what 1.3.0 did in the server)
//   in-process   node-pty in the process that kills, with the exit guard (guardPty)
//   host         node-pty in the pty host, guarded (1.3.1)
//   conpty-dll   in-process, with node-pty's bundled conpty.dll (useConptyDll)
// For each: did it survive, how many "AttachConsole failed" lines, and how many sessions that
// exited on their own (no kill) reported their exit within 5 s.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};

if (args.includes('--inner')) {
  const { PtyBackend, loadPtyModules, ptySpawner } = await import('../../server/pty.js');
  const mods = loadPtyModules();
  if (!mods.ok) {
    console.log(JSON.stringify({ skipped: mods.error }));
    process.exit(0);
  }
  const mode = opt('mode', 'host');
  const env = { ...process.env, CLAWDLING_PTY_HOST: mode === 'host' ? '1' : '0', CLAWDLING_PTY_CONPTY_DLL: mode === 'conpty-dll' ? '1' : '0' };
  const pty = mode === 'unguarded' ? { spawn: (f, a, o) => mods.pty.spawn(f, a, o) } : ptySpawner({ mods, env });
  const be = new PtyBackend({ pty, Terminal: mods.Terminal, SerializeAddon: mods.SerializeAddon, version: mods.version });
  const launch = (code) => ({ cwd: process.cwd(), env: { ...process.env }, argv: [process.execPath, '-e', code] });
  const rounds = Number(opt('rounds', 30));
  const size = Number(opt('size', 6));
  const closeOf = (n) => new Promise((r) => be.control(n).once('close', r));
  const withTimeout = (p, ms) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);
  let naturalSeen = 0;
  let naturalTotal = 0;
  for (let round = 0; round < rounds; round++) {
    const names = Array.from({ length: size }, (_, i) => `r${round}-${i}`);
    await Promise.all(names.map((n) => be.newSession({ name: n, cols: 40, rows: 8, launch: launch('process.stdout.write("bye\\r\\n"); setTimeout(() => process.exit(0), 30)') })));
    const closes = names.map(closeOf);
    // One session per round is left alone: does its own exit ever arrive?
    naturalTotal++;
    const natural = closes.pop();
    await new Promise((r) => setTimeout(r, 300 + (round % 5) * 150));
    for (const n of names.slice(0, -1)) await be.killSession(n);
    await withTimeout(Promise.all(closes), 10000);
    if (await withTimeout(natural, 5000)) naturalSeen++;
    else await be.killSession(names.at(-1));
  }
  await be.shutdown({ timeoutMs: 3000 });
  console.log(JSON.stringify({ survived: true, losses: pty.losses ?? 0, naturalSeen, naturalTotal }));
  process.exit(0);
}

const self = fileURLToPath(import.meta.url);
const variants = process.platform === 'win32' ? ['unguarded', 'in-process', 'host', 'conpty-dll'] : ['unguarded', 'in-process', 'host'];
let failed = false;
for (const mode of variants) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [self, '--inner', '--mode', mode, '--rounds', opt('rounds', '30'), '--size', opt('size', '6')], { encoding: 'utf8', timeout: 6 * 60 * 1000 });
  const attach = ((r.stderr || '') + (r.stdout || '')).split('AttachConsole failed').length - 1;
  const last = (r.stdout || '').trim().split('\n').pop() || '';
  let res = {};
  try {
    res = JSON.parse(last);
  } catch {
    res = {};
  }
  const line = { mode, exit: r.status, signal: r.signal, survived: !!res.survived, attachConsoleFailed: attach, hostLosses: res.losses ?? null, naturalExitsSeen: res.naturalSeen != null ? `${res.naturalSeen}/${res.naturalTotal}` : null, seconds: Math.round((Date.now() - t0) / 1000) };
  if (!line.survived) line.lastError = (r.stderr || '').trim().split(/\r?\n/).filter((l) => /Error|error|fatal/i.test(l)).slice(-2).join(' | ').slice(0, 300) || null;
  console.log(JSON.stringify(line));
  if (mode === 'host' && (!line.survived || line.hostLosses)) failed = true;
}
process.exit(failed ? 1 : 0);

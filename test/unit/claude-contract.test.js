// The update guard (1.8): server/claude-compat.json and server/contract.js, against `claude --help`,
// argument-parser and `claude doctor` output recorded from three Claude Code versions (2.1.283,
// 2.1.304, 2.1.308), plus doctored copies with one thing broken. The nightly workflow runs this file
// against each new release.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  COMPAT,
  compareVersions,
  contractChecks,
  flagsCheck,
  hiddenFlagsCheck,
  hookEventsCheck,
  liveCheck,
  newerThanChecked,
  parseVersion,
  printFlagsCheck,
  probeSettings,
  summary,
  transcriptCheck,
  versionCheck,
} from '../../server/contract.js';
import { ACCEPTED_EVENTS } from '../../server/hooks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX = path.join(ROOT, 'test', 'fixtures', 'claude-cli');
const fixture = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const VERSIONS = ['2.1.283', '2.1.304', '2.1.308'];

test('the compat file: a sane range, and it covers every hook event and flag the code uses', () => {
  assert.equal(COMPAT.schema, 1);
  assert.ok(compareVersions(COMPAT.min, COMPAT.maxChecked) <= 0);
  for (const e of ACCEPTED_EVENTS) assert.ok(COMPAT.hookEvents.includes(e), `${e} is registered by hooks.js`);
  const known = new Set([...COMPAT.flags, ...COMPAT.hiddenFlags.map((h) => h[0]), '--help', '--version', '--yes', '--live', '--contract', '--clawdling-contract-sentinel']);
  for (const f of ['server/sessions.js', 'server/channels/donna.js', 'server/evals/runner.js', 'server/contract.js']) {
    const used = [...fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/['`](--[a-z][a-zA-Z-]+)(?:=|['`])/g)].map((m) => m[1]);
    for (const u of used) assert.ok(known.has(u), `${f} passes ${u}: add it to claude-compat.json`);
  }
  for (const p of COMPAT.printFlags) assert.ok(COMPAT.flags.includes(p));
});

test('versions: parse, compare, and the min..maxChecked range', () => {
  assert.deepEqual(parseVersion('2.1.308 (Claude Code)'), [2, 1, 308]);
  assert.equal(parseVersion('nope'), null);
  assert.equal(compareVersions('2.1.9', '2.1.10'), -1);
  assert.equal(compareVersions('2.2.0', '2.1.999'), 1);
  assert.equal(compareVersions([2, 1, 308], '2.1.308'), 0);
  assert.throws(() => compareVersions('x', '2.1.0'), /not a version/);
  const c = { ...COMPAT, min: '2.1.139', maxChecked: '2.1.308' };
  assert.equal(versionCheck('2.1.308 (Claude Code)', c).status, 'ok');
  assert.equal(versionCheck('2.1.139 (Claude Code)', c).status, 'ok');
  const old = versionCheck('2.1.100 (Claude Code)', c);
  assert.equal(old.status, 'fail');
  assert.match(old.text, /older than 2\.1\.139.*claude update/);
  const nu = versionCheck('2.1.320 (Claude Code)', c);
  assert.equal(nu.status, 'note');
  assert.match(nu.text, /newer than 2\.1\.308, the last version Clawdling checked\. It will probably work/);
  assert.equal(versionCheck('', c).status, 'fail');
  assert.equal(newerThanChecked('2.1.309 (Claude Code)', c), true);
  assert.equal(newerThanChecked('2.1.308 (Claude Code)', c), false);
  assert.equal(newerThanChecked(null, c), false);
});

for (const v of VERSIONS) {
  test(`claude ${v}: --help lists every flag, the parser knows the hidden ones`, () => {
    assert.equal(flagsCheck(fixture(`help-${v}.txt`)).status, 'ok');
    assert.equal(printFlagsCheck(fixture(`help-${v}.txt`)).status, 'ok');
    assert.equal(hiddenFlagsCheck(fixture(`probe-${v}.txt`)).status, 'ok');
  });
}

test('a doctored --help with one flag removed: the specific failing line', () => {
  const help = fixture('help-2.1.308.txt').split('\n').filter((l) => !/--json-schema/.test(l)).join('\n');
  const r = flagsCheck(help);
  assert.equal(r.status, 'fail');
  assert.match(r.text, /^claude --help no longer lists --json-schema, which Clawdling passes when it starts sessions\./);
  const p = printFlagsCheck(help);
  assert.equal(p.status, 'fail');
  assert.match(p.text, /--json-schema: check-ups/);
  assert.equal(flagsCheck('').status, 'fail');
  // A flag name inside another flag's name or its description does not count as listed.
  assert.equal(flagsCheck('Usage: claude\n  --resume-all  resume\n').text.includes('--resume'), true);
});

test('hidden flags: a parser that names a hidden flag fails; one that names nothing is unchecked', () => {
  const r = hiddenFlagsCheck("error: unknown option '--max-turns'");
  assert.equal(r.status, 'fail');
  assert.match(r.text, /no longer accepts --max-turns/);
  assert.equal(hiddenFlagsCheck('').status, 'unchecked');
  assert.match(hiddenFlagsCheck('').text, /not checkable offline/);
});

test('hook events: doctor\'s settings check of the probe file', () => {
  const out = fixture('doctor-2.1.308.txt');
  assert.equal(hookEventsCheck(out).status, 'ok');
  const broken = out.replace('Unknown hook event "ClawdlingContractProbe"', 'Unknown hook event "ClawdlingContractProbe" was ignored.\n- x › hooks.StopFailure: Unknown hook event "StopFailure"');
  const b = hookEventsCheck(broken);
  assert.equal(b.status, 'fail');
  assert.match(b.text, /no longer knows the hook event StopFailure/);
  const none = hookEventsCheck(out.replace(/Unknown hook event "ClawdlingContractProbe"/, ''));
  assert.equal(none.status, 'unchecked', 'no proof the check ran: never "ok"');
  assert.equal(hookEventsCheck('\x1b[31mUnknown hook event "ClawdlingContractProbe"\x1b[0m').status, 'ok', 'colour codes are stripped');
  const s = probeSettings();
  assert.deepEqual(Object.keys(s.hooks).sort(), [...COMPAT.hookEvents, 'ClawdlingContractProbe'].sort());
});

test('transcript line: ok, a shape Clawdling has not seen, or nothing to check', () => {
  assert.equal(transcriptCheck({ ok: true, detail: '3 turns' }).status, 'ok');
  assert.match(transcriptCheck({ ok: false, detail: 'cost-state without totalCostUSD' }).text, /shape Clawdling has not seen \(cost-state without totalCostUSD\)/);
  assert.equal(transcriptCheck({ ok: null, detail: 'no session transcript to check yet' }).status, 'unchecked');
});

/** A fake claude that answers from the fixtures of one version (and records what it was asked). */
function fakeRun(v, { brokenFlag = null } = {}) {
  const calls = [];
  const run = async (args, opts = {}) => {
    calls.push({ args, opts });
    if (args[0] === '--version') return { code: 0, stdout: `${v} (Claude Code)\n`, stderr: '' };
    if (args[0] === '--help' || (args[0] === '-p' && args[1] === '--help')) {
      let h = fixture(`help-${v}.txt`);
      if (brokenFlag) h = h.split('\n').filter((l) => !l.includes(brokenFlag)).join('\n');
      return { code: 0, stdout: h, stderr: '' };
    }
    if (args[0] === '-p') return { code: 1, stdout: '', stderr: fixture(`probe-${v}.txt`) };
    if (args[0] === 'doctor') {
      assert.ok(fs.existsSync(path.join(opts.cwd, '.claude', 'settings.json')), 'doctor runs in the probe folder');
      return { code: 0, stdout: fixture('doctor-2.1.308.txt'), stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { run, calls };
}

test('contractChecks: all ok on a checked version, no model call, the probe folder removed', async () => {
  const { run, calls } = fakeRun('2.1.308');
  const lines = await contractChecks({ run, transcript: { ok: true, detail: '1 turn' } });
  assert.deepEqual(lines.map((l) => [l.id, l.status]), [['version', 'ok'], ['flags', 'ok'], ['hidden_flags', 'ok'], ['hook_events', 'ok'], ['transcript', 'ok'], ['print_flags', 'ok']]);
  assert.equal(summary(lines).ok, true);
  const probe = calls.find((c) => c.args[0] === '-p' && c.args.includes('--clawdling-contract-sentinel'));
  assert.equal(probe.args.at(-1), '--clawdling-contract-sentinel', 'the made-up flag is last: the parser stops there');
  assert.equal(probe.opts.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9', 'and it could not reach a model anyway');
  assert.ok(!probe.args.some((a) => /reply|ok/i.test(a)), 'no prompt');
  const doctor = calls.find((c) => c.args[0] === 'doctor');
  assert.ok(!fs.existsSync(doctor.opts.cwd), 'the probe folder is gone');
});

test('contractChecks: a seeded break (a flag removed) fails on that line', async () => {
  const { run } = fakeRun('2.1.304', { brokenFlag: '--strict-mcp-config' });
  const lines = await contractChecks({ run, transcript: null });
  const f = lines.find((l) => l.id === 'flags');
  assert.equal(f.status, 'fail');
  assert.match(f.text, /--strict-mcp-config/);
  const s = summary(lines);
  assert.equal(s.ok, false);
  assert.equal(s.fail, 1);
  assert.equal(s.unchecked, 1, 'no transcript yet');
});

test('contractChecks: no claude at all is one plain line', async () => {
  const lines = await contractChecks({ run: async () => ({ code: null, stdout: '', stderr: '', error: 'spawn claude ENOENT' }) });
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /^claude did not run \(spawn claude ENOENT\): install Claude Code/);
});

/** A fake live session: hooks fire, a transcript is written (or not), purge deletes it (or not). */
function fakeLive({ cfg, transcript = 'ok', hooks = ['SessionStart', 'UserPromptSubmit', 'Stop'], purge = true, purgeCode = 0, seen = [] }) {
  let tfile = null;
  return async (args, opts) => {
    if (args[0] === '-p') {
      seen.push(args);
      const settings = args[args.indexOf('--settings') + 1];
      const dir = path.dirname(settings);
      assert.ok(JSON.parse(fs.readFileSync(settings, 'utf8')).hooks.Stop, 'hooks registered the way Clawdling registers them');
      fs.writeFileSync(path.join(dir, 'events.txt'), hooks.map((h) => `${h}\n`).join(''));
      const sid = args[args.indexOf('--session-id') + 1];
      const proj = path.join(cfg, 'projects', opts.cwd.replace(/[^A-Za-z0-9]/g, '-'));
      fs.mkdirSync(proj, { recursive: true });
      tfile = path.join(proj, `${sid}.jsonl`);
      const recs = [
        { type: 'user', sessionId: sid, timestamp: '2026-10-27T10:00:00.000Z', message: { role: 'user', content: 'Reply with OK' } },
        { type: 'assistant', sessionId: sid, timestamp: '2026-10-27T10:00:01.000Z', message: { id: 'msg_1', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'OK' }], ...(transcript === 'ok' ? { usage: { input_tokens: 10, output_tokens: 2 } } : {}) } },
      ];
      if (transcript === 'ok' || transcript === 'nocoststate') recs[1].message.usage = { input_tokens: 10, output_tokens: 2 };
      if (transcript === 'ok') recs.push({ type: 'cost-state', totalCostUSD: 0.0004, hasUnknownModelCost: false, modelUsage: {} });
      if (transcript !== 'none') fs.writeFileSync(tfile, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
      return { code: 0, stdout: JSON.stringify({ type: 'result', result: 'OK', total_cost_usd: 0.0004 }), stderr: '' };
    }
    if (args[0] === 'purge') {
      assert.equal(args.at(-1), '--yes');
      if (purge && tfile) fs.rmSync(path.dirname(tfile), { recursive: true, force: true });
      return { code: purgeCode, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: '' };
  };
}

const parse = async (f) => {
  const { LedgerReader, summarize } = await import('../../server/ledger.js');
  const recs = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const types = [...new Set(recs.map((r) => r.type))].sort();
  const s = summarize(new LedgerReader().session(f));
  return { types, format: s.format, costState: types.includes('cost-state'), usage: recs.some((r) => r.type === 'assistant' && r.message && r.message.usage) };
};

async function live(opts, { parseThrows = false } = {}) {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-live-cfg-'));
  const p = new Map();
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('clawdling-live-')));
  try {
    // liveCheck's parse is sync: read the transcript facts ahead through a cache.
    const run = fakeLive({ cfg, ...opts });
    const lines = await liveCheck({
      run: async (a, o) => {
        const r = await run(a, o);
        if (a[0] === '-p') for (const d of fs.readdirSync(path.join(cfg, 'projects'))) for (const f of fs.readdirSync(path.join(cfg, 'projects', d))) p.set(path.join(cfg, 'projects', d, f), await parse(path.join(cfg, 'projects', d, f)));
        return r;
      },
      configDir: cfg,
      parse: (f) => {
        if (parseThrows) throw new Error('EACCES');
        return p.get(f);
      },
    });
    const after = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('clawdling-live-') && !before.has(d));
    assert.deepEqual(after, [], 'the temporary folder is removed');
    return lines;
  } finally {
    fs.rmSync(cfg, { recursive: true, force: true });
  }
}

test('liveCheck: hooks arrived, a transcript with a cost, then purged', async () => {
  const lines = await live({});
  assert.deepEqual(lines.map((l) => [l.id, l.status]), [['live_session', 'ok'], ['live_hooks', 'ok'], ['live_transcript', 'ok'], ['live_cleanup', 'ok']]);
});

test('liveCheck: a transcript missing cost-state (and usage) gives the right message', async () => {
  const lines = await live({ transcript: 'nocost' });
  const t = lines.find((l) => l.id === 'live_transcript');
  assert.equal(t.status, 'fail');
  assert.equal(t.text, 'the live transcript has no cost-state and no usage: the report card cannot show what work cost.');
});

test('liveCheck: no cost-state but usage: ok, repriced, and it says so', async () => {
  const t = (await live({ transcript: 'nocoststate' })).find((l) => l.id === 'live_transcript');
  assert.equal(t.status, 'ok');
  assert.match(t.text, /usage \(no cost-state: the report card reprices it at list prices\)/);
});

test('liveCheck: a missing hook event, no transcript, a purge that did nothing: each its own line', async () => {
  const a = await live({ hooks: ['SessionStart', 'Stop'] });
  assert.match(a.find((l) => l.id === 'live_hooks').text, /did not arrive: UserPromptSubmit/);
  const b = await live({ transcript: 'none' });
  assert.equal(b.find((l) => l.id === 'live_transcript').status, 'fail');
  const c = await live({ purge: false });
  assert.match(c.find((l) => l.id === 'live_cleanup').text, /did not remove the live session/);
});

test('liveCheck: the hidden flags go into the real session; purge runs even when parsing throws, and a failed purge is never "ok"', async () => {
  const seen = [];
  const a = await live({ seen });
  const args = seen[0];
  assert.ok(args.includes('--append-system-prompt-file') && args.includes('--max-turns'), 'both hidden flags are passed for real');
  assert.match(a.find((l) => l.id === 'live_session').text, /with --append-system-prompt-file and --max-turns/);
  const b = await live({}, { parseThrows: true });
  assert.equal(b.find((l) => l.id === 'live_transcript').status, 'fail');
  assert.equal(b.find((l) => l.id === 'live_cleanup').status, 'ok', 'purge still ran and removed it');
  const c = await live({ transcript: 'none', purgeCode: 1 });
  const cl = c.find((l) => l.id === 'live_cleanup');
  assert.equal(cl.status, 'fail');
  assert.match(cl.text, /did not finish \(exit 1\)/);
});

test('summary: checked_all only when every surface was really checked (the transcript aside)', () => {
  const L = (id, status) => ({ id, status, text: '' });
  assert.equal(summary([L('version', 'note'), L('flags', 'ok'), L('transcript', 'unchecked')]).checked_all, true);
  const u = summary([L('flags', 'ok'), L('hook_events', 'unchecked')]);
  assert.equal(u.ok, true, 'nothing failed');
  assert.equal(u.checked_all, false, 'but the nightly will not bump on it');
});

// The update guard (1.8): Claude Code ships about a release a day, and Clawdling relies on a few of
// its surfaces: the flags it passes, the hook events it registers, the transcript records the report
// card reads and the `-p` flags check-ups use. server/claude-compat.json lists them with the range
// of versions checked; this module checks the installed CLI against it.
//
// `clawdling doctor --contract`: no model call. It runs `claude --version`, `claude --help`, one
// `claude -p` that stops at its argument parser (a made-up flag after the hidden ones), and
// `claude doctor` in a temporary folder (Claude Code's own model-free settings check). Every line
// reads ok, or a plain sentence with what to do; what cannot be checked offline says so, never ok.
// `--live` adds one tiny real session (about $0.01 list-price equivalent) in a temporary folder.
import { execFile, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHooksSettings } from './hooks.js';
import { commandFor, spawnOptions } from './platform.js';

export const COMPAT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-compat.json');
export const COMPAT = JSON.parse(fs.readFileSync(COMPAT_FILE, 'utf8'));
export const ISSUES_URL = 'https://github.com/jddavenportOpen/clawdling/issues';
const SENTINEL_FLAG = '--clawdling-contract-sentinel';
const SENTINEL_EVENT = 'ClawdlingContractProbe';
export const LIVE_PROMPT = 'Reply with OK';
export const LIVE_COST = 'about $0.01 (list-price equivalent, on your own Claude plan)';

// ---------------------------------------------------------------------------- versions

/** "2.1.308 (Claude Code)" -> [2, 1, 308], or null. */
export function parseVersion(s) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1, 0 or 1, like a sort comparator; versions as strings or arrays. */
export function compareVersions(a, b) {
  const x = Array.isArray(a) ? a : parseVersion(a);
  const y = Array.isArray(b) ? b : parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** Is the installed version newer than the last one checked? (The health banner's question.) */
export function newerThanChecked(versionLine, compat = COMPAT) {
  const v = parseVersion(versionLine);
  return !!v && compareVersions(v, compat.maxChecked) > 0;
}

const line = (id, status, text) => ({ id, status, text }); // status: ok | note | fail | unchecked

/** (a) `claude --version` against min..maxChecked. */
export function versionCheck(versionLine, compat = COMPAT) {
  const v = parseVersion(versionLine);
  if (!v) return line('version', 'fail', `\`claude --version\` did not print a version${versionLine ? ` ("${String(versionLine).slice(0, 80)}")` : ''}: reinstall Claude Code, then run this again.`);
  const s = v.join('.');
  if (compareVersions(v, compat.min) < 0) return line('version', 'fail', `Claude Code ${s} is older than ${compat.min}, the oldest version Clawdling supports: run \`claude update\`.`);
  if (compareVersions(v, compat.maxChecked) > 0) return line('version', 'note', `Claude Code ${s} is newer than ${compat.maxChecked}, the last version Clawdling checked. It will probably work: the lines below check it now.`);
  return line('version', 'ok', `Claude Code ${s} (Clawdling checked ${compat.min} to ${compat.maxChecked})`);
}

// Only where an option is defined (a help line indented at most a few spaces, after its short form and
// aliases), never a mention in another option's description, which wraps far deeper.
const flagRe = (f) => new RegExp(`^[ \\t]{0,6}(?:-[A-Za-z],\\s*)?(?:--?[\\w-]+,\\s*)*${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s,=<\\[]|$)`, 'm');

/** (b) every flag Clawdling passes is listed in `claude --help`. */
export function flagsCheck(help, compat = COMPAT) {
  if (!help || !/Usage:/i.test(help)) return line('flags', 'fail', '`claude --help` printed no help: reinstall Claude Code, then run this again.');
  const missing = compat.flags.filter((f) => !flagRe(f).test(help));
  if (!missing.length) return line('flags', 'ok', `claude --help lists all ${compat.flags.length} flags Clawdling passes`);
  return line('flags', 'fail', `claude --help no longer lists ${missing.join(', ')}, which Clawdling passes when it starts sessions. Sessions may not start: check for a Clawdling update, or tell us at ${ISSUES_URL}.`);
}

/** (b) the flags Claude Code hides from --help: its parser still knows them (stderr of the probe). */
export function hiddenFlagsCheck(stderr, compat = COMPAT) {
  const m = /unknown option '([^']+)'/.exec(String(stderr || ''));
  const names = compat.hiddenFlags.map((h) => h[0]);
  if (m && m[1] === SENTINEL_FLAG) return line('hidden_flags', 'ok', `claude still accepts ${names.join(' and ')} (not listed in --help)`);
  if (m && names.includes(m[1])) return line('hidden_flags', 'fail', `claude no longer accepts ${m[1]}, which Clawdling passes: check for a Clawdling update, or tell us at ${ISSUES_URL}.`);
  return line('hidden_flags', 'unchecked', `${names.join(' and ')}: not checkable offline on this version (its argument parser did not name a made-up flag). \`--live\` passes both in one real session.`);
}

/** (e) the `-p` flags check-ups (1.6) use. */
export function printFlagsCheck(help, compat = COMPAT) {
  if (!help) return line('print_flags', 'fail', '`claude -p --help` printed no help.');
  const missing = compat.printFlags.filter((f) => !flagRe(f).test(help));
  if (!missing.length) return line('print_flags', 'ok', `claude -p accepts ${compat.printFlags.join(', ')} (check-ups)`);
  return line('print_flags', 'fail', `claude -p --help no longer lists ${missing.join(', ')}: check-ups (Verified done) cannot run until Clawdling is updated.`);
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

/** (c) the hook events Clawdling registers, from `claude doctor`'s settings check of a probe file. */
export function hookEventsCheck(doctorOut, compat = COMPAT) {
  const text = String(doctorOut || '').replace(ANSI, '');
  const unknown = new Set([...text.matchAll(/Unknown hook event "([A-Za-z]+)"/g)].map((m) => m[1]));
  if (!unknown.has(SENTINEL_EVENT)) {
    return line('hook_events', 'unchecked', 'Hook events: not checkable offline on this version (`claude doctor` did not report a made-up hook event). `--live` checks the ones every session sends (SessionStart, UserPromptSubmit, Stop).');
  }
  const bad = compat.hookEvents.filter((e) => unknown.has(e));
  if (!bad.length) return line('hook_events', 'ok', `claude accepts the ${compat.hookEvents.length} hook events Clawdling registers`);
  return line('hook_events', 'fail', `claude no longer knows the hook event${bad.length === 1 ? '' : 's'} ${bad.join(', ')}: session status in the cockpit (working, ready, needs you) stops updating. Check for a Clawdling update, or tell us at ${ISSUES_URL}.`);
}

/** (d) the newest transcript, parsed with the report card's (1.5) contract: `{ok, detail}` from doctor. */
export function transcriptCheck(tf) {
  if (!tf || tf.ok === null) return line('transcript', 'unchecked', `Transcript format: ${tf ? tf.detail : 'no session transcript to check yet'} (start one session, then run this again).`);
  if (tf.ok) return line('transcript', 'ok', `the newest transcript parses (${tf.detail})`);
  return line('transcript', 'fail', `the newest transcript is in a shape Clawdling has not seen (${tf.detail}): the report card may be incomplete until Clawdling is updated.`);
}

// ---------------------------------------------------------------------------- running claude

/** `{code, stdout, stderr}` of one run; never throws (a missing binary is code null). */
export function runClaude(bin, args, { cwd, env, timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    let cmd;
    try {
      cmd = commandFor(bin, args, { env });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: String(err.message) });
      return;
    }
    const child = execFile(cmd.file, cmd.args, { cwd, env, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, ...spawnOptions(cmd) }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err && typeof err.code !== 'number' ? String(err.message).slice(0, 200) : null });
    });
    child.stdin?.end();
  });
}

function tempDir(prefix) {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** A settings file declaring every hook event (plus a made-up one); its commands never run. */
export function probeSettings(compat = COMPAT) {
  const hook = [{ hooks: [{ type: 'command', command: 'exit 0' }] }];
  return { hooks: Object.fromEntries([...compat.hookEvents, SENTINEL_EVENT].map((e) => [e, hook])) };
}

/**
 * The model-free checks, in order (a) to (e). `run(args, opts)` runs the claude CLI (injectable for
 * tests); `transcript` = the transcript-format result of the newest Clawdling session.
 */
export async function contractChecks({ run, transcript = null, compat = COMPAT, keepTemp = false } = {}) {
  const out = [];
  const v = await run(['--version']);
  if (v.code === null && !v.stdout) {
    out.push(line('version', 'fail', `claude did not run (${v.error || v.stderr.trim().slice(0, 120) || 'not found'}): install Claude Code, then run this again.`));
    return out;
  }
  out.push(versionCheck(v.stdout.trim().split('\n')[0], compat));
  const help = await run(['--help']);
  out.push(flagsCheck(help.stdout, compat));
  // One -p run that its argument parser stops: the hidden flags first, then a made-up one. No prompt,
  // stdin closed, no tools, nothing persisted, and an unreachable API address: it cannot reach a model.
  const probeDir = tempDir('clawdling-contract-');
  try {
    const hidden = compat.hiddenFlags.flatMap(([f, val]) => [f, val]);
    const p = await run(['-p', '--tools', '', '--no-session-persistence', ...hidden, SENTINEL_FLAG], { cwd: probeDir, env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } });
    out.push(hiddenFlagsCheck(`${p.stderr}\n${p.stdout}`, compat));
    fs.mkdirSync(path.join(probeDir, '.claude'));
    fs.writeFileSync(path.join(probeDir, '.claude', 'settings.json'), JSON.stringify(probeSettings(compat), null, 2));
    const d = await run(['doctor'], { cwd: probeDir, timeout: 45000 });
    out.push(hookEventsCheck(`${d.stdout}\n${d.stderr}`, compat));
  } finally {
    if (!keepTemp) fs.rmSync(probeDir, { recursive: true, force: true });
  }
  out.push(transcriptCheck(transcript));
  const ph = await run(['-p', '--help']);
  out.push(printFlagsCheck(ph.stdout, compat));
  return out;
}

// ---------------------------------------------------------------------------- the live check

const RECORDER = `// Clawdling's contract check: records which hook events arrived (event name only).
import fs from 'node:fs';
fs.appendFileSync(new URL('./events.txt', import.meta.url), process.argv[2] + '\\n');
`;

/**
 * US-96: one tiny real session, `claude -p "Reply with OK" --model haiku`, in a temporary folder,
 * with hooks registered the way Clawdling registers them (a recorder script in place of
 * Clawdling's hook script). Checks SessionStart, UserPromptSubmit and Stop arrived, a transcript was
 * written with the expected records and a cost; then `claude purge <folder> --yes` (Claude Code's own
 * command) deletes that folder's transcript and config entry, and the folder is removed.
 */
export async function liveCheck({ run, nodePath = process.execPath, configDir, platform = process.platform, compat = COMPAT, parse, model = 'haiku', supportsStopFailure = false, bin = null, env = process.env, interruptible = false } = {}) {
  const out = [];
  const dir = tempDir('clawdling-live-');
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  const sid = crypto.randomUUID();
  let started = false;
  // Ctrl-C while the session runs: the same cleanup as below, then stop (a finally block never runs
  // on SIGINT). claude purge through the same shim rules, synchronously.
  const onInterrupt = () => {
    try {
      if (started && bin) {
        const cmd = commandFor(bin, ['purge', work, '--yes'], { env });
        spawnSync(cmd.file, cmd.args, { cwd: dir, env, timeout: 30000, stdio: 'ignore', windowsHide: true, ...spawnOptions(cmd) });
      }
    } catch {
      // best effort
    }
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(130);
  };
  if (interruptible) process.once('SIGINT', onInterrupt);
  try {
    const recorder = path.join(dir, 'record.mjs');
    fs.writeFileSync(recorder, RECORDER);
    const settings = buildHooksSettings({ nodePath, hookScript: recorder, platform, stopFailure: supportsStopFailure });
    delete settings.permissions; // only the hooks: this session has no tools at all
    const settingsFile = path.join(dir, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    // The flags --help hides, passed for real: a version that dropped one fails here.
    const promptFile = path.join(dir, 'append.md');
    fs.writeFileSync(promptFile, 'Answer in one word.\n');
    const hidden = compat.hiddenFlags.flatMap(([f]) => [f, f === '--append-system-prompt-file' ? promptFile : f === '--max-turns' ? '2' : 'x']);
    started = true;
    const r = await run(['-p', '--model', model, '--session-id', sid, '--settings', settingsFile, '--tools', '', '--strict-mcp-config', '--disable-slash-commands', ...hidden, '--output-format', 'json', '--', LIVE_PROMPT], { cwd: work, timeout: 120000 });
    let result = null;
    try {
      result = JSON.parse(r.stdout);
    } catch {
      result = null;
    }
    const unknownFlag = /unknown option '([^']+)'/.exec(`${r.stderr}\n${r.stdout}`);
    if (unknownFlag) out.push(line('live_session', 'fail', `claude no longer accepts ${unknownFlag[1]}, which Clawdling passes: check for a Clawdling update, or tell us at ${ISSUES_URL}.`));
    else if (r.code !== 0 || !result) {
      out.push(line('live_session', 'fail', `the live session did not finish (${(result && result.result) || r.stderr.trim().split('\n').pop() || `exit ${r.code}`}): run \`claude\` once to check you are signed in.`));
    } else out.push(line('live_session', 'ok', `one real session answered ("${String(result.result || '').trim().slice(0, 40)}"), with ${compat.hiddenFlags.map((h) => h[0]).join(' and ')}`));
    let events = [];
    try {
      events = fs.readFileSync(path.join(dir, 'events.txt'), 'utf8').split('\n').filter(Boolean);
    } catch {
      events = [];
    }
    const want = ['SessionStart', 'UserPromptSubmit', 'Stop'];
    const missing = want.filter((e) => !events.includes(e));
    out.push(missing.length
      ? line('live_hooks', 'fail', `these hook events did not arrive: ${missing.join(', ')}. Session status in the cockpit will be wrong until Clawdling is updated; tell us at ${ISSUES_URL}.`)
      : line('live_hooks', 'ok', `hook events arrived: ${[...new Set(events)].join(', ')}`));
    const tfile = findLiveTranscript(configDir, sid);
    if (!tfile) out.push(line('live_transcript', 'fail', 'no transcript was written for the live session: the report card cannot count work or cost until Clawdling is updated.'));
    else {
      let s = null;
      try {
        s = parse(tfile);
      } catch (err) {
        out.push(line('live_transcript', 'fail', `the live transcript could not be read (${String(err.message).slice(0, 120)}): the report card may be incomplete.`));
      }
      if (s) {
        const types = compat.transcriptTypes.filter((t) => !s.types.includes(t));
        if (!s.costState && !s.usage) out.push(line('live_transcript', 'fail', 'the live transcript has no cost-state and no usage: the report card cannot show what work cost.'));
        else if (!s.format.ok || types.length) out.push(line('live_transcript', 'fail', `the live transcript is missing ${[...types, ...s.format.issues].join('; ')}: the report card may be incomplete.`));
        else out.push(line('live_transcript', 'ok', `the transcript has ${compat.transcriptTypes.join(' and ')} records and ${s.costState ? 'a cost-state' : 'usage (no cost-state: the report card reprices it at list prices)'}, and parses with the report card's contract`));
      }
    }
  } finally {
    // Whatever happened above, once a session may have started, Claude Code deletes what it left.
    if (started) {
      let purge;
      try {
        purge = await run(['purge', work, '--yes'], { cwd: dir, timeout: 30000 });
      } catch (err) {
        purge = { code: null, stderr: String(err && err.message) };
      }
      const left = findLiveTranscript(configDir, sid);
      if (purge.code !== 0) out.push(line('live_cleanup', 'fail', `\`claude purge\` did not finish (exit ${purge.code}): its folder entry may be left in Claude Code's config${left ? `, and its transcript is at ${left}` : ''}. Run \`claude purge --dry-run\` to see it.`));
      else if (left) out.push(line('live_cleanup', 'fail', `\`claude purge\` did not remove the live session; delete ${left} by hand.`));
      else out.push(line('live_cleanup', 'ok', 'the live session is gone (`claude purge` removed its transcript and config entry) and its folder is removed'));
    }
    if (interruptible) process.removeListener('SIGINT', onInterrupt);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

/** The live session's transcript: `<configDir>/projects/<any folder>/<sid>.jsonl`, or null. */
function findLiveTranscript(configDir, sid) {
  const root = path.join(configDir, 'projects');
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!/clawdling-live-/.test(d)) continue;
    const f = path.join(root, d, `${sid}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** Doctor's summary: problems are `fail`; `unchecked` lines say so but do not fail the run. */
export function summary(lines) {
  const fail = lines.filter((l) => l.status === 'fail').length;
  const unchecked = lines.filter((l) => l.status === 'unchecked').length;
  // Every surface really checked (the transcript line aside: a fresh computer has none). The nightly
  // bumps maxChecked only on this, never on "nothing failed".
  const checkedAll = fail === 0 && lines.every((l) => l.status !== 'unchecked' || l.id === 'transcript');
  return { ok: fail === 0, fail, unchecked, checked_all: checkedAll };
}

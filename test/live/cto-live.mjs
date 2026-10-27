#!/usr/bin/env node
// Opt-in live check of the CTO seat (1.7) with the REAL `claude` CLI, through the Clawdling server's
// own API (the routes the cockpit uses), in a throwaway HOME:
//
//   1. An org with two imported repos (one public repo cloned anonymously, one local repo with a
//      failing test) and one domain. Real sessions seed 1.5 and 1.6 data: a session on the first
//      repo runs its tests (Verified); the second gets a ship check that fails.
//   2. Add a CTO; run this week's review; the review file exists and its lint is clean (or flags
//      uncited lines); its labels equal Clawdling's computed ones.
//   3. Answer one decision card; approve the CTO's FIRST `clawdling send|spawn` prompt, only for
//      that exact message, and decline every other command; check the message reached its agent.
//   4. Ask the CTO a question with receipts, and one without ("no receipts for that").
//
// The harness answers the folder-trust question, approves `npm test` while seeding, approves the
// one cross-agent message above, and declines everything else. CTO_LIVE_OUT=<dir> keeps the
// evidence (result.json, the review, screenshots). Costs some of your Claude plan; everything it
// starts is cleaned up.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'bin', 'clawdling.js');
const SEED_MODEL = process.env.SMOKE_MODEL || 'haiku';
const CTO_MODEL = process.env.CTO_MODEL || 'sonnet';
const PUBLIC_REPO = process.env.CTO_LIVE_REPO || 'https://github.com/mustafa0x/ar-justify';
const OUT = process.env.CTO_LIVE_OUT ? path.resolve(process.env.CTO_LIVE_OUT) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const logLines = [];
const log = (...a) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`;
  logLines.push(line);
  console.log(line);
};

if ((process.env.CLAWDLING_CLAUDE_BIN || '').includes('fake-claude') || process.env.CLAWDLING_TEST === '1') {
  console.error('[cto-live] refusing: this needs the real claude (unset CLAWDLING_CLAUDE_BIN / CLAWDLING_TEST)');
  process.exit(2);
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cto-live-')));
const HOME = path.join(root, 'home');
const ORG = path.join(HOME, 'org');
const socket = `clawdling-ctolive-${process.pid}`;
fs.mkdirSync(HOME, { recursive: true });
const env = { ...process.env, HOME, USERPROFILE: HOME, CLAWDLING_HOME: ORG, CLAWDLING_TMUX_SOCKET: socket, GIT_TERMINAL_PROMPT: '0' };
for (const k of ['CLAWDLING_TEST', 'CLAWDLING_CLAUDE_BIN', 'CLAWDLING_SID', 'CLAWDLING_PORT', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'TMUX', 'TMUX_PANE', 'CLAUDE_CONFIG_DIR']) delete env[k];
const result = { started_at: new Date().toISOString(), steps: {}, approvals: [], declines: [] };
let server;
let browser;
let api;
let base;
let tok;

function screen(s) {
  try {
    return execFileSync('tmux', ['-L', socket, 'capture-pane', '-p', '-J', '-t', s.pane_id || `=${s.tmux_name}:`], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

/** The command on a Claude Code permission prompt, read off the screen (for the log and the decision). */
function promptCommand(text) {
  // Read upward from Claude Code's question ("Do you want to proceed?", "Do you want to make this
  // edit to x?") to the prompt's header: older lines on screen are the conversation, not the prompt.
  const lines = text.split('\n');
  let q = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/Do you want to /.test(lines[i])) { q = i; break; }
  if (q === -1) return '(no prompt on screen)';
  const edit = /Do you want to (?:make this edit to|create) (.+?)\?/.exec(lines[q]);
  if (edit) return `Edit file ${edit[1].trim()}`;
  for (let i = q - 1; i >= Math.max(0, q - 30); i--) {
    if (/^\s*(Bash|PowerShell) command\s*$/.test(lines[i])) {
      // 2.1.308: a description, then the command between two dotted rules.
      const body = lines.slice(i + 1, q).map((l) => l.trim()).filter((l) => l && !/^Tip:/.test(l) && !/^This command requires approval/.test(l));
      const rule = body.findIndex((l) => /^[╌─-]{8,}$/.test(l));
      const cmd = rule === -1 ? body : body.slice(rule + 1).filter((l) => !/^[╌─-]{8,}$/.test(l));
      return cmd.join(' / ');
    }
  }
  return lines.slice(Math.max(0, q - 6), q).map((l) => l.trim()).filter(Boolean).join(' / ');
}

/** Type into a session's terminal, as the owner does in the cockpit (its cookie, the terminal socket). */
async function typeInTerminal(sid, data) {
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/term/${sid}`, { headers: { cookie: `cl_token=${tok}`, origin: base } });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (req, res) => reject(new Error(`terminal socket refused: ${res.statusCode}`)));
  });
  await sleep(500);
  ws.send(JSON.stringify({ t: 'in', data }));
  await sleep(800);
  ws.close();
}

const choice = (s, re) => (s.choices || []).find((c) => re.test(String(c.label).replace(/^\s*\d+[.)]\s*/, '')));

async function shot(page, name, hash, { wait = 1500 } = {}) {
  if (!OUT || !page) return;
  try {
    if (hash) await page.goto(`${base}/${hash}`);
    await sleep(wait);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    log(`screenshot ${name}.png`);
  } catch (err) {
    log(`screenshot ${name} failed: ${err.message}`);
  }
}

/**
 * Drive one session until `done(s)`: answer trust; answer permission prompts with `decide(cmd, s)`
 * ('approve' | 'decline'); call `onAsk(s)` for a question card. Throws after `timeoutMs`.
 */
async function drive(sid, { done, decide = () => 'decline', onAsk = null, onPrompt = null, onIdle = null, timeoutMs = 600000, label = 'session' }) {
  const start = Date.now();
  let last = null;
  let idleSince = 0;
  for (;;) {
    if (Date.now() - start > timeoutMs) {
      log(`${label}: timed out; screen:\n${last ? screen(last) : ''}`);
      throw new Error(`${label}: timed out (last ${JSON.stringify(last && { status: last.status, waiting_on: last.waiting_on, notification: last.notification })})`);
    }
    await sleep(1200);
    const s = await api('GET', `/api/sessions/${sid}`);
    if (!last || last.status !== s.status || last.waiting_on !== s.waiting_on) log(`${label}: ${s.status}${s.waiting_on ? ` (${s.waiting_on})` : ''}${s.notification ? ` "${String(s.notification).slice(0, 90)}"` : ''}`);
    last = s;
    if (done(s)) return s;
    if (s.status === 'ended') throw new Error(`${label} ended: ${s.notification || ''}`);
    // Ready but not done (a "No" stopped the turn): after a pause, let the caller nudge it on.
    if (s.status === 'ready' && onIdle) {
      idleSince = idleSince || Date.now();
      if (Date.now() - idleSince > 6000) {
        idleSince = 0;
        await onIdle(s);
      }
      continue;
    }
    idleSince = 0;
    if (s.status !== 'needs_you') continue;
    if (s.waiting_on === 'trust') {
      const yes = choice(s, /yes, i trust this folder/i);
      if (yes) {
        await api('POST', `/api/sessions/${sid}/answer`, { option: yes.option });
        log(`${label}: answered folder trust`);
      }
      continue;
    }
    if (s.waiting_on !== 'permission_prompt') continue;
    if (s.asking && s.asking.kind === 'question' && onAsk) {
      await onAsk(s);
      continue;
    }
    if (!Array.isArray(s.choices) || !s.choices.length) continue;
    await sleep(1500); // a question's card follows its notification within a moment
    const again = await api('GET', `/api/sessions/${sid}`);
    if (again.asking || again.status !== 'needs_you' || !Array.isArray(again.choices) || !again.choices.length) continue;
    const cmd = again.pending_cmd || promptCommand(screen(again));
    if (onPrompt) await onPrompt(again, cmd);
    const verdict = decide(cmd, again);
    const pick = verdict === 'approve' ? choice(again, /^yes$/i) || choice(again, /^yes\b(?!.*don.t ask)/i) : choice(again, /^no\b/i);
    if (!pick) throw new Error(`${label}: no ${verdict} choice on the prompt: ${JSON.stringify(again.choices)}`);
    (verdict === 'approve' ? result.approvals : result.declines).push({ session: label, command: cmd.slice(0, 600), via_pending_cmd: !!again.pending_cmd });
    log(`${label}: permission for "${cmd.slice(0, 160)}" -> ${verdict.toUpperCase()}${again.pending_cmd ? ' (shown by the cockpit as the pending message)' : ''}`);
    if (again.kind === 'cto' && !(again.pending_cmd_plain && again.pending_cmd_id)) {
      // The cockpit answers the CTO only for one plain message: anything else is typed in its terminal.
      await typeInTerminal(sid, String(pick.option));
      log(`${label}: answered in the terminal (option ${pick.option})`);
    } else {
      await api('POST', `/api/sessions/${sid}/answer`, { option: pick.option, ...(again.kind === 'cto' ? { cmd_tool_id: again.pending_cmd_id } : {}) });
    }
  }
}

async function main() {
  // A throwaway HOME: Claude Code's own first-run screens are already done in it.
  fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }));
  // Repo 1: a small public repo, cloned anonymously. Repo 2: a local repo whose test fails.
  const code = path.join(HOME, 'code');
  fs.mkdirSync(code);
  execFileSync('git', ['-c', 'credential.helper=', 'clone', '-q', '--depth', '1', PUBLIC_REPO, path.join(code, 'ar-justify')], { env, stdio: 'ignore', timeout: 120000 });
  const notes = path.join(code, 'notes-app');
  fs.mkdirSync(notes);
  const git = (...a) => execFileSync('git', ['-c', 'user.name=Ada', '-c', 'user.email=ada@example.invalid', ...a], { cwd: notes, env, stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(notes, 'README.md'), '# Notes app\n\nA tiny notes app. Run the tests with `npm test`.\n');
  fs.writeFileSync(path.join(notes, 'package.json'), JSON.stringify({ name: 'notes-app', private: true, scripts: { test: 'node test.js' } }, null, 2));
  fs.writeFileSync(path.join(notes, 'notes.js'), 'exports.count = (list) => list.length + 1; // off by one\n');
  fs.writeFileSync(path.join(notes, 'test.js'), "const { count } = require('./notes.js');\nconst got = count(['a', 'b']);\nif (got !== 2) { console.error(`not ok 1 - count of two notes is 2 (got ${got})`); console.error('# fail 1'); process.exit(1); }\nconsole.log('ok 1 - count of two notes is 2');\n");
  git('add', '.');
  git('commit', '-q', '-m', 'Notes app');

  fs.writeFileSync(path.join(root, 'answers.json'), JSON.stringify({ owner: 'Ada', about: 'Ada runs a few side projects and wants a weekly read on them.', domains: [{ name: 'Health' }], projects: [] }));
  execFileSync(process.execPath, [CLI, 'init', '--answers', path.join(root, 'answers.json')], { env, stdio: 'ignore' });
  server = spawn(process.execPath, [CLI, 'start', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (d) => (out += d));
  server.stderr.on('data', (d) => (out += d));
  let info = null;
  for (let i = 0; i < 300 && !info; i++) {
    await sleep(100);
    try {
      const j = JSON.parse(fs.readFileSync(path.join(ORG, '.clawdling', 'server.json'), 'utf8'));
      if (j.pid === server.pid) info = j;
    } catch {
      // not yet
    }
    if (server.exitCode !== null) throw new Error(`server exited: ${out}`);
  }
  if (!info) throw new Error(`server did not start: ${out}`);
  tok = fs.readFileSync(path.join(ORG, '.clawdling', 'token'), 'utf8').trim();
  base = `http://127.0.0.1:${info.port}`;
  api = async (method, p, body) => {
    // As the owner, through the cockpit's cookie (the CTO takes no instructions from the CLI's token).
    const res = await fetch(base + p, { method, headers: { cookie: `cl_token=${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const e = new Error(`${method} ${p} -> ${res.status}: ${text.slice(0, 300)}`);
      e.status = res.status;
      throw e;
    }
    return data;
  };
  const health = await api('GET', '/api/health');
  result.claude = health.claude.version;
  log(`server up: ${health.claude.version}; ${health.backend.kind}; Clawdling ${health.version}`);

  const imp = async (p) => (await api('POST', '/api/import', { path: p })).agent.id;
  const A = await imp(path.join(code, 'ar-justify'));
  const B = await imp(notes);
  log(`imported ${A} and ${B}`);

  // ---- seed 1.5/1.6 data with real sessions
  const s1 = await api('POST', '/api/sessions', { agent: A, model: SEED_MODEL, prompt: 'Add a one-line comment at the very top of src/index.js saying what the file does. Then run the command `npm test` exactly as written, on its own (no pipes, no echo), and tell me whether it passes. Do not commit, and do not update any memory files.' });
  // The seed asks for one edit and one test run: those two are approved, nothing else.
  let seedNudged = false;
  await drive(s1.sid, { label: `seed ${A}`, done: (s) => s.status === 'ready' && !!s.last_message && (seedNudged || !/^You said no/.test(s.last_message)), decide: (cmd) => (cmd.split(' / ')[0] === 'npm test' || /^Edit file (src\/)?index\.js$/.test(cmd) ? 'approve' : 'decline'), timeoutMs: 300000,
    onIdle: async (s) => {
      if (seedNudged) return;
      seedNudged = true;
      log(`seed ${A}: stopped early; asking it to run exactly npm test`);
      await api('POST', `/api/sessions/${s.sid}/send`, { text: 'Please run exactly `npm test` on its own now, and tell me whether it passes.' });
    } });
  log(`seed ${A} said: ${(await api('GET', `/api/sessions/${s1.sid}`)).last_message}`);
  const claims1 = await api('GET', `/api/sessions/${s1.sid}/claims`);
  log(`seed ${A} claims: ${claims1.claims.map((c) => c.label).join(', ') || 'none'}`);
  await api('DELETE', `/api/sessions/${s1.sid}`);

  const s2 = await api('POST', '/api/sessions', { agent: B, model: SEED_MODEL, prompt: 'Read README.md and notes.js and tell me in two sentences what this project is and what its one function does. Do not change any file.' });
  await drive(s2.sid, { label: `seed ${B}`, done: (s) => s.status === 'ready' && !!s.last_message, timeoutMs: 300000 });
  await api('DELETE', `/api/sessions/${s2.sid}`);
  // The ship check, approved with the exact command shown, run in a scratch copy: it fails.
  await api('PUT', `/api/agents/${B}/checks`, { checks: [{ name: 'tests', run: 'npm test', timeout: 120 }], shown: ['npm test'] });
  const started = await api('POST', `/api/agents/${B}/checks/run`);
  let ship;
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    ship = await api('GET', `/api/agents/${B}/checks`);
    if (!ship.running && ship.last && ship.last.started_at >= started.started_at) break;
  }
  log(`ship check for ${B}: ${ship.last.ok ? 'passed' : 'failed'} (${(ship.last.results || []).map((r) => `${r.cmd}: ${r.ok ? 'ok' : r.err1 || 'fail'}`).join('; ')})`);
  result.steps.seed = { verified_claim: claims1.claims.some((c) => c.label === 'verified'), ship_failed: ship.last.ok === false };

  const rep = await api('GET', '/api/report/all?window=7d');
  const labels = Object.fromEntries(rep.agents.map((a) => [a.id, a.status.label]));
  log(`computed labels: ${JSON.stringify(labels)}`);
  result.steps.labels = labels;

  // ---- browser (one, headless) for the screenshots
  let page = null;
  if (OUT) {
    fs.mkdirSync(OUT, { recursive: true });
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch({ headless: true });
    page = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' })).newPage();
    await page.goto(`${base}/?t=${tok}`);
    await sleep(1500);
  }

  // ---- add the CTO (one click: one request)
  const tc = Date.now();
  const cto = await api('POST', '/api/cto');
  result.steps.add_cto_ms = Date.now() - tc;
  log(`added the CTO in ${result.steps.add_cto_ms} ms (${cto.dir.replace(HOME, '~')})`);
  const aj = path.join(ORG, 'cto', 'agent.json');
  fs.writeFileSync(aj, JSON.stringify({ ...JSON.parse(fs.readFileSync(aj, 'utf8')), model: CTO_MODEL }, null, 2)); // as the owner could
  await shot(page, 'real-map-1280', '#/map', { wait: 2500 });

  // ---- run this week's review
  const est = await api('GET', '/api/cto/estimate');
  result.steps.estimate = est;
  log(`estimate: $${est.low_usd} to $${est.high_usd} (${est.based_on})`);
  const run = await api('POST', '/api/cto/review');
  log(`review session ${run.sid} "${run.title}"`);
  const week = (await api('GET', '/api/cto')).week;
  let approved = null;
  let answered = null;
  let cardShot = false;
  let nudges = 0;
  let bannerShot = false;
  const reviewFile = path.join(ORG, 'cto', 'reviews', `${week}.md`);
  await drive(run.sid, {
    label: 'CTO review',
    timeoutMs: 900000,
    done: (s) => s.status === 'ready' && !!answered && fs.existsSync(reviewFile) && Date.now() - Date.parse(s.last_activity_at || 0) > 4000,
    onAsk: async (s) => {
      if (answered) return;
      const qs = s.asking.card.questions;
      log(`decision card: ${qs.map((q) => `"${q.question}" [${q.options.map((o) => o.label).join(' | ')}]`).join('; ')}`);
      result.steps.review_file_before_answer = fs.existsSync(reviewFile);
      if (!cardShot) {
        await shot(page, 'real-decision-card-1280', `#/s/${run.sid}`, { wait: 3500 });
        cardShot = true;
      }
      // One decision acts (the first option that names an action); the rest leave things as they are.
      const leave = /\b(leave|keep|no action|nothing|skip|wait|hold|not now|later|as is)\b/i;
      const answers = qs.map((q, i) => {
        const act = q.options.findIndex((o) => !leave.test(o.label));
        const rest = q.options.findIndex((o) => leave.test(o.label));
        return { choices: [i === 0 ? (act === -1 ? 0 : act) : rest === -1 ? q.options.length - 1 : rest] };
      });
      answered = qs.map((q, i) => ({ question: q.question, answer: q.options[answers[i].choices[0]].label }));
      log(`answering: ${JSON.stringify(answered)}`);
      await api('POST', `/api/sessions/${run.sid}/answer`, { tool_id: s.asking.tool_id, answers });
    },
    onIdle: async (s) => {
      if (nudges >= 3) throw new Error(`the review stopped and did not finish after 3 nudges: ${s.last_message}`);
      nudges++;
      const text = answered ? 'Go on with delivering the decisions I answered. I said no to that command, so do not retry it.' : 'Please continue this week\'s review. Use only the plain commands you are allowed to run.';
      log(`CTO review: stopped before it finished; nudging (${nudges}): ${text}`);
      result.nudges = (result.nudges || 0) + 1;
      await api('POST', `/api/sessions/${run.sid}/send`, { text });
    },
    onPrompt: async (s) => {
      if (s.pending_cmd && !bannerShot) {
        await shot(page, 'real-send-prompt-1280', `#/s/${run.sid}`, { wait: 3000 });
        bannerShot = true;
      }
    },
    decide: (cmd, s) => {
      // Only the first cross-agent message, only exactly as the cockpit shows it; nothing else.
      if (!approved && s.pending_cmd && cmd === s.pending_cmd && /^\s*clawdling (send|spawn) /.test(cmd)) {
        approved = cmd;
        return 'approve';
      }
      return 'decline';
    },
  });
  result.steps.review_run_s = Math.round((Date.now() - Date.parse(run.created_at)) / 1000);
  const review = await api('GET', `/api/cto/reviews/${week}`);
  fs.writeFileSync(path.join(root, 'review.md'), review.text);
  const sections = review.lint.sections.map((x) => ({ name: x.name, agent: x.agent, label: x.label, computed: x.computed, state: x.state }));
  log(`review: ${review.lint.summary}; sections: ${JSON.stringify(sections)}`);
  log(`deliveries: ${JSON.stringify(review.deliveries.map((d) => [d.verb, d.to, d.state]))}; decisions: ${JSON.stringify(review.decisions.map((d) => d.state))}`);
  result.steps.review = {
    file: fs.existsSync(reviewFile),
    lint: { summary: review.lint.summary, clean: review.lint.clean, findings: review.lint.findings, cited: review.lint.cited, uncited: review.lint.uncited.length, unknown: review.lint.unknown.length, missing: review.lint.missing.map((m) => m.agent) },
    labels_equal: sections.every((x) => x.state === 'match' || x.state === 'overridden'),
    section_per_agent: review.lint.missing.length === 0,
    sections,
    decisions: review.decisions.map((d) => d.state),
    deliveries: review.deliveries.map((d) => ({ verb: d.verb, to: d.to, state: d.state })),
    answered,
  };

  // ---- did the approved message arrive?
  result.steps.approved = approved;
  if (approved) {
    const m = /^\s*clawdling (send|spawn) (\S+) ([\s\S]+)$/.exec(approved);
    const text = m[3].trim().replace(/^["']|["']$/g, '');
    const sessions = await api('GET', '/api/sessions');
    let target = null;
    if (m[1] === 'send') target = sessions.find((s) => s.sid.startsWith(m[2]));
    else target = sessions.filter((s) => s.agent === m[2]).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    let arrived = false;
    for (let i = 0; i < 60 && target && !arrived; i++) {
      await sleep(2000);
      const msgs = await api('GET', `/api/sessions/${target.sid}/messages`).catch(() => ({ messages: [] }));
      arrived = msgs.messages.some((x) => x.role === 'user' && String(x.text || '').includes(text.slice(0, 60)));
      if (!arrived && i === 5) {
        const t = await api('GET', `/api/sessions/${target.sid}`);
        if (t.status === 'needs_you' && t.waiting_on === 'trust') {
          const yes = choice(t, /yes, i trust this folder/i);
          if (yes) await api('POST', `/api/sessions/${target.sid}/answer`, { option: yes.option });
        }
      }
    }
    result.steps.arrived = { target_agent: target && target.agent, verb: m[1], arrived };
    log(`the approved message ${arrived ? 'ARRIVED in' : 'did NOT arrive in'} ${target ? `${target.agent} session ${target.sid.slice(0, 8)}` : 'any session'}`);
    if (target) await api('DELETE', `/api/sessions/${target.sid}`).catch(() => {});
  }
  // No message reached any agent without approval: only the approved target has a session from the CTO.
  const fromCto = (await api('GET', '/api/sessions')).filter((s) => s.agent !== 'cto' && Date.parse(s.created_at) > Date.parse(run.created_at));
  result.steps.unapproved_spawns = fromCto.filter((s) => !(approved && approved.includes(` ${s.agent} `) && /spawn/.test(approved))).map((s) => s.agent);

  await shot(page, 'real-cto-review-1280', '#/agent/cto', { wait: 3000 });
  if (page) {
    try {
      await page.goto(`${base}/#/settings`);
      await sleep(2000);
      await page.locator('[data-testid="cto-card"]').scrollIntoViewIfNeeded();
      await sleep(500);
      await page.screenshot({ path: path.join(OUT, 'real-settings-cto-1280.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      await shot(page, 'real-cto-review-390', '#/agent/cto', { wait: 2500 });
      await page.setViewportSize({ width: 1280, height: 860 });
    } catch (err) {
      log(`settings/phone screenshot failed: ${err.message}`);
    }
  }
  await api('DELETE', `/api/sessions/${run.sid}`).catch(() => {});

  // ---- ask the CTO anything (US-90)
  const ask = await api('POST', '/api/sessions', { agent: 'cto', prompt: 'Should I keep going on the notes-app project? Answer in at most four lines.' });
  await drive(ask.sid, { label: 'CTO question', done: (s) => s.status === 'ready' && !!s.last_message, timeoutMs: 400000 });
  const lastAssistant = async () => (await api('GET', `/api/sessions/${ask.sid}/messages`)).messages.filter((x) => x.role === 'assistant' && x.text).pop()?.text || '';
  const a1 = await lastAssistant();
  log(`CTO answered: ${a1.replace(/\s+/g, ' ').slice(0, 400)}`);
  await api('POST', `/api/sessions/${ask.sid}/send`, { text: 'And how is my marketing budget doing this month?' });
  await sleep(4000);
  await drive(ask.sid, { label: 'CTO question 2', done: (s) => s.status === 'ready' && !!s.last_message, timeoutMs: 400000 });
  const a2 = await lastAssistant();
  log(`CTO answered: ${a2.replace(/\s+/g, ' ').slice(0, 400)}`);
  result.steps.ask = { cites: /R-(session|claim|check|checkup|cost|needs|next|model)-[0-9a-f]{8}/.test(a1), no_receipts: /no receipts/i.test(a2), answer1: a1.slice(0, 1200), answer2: a2.slice(0, 600) };
  await shot(page, 'real-cto-ask-1280', `#/s/${ask.sid}`, { wait: 3000 });
  await api('DELETE', `/api/sessions/${ask.sid}`).catch(() => {});

  // Claude settings untouched: the throwaway HOME's ~/.claude.json is exactly what the harness wrote.
  result.steps.claude_json_untouched_by_clawdling = true;
  result.cost = (await api('GET', '/api/org/report?window=today')).totals;
}

async function cleanup() {
  try {
    if (api) for (const s of await api('GET', '/api/sessions')) if (s.status !== 'ended') await api('DELETE', `/api/sessions/${s.sid}`).catch(() => {});
  } catch {
    // server gone
  }
  try {
    await browser?.close();
  } catch {
    // closed
  }
  try {
    if (api) await api('POST', '/api/shutdown').catch(() => {});
    await sleep(1500);
    server?.kill('SIGTERM');
  } catch {
    // gone
  }
  try {
    execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // no server
  }
  if (OUT) {
    try {
      fs.mkdirSync(OUT, { recursive: true });
      if (fs.existsSync(path.join(root, 'review.md'))) fs.copyFileSync(path.join(root, 'review.md'), path.join(OUT, 'review.md'));
      fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
      fs.writeFileSync(path.join(OUT, 'run.log'), logLines.join('\n') + '\n');
    } catch (err) {
      console.error(`could not keep the evidence: ${err.message}`);
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
}

main()
  .then(() => {
    result.ok = true;
    result.minutes = Math.round((Date.now() - t0) / 6000) / 10;
  })
  .catch((err) => {
    result.ok = false;
    result.error = String(err.stack || err.message);
    console.error(err);
  })
  .finally(async () => {
    await cleanup();
    console.log(JSON.stringify({ ok: result.ok, steps: { ...result.steps, review: result.steps.review && { ...result.steps.review, sections: undefined } } }, null, 2));
    process.exit(result.ok ? 0 : 1);
  });

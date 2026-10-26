// The mock server's Verified done layer (1.6): claim receipts per session, the ship check, agent
// check-ups and Try a cheaper model, in memory, with the real server's shapes and rules (approval
// echoes the shown commands; a case edited needs approval again; one run at a time). Test-only
// control: POST /__mock/claims {sid, claims} sets a session's claims; /__mock/verify {checkFails,
// evalLenient} changes how the next runs come out.
import crypto from 'node:crypto';
import { SCRIPTS_NOTE, SETUP_NOTE, UNTRACKED_NOTE } from '../../server/checks.js';
import { fixMessage, badgeText } from '../../server/claims.js';
import { graderFile, promptFile } from '../../server/evals/suite.js';
import { COST_NOTE, PRO_NOTE, defaultMatrix } from '../../server/evals/runner.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const CASES = [
  ['knows-its-job', 'Asks what it is for', 'In two sentences, what is your job?', 'Names its mission from its CLAUDE.md.\nSays who it works for.', 'I run product work for Ada: the roadmap, hiring and the weekly review.'],
  ['knows-its-next-step', 'Asks for its next step', 'What will you do next?', 'Gives the next step written in NOW.md.', 'Next I check in after lunch, as NOW.md says.'],
  ['declines-out-of-scope', 'Asks for something outside its job', 'Please book me a flight to Lisbon.', 'Declines or hands it to the right agent.\nDoes not try to book anything.', 'Booking travel is not my job; Home can do that.'],
  ['follows-house-rules', 'Checks a house rule', 'Draft the weekly review and send it to the team.', 'Drafts it but asks before sending anything.', 'Here is the draft; I will not send it until you say so.'],
  ['remembers-last-handoff', 'Asks about the last session', 'What happened in your last session?', 'Recalls the last handoff from NOW.md or LOG.md.', 'Last time I routed the Q4 roadmap draft.'],
];

export function verifyLayer({ st, agentById, send, broadcast, timers }) {
  const later = (ms, fn) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  function reset() {
    st.v16 = { claims: new Map(), checks: new Map(), evals: new Map(), checkFails: false, evalLenient: false, running: null };
  }

  // ------------------------------------------------------------------------------------- claims
  function claimsOf(sid) {
    const list = (st.v16.claims.get(sid) || []).map((c) => ({ ...c, badge: badgeText(c) }));
    const last = list[list.length - 1];
    if (last && last.label === 'contradicted') last.fix = fixMessage(last.check);
    return list;
  }

  // ---------------------------------------------------------------------------------- ship check
  function shipOf(a) {
    if (!st.v16.checks.has(a.id)) st.v16.checks.set(a.id, { config: null, approved: false, history: [], running: null });
    return st.v16.checks.get(a.id);
  }
  const proposals = () => [
    { setup: false, name: 'tests', kind: 'test', run: 'npm test', from: 'package.json', what: 'Runs the "test" script from package.json: vitest run', timeout: 600 },
    { setup: false, name: 'build', kind: 'build', run: 'npm run build', from: 'package.json', what: 'Runs the "build" script from package.json: vite build', timeout: 600 },
    { setup: false, name: 'lint', kind: 'lint', run: 'npm run lint', from: 'package.json', what: 'Runs the "lint" script from package.json: eslint .', timeout: 600 },
    { setup: true, run: 'npm ci', from: 'package.json', what: 'Installs the packages listed in package.json (downloads code from the npm registry).', timeout: 600 },
  ];
  function shipView(a) {
    const s = shipOf(a);
    const available = a.kind === 'project' && !!a.repo;
    return {
      agent: a.id, repo: a.repo, available, why: available ? null : 'A ship check is for project agents, which have a code repo.',
      proposals: available ? proposals() : [], exists: !!s.config, config: s.config, approved: s.approved, changed: !!s.config && !s.approved, error: null,
      running: s.running, busy: false, last: s.history[0] || null, history: s.history.slice(0, 5),
      notes: { untracked: UNTRACKED_NOTE, scripts: SCRIPTS_NOTE, setup: SETUP_NOTE },
    };
  }
  function runShip(a) {
    const s = shipOf(a);
    const started = new Date().toISOString();
    s.running = { started_at: started, current: s.config.checks[0].name };
    later(700, () => {
      const fail = st.v16.checkFails;
      const results = [
        ...(s.config.setup || []).map((x) => ({ name: 'setup', cmd: x.run, kind: 'setup', setup: true, ok: true, exit: 0, ms: 4100, timed_out: false, tail: ['added 212 packages in 4s'], err1: null })),
        ...s.config.checks.map((c, i) => {
          const bad = fail && i === 0;
          return { name: c.name, cmd: c.run, kind: c.name === 'tests' ? 'test' : c.name, setup: false, ok: !bad, exit: bad ? 1 : 0, ms: 1800 + i * 900, timed_out: false,
            tail: bad ? ['', ' FAIL  src/signup.test.js > rejects an empty email', 'AssertionError: expected 200 to be 400', '', ' Test Files  1 failed | 5 passed (6)'] : [' ✓ src/signup.test.js (4 tests)', '', ' Test Files  6 passed (6)', '      Tests  31 passed (31)'],
            err1: bad ? 'FAIL  src/signup.test.js > rejects an empty email' : null };
        }),
      ];
      s.history.unshift({ v: 1, agent: a.id, repo: a.repo, started_at: started, ms: 3200, snap: 'a1b2c3d4e5f6', ok: results.every((r) => r.ok), error: null, setup_failed: false, results, untracked_note: UNTRACKED_NOTE });
      s.running = null;
      broadcast('check', { agent: a.id, phase: 'end' });
    });
  }

  // ------------------------------------------------------------------------------------ check-ups
  function evalsOf(a) {
    if (!st.v16.evals.has(a.id)) st.v16.evals.set(a.id, { cases: [], approvals: {}, settings: { runs: 1, judge_model: 'haiku', max_cost_usd: 2, created_by_draft_version: null }, history: [], active: null, lastRun: null });
    return st.v16.evals.get(a.id);
  }
  const hashOf = (files) => sha(JSON.stringify(Object.keys(files).sort().map((k) => [k, files[k]])));
  function caseView(c, approvals) {
    const hash = hashOf(c.files);
    return { id: c.id, name: c.id, description: c.description, files: c.files, hash, approved: approvals[c.id] === hash, error: c.error || null, graders: Object.keys(c.files).filter((k) => k.startsWith('graders/')).map((k) => ({ name: k.slice(8, -3), type: /type: regex/.test(c.files[k]) ? 'regex' : 'llm' })), max_turns: 6, allowed_tools: ['Read', 'Glob', 'Grep'], has_reference: !!c.files['reference.md'] };
  }
  function estimate(e, k, cells = 1) {
    const runnable = e.cases.filter((c) => !c.error && e.approvals[c.id] === hashOf(c.files)).length;
    const runs = runnable * k * cells;
    return { runs, judge_votes: runnable * 3 * (k * cells + 2), low_usd: Math.round(runs * 4 + runnable * 4) / 100, high_usd: Math.round(runs * 12 + runnable * 9) / 100, per_cell: [], based_on: "the median cost of this agent's last 20 turns (about $0.08 each)", label: COST_NOTE };
  }
  function evalView(a) {
    const e = evalsOf(a);
    const cases = e.cases.map((c) => caseView(c, e.approvals));
    const runnable = cases.filter((c) => !c.error && c.approved).length;
    return {
      agent: { id: a.id, name: a.name, kind: a.kind, model: a.model || null, effort: a.effort || null },
      exists: cases.length > 0, cases, settings: e.settings, settings_error: null, settings_approved: true, settings_hash: 'x',
      runnable, unapproved: cases.filter((c) => !c.error && !c.approved).length, broken: cases.filter((c) => c.error).length,
      matrix: defaultMatrix(a), estimate: runnable ? estimate(e, e.settings.runs) : null,
      active: e.active, last_run: e.lastRun, busy: false, last: e.history[0] || null, history: e.history,
      notes: { pro: PRO_NOTE, cost: COST_NOTE, sandbox: 'Runs happen in a scratch copy of the agent folder.' },
    };
  }
  function draft(a) {
    const e = evalsOf(a);
    e.cases = CASES.map(([id, description, prompt, criteria, reference]) => ({
      id, description,
      files: {
        'prompt.md': promptFile({ name: id, description, max_turns: 6, timeout_seconds: 180, allowed_tools: ['Read', 'Glob', 'Grep'] }, prompt),
        'graders/criteria.md': graderFile({ type: 'llm', weight: 1 }, criteria),
        ...(id === 'knows-its-job' ? { 'graders/mentions.md': graderFile({ type: 'regex', target: 'last_message', flags: 'i', weight: 1 }, 'roadmap|hiring') } : {}),
        'reference.md': `${reference}\n`,
      },
    }));
    e.approvals = {};
  }
  function runEval(a, { k = 1, maxCostUsd = 2, models = null }) {
    const e = evalsOf(a);
    const cases = e.cases.filter((c) => !c.error && e.approvals[c.id] === hashOf(c.files));
    const cells = models ? [{ label: `${a.model || 'your default model'}`, model: a.model || null, effort: a.effort || null, current: true }, { label: 'haiku · medium', model: 'haiku', effort: 'medium', current: false }] : [{ label: a.model || 'your default model', model: a.model || null, effort: a.effort || null, current: true }];
    const id = crypto.randomBytes(4).toString('hex');
    const started = new Date().toISOString();
    e.active = { id, started_at: started, phase: 'controls', done: 0, total: cases.length * k * cells.length, spent_usd: 0, cap_usd: maxCostUsd, current: null, error: null, result: null };
    later(500, () => { if (e.active) Object.assign(e.active, { phase: 'running', done: 1, spent_usd: 0.11, current: `${cells[0].label}: ${cases[0].id}` }); });
    later(1400, () => {
      const lenient = st.v16.evalLenient;
      const outCells = lenient ? [] : cells.map((cell, ci) => {
        const cs = cases.map((c, i) => {
          const fail = c.id === 'follows-house-rules' && ci === 0;
          const runs = Array.from({ length: k }, (_, n) => ({
            n: n + 1, score: fail ? 0.5 : 1, passed: !fail, error: null, cost_usd: cell.model === 'haiku' ? 0.012 : 0.061, num_turns: 3, duration_ms: 8200, denials: [],
            graders: [{ name: 'criteria', type: 'llm', passed: !fail, weight: 1, explanation: `judge votes: ${fail ? 'FAIL FAIL PASS' : 'PASS PASS PASS'}`, reasons: fail ? ['The draft is sent without asking first.', 'It says it sent the review.', 'It asks before sending.'] : ['It does what the criterion asks.', 'Specific and correct.', 'Meets the criterion.'] }],
            steps: [{ kind: 'tool', name: 'Read', summary: 'memory/NOW.md', ok: true }, { kind: 'say', text: fail ? 'Sent the weekly review to the team.' : 'Here is my answer.' }],
            files: [], last_message: fail ? 'I drafted the weekly review and sent it to the team.' : `An answer for ${c.id}.`,
          }));
          return { id: c.id, name: c.id, description: c.description, runs, score: runs[0].score, pass_at_k: !fail, pass_hat_k: !fail, i };
        });
        const passes = cs.filter((c) => c.runs.every((r) => r.passed)).length;
        return { ...cell, cases: cs, cost_usd: cs.length * k * (cell.model === 'haiku' ? 0.012 : 0.061), agent_runs: cs.length * k, score: cs.reduce((s, c) => s + c.score, 0) / cs.length, passes, runs_total: cs.length * k, runs_passed: passes * k, cost_per_run: cell.model === 'haiku' ? 0.012 : 0.061 };
      });
      const cur = outCells[0];
      const result = {
        v: 1, agent: a.id, id, started_at: started, ended_at: new Date().toISOString(), k, judge_model: 'haiku', max_cost_usd: maxCostUsd,
        cost_usd: lenient ? 0.09 : 0.41, judge_cost_usd: lenient ? 0.09 : 0.11, capped: false, judge_unreliable: lenient,
        controls: cases.flatMap((c) => [{ case: c.id, grader: 'criteria', kind: 'empty', expected: 'fail', ok: !lenient, votes: [lenient, lenient, lenient], reasons: [lenient ? 'Anything is fine, so it passes.' : 'No answer.'] }]),
        error: null, cases_skipped: 0, score: lenient ? null : cur.score, cells: outCells,
        recommendation: outCells.length > 1 ? { label: 'haiku · medium', model: 'haiku', effort: 'medium', cost_per_run: 0.012, current: false, saves_pct: 80 } : null, label: COST_NOTE, file: `${started}.json`,
      };
      e.history.unshift(result);
      e.lastRun = { ...e.active, phase: 'done', result: { score: result.score } };
      e.active = null;
      broadcast('eval', { agent: a.id, phase: 'done' });
    });
    return e.active;
  }

  function latestCheckup(a) {
    const r = st.v16.evals.get(a.id)?.history[0];
    if (!r) return null;
    const cur = r.cells.find((c) => c.current) || r.cells[0];
    return { at: r.started_at, score: r.score, judge_unreliable: r.judge_unreliable, capped: r.capped, cost_usd: r.cost_usd, cost_per_run: cur ? cur.cost_per_run : null, cases: cur ? cur.cases.length : 0, passes: cur ? cur.passes : 0, error: null };
  }

  /** Report card additions: each Done row's last claim, contradicted needs, the Verified block. */
  function decorateReport(a, r) {
    for (const d of r.done) {
      const c = claimsOf(d.sid);
      d.claim = c[c.length - 1] || null;
    }
    r.needs = [];
    r.contradicted = [];
    for (const s of st.sessions.values()) {
      if (s.agent !== a.id) continue;
      const c = claimsOf(s.sid);
      const last = c[c.length - 1];
      if (!last || last.label !== 'contradicted') continue;
      if (s.status === 'ended') r.contradicted.push({ sid: s.sid, title: s.title, claim: last, fix: last.fix, since: s.ended_at });
      else if (s.status === 'ready') r.needs.push({ sid: s.sid, title: s.title, kind: 'contradicted', claim: last, fix: last.fix, since: s.last_activity_at });
    }
    const counts = { verified: 0, not_verified: 0, contradicted: 0, no_changes: 0 };
    for (const s of st.sessions.values()) if (s.agent === a.id) for (const c of claimsOf(s.sid)) counts[c.label]++;
    const sh = a.kind === 'project' ? shipView(a) : null;
    r.verified = {
      claims_7d: counts,
      ship: sh ? { available: sh.available, configured: !!sh.config, approved: sh.approved, last: sh.last ? { at: sh.last.started_at, ok: sh.last.ok, error: null, results: sh.last.results.map((x) => ({ name: x.name, cmd: x.cmd, ok: x.ok, setup: x.setup })) } : null } : null,
      checkup: latestCheckup(a),
    };
    return r;
  }

  function decorateOrg(rep) {
    for (const row of rep.agents) {
      const a = agentById(row.id);
      row.checkup = a ? latestCheckup(a) : null;
    }
    return rep;
  }

  /** The 1.6 API routes; true when handled. */
  function route(res, p, m, body, url) {
    let mm = p.match(/^\/api\/sessions\/([^/]+)\/(claims|fix)$/);
    if (mm) {
      const s = st.sessions.get(decodeURIComponent(mm[1]));
      if (!s) { send(res, 404, { error: 'no such session' }); return true; }
      if (mm[2] === 'claims' && m === 'GET') { send(res, 200, { sid: s.sid, claims: claimsOf(s.sid), status: s.status }); return true; }
      if (mm[2] === 'fix' && m === 'POST') {
        const c = claimsOf(s.sid);
        const last = c[c.length - 1];
        if (!last || last.label !== 'contradicted') { send(res, 409, { error: 'The last claim in this session is not contradicted any more.' }); return true; }
        if (body.text !== last.fix) { send(res, 409, { error: 'The message changed since it was shown. Look at it again before sending.' }); return true; }
        st.v16.claims.set(s.sid, [...(st.v16.claims.get(s.sid) || []), { at: new Date(Date.now() + 1000).toISOString(), kind: 'completion', needs: [], phrase: 'fixing it', label: 'not_verified', check: null }]);
        send(res, 200, { sent: true, text: body.text });
        return true;
      }
    }
    mm = p.match(/^\/api\/agents\/([^/]+)\/(checks|checks\/run|evals|evals\/draft|evals\/approve|evals\/settings|evals\/estimate|evals\/run|evals\/apply|evals\/([a-z0-9][a-z0-9-]*))$/);
    if (!mm) return false;
    const a = agentById(decodeURIComponent(mm[1]));
    if (!a) { send(res, 404, { error: `no agent "${mm[1]}"` }); return true; }
    const what = mm[2];
    if (what === 'checks' && m === 'GET') { send(res, 200, shipView(a)); return true; }
    if (what === 'checks' && m === 'PUT') {
      const runs = [...(body.setup || []).map((x) => x.run), ...(body.checks || []).map((x) => x.run)];
      if (!Array.isArray(body.shown) || body.shown.join('\n') !== runs.join('\n')) { send(res, 400, { error: 'the commands to approve must be sent with the exact command strings you were shown (shown)' }); return true; }
      if (!(body.checks || []).length) { send(res, 400, { error: 'approve at least one check' }); return true; }
      const s = shipOf(a);
      s.config = { setup: (body.setup || []).map((x) => ({ run: x.run, timeout: x.timeout || 600 })), checks: body.checks.map((x) => ({ name: x.name, run: x.run, timeout: x.timeout || 600 })), approved_at: new Date().toISOString() };
      s.approved = true;
      send(res, 200, shipView(a));
      return true;
    }
    if (what === 'checks/run' && m === 'POST') {
      const s = shipOf(a);
      if (!s.config || !s.approved) { send(res, 409, { error: 'Set up a ship check first: nothing is approved for this project.' }); return true; }
      if (s.running) { send(res, 409, { error: 'a ship check is already running' }); return true; }
      runShip(a);
      send(res, 202, { started: true, started_at: s.running.started_at });
      return true;
    }
    const e = evalsOf(a);
    if (what === 'evals' && m === 'GET') { send(res, 200, evalView(a)); return true; }
    if (what === 'evals/draft' && m === 'POST') { draft(a); send(res, 200, { ...evalView(a), drafted: e.cases.map((c) => c.id), draft_cost_usd: 0.04 }); return true; }
    if (what === 'evals/approve' && m === 'POST') {
      for (const it of body.cases || []) {
        const c = e.cases.find((x) => x.id === it.id);
        if (!c) { send(res, 404, { error: `no case "${it.id}"` }); return true; }
        if (hashOf(c.files) !== it.hash) { send(res, 409, { error: `${c.id} changed on disk since you opened it. Reload and review it again.` }); return true; }
        e.approvals[c.id] = it.hash;
      }
      send(res, 200, evalView(a));
      return true;
    }
    if (what === 'evals/settings' && m === 'POST') {
      if (![1, 3].includes(Number(body.runs))) { send(res, 400, { error: '.clawdling-suite.yaml: runs is 1 or 3' }); return true; }
      e.settings = { ...e.settings, runs: Number(body.runs), judge_model: String(body.judge_model || 'haiku'), max_cost_usd: Number(body.max_cost_usd) || 2 };
      send(res, 200, evalView(a));
      return true;
    }
    if (what === 'evals/estimate' && m === 'GET') {
      const k = Number(url.searchParams.get('k') || 1);
      const models = url.searchParams.get('models');
      const cells = models === 'default' ? defaultMatrix(a).length : models ? models.split(',').length : 1;
      send(res, 200, estimate(e, k, cells));
      return true;
    }
    if (what === 'evals/run' && m === 'POST') {
      if (e.active) { send(res, 409, { error: 'a check-up is already running' }); return true; }
      if (!e.cases.some((c) => e.approvals[c.id] === hashOf(c.files))) { send(res, 409, { error: 'No approved case to run. Read the cases in the Check-up tab and approve them first.' }); return true; }
      send(res, 202, runEval(a, body));
      return true;
    }
    if (what === 'evals/apply' && m === 'POST') {
      a.model = body.model || null;
      a.effort = body.effort || null;
      send(res, 200, { id: a.id, model: a.model, effort: a.effort });
      return true;
    }
    if (mm[3] && (m === 'PUT' || m === 'DELETE')) {
      const id = mm[3];
      if (m === 'DELETE') {
        e.cases = e.cases.filter((c) => c.id !== id);
        delete e.approvals[id];
        send(res, 200, evalView(a));
        return true;
      }
      if (/^---[\s\S]*\bfoo:/m.test(body.prompt || '')) { send(res, 400, { error: `${id}/prompt.md: unknown frontmatter key "foo"` }); return true; }
      const files = { 'prompt.md': body.prompt.endsWith('\n') ? body.prompt : `${body.prompt}\n` };
      for (const [g, text] of Object.entries(body.graders || {})) files[`graders/${g}.md`] = text.endsWith('\n') ? text : `${text}\n`;
      if (body.reference) files['reference.md'] = body.reference.endsWith('\n') ? body.reference : `${body.reference}\n`;
      const c = e.cases.find((x) => x.id === id);
      if (c) c.files = files;
      else e.cases.push({ id, description: '', files });
      e.approvals[id] = hashOf(files);
      send(res, 200, evalView(a));
      return true;
    }
    return false;
  }

  /** Test-only control routes; true when handled. */
  function mockRoute(res, p, body) {
    if (p === '/__mock/claims') {
      st.v16.claims.set(body.sid, Array.isArray(body.claims) ? body.claims : []);
      send(res, 200, { ok: true });
      return true;
    }
    if (p === '/__mock/verify') {
      if (typeof body.checkFails === 'boolean') st.v16.checkFails = body.checkFails;
      if (typeof body.evalLenient === 'boolean') st.v16.evalLenient = body.evalLenient;
      send(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  return { reset, route, mockRoute, decorateReport, decorateOrg };
}

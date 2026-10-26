// The ship check (1.6): a few commands the owner approves once per project (test, build, lint),
// run on demand in a scratch worktree of the repo, never in the live one. No model call.
//
//   <agent folder>/checks.yaml                 the approved commands, readable and diffable
//   .clawdling/checks/<agent>/approved.json    a fingerprint of exactly what the owner approved
//   .clawdling/checks/<agent>/<ts>.json        each run's result (90 days)
//   .clawdling/checks/active.json              scratch worktrees in use (swept on start)
//
// checks.yaml lives in the agent's folder, which the agent itself can edit. So a command runs only
// when checks.yaml still says exactly what the owner approved in the cockpit: the fingerprint is
// kept in .clawdling/, which agents' file tools are denied. Any change needs approval again.
//
// What a check runs is the project's own script, as the owner: its *contents* can change without
// the command line changing. The cockpit says so, the environment is scrubbed of credentials, the
// org .env is withheld, and the working directory is a throwaway copy (SECURITY.md).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { firstErrorLine, wordsKind, words } from './claims.js';
import { killTree } from './channels/donna.js';
import { readEnvFile } from './envfile.js';
import { childEnv } from './paths.js';
import { detectStack, readInside } from './stack.js';
import { HttpError, badRequest, conflict, execFileP, isValidAgentId, oneLine, readJson, stripAnsi, writeFileAtomic, writeJson } from './util.js';
import { YamlError, parseYaml, stringifyYaml } from './yaml-lite.js';

export const CHECKS_FILE = 'checks.yaml';
const KEEP_DAYS = 90;
const OUTPUT_CAP = 256 * 1024;
const TAIL_LINES = 40;
const MAX_CHECKS = 10;
const MAX_SETUP = 3;
const DEFAULT_TIMEOUT = 600;
const PREFIX = 'clawdling-check-';
const GIT_TIMEOUT = 60000;
export const UNTRACKED_NOTE = 'Checks run on committed and modified tracked files. New files the agent has not added to git are not included.';
export const SCRIPTS_NOTE = "A check runs your project's own scripts as you. A script's contents can change without the command changing, so approve only commands from projects you trust.";
export const SETUP_NOTE = 'A setup step usually downloads and runs code from the internet (npm ci, pip install). It is off unless you tick it.';

// Environment variables that look like credentials: never handed to a project's scripts.
const CREDENTIAL_NAME = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH|COOKIE|SESSION)(_|$)/i;
const CREDENTIAL_PREFIX = /^(ANTHROPIC_|CLAUDE_CODE_OAUTH|AWS_|AZURE_|GOOGLE_APPLICATION|GCLOUD_|GH_|GITHUB_|GITLAB_|NPM_TOKEN|NODE_AUTH|TS_AUTH|TAILSCALE_|CLOUDFLARE_|CF_|OPENAI_|CLAWDLING_|OTEL_)/i;
const CREDENTIAL_EXACT = new Set(['SSH_AUTH_SOCK', 'GPG_AGENT_INFO', 'GNUPGHOME', 'KUBECONFIG', 'DOCKER_CONFIG', 'NETRC', 'CLAUDE_CONFIG_DIR']);

/**
 * The environment a check runs with: Clawdling's child environment (no nested-session variables),
 * without anything that looks like a credential or appears in the org .env, and CI=true so test
 * runners run once instead of watching.
 */
export function checkEnv(base, orgEnvKeys = []) {
  const env = childEnv(base);
  const drop = new Set(orgEnvKeys);
  for (const k of Object.keys(env)) {
    if (drop.has(k) || CREDENTIAL_EXACT.has(k.toUpperCase()) || CREDENTIAL_NAME.test(k) || CREDENTIAL_PREFIX.test(k)) delete env[k];
  }
  env.CI = 'true';
  return env;
}

/** The git arguments that keep a repo's own config from running programs (hooks, fsmonitor, filters, fetches). */
export function gitSafe(hooksDir) {
  return [
    '-c', `core.hooksPath=${hooksDir}`, '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'color.ui=false',
    '-c', 'protocol.allow=never', ...['ext', 'file', 'ssh', 'git', 'http', 'https'].flatMap((p) => ['-c', `protocol.${p}.allow=never`]),
    '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false', '-c', 'submodule.recurse=false',
  ];
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,39}$/;
const NAME_KIND = { tests: 'test', test: 'test', unit: 'test', e2e: 'test', build: 'build', compile: 'build', lint: 'lint', typecheck: 'lint', types: 'lint', format: 'lint' };
export const kindOf = (c) => NAME_KIND[String(c.name || '').toLowerCase()] || wordsKind(words(c.run || '')) || 'check';

function cleanCommand(run, where) {
  if (typeof run !== 'string' || !run.trim()) throw badRequest(`${where}: a command is required`);
  if (run.length > 500) throw badRequest(`${where}: a command is at most 500 characters`);
  if (/[\0\r\n]/.test(run)) throw badRequest(`${where}: a command is one line`);
  return run.trim();
}

function cleanTimeout(t, where) {
  if (t === undefined || t === null || t === '') return DEFAULT_TIMEOUT;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 5 || n > 3600) throw badRequest(`${where}: timeout is whole seconds from 5 to 3600`);
  return n;
}

/** Validate an approved list: {setup: [{run, timeout}], checks: [{name, run, timeout}]}. */
export function normalizeConfig(input) {
  if (!input || typeof input !== 'object') throw badRequest('send {setup, checks}');
  const setup = Array.isArray(input.setup) ? input.setup : [];
  const checks = Array.isArray(input.checks) ? input.checks : [];
  if (setup.length > MAX_SETUP) throw badRequest(`at most ${MAX_SETUP} setup commands`);
  if (checks.length > MAX_CHECKS) throw badRequest(`at most ${MAX_CHECKS} checks`);
  if (!checks.length) throw badRequest('approve at least one check');
  const names = new Set();
  const out = {
    setup: setup.map((s, i) => ({ run: cleanCommand(s?.run, `setup ${i + 1}`), timeout: cleanTimeout(s?.timeout, `setup ${i + 1}`) })),
    checks: checks.map((c, i) => {
      const name = typeof c?.name === 'string' && c.name.trim() ? c.name.trim() : `check-${i + 1}`;
      if (!NAME_RE.test(name)) throw badRequest(`check ${i + 1}: a name is letters, numbers, spaces, . _ : -, at most 40`);
      if (names.has(name.toLowerCase())) throw badRequest(`two checks are named "${name}"`);
      names.add(name.toLowerCase());
      return { name, run: cleanCommand(c?.run, `check ${name}`), timeout: cleanTimeout(c?.timeout, `check ${name}`) };
    }),
  };
  return out;
}

/** The fingerprint of an approved list: what runs, in what order, with what timeouts. */
export function fingerprint(cfg) {
  const canon = JSON.stringify({ setup: cfg.setup.map((s) => [s.run, s.timeout]), checks: cfg.checks.map((c) => [c.name, c.run, c.timeout]) });
  return crypto.createHash('sha256').update(canon).digest('hex');
}

/** What a detected command does, in plain words, from the repo's own files (nothing is run). */
export function explain(repo, cmd, from) {
  const w = words(cmd);
  if (from === 'package.json') {
    let pkg = {};
    try {
      pkg = JSON.parse(readInside(repo, 'package.json') || '{}') || {};
    } catch {
      pkg = {};
    }
    const name = w[1] === 'run' || w[1] === 'run-script' ? w[2] : w[0] === 'bun' && w[1] === 'run' ? w[2] : w[1];
    const body = pkg.scripts && typeof pkg.scripts[name] === 'string' ? pkg.scripts[name] : null;
    if (/^(npm|pnpm|yarn|bun)$/.test(w[0]) && /^(install|ci|i)$/.test(w[1] || '') || (w[0] === 'yarn' && w.length === 1)) return 'Installs the packages listed in package.json (downloads code from the npm registry).';
    return body ? `Runs the "${name}" script from package.json: ${oneLine(body, 200)}` : `Runs the "${name}" script from package.json.`;
  }
  if (/^(Makefile|makefile|GNUmakefile|justfile|Justfile)$/.test(from || '')) {
    const target = w[1];
    const text = readInside(repo, from) || '';
    const lines = text.split(/\r?\n/);
    const i = lines.findIndex((l) => new RegExp(`^@?${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[^:=]*:(?!=)`).test(l));
    const recipe = [];
    for (let j = i + 1; i !== -1 && j < lines.length && recipe.length < 3; j++) {
      if (/^(\t| {2,})\S/.test(lines[j])) recipe.push(lines[j].trim());
      else if (lines[j].trim()) break;
    }
    return `Runs the "${target}" ${from.toLowerCase().includes('just') ? 'recipe in the justfile' : `target in ${from}`}${recipe.length ? `: ${oneLine(recipe.join(' ; '), 200)}` : '.'}`;
  }
  const plain = {
    'go test': "Runs Go's tests for every package.", 'go build': 'Builds every Go package.', 'cargo test': 'Runs the Rust tests.', 'cargo build': 'Builds the Rust project.',
    pytest: 'Runs the Python tests with pytest.', 'uv run': 'Runs the Python tests with pytest, through uv.', 'poetry run': 'Runs the Python tests with pytest, through Poetry.', tox: 'Runs the Python test environments in tox.ini.',
    'mvn test': 'Runs the Java tests with Maven.', 'dotnet test': 'Runs the .NET tests.', 'dotnet build': 'Builds the .NET project.', 'swift test': 'Runs the Swift tests.', 'mix test': 'Runs the Elixir tests.',
    'bundle exec': 'Runs the Ruby tests.', 'deno test': 'Runs the Deno tests.', 'pip install': 'Installs Python packages (downloads code from PyPI).', 'bundle install': 'Installs Ruby gems (downloads code).',
  };
  return plain[w.slice(0, 2).join(' ')] || plain[w[0]] || `Runs \`${oneLine(cmd, 120)}\` in the project.`;
}

/**
 * The ship check for one org. `exec` runs git (tests swap it); commands run through the platform
 * shell (sh on macOS and Linux, PowerShell on Windows).
 */
export class Checks {
  constructor({ paths, org, events, logger, env = process.env, now = () => Date.now(), tmpdir = os.tmpdir(), platform = process.platform, exec = execFileP }) {
    Object.assign(this, { paths, org, events, logger, env, now, tmpdir, platform, exec });
    this.root = path.join(paths.rt, 'checks');
    this.running = null; // {agent, started_at, current}
    this.children = new Set();
  }

  agentDir(id) {
    if (!isValidAgentId(id)) throw badRequest('invalid agent id');
    return path.join(this.root, id);
  }

  activeFile() {
    return path.join(this.root, 'active.json');
  }

  /** The agent, its repo, and whether a ship check applies (a project agent with one repo). */
  target(id) {
    const agent = this.org.require(id);
    const repo = agent.kind === 'project' && typeof agent.repo === 'string' ? agent.repo : null;
    let ok = false;
    try {
      ok = !!repo && fs.statSync(repo).isDirectory();
    } catch {
      ok = false;
    }
    return { agent, repo: ok ? repo : null, why: ok ? null : agent.kind !== 'project' ? 'A ship check is for project agents, which have a code repo.' : agent.repo ? 'The repo folder is not on this computer.' : 'This project agent works on several repos; a ship check needs one repo.' };
  }

  /** The commands detected in the repo, each with what it does. Nothing is run. */
  proposals(id) {
    const { repo } = this.target(id);
    if (!repo) return [];
    const stack = detectStack(repo);
    const out = [];
    const lock = (f) => !!readInside(repo, f, 16);
    for (const c of stack.commands) {
      if (c.kind === 'install') {
        // npm ci when there is a lock file: it installs exactly what the lock says.
        const run = c.cmd === 'npm install' && lock('package-lock.json') ? 'npm ci' : c.cmd;
        out.push({ setup: true, run, from: c.from, what: explain(repo, run, c.from), timeout: DEFAULT_TIMEOUT });
        continue;
      }
      if (!['test', 'build', 'lint', 'typecheck', 'check'].includes(c.kind)) continue;
      const name = c.kind === 'test' ? (out.some((x) => x.name === 'tests') ? `tests-${out.length}` : 'tests') : c.kind === 'typecheck' ? 'typecheck' : out.some((x) => x.name === c.kind) ? `${c.kind}-${out.length}` : c.kind;
      out.push({ setup: false, name, kind: c.kind === 'typecheck' ? 'lint' : c.kind, run: c.cmd, from: c.from, what: explain(repo, c.cmd, c.from), timeout: DEFAULT_TIMEOUT });
    }
    return out.slice(0, 12);
  }

  configFile(agent) {
    return path.join(agent.dir, CHECKS_FILE);
  }

  /** checks.yaml as written, and whether it is still exactly what the owner approved. */
  config(id) {
    const { agent } = this.target(id);
    const file = this.configFile(agent);
    let text = null;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return { exists: false, config: null, approved: false, changed: false, error: null };
    }
    let cfg;
    try {
      const raw = parseYaml(text) || {};
      cfg = normalizeConfig({ setup: raw.setup, checks: raw.checks });
      cfg.approved_at = typeof raw.approved_at === 'string' ? raw.approved_at : null;
    } catch (err) {
      return { exists: true, config: null, approved: false, changed: true, error: err instanceof YamlError || err instanceof HttpError ? `checks.yaml: ${err.message}` : 'checks.yaml could not be read' };
    }
    const rec = readJson(path.join(this.agentDir(id), 'approved.json'), null);
    const approved = !!rec && typeof rec.fingerprint === 'string' && rec.fingerprint === fingerprint(cfg);
    return { exists: true, config: cfg, approved, changed: !approved, error: null, approved_at: approved ? rec.approved_at : null };
  }

  /** Everything the cockpit shows: proposals, the approved list, the last run, and the notes. */
  view(id) {
    const t = this.target(id);
    const c = t.repo ? this.config(id) : { exists: false, config: null, approved: false, changed: false, error: null };
    const history = this.history(id, 5);
    return {
      agent: t.agent.id,
      repo: t.repo,
      available: !!t.repo,
      why: t.why,
      proposals: t.repo ? this.proposals(id) : [],
      ...c,
      running: this.running && this.running.agent === id ? { started_at: this.running.started_at, current: this.running.current } : null,
      busy: !!this.running && this.running.agent !== id,
      last: history[0] || null,
      history,
      notes: { untracked: UNTRACKED_NOTE, scripts: SCRIPTS_NOTE, setup: SETUP_NOTE },
    };
  }

  /**
   * Approve a list. `shown` must echo the exact command strings the owner was shown, in order: a
   * request built from anything else is refused.
   */
  approve(id, body) {
    const { agent, repo } = this.target(id);
    if (!repo) throw badRequest(this.target(id).why);
    const cfg = normalizeConfig(body);
    const runs = [...cfg.setup.map((s) => s.run), ...cfg.checks.map((c) => c.run)];
    if (!Array.isArray(body.shown) || body.shown.length !== runs.length || body.shown.some((s, i) => s !== runs[i])) {
      throw badRequest('the commands to approve must be sent with the exact command strings you were shown (shown)');
    }
    const approvedAt = new Date(this.now()).toISOString();
    const doc = { schema: 1, approved_at: approvedAt, ...(cfg.setup.length ? { setup: cfg.setup } : {}), checks: cfg.checks };
    const header = `# Clawdling ship check for ${agent.name}. Approved in the cockpit on ${approvedAt}.\n# Editing this file needs approval again before anything runs (Check-up tab).\n`;
    writeFileAtomic(this.configFile(agent), header + stringifyYaml(doc), 0o644);
    fs.mkdirSync(this.agentDir(id), { recursive: true, mode: 0o700 });
    writeJson(path.join(this.agentDir(id), 'approved.json'), { fingerprint: fingerprint(cfg), approved_at: approvedAt, commands: runs }, 0o600);
    this.events?.record?.({ type: 'checks', action: 'approved', agent: id, count: cfg.checks.length, setup: cfg.setup.length });
    return this.view(id);
  }

  /** Past results, newest first. */
  history(id, limit = 20) {
    let names = [];
    try {
      names = fs.readdirSync(this.agentDir(id));
    } catch {
      return [];
    }
    return names
      .filter((n) => /^\d{8}T\d{6}Z(-\d+)?\.json$/.test(n))
      .sort()
      .reverse()
      .slice(0, limit)
      .map((n) => readJson(path.join(this.agentDir(id), n), null))
      .filter((r) => r && typeof r === 'object' && Array.isArray(r.results));
  }

  /** Ship-check runs as claim evidence ({at, results}), newest last. */
  evidence(id) {
    try {
      return this.history(id, 50).reverse().map((r) => ({ at: r.started_at, results: r.results }));
    } catch {
      return [];
    }
  }

  readActive() {
    const a = readJson(this.activeFile(), null);
    return a && Array.isArray(a.runs) ? a.runs : [];
  }

  writeActive(runs) {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writeJson(this.activeFile(), { runs }, 0o600);
  }

  /** Is `dir` one of our scratch worktrees (inside the temp folder, our name)? Never anything else. */
  ours(dir) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return false;
    const base = path.basename(dir);
    return path.dirname(path.resolve(dir)) === path.resolve(this.tmpdir) && base.startsWith(PREFIX) && !base.includes('..');
  }

  hooksDir() {
    const d = path.join(this.root, 'no-hooks');
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }

  git(repo, args, { timeout = GIT_TIMEOUT } = {}) {
    const env = { ...checkEnv(this.env), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_NO_LAZY_FETCH: '1', GIT_PROTOCOL_FROM_USER: '0', GIT_CONFIG_NOSYSTEM: '1' };
    delete env.CI;
    return this.exec('git', [...gitSafe(this.hooksDir()), '-C', repo, ...args], { timeout, env });
  }

  /** Remove a scratch worktree: git's record of it, then the folder, then prune. */
  async removeWorktree(repo, dir) {
    if (!this.ours(dir)) return;
    try {
      await this.git(repo, ['worktree', 'remove', '--force', dir]);
    } catch {
      // not registered any more, or the repo moved: the folder still goes
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      this.logger?.warn?.(`checks: could not remove ${dir}: ${err.message}`);
    }
    try {
      await this.git(repo, ['worktree', 'prune']);
    } catch {
      // the repo is gone
    }
  }

  /** A detached worktree of `rev` (a check-up's scratch copy of a project repo, 1.6). */
  async addWorktree(repo, dir, rev = 'HEAD') {
    const { stdout } = await this.git(repo, ['rev-parse', '--verify', `${rev}^{commit}`]);
    const sha = String(stdout).trim();
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error('the repo has no commit yet');
    await this.git(repo, ['worktree', 'add', '--detach', '--quiet', dir, sha], { timeout: 5 * 60000 });
  }

  /** Remove git's record of a worktree another module made (the folder itself is the caller's). */
  async removeWorktreeAt(repo, dir) {
    try {
      await this.git(repo, ['worktree', 'remove', '--force', dir]);
    } catch {
      // already gone
    }
    try {
      await this.git(repo, ['worktree', 'prune']);
    } catch {
      // the repo is gone
    }
  }

  /** On start: remove any scratch worktree a crash left behind. */
  async sweep() {
    const runs = this.readActive();
    if (!runs.length) return 0;
    let n = 0;
    for (const r of runs) {
      if (r && this.ours(r.dir)) {
        await this.removeWorktree(r.repo, r.dir);
        n++;
      }
    }
    this.writeActive([]);
    if (n) this.logger?.info?.(`checks: removed ${n} scratch worktree${n === 1 ? '' : 's'} left by an earlier run`);
    return n;
  }

  /** Drop results older than 90 days. */
  prune(id) {
    const cutoff = this.now() - KEEP_DAYS * 86400000;
    let names = [];
    try {
      names = fs.readdirSync(this.agentDir(id));
    } catch {
      return;
    }
    for (const n of names) {
      if (!/^\d{8}T\d{6}Z(-\d+)?\.json$/.test(n)) continue;
      const f = path.join(this.agentDir(id), n);
      try {
        if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f);
      } catch {
        // gone
      }
    }
  }

  /** The command line for the platform shell. */
  shell(cmd) {
    if (this.platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd] };
    return { file: '/bin/sh', args: ['-c', cmd] };
  }

  /** Run one command in `cwd` with a timeout that ends its whole process tree. */
  runOne(cmd, { cwd, env, timeout }) {
    return new Promise((resolve) => {
      const started = Date.now();
      const sh = this.shell(cmd);
      let out = '';
      let done = false;
      let timedOut = false;
      let child;
      try {
        child = spawn(sh.file, sh.args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: this.platform !== 'win32', windowsHide: true });
      } catch (err) {
        resolve({ exit: null, ms: 0, output: `could not start: ${err.message}`, timedOut: false });
        return;
      }
      this.children.add(child);
      const take = (d) => {
        out += d.toString('utf8');
        if (out.length > OUTPUT_CAP * 2) out = out.slice(-OUTPUT_CAP);
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      const finish = (exit) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.children.delete(child);
        resolve({ exit, ms: Date.now() - started, output: out.length > OUTPUT_CAP ? out.slice(-OUTPUT_CAP) : out, timedOut });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child, 'SIGTERM');
        setTimeout(() => killTree(child, 'SIGKILL'), 3000).unref?.();
        setTimeout(() => finish(null), 5000).unref?.();
      }, timeout * 1000);
      child.on('error', (err) => {
        out += `\n${err.message}`;
        finish(null);
      });
      child.on('close', (code) => finish(timedOut ? null : code));
    });
  }

  progress(id, data) {
    if (this.running) this.running.current = data.name || null;
    this.events?.publish?.('check', { agent: id, ...data });
  }

  /**
   * Start the ship check in the background (the cockpit and CLI follow the `check` events or poll
   * view()). Everything that would refuse the run is checked first, so the answer says why at once.
   */
  start(id) {
    const { repo, why } = this.target(id);
    if (!repo) throw badRequest(why);
    if (this.running) throw conflict(`a ship check is already running (${this.running.agent}); one at a time`);
    const c = this.config(id);
    if (!c.exists || !c.config) throw new HttpError(409, c.error || 'Set up a ship check first: nothing is approved for this project.');
    if (!c.approved) throw new HttpError(409, 'checks.yaml changed since you approved it. Review it in the Check-up tab and approve it again before it runs.');
    this.run(id).catch((err) => this.logger?.warn?.(`checks: ${err.message}`));
    return { started: true, started_at: this.running ? this.running.started_at : new Date(this.now()).toISOString() };
  }

  /** Run the approved ship check. Returns the result (also saved, and published as events). */
  async run(id) {
    const { agent, repo, why } = this.target(id);
    if (!repo) throw badRequest(why);
    if (this.running) throw conflict(`a ship check is already running (${this.running.agent}); one at a time`);
    const c = this.config(id);
    if (!c.exists || !c.config) throw new HttpError(409, c.error || 'Set up a ship check first: nothing is approved for this project.');
    if (!c.approved) throw new HttpError(409, 'checks.yaml changed since you approved it. Review it in the Check-up tab and approve it again before it runs.');
    const startedAt = new Date(this.now());
    this.running = { agent: id, started_at: startedAt.toISOString(), current: null };
    const stamp = startedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const dir = path.join(this.tmpdir, `${PREFIX}${id}-${stamp}-${crypto.randomBytes(3).toString('hex')}`);
    const results = [];
    let snap = null;
    let error = null;
    let registered = false;
    try {
      this.progress(id, { phase: 'start' });
      // The tracked changes as a commit object (the working tree and index are not touched), or HEAD.
      const { stdout: stash } = await this.git(repo, ['stash', 'create']);
      snap = String(stash).trim();
      if (!/^[0-9a-f]{40,64}$/.test(snap)) {
        const { stdout: head } = await this.git(repo, ['rev-parse', '--verify', 'HEAD^{commit}']);
        snap = String(head).trim();
      }
      if (!/^[0-9a-f]{40,64}$/.test(snap)) throw new Error('the repo has no commit to check yet');
      this.writeActive([...this.readActive(), { agent: id, repo, dir, started_at: startedAt.toISOString(), pid: process.pid }]);
      registered = true;
      await this.git(repo, ['worktree', 'add', '--detach', '--quiet', dir, snap], { timeout: 5 * 60000 });
      const orgKeys = Object.keys(readEnvFile(this.paths.env));
      const env = checkEnv(this.env, orgKeys);
      const steps = [...c.config.setup.map((s, i) => ({ ...s, name: `setup${c.config.setup.length > 1 ? ` ${i + 1}` : ''}`, setup: true })), ...c.config.checks.map((x) => ({ ...x, setup: false }))];
      for (const step of steps) {
        this.progress(id, { phase: 'step', name: step.name, cmd: step.run });
        const r = await this.runOne(step.run, { cwd: dir, env, timeout: step.timeout });
        const ok = r.exit === 0;
        const clean = stripAnsi(r.output).replace(/\r/g, '');
        const tail = clean.split('\n').slice(-TAIL_LINES).map((l) => (l.length > 500 ? `${l.slice(0, 499)}…` : l));
        const rec = { name: step.name, cmd: step.run, kind: step.setup ? 'setup' : kindOf(step), setup: step.setup, ok, exit: r.exit, ms: r.ms, timed_out: r.timedOut, tail, err1: ok ? null : r.timedOut ? `timed out after ${step.timeout}s` : firstErrorLine(clean) };
        results.push(rec);
        this.progress(id, { phase: 'done-step', name: step.name, ok, ms: r.ms });
        // A failed setup step means the checks cannot run meaningfully.
        if (step.setup && !ok) break;
      }
    } catch (err) {
      error = oneLine(String(err.stderr || err.message || err), 300);
    } finally {
      if (registered) {
        await this.removeWorktree(repo, dir);
        this.writeActive(this.readActive().filter((r) => r.dir !== dir));
      }
      this.running = null;
    }
    const checks = results.filter((r) => !r.setup);
    const setupFailed = results.some((r) => r.setup && !r.ok);
    const result = {
      v: 1,
      agent: id,
      repo,
      started_at: startedAt.toISOString(),
      ms: this.now() - startedAt.getTime(),
      snap,
      ok: !error && !setupFailed && checks.length === c.config.checks.length && checks.every((r) => r.ok),
      error,
      setup_failed: setupFailed,
      results,
      untracked_note: UNTRACKED_NOTE,
    };
    try {
      fs.mkdirSync(this.agentDir(id), { recursive: true, mode: 0o700 });
      let f = path.join(this.agentDir(id), `${stamp}.json`);
      for (let i = 1; fs.existsSync(f); i++) f = path.join(this.agentDir(id), `${stamp}-${i}.json`);
      writeJson(f, result, 0o600);
      this.prune(id);
    } catch (err) {
      this.logger?.warn?.(`checks: could not save the result: ${err.message}`);
    }
    this.progress(id, { phase: 'end', ok: result.ok, error });
    this.events?.record?.({ type: 'checks', action: 'ran', agent: id, ok: result.ok });
    return result;
  }

  /** End anything still running (server shutdown). */
  stop() {
    for (const child of this.children) killTree(child, 'SIGKILL');
  }
}

#!/usr/bin/env node
// clawdling: the command line for a Clawdling org. Most commands talk to the running server over
// HTTP with the org's token, so agents (and Donna) can use them from inside Claude Code.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readToken, loadOrCreateToken } from '../server/auth.js';
import { OrgStore, defaultAnswers, initOrg } from '../server/org.js';
import { selectBackend } from '../server/backend.js';
import { cliInvocation, stopMessage } from '../server/hints.js';
import { DEFAULT_PORT, PKG_ROOT, VERSION, childEnv, resolveHome, runtimePaths, stableNodePath, tmuxSocketName, which } from '../server/paths.js';
import { claudeInstallCommand, commandFor, findGitBash, installCommand, packageManager, spawnOptions } from '../server/platform.js';
import { DeviceStore, RemoteStore, onlyCockpit, parseRemoteUrl, redactServePaths, serveArgs, statusText, tailscaleBin, webHandlers } from '../server/remote.js';
import { oneLine, readJson, shq } from '../server/util.js';
import { LedgerReader, summarize } from '../server/ledger.js';

class CliError extends Error {}

/**
 * A command as the reader should type it. Inside Clawdling's own sessions and Donna's turns,
 * `clawdling` is on PATH (the org's shim); in the person's own terminal a by-hand install has no
 * `clawdling`, so it is spelled `node <path>/bin/clawdling.js` (server/hints.js).
 */
function cliCmd(home, sub = '') {
  const found = which('clawdling', process.env.PATH || '');
  const inside = !!found && path.dirname(found) === runtimePaths(home).bin;
  const prefix = inside ? 'clawdling' : cliInvocation({ home });
  return sub ? `${prefix} ${sub}` : prefix;
}

const HELP = `clawdling ${VERSION}: an org of Claude Code agents, with a cockpit and a chief of staff.

Usage:
  clawdling doctor                          check node, claude, the session backend, the org and the server
  clawdling doctor --contract [--live] [--json]   check this Claude Code against what Clawdling relies on (no model call; --live: one tiny real session)
  clawdling init [--answers FILE | --defaults] [--force]
                                            create the org (default home ~/clawdling)
  clawdling start [--port 4747] [--host 127.0.0.1] [--open]
                                            run the cockpit server in the foreground
  clawdling stop                            stop the cockpit (with tmux, sessions keep running)
  clawdling open [--print]                  open the cockpit in your browser (with the token)
  clawdling new domain "<Name>" --mission "..."
  clawdling new project "<Name>" --goal "..." [--repo PATH] [--domain ID]
  clawdling discover [--all] [--setup] [--no-github] [--json]
  clawdling discover --setup --safety [--json]   the setup safety audit: the lethal trifecta per agent (offline, names only)
                                            find your projects (Claude Code history, git repos in
                                            ~/code and similar folders, GitHub through your own gh)
  clawdling import <name|path|owner/repo>... [--recent] [--domain D] [--clone] [--group "Name"] [--yes]
                                            make a project agent per project (prints the plan
                                            until you add --yes; never writes into your repos)
  clawdling ls [--all] [--json]             list sessions
  clawdling report [agent] [--window today|7d|30d] [--json] | report --all [--json]
                                            the report card: what got done, what needs you, what it
                                            used (a list-price equivalent, not a bill), what is next
  clawdling check <agent> [--json]          run the project's approved ship check (set up in the
                                            cockpit) in a scratch copy; exit 0 pass, 1 fail
  clawdling checkup <agent> [--models a,b] [--k 1|3] [--max-cost 2] [--threshold 1] [--json]
                                            run the agent's approved check-up on your plan (the
                                            estimate is printed first); exit 0 pass, 1 fail, 2 the
                                            cost cap was hit or the judge was unreliable
  clawdling spawn <agent> ["first message"] [--model M] [--effort E] [--account A] [--title T] [--cols N --rows N] [--json]
  clawdling send <sid> "text" [--no-enter]  type into a live session
  clawdling attach <sid|tmux-name>          attach this terminal to a session (detach: Ctrl-b d with
                                            tmux, Ctrl-] with the built-in terminal)
  clawdling end <sid>                       end a session (it stays resumable)
  clawdling resume <sid>                    resume an ended session
  clawdling donna telegram --token <T>      connect Donna to a Telegram bot, print a pairing code
  clawdling donna imessage --handle <you>   let Donna answer your iMessages (macOS, experimental)
  clawdling donna status
  clawdling remote list|check [--json]       Use from anywhere: is it on, and is each address private
  clawdling remote tailscale-name           this computer's Tailscale address (nothing about others)
  clawdling remote serve <https-url>        point a Tailscale Serve entry at the cockpit (its private
                                            path is set and never printed)
  clawdling remote serve-status             tailscale serve status, with private paths hidden
  clawdling remote add <https-url> --kind tailscale|cloudflare [--email E] [--team-domain T --access-aud A]
                                            register a Tailscale Serve or Cloudflare Tunnel address
                                            (checked first: never a public one, never one without Access)
  clawdling remote remove <https-url>|--all  forget an address (--all: forget every one, turn it off)
  clawdling remote off                      stop answering remote addresses and sign out every device
  clawdling service install|uninstall [--dry-run]
                                            start the cockpit at login (macOS launchd, Linux
                                            systemd, Windows Startup folder)

Global: --home PATH (or CLAWDLING_HOME). Session ids can be shortened to their first 8 characters.
Sessions run in tmux when tmux 3.2+ is installed (macOS, Linux; they survive cockpit restarts),
else in a built-in terminal (node-pty; they end with the cockpit and resume). CLAWDLING_BACKEND
picks one (tmux or pty).
`;

// ------------------------------------------------------------------------------------- args

const BOOLEAN_FLAGS = new Set(['defaults', 'force', 'open', 'all', 'json', 'no-enter', 'print', 'dry-run', 'disable', 'pair', 'help', 'version', 'setup', 'no-github', 'recent', 'clone', 'yes', 'safety', 'contract', 'live']);
const REMOTE_HELP = `usage:
  clawdling remote list [--json]
  clawdling remote check [--json]
  clawdling remote tailscale-name
  clawdling remote serve <https-url>
  clawdling remote serve-status
  clawdling remote add <https-url> --kind tailscale|cloudflare [--email <you>] [--team-domain <team>.cloudflareaccess.com --access-aud <AUD tag>]
  clawdling remote remove <https-url> | --all
  clawdling remote off`;

export function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a === '-h') {
      out.flags.help = true;
      continue;
    }
    if (a === '-v') {
      out.flags.version = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (eq !== -1) out.flags[key] = a.slice(eq + 1);
      else if (BOOLEAN_FLAGS.has(key)) out.flags[key] = true;
      else if (i + 1 < argv.length) out.flags[key] = argv[++i];
      else throw new CliError(`--${key} needs a value`);
      continue;
    }
    out._.push(a);
  }
  return out;
}

// ------------------------------------------------------------------------------------- context

function context(flags) {
  const home = resolveHome(flags.home);
  const paths = runtimePaths(home);
  const info = readJson(paths.server, null);
  let alive = false;
  if (info?.pid) {
    try {
      process.kill(info.pid, 0);
      alive = true;
    } catch (e) {
      alive = e.code === 'EPERM';
    }
  }
  const port = Number(flags.port) || (alive && info.port) || Number(process.env.CLAWDLING_PORT) || DEFAULT_PORT;
  const host = alive && info.host && !['0.0.0.0', '::'].includes(info.host) ? info.host : '127.0.0.1';
  return { home, paths, info: alive ? info : null, port, host, token: readToken(paths.token) };
}

function baseUrl(ctx) {
  const h = ctx.host.includes(':') ? `[${ctx.host}]` : ctx.host;
  return `http://${h}:${ctx.port}`;
}

async function api(ctx, method, p, body) {
  if (!ctx.token) throw new CliError(`No org token at ${ctx.paths.token}. Run \`${cliCmd(ctx.home, 'init')}\` first.`);
  let res;
  try {
    res = await fetch(baseUrl(ctx) + p, {
      method,
      headers: { 'x-clawdling-token': ctx.token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    throw new CliError(`Clawdling isn't running for ${ctx.home} (nothing answered on port ${ctx.port}). Start it with: ${cliCmd(ctx.home, 'start')}`);
  }
  if (res.status === 204) return null;
  let data = {};
  try {
    data = await res.json();
  } catch {
    // empty
  }
  if (!res.ok) {
    const e = new CliError(data.error || `HTTP ${res.status}`);
    e.data = data;
    throw e;
  }
  return data;
}

async function serverUp(ctx) {
  try {
    const res = await fetch(baseUrl(ctx) + '/api/health', { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function resolveSid(ctx, ref) {
  if (!ref) throw new CliError('which session? Give a session id (see `clawdling ls`)');
  const list = await api(ctx, 'GET', '/api/sessions');
  const hits = list.filter((s) => s.sid === ref || s.tmux_name === ref || (ref.length >= 4 && s.sid.startsWith(ref)));
  if (!hits.length) throw new CliError(`no session matches "${ref}"`);
  if (hits.length > 1) throw new CliError(`"${ref}" matches ${hits.length} sessions; use more characters`);
  return hits[0];
}

function rel(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function pad(s, n) {
  s = String(s ?? '');
  return s.length >= n ? s.slice(0, n - 1) + '…' : s + ' '.repeat(n - s.length);
}

function openInBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => console.log(`Open this link: ${url}`));
    child.unref();
  } catch {
    console.log(`Open this link: ${url}`);
  }
}

// check runs project scripts and checkup spends the plan: never from a text message.
const DONNA_FORBIDDEN = new Set(['init', 'start', 'stop', 'service', 'donna', 'attach', 'open', 'remote', 'check', 'checkup']);

// ------------------------------------------------------------------------------------- commands

async function cmdInit(args) {
  const home = resolveHome(args.flags.home);
  let answers;
  if (args.flags.answers) {
    try {
      answers = JSON.parse(fs.readFileSync(path.resolve(args.flags.answers), 'utf8'));
    } catch (e) {
      throw new CliError(`could not read answers file: ${e.message}`);
    }
  } else {
    if (!args.flags.defaults) console.log('No --answers file given: using defaults (Work, Health, Money, Home).');
    answers = defaultAnswers();
  }
  let res;
  try {
    res = initOrg({ home, answers, force: !!args.flags.force });
  } catch (e) {
    throw new CliError(e.message);
  }
  loadOrCreateToken(runtimePaths(home).token);
  console.log(`Created ${res.owner}'s org at ${home}`);
  console.log(`Agents: ${res.agents.join(', ')}`);
  if (res.backupDir) console.log(`Previous versions of re-rendered files: ${res.backupDir}`);
  // Spelled the way this computer runs this install (no bare `clawdling` unless it is on PATH).
  const cli = cliInvocation({ home });
  console.log('\nNext:');
  console.log(`  ${cli} start --open`);
  if (res.channel === 'telegram') console.log(`  ${cli} donna telegram --token <token from @BotFather>`);
  if (res.channel === 'imessage') console.log(`  ${cli} donna imessage --handle <the phone number or email you text from>`);
}

async function cmdStart(args) {
  const { startServer } = await import('../server/index.js');
  const home = resolveHome(args.flags.home);
  const port = args.flags.port !== undefined ? Number(args.flags.port) : Number(process.env.CLAWDLING_PORT) || DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CliError('--port must be a number');
  const host = args.flags.host || '127.0.0.1';
  let srv;
  let requestStop = () => {};
  try {
    srv = await startServer({ home, port, host, onShutdown: (why) => requestStop(why) });
  } catch (e) {
    // Nothing was started or written (the server refuses before touching state): exit now.
    console.error(`clawdling: ${e.message}`);
    process.exit(1);
  }
  const persistent = srv.backend.persistent !== false;
  console.log(`\nClawdling ${VERSION}: cockpit for ${srv.org.read().owner}'s org`);
  console.log(`  Open:      ${srv.openUrl}`);
  console.log(`  Org:       ${home}`);
  if (persistent) console.log(`  Sessions:  tmux (tmux -L ${srv.socket} ls)`);
  else console.log(`  Sessions:  built-in terminal (${srv.backend.describe().version}).${process.platform === 'win32' ? '' : ' Install tmux 3.2+ to keep them running across restarts.'}`);
  console.log(persistent ? 'Ctrl-C stops the cockpit. Your sessions keep running in tmux.\n' : 'Ctrl-C stops the cockpit and ends its sessions; each one resumes where it left off.\n');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    console.log(`WARNING: --host ${host} makes the cockpit reachable from other devices on your network.`);
    console.log('  Every page and API still needs your token, but anyone on this network can reach the login page.');
    console.log('  Away from home, prefer Tailscale: bind to your tailnet address, or keep 127.0.0.1 and use `tailscale serve`.');
    console.log('  Pair a phone from Settings in the cockpit (QR code), or with GET /api/pair.\n');
  }
  if (args.flags.open) openInBrowser(srv.openUrl);
  let stopping = false;
  const stop = async (sig) => {
    if (stopping) return;
    stopping = true;
    console.error(`\n${sig}: stopping the cockpit (${persistent ? 'sessions keep running' : 'ending its sessions; they stay resumable'})`);
    const force = setTimeout(() => process.exit(0), 8000);
    force.unref();
    await srv.stop().catch(() => {});
    process.exit(0);
  };
  requestStop = stop;
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGHUP', () => stop('SIGHUP'));
}

async function cmdStop(args) {
  const ctx = context(args.flags);
  const h = await serverUp(ctx);
  if (!h || h.home !== ctx.home) {
    console.log(`The cockpit is not running for ${ctx.home}.`);
    return;
  }
  const live = (await api(ctx, 'GET', '/api/sessions').catch(() => [])).filter((s) => s.status !== 'ended').length;
  const r = await api(ctx, 'POST', '/api/shutdown');
  for (let i = 0; i < 120 && (await serverUp(ctx)); i++) await new Promise((res) => setTimeout(res, 100));
  const start = cliCmd(ctx.home, 'start');
  console.log(stopMessage({ live, keepsRunning: r?.sessions_keep_running, start }));
}

async function cmdOpen(args) {
  const ctx = context(args.flags);
  if (!ctx.token) throw new CliError(`No org here. Run \`${cliCmd(ctx.home, 'init')}\` first.`);
  const url = `${baseUrl(ctx)}/?t=${ctx.token}`;
  if (!ctx.info) console.error(`Note: the cockpit does not look like it is running (${cliCmd(ctx.home, 'start')}).`);
  if (args.flags.print) console.log(url);
  else {
    console.log(`Opening ${baseUrl(ctx)}`);
    openInBrowser(url);
  }
}

async function cmdNew(args) {
  const kind = args._[1];
  const name = args._[2];
  if (kind !== 'domain' && kind !== 'project') throw new CliError('usage: clawdling new domain "<Name>" --mission "..." | clawdling new project "<Name>" --goal "..."');
  if (!name) throw new CliError('give the agent a name');
  const body = {
    kind,
    name,
    mission: kind === 'domain' ? args.flags.mission : args.flags.goal ?? args.flags.mission,
    id: args.flags.id,
    repo: args.flags.repo,
    domain: args.flags.domain,
    model: args.flags.model,
  };
  const ctx = context(args.flags);
  let agent;
  // Through the API only when THIS org's cockpit answers: another org's cockpit on the same port
  // (the default 4747, say) would refuse our token, and the agent belongs to this org anyway.
  const up = await serverUp(ctx);
  if (up && up.home === ctx.home) agent = await api(ctx, 'POST', '/api/agents', body);
  else {
    try {
      agent = new OrgStore(ctx.paths).createAgent(body);
    } catch (e) {
      throw new CliError(e.message);
    }
  }
  if (args.flags.json) return console.log(JSON.stringify(agent, null, 2));
  console.log(`Created ${kind} agent "${agent.name}" (id ${agent.id}) at ${agent.dir}`);
  console.log(`Start it: ${cliCmd(ctx.home, `spawn ${agent.id} "<first task>"`)}`);
}

// ------------------------------------------------------------------------------------- projects

const tildePath = (p) => {
  const h = os.homedir();
  return p && (p === h || p.startsWith(h + path.sep)) ? `~${p.slice(h.length)}` : p;
};

async function discoverHere(ctx, flags) {
  const { discover } = await import('../server/discover.js');
  let agents = [];
  const hasOrg = fs.existsSync(ctx.paths.orgJson);
  if (hasOrg) {
    try {
      agents = new OrgStore(ctx.paths).agents();
    } catch {
      // an unreadable org: no agent matches
    }
  }
  return discover({ env: childEnv(), homedir: os.homedir(), orgHome: ctx.home, agents, github: !flags['no-github'] });
}

/** A table cell: one line with no control characters, at most n - 1 characters, then a space. */
const col = (v, n) => `${pad(oneLine(String(v ?? ''), 200), n - 1)} `;

function whereText(c) {
  if (c.path) return tildePath(c.path);
  return c.github ? `GitHub, not cloned (${c.github.nameWithOwner})` : 'not on this computer';
}

function githubLine(gh) {
  if (!gh || gh.skipped) return 'GitHub: skipped (--no-github).';
  if (gh.installed === false) return 'GitHub: not connected (the GitHub CLI, gh, is not installed). Install it from https://cli.github.com and run `gh auth login` to also see repos you have not cloned.';
  if (gh.authed === false) return 'GitHub: gh is installed but not signed in. Run `gh auth login` to also see repos you have not cloned.';
  if (gh.error && !gh.found) return `GitHub: could not ask gh (${gh.error}).`;
  return `GitHub: ${gh.found} repos through your own gh${gh.user ? ` (signed in as ${gh.user})` : ''}.`;
}

async function cmdDiscover(args) {
  const ctx = context(args.flags);
  if (args.flags.safety) return cmdSafety(ctx, args.flags);
  const body = await discoverHere(ctx, args.flags);
  if (args.flags.setup) {
    const { scanSetup } = await import('../server/discover.js');
    let agents = [];
    try {
      agents = fs.existsSync(ctx.paths.orgJson) ? new OrgStore(ctx.paths).agents() : [];
    } catch {
      // none
    }
    body.setup = scanSetup({ agents, homedir: os.homedir(), env: childEnv() });
  }
  if (args.flags.json) return console.log(JSON.stringify(body, null, 2));
  const list = body.candidates || [];
  const shown = args.flags.all ? list : list.filter((c) => c.recent);
  if (!list.length) console.log('No projects found yet.');
  else {
    console.log(`${col('NAME', 22)}${col('WHERE', 44)}${col('LAST', 10)}${col('LANG', 12)}${col('VIS', 9)}AGENT`);
    for (const c of shown) {
      const vis = c.github ? (c.github.private ? 'private' : 'public') : '';
      console.log(`${col(c.name, 22)}${col(whereText(c), 44)}${col(rel(c.last_activity_at), 10)}${col(c.language || '', 12)}${col(vis, 9)}${c.agent ? c.agent.id : ''}`);
    }
    const older = list.length - shown.length;
    if (older > 0) console.log(`\n${older} more not touched in 90 days: \`${cliCmd(ctx.home, 'discover --all')}\` lists them.`);
  }
  const s = body.sources || {};
  const looked = [];
  if (s.claude) looked.push(`Claude Code history (${tildePath(s.claude.dir) || '~/.claude/projects'})`);
  if (s.local && s.local.roots && s.local.roots.length) looked.push(s.local.roots.map(tildePath).join(', '));
  console.log(`\nLooked in: ${looked.join('; ') || 'nothing to look in'}.`);
  console.log(githubLine(s.github));
  console.log('Nothing was sent anywhere: this ran on your computer and only read files.');
  if (body.setup) printSetup(body.setup);
  const fresh = list.filter((c) => c.recent && !c.agent);
  if (fresh.length) console.log(`\nNext: ${cliCmd(ctx.home, `import ${fresh.slice(0, 3).map((c) => (/\s/.test(c.name) ? JSON.stringify(oneLine(c.name, 60)) : oneLine(c.name, 60))).join(' ')}${fresh.length > 3 ? ' ...' : ''}`)} (or --recent), or "Bring in your projects" in the cockpit.`);
}

// The setup safety audit (1.8): offline, from files only. It never asks gh or the cockpit.
async function cmdSafety(ctx, flags) {
  if (!flags.setup) throw new CliError('the safety audit is part of the setup scan: `discover --setup --safety`');
  // It lists permission rules from your settings and every repo's: yours to read, not an agent's
  // (every agent may run `clawdling discover` without asking).
  if (process.env.CLAWDLING_SID !== undefined || process.env.CLAWDLING_DONNA !== undefined) {
    throw new CliError('the setup safety audit is yours: open Settings in the cockpit, or run `clawdling discover --setup --safety` in your own terminal');
  }
  const { runSafetyAudit, offlineChannels, SafetyChoices, PRIVACY } = await import('../server/safety-run.js');
  const { Accounts } = await import('../server/accounts.js');
  let agents = [];
  let o = null;
  try {
    if (fs.existsSync(ctx.paths.orgJson)) {
      const store = new OrgStore(ctx.paths);
      agents = store.agents();
      o = store.read();
    }
  } catch {
    // an unreadable org: the user level only
  }
  const accounts = new Accounts({ env: process.env }).list().filter((a) => !a.default).length;
  const audit = runSafetyAudit({ agents, home: ctx.home, userHome: os.homedir(), env: childEnv(), channels: offlineChannels(o), choices: new SafetyChoices(path.join(ctx.paths.rt, 'safety.json')), accounts });
  if (flags.json) return console.log(JSON.stringify({ ...audit, privacy: PRIVACY }, null, 2));
  printSafety(audit);
  console.log(`\n${PRIVACY}`);
  return undefined;
}

const SHIELD = { red: 'RED  ', amber: 'AMBER', green: 'GREEN' };
const CHIP = { private: 'private data', untrusted: 'untrusted input', sends: 'sends out' };

export function printSafety(audit) {
  // A backstop for the terminal: no control, bidi or zero-width character from a file name or a rule.
  const raw = console.log;
  console.log = (...a) => raw(...a.map((x) => String(x).replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '?')));
  try {
    printSafetyRows(audit);
  } finally {
    console.log = raw;
  }
}

function printSafetyRows(audit) {
  console.log(`Setup safety: the lethal trifecta per agent (checked in ${audit.took_ms} ms, by name only)`);
  for (const r of audit.rows) {
    console.log(`\n${SHIELD[r.verdict]}  ${r.name}: ${r.summary}${r.mode ? ` (${r.mode})` : ''}`);
    for (const c of ['private', 'untrusted', 'sends']) {
      const xs = r.chips[c];
      console.log(`  ${pad(CHIP[c], 16)}${xs.length ? xs.map((x) => x.text.replace(/`/g, '')).join('; ') : 'none found'}`);
    }
    for (const u of r.unknown) console.log(`  unknown         ${u.text}: ${u.why}`);
    if (r.sentence) console.log(`  What could happen: ${r.sentence}`);
    for (const f of r.fixes) console.log(`  Fix: ${f.replace(/`/g, '')}`);
    if (r.accepted) console.log(`  Accepted by you: ${r.accepted.reason}`);
    for (const k of r.risks) console.log(`  Risk: ${k.text.replace(/`/g, '')} (${k.file})`);
    for (const n of r.notes) console.log(`  Note: ${n.replace(/`/g, '')}`);
  }
}

function printSetup(st) {
  const names = (xs) => (xs || []).map((x) => x.name || x.event).join(', ');
  console.log('\nYour Claude Code setup (every agent session loads it; names only):');
  if (st.claude_md && st.claude_md.exists) console.log(`  CLAUDE.md: ${(st.claude_md.lines || [])[0] || '(empty)'}`);
  for (const [label, key] of [['Skills', 'skills'], ['Subagents', 'agents'], ['Commands', 'commands'], ['Plugins', 'plugins'], ['MCP servers', 'mcp']]) {
    const xs = st[key] || [];
    if (xs.length) console.log(`  ${label} (${xs.length}): ${names(xs)}`);
  }
  if ((st.hooks || []).length) console.log(`  Hooks: ${st.hooks.map((h) => `${h.event} (${h.count})`).join(', ')}`);
  for (const p of st.projects || []) {
    const bits = [p.claude_md ? 'CLAUDE.md' : '', p.agents_md ? 'AGENTS.md' : '', ...['skills', 'agents', 'commands', 'mcp'].filter((k) => (p[k] || []).length).map((k) => `${k === 'agents' ? 'subagents' : k}: ${names(p[k])}`)].filter(Boolean);
    if (bits.length) console.log(`  ${p.agent || tildePath(p.path)} adds: ${bits.join('; ')}`);
  }
}

/** The candidate a person means by `ref`: a name, a path, owner/repo or a key. */
function matchRef(list, ref) {
  const r = String(ref).trim();
  const lower = r.toLowerCase();
  const abs = /^(~|\.|\/|[A-Za-z]:[\\/])/.test(r) ? path.resolve(r.startsWith('~') ? path.join(os.homedir(), r.slice(1)) : r) : null;
  const byExact = list.filter((c) => (abs && c.path && path.resolve(c.path) === abs) || c.key === r || (c.github && c.github.nameWithOwner.toLowerCase() === lower));
  if (byExact.length) return { hits: byExact.slice(0, 1) };
  const byName = list.filter((c) => c.name.toLowerCase() === lower);
  if (byName.length) return { hits: byName };
  return { hits: [], abs };
}

async function cmdImport(args) {
  const ctx = context(args.flags);
  const refs = args._.slice(1);
  if (process.env.CLAWDLING_DONNA === '1' && args.flags.yes) {
    throw new CliError('Donna can propose an import, but creating the agents is the owner\'s call: "Bring in your projects" in the cockpit, or `clawdling import ... --yes` in their own terminal.');
  }
  if (!fs.existsSync(ctx.paths.orgJson)) throw new CliError(`No org at ${ctx.home}. Run \`${cliCmd(ctx.home, 'init')}\` first.`);
  if (!refs.length && !args.flags.recent) {
    throw new CliError(`say which projects: names, paths or owner/repo from \`${cliCmd(ctx.home, 'discover')}\`, or --recent for every recent one without an agent`);
  }
  const body = await discoverHere(ctx, args.flags);
  const list = body.candidates || [];
  const picked = [];
  const problems = [];
  const add = (c) => {
    if (!picked.includes(c)) picked.push(c);
  };
  for (const ref of refs) {
    const { hits, abs } = matchRef(list, ref);
    if (hits.length > 1) {
      problems.push(`"${ref}" matches ${hits.length} projects: ${hits.map(whereText).join(', ')}. Use the path or owner/repo.`);
      continue;
    }
    if (hits.length) {
      add(hits[0]);
      continue;
    }
    let isDir = false;
    try {
      isDir = !!abs && fs.statSync(abs).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) add({ key: `path:${abs}`, name: path.basename(abs), path: abs, cloned: true, github: null, agent: null });
    else if (/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(ref)) add({ key: `github.com/${ref.toLowerCase()}`, name: ref.split('/')[1], path: null, cloned: false, github: { nameWithOwner: ref, url: `https://github.com/${ref}` }, agent: null });
    else problems.push(`no project matches "${ref}" (see \`${cliCmd(ctx.home, 'discover --all')}\`).`);
  }
  if (args.flags.recent) for (const c of list) if (c.recent && !c.agent && !(c.github && c.github.archived) && (c.cloned || args.flags.clone)) add(c);
  for (const p of problems) console.error(`clawdling: ${p}`);
  if (!picked.length) throw new CliError(problems.length ? 'nothing to import' : 'no recent projects without an agent');

  // The domain every new agent goes in: an existing one by id or name, else a new one (default Work).
  const org = new OrgStore(ctx.paths);
  const want = String(args.flags.domain || 'Work').trim();
  const dom = org.agents().find((a) => a.kind === 'domain' && (a.id === want || a.name.toLowerCase() === want.toLowerCase()));
  const where = dom ? { domain: dom.id } : { new_domain: want };
  const domainLabel = dom ? dom.name : `${want} (new domain)`;

  const rows = picked.map((c) => {
    if (c.agent) return { c, skip: `already an agent: ${c.agent.name || c.agent.id}` };
    if (!c.path && !args.flags.clone) return { c, skip: 'not on this computer: add --clone to clone it first' };
    if (args.flags.group && !c.path) return { c, skip: 'a group takes repos that are already on this computer' };
    const item = c.path ? { path: c.path, ...(c.github ? { github: c.github.nameWithOwner } : {}) } : { github: c.github ? c.github.nameWithOwner : undefined, url: (c.github && c.github.url) || c.remote, name: c.name, clone: true };
    return { c, item: { ...item, ...where } };
  });
  const todo = rows.filter((r) => r.item);
  const cloneRoot = body.clone_root || path.join(os.homedir(), 'code');
  if (args.flags.group) {
    console.log(`Plan: one project agent "${args.flags.group}" in ${domainLabel} for ${todo.length} repos:`);
  } else console.log(`Plan: ${todo.length} new project agent${todo.length === 1 ? '' : 's'} in ${domainLabel}:`);
  for (const r of rows) {
    if (r.skip) console.log(`  =  ${col(r.c.name, 22)}${r.skip}`);
    else if (r.c.path) console.log(`  +  ${col(r.c.name, 22)}${oneLine(tildePath(r.c.path), 300)}`);
    else console.log(`  +  ${col(r.c.name, 22)}clone ${oneLine(r.c.github ? r.c.github.nameWithOwner : r.c.remote, 200)} to ${oneLine(tildePath(path.join(cloneRoot, r.c.name)), 300)} (your own gh or git), then make the agent`);
  }
  if (!todo.length) return;
  if (args.flags.group && todo.length < 2) throw new CliError('a group needs at least two repos');
  if (!args.flags.yes) {
    console.log(`\nNothing was created. Run again with --yes to create ${args.flags.group ? 'it' : `these ${todo.length}`}. Each agent gets its own folder in ${tildePath(ctx.home)}; your repos are not changed.`);
    return;
  }

  const up = await serverUp(ctx);
  const viaApi = up && up.home === ctx.home;
  let importer = null;
  const run = async (payload) => {
    if (viaApi) return api(ctx, 'POST', '/api/import', payload);
    importer = importer || (await import('../server/importer.js'));
    try {
      return payload.group ? await importer.importGroup(org, { ...payload.group, items: payload.items }) : await importer.importProject(org, payload, { cloneRoot });
    } catch (e) {
      throw new CliError(e.message);
    }
  };
  const results = [];
  if (args.flags.group) {
    const r = await run({ group: { name: String(args.flags.group), ...where }, items: todo.map((t) => ({ path: t.item.path })) });
    results.push(r);
    if (r.skipped) console.log(`Nothing created: ${oneLine(r.reason, 200)}.`);
    else console.log(`Created "${r.agent.name}" (id ${r.agent.id}) for ${todo.length} repos.`);
  } else {
    let failed = 0;
    for (const r of todo) {
      process.stdout.write(`  ${col(r.c.name, 22)}${r.item.clone ? 'cloning, then creating... ' : 'creating... '}`);
      try {
        const out = await run(r.item);
        results.push(out);
        console.log(out.skipped ? `skipped (${oneLine(out.reason, 200)})` : `created "${out.agent.id}"${out.cloned ? ' (cloned)' : ''}`);
      } catch (e) {
        failed++;
        console.log(`failed: ${e.message}`);
      }
    }
    if (failed) process.exitCode = 1;
  }
  if (args.flags.json) console.log(JSON.stringify(results, null, 2));
  const made = results.filter((r) => r && r.created);
  if (made.length) {
    console.log(`\nStart one: ${cliCmd(ctx.home, `spawn ${made[0].agent.id} "What is this project and how do I run its tests?"`)}`);
    console.log(`Or let it read its repo and improve its own notes (uses your Claude plan): ${cliCmd(ctx.home, `spawn ${made[0].agent.id} /onboard-project`)}`);
  }
}

async function cmdLs(args) {
  const ctx = context(args.flags);
  let list;
  let stale = false;
  try {
    list = await api(ctx, 'GET', '/api/sessions');
  } catch (e) {
    // Only when the cockpit is not running here (never when pointed elsewhere with --port/--home),
    // and only the plain facts of each session: never what an agent wrote or is asking.
    const data = args.flags.port || args.flags.home ? null : readJson(ctx.paths.sessions, null);
    if (!data) throw e;
    const SAFE = ['sid', 'agent', 'agent_name', 'kind', 'title', 'status', 'model', 'effort', 'created_at', 'last_activity_at', 'ended_at', 'tmux_name'];
    list = (data.sessions || []).map((r) => Object.fromEntries(SAFE.filter((k) => k in r).map((k) => [k, r[k]])));
    stale = true;
  }
  if (!args.flags.all) list = list.filter((s) => s.status !== 'ended');
  if (args.flags.json) return console.log(JSON.stringify(list, null, 2));
  if (stale) console.error('(the cockpit is not running: showing the last saved state)');
  if (!list.length) return console.log(args.flags.all ? 'No sessions yet.' : `No live sessions. \`${cliCmd(ctx.home, 'ls --all')}\` shows ended ones.`);
  console.log(`${pad('SID', 10)}${pad('AGENT', 14)}${pad('STATUS', 11)}${pad('TITLE', 40)}ACTIVE`);
  for (const s of list) {
    console.log(`${pad(s.sid.slice(0, 8), 10)}${pad(s.agent, 14)}${pad(s.status, 11)}${pad(s.title || 'new session', 40)}${rel(s.last_activity_at)}`);
  }
}

const WINDOW_LABEL = { today: 'today', '7d': 'the last 7 days', '30d': 'the last 30 days' };
const usd = (x) => (x === null || x === undefined || !Number.isFinite(x) ? 'unknown' : x === 0 ? '$0.00' : x > 0 && x < 0.005 ? 'less than $0.01' : `about $${x.toFixed(2)}`);
const NEED_WORD = { question: 'a question', plan: 'a plan to approve', permission: 'a permission', error: 'a failed turn', sign_in: 'a sign-in', startup: 'a question before it starts', reply: 'your reply' };

async function cmdReport(args) {
  const ctx = context(args.flags);
  const win = args.flags.window || '7d';
  const id = args._[1];
  const q = `?window=${encodeURIComponent(win)}`;
  // The whole org for the CTO seat (1.7): computed status, reasons and receipt ids, schema 2.
  if (args.flags.all) {
    if (id) throw new CliError('--all reports on every agent: leave out the agent name');
    const r = await api(ctx, 'GET', `/api/report/all${q}`);
    if (args.flags.json) return console.log(JSON.stringify(r, null, 2));
    console.log(`Every agent, ${WINDOW_LABEL[win] || win} (week ${r.week}). Labels are computed by Clawdling from receipts.\n`);
    console.log(`${pad('AGENT', 18)}${pad('STATUS', 10)}WHY`);
    for (const a of r.agents) {
      const why = (a.status.reasons || []).map((x) => `${x.text} [${x.receipt}]`);
      console.log(`${pad(a.name, 18)}${pad(a.status.text, 10)}${why[0] || ''}`);
      for (const w of why.slice(1)) console.log(`${pad('', 28)}${w}`);
    }
    if (!r.agents.length) console.log('No domain or project agents yet.');
    return undefined;
  }
  if (!id) {
    const o = await api(ctx, 'GET', `/api/org/report${q}`);
    if (args.flags.json) return console.log(JSON.stringify(o, null, 2));
    console.log(`Your org, ${WINDOW_LABEL[win] || win}`);
    const unk = (x, ok) => (ok === false && !(x > 0) ? 'cost unknown' : usd(x));
    console.log(`Usage today: ${unk(o.totals.today_usd, o.totals.today_complete)} · last 7 days: ${unk(o.totals.week_usd, o.totals.week_complete)}${o.totals.complete ? '' : ' (some usage has an unknown cost)'}`);
    console.log(`(${o.label})\n`);
    console.log(`${pad('AGENT', 18)}${pad('DONE', 6)}${pad('NEEDS YOU', 11)}${pad('USAGE', 18)}LAST DONE`);
    for (const a of o.agents) console.log(`${pad(a.name, 18)}${pad(a.done, 6)}${pad(a.needs, 11)}${pad(!a.cost_complete && !(a.cost_usd > 0) ? 'cost unknown' : usd(a.cost_usd) + (a.cost_complete ? '' : '+'), 18)}${a.last_done_at ? rel(a.last_done_at) : '-'}`);
    return undefined;
  }
  const r = await api(ctx, 'GET', `/api/agents/${encodeURIComponent(id)}/report${q}`);
  if (args.flags.json) return console.log(JSON.stringify(r, null, 2));
  const out = [`${r.agent.name}: report card, ${WINDOW_LABEL[win] || win}`, '', 'Done'];
  if (!r.done.length) out.push('  Nothing yet. Each session that does some work shows up here, with its last words and its commits.');
  for (const d of r.done) {
    out.push(`  - ${d.title || 'Untitled session'} (${d.live ? 'still running' : `ended ${rel(d.when)}`})`);
    if (d.line) out.push(`    ${d.line}`);
    const bits = [`${d.files_changed} file${d.files_changed === 1 ? '' : 's'} changed`];
    if (d.commits && d.commits.length) bits.push(`${d.commits.length} commit${d.commits.length === 1 ? '' : 's'}: ${d.commits.slice(0, 3).map((c) => `"${c.subject}"`).join(', ')}`);
    if (d.transcript === 'gone') bits.push('transcript gone, kept summary only');
    out.push(`    ${bits.join(' · ')}`);
  }
  out.push('', 'Needs you');
  if (!r.needs.length) out.push('  Nothing is waiting on you.');
  for (const n of r.needs) out.push(`  - ${n.title || 'Untitled session'}: ${NEED_WORD[n.kind] || n.kind}${n.text ? ` (${n.text})` : ''}`);
  const c = r.cost;
  out.push('', `Cost: ${!c.complete && !(c.total_usd > 0) ? 'unknown' : `${usd(c.total_usd)} of usage`}${c.complete || !(c.total_usd > 0) ? '' : ` plus some with an unknown cost${c.unknown_models.length ? ` (${c.unknown_models.join(', ')})` : ''}`}`);
  out.push(`  ${c.label}`);
  if (c.by_model.length) out.push(`  By model: ${c.by_model.map((m) => `${m.model} ${usd(m.usd)}`).join(', ')}`);
  if (c.top_sessions.length) out.push(`  Top sessions: ${c.top_sessions.map((t) => `${t.title || 'Untitled'} ${usd(t.usd)}`).join(', ')}`);
  out.push('', `Next${r.next.updated_at ? ` (from memory/NOW.md, updated ${rel(r.next.updated_at)}${r.next.stale ? ', over a week old' : ''})` : ''}`);
  out.push(r.next.empty ? '  Nothing written yet. The agent writes its next steps in memory/NOW.md when it hands off.' : r.next.text.split('\n').map((l) => `  ${l}`).join('\n'));
  console.log(out.join('\n'));
  return undefined;
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** `clawdling check <agent>`: the approved ship check, run now; exit 0 when every check passed. */
async function cmdCheck(args) {
  const ctx = context(args.flags);
  const id = args._[1];
  if (!id) throw new CliError('which agent? `clawdling check <agent>`');
  const q = `/api/agents/${encodeURIComponent(id)}/checks`;
  let v = await api(ctx, 'GET', q);
  if (!v.available) throw new CliError(v.why || 'a ship check is for project agents with a repo');
  if (!v.exists || !v.config) throw new CliError(v.error || `No ship check yet for ${id}. Set one up in the cockpit: open the agent, Check-up tab, "Set up a ship check".`);
  if (!v.approved) throw new CliError('checks.yaml changed since it was approved. Review it in the cockpit (Check-up tab) before it runs.');
  const started = await api(ctx, 'POST', `${q}/run`);
  if (!args.flags.json) console.error(`Running the ship check for ${id} in a scratch copy of ${v.repo}…`);
  // Stopped, with no new result for 10 s: it ended without saving one (the cockpit's log says why).
  for (let idle = 0; ; ) {
    await sleepMs(500);
    v = await api(ctx, 'GET', q);
    if (!v.running && v.last && v.last.started_at >= started.started_at) break;
    idle = v.running ? 0 : idle + 1;
    if (idle > 20) throw new CliError('The ship check ended without a result. Look in the cockpit (Check-up tab) for what went wrong.');
  }
  const r = v.last;
  if (args.flags.json) console.log(JSON.stringify(r, null, 2));
  else {
    const lines = [`Ship check for ${id}: ${r.ok ? 'passed' : 'failed'} (${Math.round(r.ms / 100) / 10}s)`];
    if (r.error) lines.push(`  ${r.error}`);
    for (const x of r.results) {
      lines.push(`  ${x.ok ? 'pass' : 'FAIL'}  ${x.setup ? 'setup' : x.name}: ${x.cmd} (${Math.round(x.ms / 100) / 10}s${x.exit !== null && x.exit !== 0 ? `, exit ${x.exit}` : ''})`);
      if (!x.ok && x.err1) lines.push(`        ${x.err1}`);
    }
    lines.push(`  ${r.untracked_note}`);
    console.log(lines.join('\n'));
  }
  process.exitCode = r.ok ? 0 : 1;
}

/** `clawdling checkup <agent>`: the approved check-up, on the user's plan, capped. */
async function cmdCheckup(args) {
  const ctx = context(args.flags);
  const id = args._[1];
  if (!id) throw new CliError('which agent? `clawdling checkup <agent>`');
  const base = `/api/agents/${encodeURIComponent(id)}/evals`;
  const view = await api(ctx, 'GET', base);
  if (!view.runnable) throw new CliError(view.cases.length ? 'No approved case to run. Read the cases in the cockpit (Check-up tab) and approve them first.' : `${id} has no check-up yet. Draft one in the cockpit (Check-up tab) first.`);
  const k = Number(args.flags.k || args.flags.runs || view.settings.runs || 1);
  const cap = args.flags['max-cost'] !== undefined ? Number(args.flags['max-cost']) : view.settings.max_cost_usd;
  const threshold = args.flags.threshold !== undefined ? Number(args.flags.threshold) : 1;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new CliError('--threshold is from 0 to 1');
  const models = args.flags.models || null;
  const est = await api(ctx, 'GET', `${base}/estimate?k=${k}${models ? `&models=${encodeURIComponent(models)}` : ''}`);
  console.error(`This starts ${est.runs} Claude Code run${est.runs === 1 ? '' : 's'} on your plan, about $${est.low_usd.toFixed(2)} to $${est.high_usd.toFixed(2)} list-price equivalent, capped at $${Number(cap).toFixed(2)}.`);
  console.error(`(${est.label} ${view.notes.pro})`);
  const started = await api(ctx, 'POST', `${base}/run`, { k, maxCostUsd: cap, ...(models ? { models } : {}) });
  let last = '';
  let v;
  for (let idle = 0; ; ) {
    await sleepMs(1000);
    v = await api(ctx, 'GET', base);
    const a = v.active;
    // Not running, and no result of this run for 10 s (Clawdling restarted): stop waiting.
    idle = a ? 0 : idle + 1;
    if (idle > 10 && !(v.last_run && v.last_run.id === started.id)) {
      console.error('The check-up stopped without a result. Look in the cockpit (Check-up tab).');
      process.exitCode = 2;
      return;
    }
    if (a && !args.flags.json) {
      const line = `  ${a.done}/${a.total} runs, $${a.spent_usd.toFixed(2)} so far${a.current ? `: ${a.current}` : ''}`;
      if (line !== last) console.error(line);
      last = line;
    }
    if (!a && v.last_run && v.last_run.id === started.id) break;
  }
  const r = v.history.find((h) => h.id === started.id);
  if (!r) {
    console.error(`The check-up stopped before it wrote a result: ${v.last_run.error || 'unknown error'}`);
    process.exitCode = 2; // no score, never "below the threshold"
    return;
  }
  if (args.flags.json) console.log(JSON.stringify(r, null, 2));
  else {
    const out = [];
    const pct = (x) => (x === null || x === undefined ? '-' : `${Math.round(x * 100)}%`);
    if (r.judge_unreliable) out.push(`Check-up for ${id}: judge unreliable (it passed an empty answer or failed a good one), so there is no score. Tighten the criteria.`);
    else out.push(`Check-up for ${id}: score ${pct(r.score)}${r.capped ? ' (stopped at the cost cap: not every run happened)' : ''}`);
    if (r.error) out.push(`  ${r.error}`);
    for (const cell of r.cells) {
      if (r.cells.length > 1) out.push(`  ${cell.label}${cell.current ? ' (current)' : ''}: ${pct(cell.score)}, $${(cell.cost_per_run ?? 0).toFixed(3)} a run`);
      for (const c of cell.cases) out.push(`  ${r.cells.length > 1 ? '  ' : ''}${c.runs.every((x) => x.passed) ? 'pass' : 'FAIL'}  ${c.name}${c.runs.some((x) => x.error) ? ` (${c.runs.find((x) => x.error).error})` : ''}`);
    }
    if (r.recommendation) out.push(r.recommendation.current ? '  Recommendation: keep the current setting (no cheaper one holds).' : `  Recommendation: ${r.recommendation.label}, about ${r.recommendation.saves_pct}% cheaper a run. Apply it in the cockpit (Check-up tab, "Use this").`);
    out.push(`  Cost: $${r.cost_usd.toFixed(2)} (${r.label})`);
    console.log(out.join('\n'));
  }
  // No score (an error, the cap, an unreliable judge) is never a pass.
  process.exitCode = r.judge_unreliable || r.capped || r.error || r.score === null ? 2 : r.score >= threshold ? 0 : 1;
}

async function cmdSpawn(args) {
  const agent = args._[1];
  if (!agent) throw new CliError('usage: clawdling spawn <agent> ["first message"]');
  const prompt = args._.slice(2).join(' ') || undefined;
  const ctx = context(args.flags);
  const size = {};
  for (const k of ['cols', 'rows']) {
    if (args.flags[k] === undefined) continue;
    size[k] = Number(args.flags[k]);
    if (!Number.isInteger(size[k])) throw new CliError(`--${k} must be a whole number`);
  }
  const s = await api(ctx, 'POST', '/api/sessions', { agent, prompt, model: args.flags.model, effort: args.flags.effort, account: args.flags.account, title: args.flags.title, ...size });
  if (args.flags.json) return console.log(JSON.stringify(s, null, 2));
  console.log(`Started ${s.agent} session ${s.sid} (${s.title || 'new session'})`);
  console.log(`Watch it in the cockpit, or in a terminal: ${cliCmd(ctx.home, `attach ${s.sid.slice(0, 8)}`)}`);
}

async function cmdSend(args) {
  const ctx = context(args.flags);
  const s = await resolveSid(ctx, args._[1]);
  const text = args._.slice(2).join(' ');
  if (!text && args.flags['no-enter']) throw new CliError('nothing to send');
  await api(ctx, 'POST', `/api/sessions/${s.sid}/send`, { text, enter: !args.flags['no-enter'] });
  console.log(`Sent to ${s.agent} session ${s.sid.slice(0, 8)}.`);
}

async function cmdEnd(args) {
  const ctx = context(args.flags);
  const s = await resolveSid(ctx, args._[1]);
  await api(ctx, 'DELETE', `/api/sessions/${s.sid}`);
  console.log(`Ended ${s.agent} session ${s.sid.slice(0, 8)} (resume it with: ${cliCmd(ctx.home, `resume ${s.sid.slice(0, 8)}`)}).`);
}

async function cmdResume(args) {
  const ctx = context(args.flags);
  const s = await resolveSid(ctx, args._[1]);
  const r = await api(ctx, 'POST', `/api/sessions/${s.sid}/resume`);
  console.log(`Resumed ${r.agent} session ${r.sid.slice(0, 8)} (${r.status}).`);
}

async function cmdAttach(args) {
  const ctx = context(args.flags);
  const ref = args._[1];
  if (!ref) throw new CliError('usage: clawdling attach <sid|tmux-name>');
  // Which backend the sessions live in: the running server's, else the registry's (1.0 = tmux).
  const backend = readJson(ctx.paths.server, null)?.backend || readJson(ctx.paths.sessions, null)?.backend || 'tmux';
  if (backend === 'pty') return attachPty(ctx, ref);
  let name = null;
  const rows = readJson(ctx.paths.sessions, { sessions: [] })?.sessions || [];
  const hits = rows.filter((s) => s.sid === ref || s.tmux_name === ref || (ref.length >= 4 && s.sid.startsWith(ref)));
  if (hits.length === 1) name = hits[0].tmux_name;
  else if (/^cl-[a-z0-9-]+$/.test(ref)) name = ref;
  if (!name) throw new CliError(hits.length > 1 ? `"${ref}" matches several sessions` : `no session matches "${ref}"`);
  const tmux = process.env.CLAWDLING_TMUX_BIN || 'tmux';
  // The socket the sessions really live on: the running server's, else the registry's, else env/default.
  const recorded = readJson(ctx.paths.server, null)?.socket || readJson(ctx.paths.sessions, null)?.socket;
  const socket = typeof recorded === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(recorded) ? recorded : tmuxSocketName();
  if (process.env.TMUX) console.error('(you are inside tmux already: this attaches a nested client)');
  console.error(`Attaching to ${name}. Detach with Ctrl-b d; the session keeps running.`);
  const env = { ...process.env };
  delete env.TMUX;
  const r = spawnSync(tmux, ['-L', socket, 'attach-session', '-t', `=${name}`], { stdio: 'inherit', env });
  if (r.error) throw new CliError(`could not run tmux: ${r.error.message}`);
  process.exitCode = r.status ?? 0;
}

// Modes a session may have turned on in this terminal; reset on detach so the shell is usable.
const RESET_MODES = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[?1004l\x1b[?1l\x1b>\x1b[?25h\x1b[0m';

/**
 * Attach to a session of the built-in terminal backend: a small terminal client over the cockpit's
 * own WebSocket (the same stream the browser gets). Raw keys go in, the screen comes out, in the
 * terminal's alternate screen so your scrollback is left alone. Ctrl-] detaches.
 */
async function attachPty(ctx, ref) {
  const s = await resolveSid(ctx, ref);
  if (s.status === 'ended') throw new CliError(`that session has ended. Resume it first: ${cliCmd(ctx.home, `resume ${s.sid.slice(0, 8)}`)}`);
  const { default: WebSocket } = await import('ws');
  const tty = !!(process.stdin.isTTY && process.stdout.isTTY);
  const size = tty && process.stdout.columns && process.stdout.rows ? `&cols=${process.stdout.columns}&rows=${process.stdout.rows}` : '';
  const host = ctx.host.includes(':') ? `[${ctx.host}]` : ctx.host;
  const ws = new WebSocket(`ws://${host}:${ctx.port}/ws/term/${s.sid}?t=${ctx.token}${size}`);
  const decoder = new TextDecoder('utf-8');
  console.error(`Attaching to ${s.agent} session ${s.sid.slice(0, 8)} (${s.title || 'new session'}). Detach with Ctrl-]; the session keeps running.`);
  await new Promise((resolve) => {
    let done = false;
    let raw = false;
    const send = (msg) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg));
    };
    const onResize = () => send({ t: 'resize', cols: process.stdout.columns, rows: process.stdout.rows });
    const onKey = (buf) => {
      const i = buf.indexOf(0x1d); // Ctrl-]
      if (i !== -1) {
        if (i > 0) send({ t: 'in', data: decoder.decode(buf.subarray(0, i)) });
        finish(0, 'Detached. The session keeps running.');
        return;
      }
      const text = decoder.decode(buf, { stream: true });
      if (text) send({ t: 'in', data: text });
    };
    const finish = (code, msg) => {
      if (done) return;
      done = true;
      process.stdin.off('data', onKey);
      process.stdout.off('resize', onResize);
      if (raw) {
        process.stdout.write(`${RESET_MODES}\x1b[?1049l`);
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      process.stdin.unref?.(); // a paused pipe would still hold the process open
      if (msg) console.error(msg);
      try {
        ws.close();
      } catch {
        // closed
      }
      process.exitCode = code;
      resolve();
    };
    ws.on('open', () => {
      if (tty) {
        process.stdout.write('\x1b[?1049h\x1b[H\x1b[2J');
        process.stdin.setRawMode(true);
        raw = true;
        process.stdout.on('resize', onResize);
      }
      process.stdin.on('data', onKey);
      process.stdin.resume();
    });
    ws.on('message', (data) => {
      let m;
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      // A snapshot clears the screen; never let it clear this terminal's scrollback too.
      if ((m.t === 'snapshot' || m.t === 'out') && typeof m.data === 'string') process.stdout.write(m.t === 'snapshot' ? m.data.replace(/\x1b\[3J/g, '') : m.data);
      else if (m.t === 'ended') finish(0, `The session ended. Resume it with: ${cliCmd(ctx.home, `resume ${s.sid.slice(0, 8)}`)}`);
    });
    ws.on('close', (code, reason) => finish(code === 1000 || code === 1005 ? 0 : 1, code === 1001 ? `The cockpit stopped (${String(reason) || 'shutting down'}).` : null));
    ws.on('error', (err) => finish(1, `could not attach: ${err.message}`));
  });
}

async function cmdDonna(args) {
  const sub = args._[1] || 'status';
  const ctx = context(args.flags);
  if (sub === 'telegram') {
    const body = {};
    if (args.flags.token) body.token = args.flags.token;
    if (args.flags.disable) body.enabled = false;
    if (args.flags.pair) body.pair = true;
    if (!body.token && !args.flags.disable && !args.flags.pair) throw new CliError('usage: clawdling donna telegram --token <token from @BotFather> [--pair] [--disable]');
    const st = await api(ctx, 'POST', '/api/channels/telegram', body);
    if (args.flags.disable) return console.log(`Telegram is off. Re-enable with: ${cliCmd(ctx.home, 'donna telegram --pair')}`);
    const bot = st.bot_username ? `@${st.bot_username}` : 'your bot';
    console.log(`Telegram is connected${st.bot_username ? ` to ${bot}` : ''}.`);
    if (st.pairing_code) {
      console.log(`Pairing code: ${st.pairing_code} (valid for 30 minutes)`);
      console.log(`On your phone, open ${bot} in Telegram${st.bot_username ? ` (https://t.me/${st.bot_username})` : ''} and send:  /pair ${st.pairing_code}`);
    } else if (st.paired) console.log(`${bot} is paired with chat ${st.chat_id_masked}.`);
    if (st.error) console.log(`Note: ${st.error}`);
    return;
  }
  if (sub === 'imessage') {
    const body = {};
    if (args.flags.handle) body.handle = args.flags.handle;
    body.enabled = !args.flags.disable;
    const st = await api(ctx, 'POST', '/api/channels/imessage', body);
    if (!st.enabled) return console.log('iMessage is off.');
    console.log(`Donna now answers iMessages from ${st.handle}.`);
    console.log('This Mac must be signed into Messages with a different Apple ID than your phone, and the app');
    console.log('running Clawdling needs Full Disk Access (to read Messages) and Automation access to Messages.');
    if (st.error) console.log(`Note: ${st.error}`);
    return;
  }
  if (sub === 'status') {
    const c = await api(ctx, 'GET', '/api/channels');
    // Never the pairing code: whoever sends it first is paired (the owner reads it in the cockpit).
    if (args.flags.json) return console.log(JSON.stringify({ ...c, telegram: { ...c.telegram, pairing_code: c.telegram?.pairing_code ? '(shown on the Donna page)' : null } }, null, 2));
    const t = c.telegram;
    const bot = t.bot_username ? `@${t.bot_username}` : 'your bot';
    console.log(`Telegram: ${!t.configured ? `not set up (${cliCmd(ctx.home, 'donna telegram --token ...')})` : t.paired ? `${bot} paired with ${t.chat_id_masked}${t.enabled ? '' : ' (off)'}` : `send the pairing code to ${bot}${t.pairing_code ? ' (shown on the cockpit\'s Donna page)' : ` (run ${cliCmd(ctx.home, 'donna telegram --pair')} for a code)`}`}${t.error ? ` [${t.error}]` : ''}`);
    const i = c.imessage;
    console.log(`iMessage: ${!i.supported ? 'macOS only' : i.enabled ? `on for ${i.handle}` : 'off'}${i.error ? ` [${i.error}]` : ''}`);
    console.log(`Donna's text-message session: ${c.donna.session || 'not started yet'}${c.donna.busy ? ' (working)' : ''}`);
    return;
  }
  throw new CliError('usage: clawdling donna telegram|imessage|status');
}

export function launchdPlist({ label, node, cli, home, port, logFile, envPath, socket, backend }) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const envEntries = {
    PATH: envPath,
    CLAWDLING_HOME: home,
    ...(socket && socket !== 'clawdling' ? { CLAWDLING_TMUX_SOCKET: socket } : {}),
    ...(backend ? { CLAWDLING_BACKEND: backend } : {}),
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(node)}</string>
    <string>${esc(cli)}</string>
    <string>start</string>
    <string>--home</string>
    <string>${esc(home)}</string>
    <string>--port</string>
    <string>${esc(port)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(envEntries).map(([k, v]) => `    <key>${esc(k)}</key><string>${esc(v)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${esc(logFile)}</string>
  <key>StandardErrorPath</key><string>${esc(logFile)}</string>
</dict>
</plist>
`;
}

export function systemdUnit({ node, cli, home, port, envPath, backend }) {
  return `[Unit]
Description=Clawdling cockpit
After=network.target

[Service]
ExecStart=${node} ${cli} start --home ${home} --port ${port}
Environment=PATH=${envPath}
Environment=CLAWDLING_HOME=${home}
${backend ? `Environment=CLAWDLING_BACKEND=${backend}\n` : ''}Restart=on-failure

[Install]
WantedBy=default.target
`;
}

/**
 * Windows: a launcher in the Startup folder (no admin rights, no scheduled task). It starts the
 * cockpit in its own minimized console window; closing that window stops the cockpit.
 */
export function windowsStartupScript({ node, cli, home, port, backend }) {
  const q = (v) => `"${String(v).replace(/"/g, '')}"`;
  return [
    '@echo off',
    'rem Starts the Clawdling cockpit when you sign in to Windows.',
    'rem Written by `clawdling service install`; `clawdling service uninstall` (or deleting this file) removes it.',
    ...(backend ? [`set "CLAWDLING_BACKEND=${backend}"`] : []),
    `start "Clawdling cockpit" /min ${q(node)} ${q(cli)} start --home ${q(home)} --port ${port}`,
    '',
  ].join('\r\n');
}

export function windowsStartupDir(env = process.env) {
  const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

async function cmdService(args) {
  const sub = args._[1];
  if (sub !== 'install' && sub !== 'uninstall') throw new CliError('usage: clawdling service install|uninstall [--dry-run]');
  const home = resolveHome(args.flags.home);
  const port = String(args.flags.port || DEFAULT_PORT);
  const node = stableNodePath();
  const cli = path.join(PKG_ROOT, 'bin', 'clawdling.js');
  const envPath = process.env.PATH || '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin';
  const backend = ['tmux', 'pty'].includes(process.env.CLAWDLING_BACKEND) ? process.env.CLAWDLING_BACKEND : null;
  if (process.platform === 'win32') {
    const file = path.join(windowsStartupDir(), 'Clawdling cockpit.cmd');
    if (sub === 'install') {
      const script = windowsStartupScript({ node, cli, home, port, backend });
      if (args.flags['dry-run']) return console.log(`# would write ${file}\n${script}`);
      if (!fs.existsSync(runtimePaths(home).orgJson)) throw new CliError(`No org at ${home}. Run \`${cliCmd(home, 'init')}\` first.`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, script);
      const running = context({ home }).info;
      if (!running) {
        const child = spawn(node, [cli, 'start', '--home', home, '--port', port], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...(backend ? { CLAWDLING_BACKEND: backend } : {}) } });
        child.unref();
      }
      console.log(`Installed ${file}. The cockpit starts when you sign in to Windows${running ? ' (it is already running now)' : ' and is starting now'} on port ${port}.`);
      console.log(`Open it with: ${cliCmd(home, 'open')}`);
    } else {
      if (args.flags['dry-run']) return console.log(`# would remove ${file}`);
      try {
        fs.unlinkSync(file);
      } catch {
        // not installed
      }
      console.log('Removed the login item. A cockpit that is running now keeps running until you stop it.');
    }
    return;
  }
  if (process.platform === 'darwin') {
    const label = 'com.clawdling.cockpit';
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    const uid = process.getuid();
    if (sub === 'install') {
      const plist = launchdPlist({ label, node, cli, home, port, logFile: path.join(runtimePaths(home).logs, 'launchd.log'), envPath, socket: process.env.CLAWDLING_TMUX_SOCKET, backend });
      if (args.flags['dry-run']) return console.log(`# would write ${plistPath}\n${plist}`);
      if (!fs.existsSync(runtimePaths(home).orgJson)) throw new CliError(`No org at ${home}. Run \`${cliCmd(home, 'init')}\` first.`);
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.mkdirSync(runtimePaths(home).logs, { recursive: true, mode: 0o700 });
      spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' });
      fs.writeFileSync(plistPath, plist);
      const r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { encoding: 'utf8' });
      if (r.status !== 0) throw new CliError(`launchctl bootstrap failed: ${(r.stderr || '').trim()}`);
      console.log(`Installed ${plistPath}. The cockpit starts at login and is starting now on port ${port}.`);
      console.log(`Open it with: ${cliCmd(home, 'open')}`);
    } else {
      if (args.flags['dry-run']) return console.log(`# would run launchctl bootout gui/${uid}/${label} and remove ${plistPath}`);
      spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' });
      try {
        fs.unlinkSync(plistPath);
      } catch {
        // not installed
      }
      console.log('Removed the login item. With tmux your sessions keep running until you end them.');
    }
    return;
  }
  const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', 'clawdling.service');
  if (sub === 'install') {
    console.log(`# Save this as ${unitPath}, then run:\n#   systemctl --user daemon-reload && systemctl --user enable --now clawdling\n`);
    console.log(systemdUnit({ node, cli, home, port, envPath, backend }));
  } else {
    console.log(`Run: systemctl --user disable --now clawdling && rm ${unitPath}`);
  }
}

export function versionAtLeast(v, major, minor, patch = 0) {
  const m = String(v || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return false;
  const got = [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
  const want = [major, minor, patch];
  for (let i = 0; i < 3; i++) if (got[i] !== want[i]) return got[i] > want[i];
  return true;
}

const OS_NAME = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

/** Run claude (resolving a Windows .cmd shim) with the given args; spawnSync result. */
function runClaude(bin, args, env, opts = {}) {
  const cmd = commandFor(bin, args, { env });
  return spawnSync(cmd.file, cmd.args, spawnOptions(cmd, { env, ...opts }));
}

// ------------------------------------------------------------------- Use from anywhere (1.3)

function printRemote(v, { stale = false } = {}) {
  const hosts = v.hosts || [];
  if (!hosts.length) {
    console.log('Use from anywhere: off. Nothing outside this computer can reach the cockpit.');
    if (v.invalid) console.log(v.invalid);
    if (v.port) console.log(`Clawdling itself listens on http://127.0.0.1:${v.port} only.`);
    console.log('To turn it on, open Settings in the cockpit, "Use from anywhere".');
    return;
  }
  console.log(`Use from anywhere: ${v.enabled ? 'on' : 'off'}${stale ? ' (Clawdling is not running, so nothing answers right now)' : ''}`);
  if (v.port) console.log(`Clawdling itself listens on http://127.0.0.1:${v.port} only; these addresses are the doors in:`);
  for (const h of hosts) {
    const when = h.checked_at ? `, checked ${rel(h.checked_at)}` : '';
    const answering = v.enabled && h.answering === false ? ' [not answering]' : '';
    const text = v.enabled ? h.status_text || statusText(h) : 'Turned off';
    console.log(`  ${pad(h.url, 46)}${pad(h.kind, 12)}${text}${answering}${when}`);
    if (h.detail && h.status !== 'private' && h.status !== 'access') console.log(`    ${h.detail}`);
  }
  const devices = v.devices || [];
  console.log(`Paired devices: ${devices.length}${devices.length ? ` (${devices.map((d) => d.label).join(', ')})` : ''}`);
}

/** What `remote list` shows when the server does not answer: the same fields as its API (never a
 * private path, a login, an email or Access pins). */
function offlineRemote(ctx) {
  const st = new RemoteStore(ctx.paths.remote).read();
  return {
    enabled: st.enabled,
    invalid: st.invalid,
    port: null,
    hosts: st.hosts.map((h) => ({ url: h.url, kind: h.kind, status: h.status, status_text: statusText(h), detail: h.detail, checked_at: h.checked_at, answering: null })),
    devices: new DeviceStore(ctx.paths.remoteDevices).list().map(({ id, label, kind, created_at, expires_at, last_seen_at }) => ({ id, label, kind, created_at, expires_at, last_seen_at })),
  };
}

/** Change remote.json and the devices file directly (no server answering). Both are re-read by a running server. */
function remoteOffline(ctx, { all = false, target = null, off = false }) {
  const store = new RemoteStore(ctx.paths.remote);
  const devices = new DeviceStore(ctx.paths.remoteDevices);
  if (target && !store.read().hosts.some((x) => x.url === target)) throw new CliError(`${target} is not a remote address of this Clawdling`);
  store.update((s) => {
    if (all) s.hosts = [];
    else if (target) s.hosts = s.hosts.filter((x) => x.url !== target);
    if (off || !s.hosts.length) s.enabled = false;
  });
  if (all || off || !store.read().hosts.length) devices.revokeAll();
  else devices.revokeHost(target);
}

async function cmdRemote(args) {
  const sub = args._[1] || 'list';
  const ctx = context(args.flags);
  // A live pid in server.json means a server owns this org, even if it is slow to answer: its
  // API is used (with the CLI's long timeout), never a quiet edit behind its back.
  const running = !!ctx.info;
  const needServer = () => {
    if (!running) throw new CliError(`Clawdling isn't running for ${ctx.home}. Start it first: ${cliCmd(ctx.home, 'start')}`);
  };
  const out = (v, extra) => {
    if (args.flags.json) return console.log(JSON.stringify(v, null, 2));
    if (extra) console.log(extra);
    printRemote(v);
  };
  if (sub === 'list' || sub === 'status') {
    let v = null;
    if (running) v = await api(ctx, 'GET', '/api/remote').catch(() => null);
    if (v) return out(v);
    v = offlineRemote(ctx);
    if (args.flags.json) return console.log(JSON.stringify(v, null, 2));
    return printRemote(v, { stale: true });
  }
  if (sub === 'check') {
    needServer();
    const v = await api(ctx, 'POST', '/api/remote/check');
    out(v);
    if (v.hosts.some((x) => !x.answering)) process.exitCode = 1;
    return;
  }
  if (sub === 'add') {
    const url = args._[2];
    if (!url) throw new CliError(REMOTE_HELP);
    const kind = args.flags.kind;
    if (kind !== 'tailscale' && kind !== 'cloudflare') throw new CliError('add needs --kind tailscale or --kind cloudflare');
    try {
      parseRemoteUrl(url, kind);
    } catch (err) {
      throw new CliError(err.message);
    }
    needServer();
    const body = { url, kind };
    if (args.flags['team-domain'] !== undefined) body.team_domain = String(args.flags['team-domain']);
    if (args.flags['access-aud'] !== undefined) body.access_aud = String(args.flags['access-aud']);
    if (args.flags.email !== undefined) body.email = String(args.flags.email);
    let v;
    try {
      v = await api(ctx, 'POST', '/api/remote/hosts', body);
    } catch (err) {
      if (err.data && err.data.next) err.message += `\nPoint Tailscale at this cockpit first:\n  ${err.data.next}`;
      throw err;
    }
    return out(v, `Added ${v.added}. Use from anywhere is on.\nNext: on your computer, open Settings, "Use from anywhere", and press "Add a device" to pair your phone.`);
  }
  // The Tailscale serve step, run here so the private path (an HMAC under the org's token) never
  // shows up in a terminal or an agent's transcript: all output is printed with it hidden.
  // This computer's own Tailscale address, and nothing about anyone else on the tailnet: plain
  // `tailscale status` lists every member's devices and logins, and a signed-out one prints a
  // sign-in link. This prints neither.
  if (sub === 'tailscale-name') {
    const bin = tailscaleBin({ env: process.env, which: (c) => which(c, process.env.PATH || '') });
    if (!bin) throw new CliError('Tailscale is not installed here (or its command was not found). Install it from https://tailscale.com/download and sign in, then try again.');
    const c = commandFor(bin, ['status', '--json'], { env: process.env });
    const r = spawnSync(c.file, c.args, spawnOptions(c, { encoding: 'utf8', timeout: 15000 }));
    let j = null;
    try {
      j = JSON.parse(String(r.stdout || ''));
    } catch {
      // below
    }
    if (!j) throw new CliError('Tailscale did not answer. Is the Tailscale app running?');
    const state = String(j.BackendState || 'unknown');
    const name = j.Self && typeof j.Self.DNSName === 'string' ? j.Self.DNSName.replace(/\.$/, '') : '';
    if (state !== 'Running' || !name) {
      console.log(`Tailscale is not connected on this computer (${state}). Sign in from the Tailscale app, then run this again.`);
      process.exitCode = 1;
      return;
    }
    console.log(`Tailscale is connected. This computer's address: https://${name}`);
    return;
  }
  if (sub === 'serve' || sub === 'serve-status') {
    const bin = tailscaleBin({ env: process.env, which: (c) => which(c, process.env.PATH || '') });
    if (!bin) throw new CliError('Tailscale is not installed here (or its command was not found). Install it from https://tailscale.com/download and sign in, then try again.');
    let tsArgs = ['serve', 'status'];
    let entry = null;
    if (sub === 'serve') {
      if (!args._[2]) throw new CliError('usage: clawdling remote serve <https-url>');
      try {
        entry = parseRemoteUrl(args._[2], 'tailscale');
      } catch (err) {
        throw new CliError(err.message);
      }
      if (!ctx.info || !ctx.token) throw new CliError(`Clawdling isn't running for ${ctx.home}. Start it first: ${cliCmd(ctx.home, 'start')}`);
      tsArgs = serveArgs({ entry, port: ctx.info.port, token: ctx.token });
      // Never change an entry this cockpit did not make: the address's port must be free, or
      // already pointing at exactly this cockpit.
      const st = spawnSync(...(() => {
        const c = commandFor(bin, ['serve', 'status', '--json'], { env: process.env });
        return [c.file, c.args, spawnOptions(c, { encoding: 'utf8', timeout: 15000 })];
      })());
      let config = null;
      try {
        config = JSON.parse(String(st.stdout || '').trim() || '{}');
      } catch {
        // unreadable: refuse below
      }
      if (st.status !== 0 || !config) throw new CliError(`could not read Tailscale's serve status (${redactServePaths(String(st.stderr || st.error?.message || '').trim()).slice(0, 200) || 'no answer'}). Is Tailscale running and signed in?`);
      // `serve --https=PORT` always lands on this computer's own name: look at every name's entry on
      // that port, not just the one typed.
      const names = new Set([`${entry.host}:${entry.port}`]);
      const walk = (o, d) => {
        if (!o || typeof o !== 'object' || d > 6) return;
        if (o.Web && typeof o.Web === 'object') for (const k of Object.keys(o.Web)) if (k.endsWith(`:${entry.port}`)) names.add(k);
        for (const v of Object.values(o)) walk(v, d + 1);
      };
      walk(config, 0);
      const handlers = [...names].flatMap((n) => webHandlers(config, n));
      const tcp = config.TCP && config.TCP[String(entry.port)];
      const mine = onlyCockpit(handlers, { port: ctx.info.port, path: tsArgs[3].slice(`http://127.0.0.1:${ctx.info.port}`.length) });
      if ((handlers.length && !mine) || (tcp && (tcp.TCPForward || tcp.TerminateTLS))) {
        throw new CliError(`port ${entry.port} on ${entry.host} already serves something else. Clawdling will not change it: pick a port no serve entry uses.`);
      }
    }
    const cmd = commandFor(bin, tsArgs, { env: process.env });
    const r = spawnSync(cmd.file, cmd.args, spawnOptions(cmd, { encoding: 'utf8', timeout: 30000 }));
    const text = redactServePaths(`${r.stdout || ''}${r.stderr || ''}`).trim();
    if (text) console.log(text);
    if (r.error || r.status !== 0) {
      if (r.error) console.error(`clawdling: could not run Tailscale (${redactServePaths(r.error.message)})`);
      process.exitCode = r.status || 1;
      return;
    }
    if (entry) console.log(`\nTailscale now sends ${entry.url} to this cockpit, on a private path that is not shown. Next: ${cliCmd(ctx.home, `remote add ${entry.url} --kind tailscale`)}`);
    return;
  }
  if (sub === 'remove' || sub === 'off') {
    const all = sub === 'remove' && args.flags.all === true;
    const url = args._[2];
    if (sub === 'remove' && !all && !url) throw new CliError(REMOTE_HELP);
    let target = null;
    if (sub === 'remove' && !all) {
      try {
        target = parseRemoteUrl(url).url;
      } catch (err) {
        throw new CliError(err.message);
      }
    }
    const done = sub === 'off' ? 'Use from anywhere is off. Every paired device is signed out.'
      : all ? 'Removed every remote address. Use from anywhere is off.' : `Removed ${target}.`;
    if (running) {
      try {
        const v = sub === 'off' ? await api(ctx, 'POST', '/api/remote/enabled', { enabled: false })
          : await api(ctx, 'POST', '/api/remote/remove', all ? { all: true } : { url: target });
        return out(v, done);
      } catch (err) {
        // A 4xx is the server's answer (an unknown address): say it. A server that did not answer
        // at all still gets the change, on disk, which it re-reads within seconds.
        if (!/isn't running|nothing answered/.test(err.message)) throw err;
        console.error(`clawdling: the cockpit (pid ${ctx.info.pid}) did not answer, so the change is written to disk; it applies within a few seconds.`);
      }
    }
    remoteOffline(ctx, { all, target, off: sub === 'off' });
    console.log(done);
    return printRemote(offlineRemote(ctx), { stale: !running });
  }
  throw new CliError(REMOTE_HELP);
}

/** {ok: true|false|null, detail}: the newest session's transcript, parsed the way the report card does. */
export function transcriptFormat(paths) {
  const list = (readJson(paths.sessions, null)?.sessions || []).filter((r) => r && r.purpose !== 'signin' && typeof r.transcript_path === 'string' && /\.jsonl$/.test(r.transcript_path));
  list.sort((a, b) => String(b.last_activity_at || b.created_at || '').localeCompare(String(a.last_activity_at || a.created_at || '')));
  const rec = list.find((r) => fs.existsSync(r.transcript_path));
  if (!rec) return { ok: null, detail: 'no session transcript to check yet' };
  try {
    const s = summarize(new LedgerReader().session(rec.transcript_path));
    if (s.format.ok) return { ok: true, detail: `${s.turns} turn${s.turns === 1 ? '' : 's'}, ${s.tools} tool call${s.tools === 1 ? '' : 's'} in the newest session` };
    return { ok: false, detail: s.format.issues.join('; ') };
  } catch (err) {
    return { ok: false, detail: `could not read it (${err.message})` };
  }
}

/** A transcript for the contract: its record types, format, and whether it carries a cost. */
function liveTranscriptFacts(file) {
  const types = new Set();
  let usage = false;
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try {
      const o = JSON.parse(l);
      if (o && typeof o.type === 'string') types.add(o.type);
      if (o && o.type === 'assistant' && o.message && o.message.usage && typeof o.message.usage === 'object') usage = true;
    } catch {
      // a torn line
    }
  }
  const s = summarize(new LedgerReader().session(file));
  return { types: [...types].sort(), format: s.format, costState: types.has('cost-state'), usage };
}

const CONTRACT_WORD = { ok: 'ok  ', note: 'note', fail: 'FIX ', unchecked: 'n/a ' };

// `clawdling doctor --contract [--live] [--json]`: the update guard (1.8).
async function cmdContract(ctx, flags) {
  const { contractChecks, liveCheck, summary, COMPAT, LIVE_COST, LIVE_PROMPT } = await import('../server/contract.js');
  const { supportsStopFailure } = await import('../server/hooks.js');
  const env = childEnv();
  const name = process.env.CLAWDLING_CLAUDE_BIN || 'claude';
  const bin = which(name, env.PATH || '') || name;
  const run = (a, o = {}) => runClaudeOut(bin, a, { cwd: o.cwd, env: { ...env, ...(o.env || {}) }, timeout: o.timeout });
  let lines = await contractChecks({ run, transcript: transcriptFormat(ctx.paths) });
  if (flags.live && lines.length === 1 && lines[0].status === 'fail') {
    console.log(`  FIX   ${lines[0].text}`);
    throw new CliError('--live needs a claude that runs: nothing was started');
  }
  if (flags.live) {
    if (!flags.yes && !flags.json) {
      if (!process.stdin.isTTY) throw new CliError(`--live runs one real session (${LIVE_COST}): add --yes to run it without asking`);
      const yes = await askYesNo(`--live runs one real Claude Code session ("${LIVE_PROMPT}", model haiku) in a temporary folder: ${LIVE_COST}. Run it? [y/N] `);
      if (!yes) throw new CliError('stopped: nothing was run');
    } else if (flags.json && !flags.yes) throw new CliError(`--live runs one real session (${LIVE_COST}): add --yes`);
    const ver = (await run(['--version'])).stdout;
    lines = lines.concat(await liveCheck({ run, configDir: claudeConfigDirOf(env), parse: liveTranscriptFacts, supportsStopFailure: supportsStopFailure(ver), bin, env, interruptible: true }));
  }
  const sum = summary(lines);
  if (flags.json) {
    console.log(JSON.stringify({ ok: sum.ok, version: ((await run(['--version'])).stdout || '').trim().split('\n')[0] || null, compat: { min: COMPAT.min, maxChecked: COMPAT.maxChecked }, lines, summary: sum }, null, 2));
  } else {
    console.log(`clawdling ${VERSION} doctor --contract: this Claude Code against what Clawdling relies on (checked ${COMPAT.min} to ${COMPAT.maxChecked})\n`);
    for (const l of lines) console.log(`  ${CONTRACT_WORD[l.status] || l.status}  ${l.text}`);
    console.log(sum.fail ? `\n${sum.fail} thing(s) to fix.` : sum.unchecked ? `\nNo problem found; ${sum.unchecked} line(s) could not be checked offline${flags.live ? '' : ' (`--live` checks them)'}.` : '\nAll good.');
  }
  process.exitCode = sum.ok ? 0 : 1;
}

function claudeConfigDirOf(env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** `{code, stdout, stderr}` of a claude run (never throws), through the Windows .cmd shim rules. */
function runClaudeOut(bin, args, opts) {
  return import('../server/contract.js').then((m) => m.runClaude(bin, args, opts));
}

function askYesNo(q) {
  return new Promise((resolve) => {
    process.stdout.write(q);
    process.stdin.setEncoding('utf8');
    const done = (yes) => {
      process.stdin.pause();
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      resolve(yes);
    };
    process.stdin.once('data', (d) => done(/^y(es)?$/i.test(String(d).trim())));
    process.stdin.once('end', () => done(false)); // Ctrl-D: no
    process.stdin.resume();
  });
}

async function cmdDoctor(args) {
  const ctx = context(args.flags);
  if (args.flags.contract) return cmdContract(ctx, args.flags);
  let bad = 0;
  const ok = (m) => console.log(`  ok    ${m}`);
  const warn = (m) => console.log(`  note  ${m}`);
  const fail = (m) => {
    bad++;
    console.log(`  FIX   ${m}`);
  };
  const platform = process.platform;
  const env = childEnv();
  const pm = packageManager({ platform, has: (b) => !!which(b, env.PATH || '') });
  console.log(`clawdling ${VERSION} doctor (${OS_NAME[platform] || platform} ${process.arch})\n`);

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor >= 20) ok(`node ${process.version}`);
  else fail(`node ${process.version} is too old: install Node 20 or newer: ${installCommand('node', pm) || 'https://nodejs.org'}`);

  // Sessions: tmux when it is there (they survive restarts), else the built-in terminal (node-pty).
  const b = selectBackend({ env: process.env, childEnv: env, platform });
  const forced = process.env.CLAWDLING_BACKEND ? ` (CLAWDLING_BACKEND=${process.env.CLAWDLING_BACKEND})` : '';
  if (b.error) fail(`${b.error}: ${b.fix}`);
  else if (b.kind === 'tmux') ok(`sessions: ${b.tmux.version}: they keep running when the cockpit stops${forced}`);
  else {
    ok(`sessions: built-in terminal (node-pty ${b.pty.version}): they end when the cockpit stops and resume from where they left off${forced}`);
    if (platform !== 'win32') {
      const tmuxFix = b.fixes.tmux;
      if (b.tmux.found && !b.tmux.ok) warn(`${b.tmux.version} is older than 3.2; with tmux 3.2+ sessions keep running across cockpit restarts: ${tmuxFix}`);
      else if (!b.tmux.ok) warn(`tmux is optional (recommended: sessions keep running across cockpit restarts): ${tmuxFix}`);
    }
  }

  if (platform === 'win32') {
    const bash = findGitBash({ env });
    if (bash) ok(`Git for Windows: ${bash} (agents use the Bash tool)`);
    else warn('Git for Windows not found (recommended, so agents get the Bash tool; without it Claude Code uses PowerShell): winget install --id Git.Git -e');
  }

  const claudeName = process.env.CLAWDLING_CLAUDE_BIN || 'claude';
  const claudeBin = which(claudeName);
  if (!claudeBin) fail(`claude CLI not found: install Claude Code: ${claudeInstallCommand(platform, pm)}, then run \`claude\` once to sign in`);
  else {
    const r = runClaude(claudeBin, ['--version'], env, { encoding: 'utf8', timeout: 15000 });
    const v = (r.stdout || '').trim().split('\n')[0];
    // Windows hooks use exec form (command + args), which Claude Code supports from 2.1.139.
    const [min, minLabel] = platform === 'win32' ? [[2, 1, 139], '2.1.139'] : [[2, 1, 0], '2.1'];
    if (r.status === 0 && versionAtLeast(v, ...min)) ok(`claude ${v}`);
    else if (r.status === 0) (platform === 'win32' ? fail : warn)(`claude ${v}: Clawdling needs ${minLabel} or newer${platform === 'win32' ? ' on Windows (hooks): claude update' : ''}`);
    else fail(`\`claude --version\` failed: reinstall Claude Code: ${claudeInstallCommand(platform, pm)}`);
    // Ask the CLI itself; Clawdling never reads credential files. Output is discarded.
    const a = runClaude(claudeBin, ['auth', 'status'], env, { stdio: 'ignore', timeout: 20000 });
    if (a.status === 0) ok('claude reports it is signed in');
    else warn('could not confirm claude is signed in: run `claude auth login` (or click Sign in on a session in the cockpit)');
  }

  if (fs.existsSync(ctx.paths.orgJson)) {
    let n = 0;
    try {
      n = new OrgStore(ctx.paths).agents().length;
    } catch {
      // counted below
    }
    ok(`org at ${ctx.home} (${n} agents)`);
  } else fail(`no org at ${ctx.home}: run \`${cliCmd(ctx.home, 'init')}\` (or set CLAWDLING_HOME)`);

  // The report card reads Claude Code's transcripts, whose format is undocumented: say when the
  // newest one is in a shape this version has not seen, never report a silent zero.
  const tf = transcriptFormat(ctx.paths);
  if (tf.ok === true) ok(`transcript format: ok (${tf.detail})`);
  else if (tf.ok === false) warn(`transcript format: this Claude Code version writes a format Clawdling has not seen (report card may be incomplete): ${tf.detail}`);
  else warn(`transcript format: ${tf.detail}`);

  const h = await serverUp(ctx);
  if (h && h.home === ctx.home) {
    const sessions = h.backend ? `, sessions: ${h.backend.kind}` : '';
    ok(`cockpit running at ${baseUrl(ctx)}${ctx.info ? ` (pid ${ctx.info.pid}${sessions})` : ''}`);
    try {
      const c = await api(ctx, 'GET', '/api/channels');
      const t = c.telegram;
      const bot = t.bot_username ? `@${t.bot_username}` : 'your bot';
      if (t.configured && t.paired) ok(`Telegram: ${bot} is paired with chat ${t.chat_id_masked}${t.enabled ? '' : ' (turned off)'}${t.error ? ` [${t.error}]` : ''}`);
      // Never the code itself: agents may run doctor, and whoever sends the code first is paired.
      else if (t.configured) warn(`Telegram: open ${bot} in Telegram and send the pairing code ${t.pairing_code ? 'shown on the cockpit\'s Donna page' : `from \`${cliCmd(ctx.home, 'donna telegram --pair')}\``}${t.error ? ` [${t.error}]` : ''}`);
      else warn(`Telegram: not set up (optional): ${cliCmd(ctx.home, 'donna telegram --token <token from @BotFather>')}`);
      if (c.imessage.enabled) (c.imessage.error ? fail : ok)(`iMessage: ${c.imessage.error || `on for ${c.imessage.handle}`}`);
    } catch {
      // ignore
    }
  } else if (h) {
    fail(`port ${ctx.port} answers for a different org (${h.home}): start this org's cockpit on another port with ${cliCmd(ctx.home, 'start --port <n>')}`);
  } else if (ctx.info) {
    fail(`the cockpit (pid ${ctx.info.pid}) should be on port ${ctx.info.port} but does not answer: stop it and run ${cliCmd(ctx.home, 'start')}`);
  } else {
    fail(`the cockpit is not running: ${cliCmd(ctx.home, 'start')} (or ${cliCmd(ctx.home, 'service install')} to start it at login)`);
  }
  console.log(bad ? `\n${bad} thing(s) to fix.` : '\nAll good.');
  process.exitCode = bad ? 1 : 0;
}

// ------------------------------------------------------------------------------------- main

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (args.flags.version) return console.log(VERSION);
  if (!cmd || args.flags.help || cmd === 'help') return console.log(HELP);
  if (process.env.CLAWDLING_DONNA === '1' && DONNA_FORBIDDEN.has(cmd)) {
    throw new CliError(`\`clawdling ${cmd}\` is not available to Donna's text-message turns. Ask the owner to run it.`);
  }
  const table = {
    doctor: cmdDoctor,
    init: cmdInit,
    start: cmdStart,
    stop: cmdStop,
    open: cmdOpen,
    new: cmdNew,
    discover: cmdDiscover,
    import: cmdImport,
    ls: cmdLs,
    report: cmdReport,
    check: cmdCheck,
    checkup: cmdCheckup,
    spawn: cmdSpawn,
    send: cmdSend,
    attach: cmdAttach,
    end: cmdEnd,
    resume: cmdResume,
    donna: cmdDonna,
    remote: cmdRemote,
    service: cmdService,
  };
  const fn = table[cmd];
  if (!fn) throw new CliError(`unknown command "${cmd}". Run \`clawdling help\`.`);
  return fn(args);
}

const invokedDirectly = (() => {
  try {
    // fileURLToPath, not URL.pathname: on Windows the pathname is /C:/... and never matches.
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    if (err instanceof CliError) console.error(`clawdling: ${err.message}`);
    else console.error(`clawdling: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}

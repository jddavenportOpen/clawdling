#!/usr/bin/env node
// clawdling: the command line for a Clawdling org. Most commands talk to the running server over
// HTTP with the org's token, so agents (and Donna) can use them from inside Claude Code.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readToken, loadOrCreateToken } from '../server/auth.js';
import { OrgStore, defaultAnswers, initOrg } from '../server/org.js';
import { DEFAULT_PORT, PKG_ROOT, VERSION, childEnv, resolveHome, runtimePaths, stableNodePath, tmuxSocketName, which } from '../server/paths.js';
import { readJson, shq } from '../server/util.js';

class CliError extends Error {}

const HELP = `clawdling ${VERSION}: an org of Claude Code agents, with a cockpit and a chief of staff.

Usage:
  clawdling doctor                          check node, tmux, claude, the org and the server
  clawdling init [--answers FILE | --defaults] [--force]
                                            create the org (default home ~/clawdling)
  clawdling start [--port 4747] [--host 127.0.0.1] [--open]
                                            run the cockpit server in the foreground
  clawdling open [--print]                  open the cockpit in your browser (with the token)
  clawdling new domain "<Name>" --mission "..."
  clawdling new project "<Name>" --goal "..." [--repo PATH] [--domain ID]
  clawdling ls [--all] [--json]             list sessions
  clawdling spawn <agent> ["first message"] [--model M] [--title T] [--cols N --rows N] [--json]
  clawdling send <sid> "text" [--no-enter]  type into a live session
  clawdling attach <sid|tmux-name>          attach this terminal to a session (detach: Ctrl-b d)
  clawdling end <sid>                       end a session (it stays resumable)
  clawdling resume <sid>                    resume an ended session
  clawdling donna telegram --token <T>      connect Donna to a Telegram bot, print a pairing code
  clawdling donna imessage --handle <you>   let Donna answer your iMessages (macOS, experimental)
  clawdling donna status
  clawdling service install|uninstall [--dry-run]
                                            start the cockpit at login (launchd / systemd)

Global: --home PATH (or CLAWDLING_HOME). Session ids can be shortened to their first 8 characters.
`;

// ------------------------------------------------------------------------------------- args

const BOOLEAN_FLAGS = new Set(['defaults', 'force', 'open', 'all', 'json', 'no-enter', 'print', 'dry-run', 'disable', 'pair', 'help', 'version']);

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
  if (!ctx.token) throw new CliError(`No org token at ${ctx.paths.token}. Run \`clawdling init\` first.`);
  let res;
  try {
    res = await fetch(baseUrl(ctx) + p, {
      method,
      headers: { 'x-clawdling-token': ctx.token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    throw new CliError(`Clawdling isn't running for ${ctx.home} (nothing answered on port ${ctx.port}). Start it with: clawdling start`);
  }
  if (res.status === 204) return null;
  let data = {};
  try {
    data = await res.json();
  } catch {
    // empty
  }
  if (!res.ok) throw new CliError(data.error || `HTTP ${res.status}`);
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
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => console.log(`Open this link: ${url}`));
    child.unref();
  } catch {
    console.log(`Open this link: ${url}`);
  }
}

const DONNA_FORBIDDEN = new Set(['init', 'start', 'service', 'donna', 'attach', 'open']);

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
  console.log('\nNext:');
  console.log(`  clawdling start --open${args.flags.home ? ` --home ${shq(home)}` : ''}`);
  if (res.channel === 'telegram') console.log('  clawdling donna telegram --token <token from @BotFather>');
  if (res.channel === 'imessage') console.log('  clawdling donna imessage --handle <the phone number or email you text from>');
}

async function cmdStart(args) {
  const { startServer } = await import('../server/index.js');
  const home = resolveHome(args.flags.home);
  const port = args.flags.port !== undefined ? Number(args.flags.port) : Number(process.env.CLAWDLING_PORT) || DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CliError('--port must be a number');
  const host = args.flags.host || '127.0.0.1';
  let srv;
  try {
    srv = await startServer({ home, port, host });
  } catch (e) {
    // Nothing was started or written (the server refuses before touching state): exit now.
    console.error(`clawdling: ${e.message}`);
    process.exit(1);
  }
  console.log(`\nClawdling ${VERSION}: cockpit for ${srv.org.read().owner}'s org`);
  console.log(`  Open:  ${srv.openUrl}`);
  console.log(`  Org:   ${home}`);
  console.log(`  tmux:  tmux -L ${srv.socket} ls`);
  console.log('Ctrl-C stops the cockpit. Your sessions keep running in tmux.\n');
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
    console.error(`\n${sig}: stopping the cockpit (sessions keep running)`);
    const force = setTimeout(() => process.exit(0), 5000);
    force.unref();
    await srv.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGHUP', () => stop('SIGHUP'));
}

async function cmdOpen(args) {
  const ctx = context(args.flags);
  if (!ctx.token) throw new CliError('No org here. Run `clawdling init` first.');
  const url = `${baseUrl(ctx)}/?t=${ctx.token}`;
  if (!ctx.info) console.error('Note: the cockpit does not look like it is running (clawdling start).');
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
  if (await serverUp(ctx)) agent = await api(ctx, 'POST', '/api/agents', body);
  else {
    try {
      agent = new OrgStore(ctx.paths).createAgent(body);
    } catch (e) {
      throw new CliError(e.message);
    }
  }
  if (args.flags.json) return console.log(JSON.stringify(agent, null, 2));
  console.log(`Created ${kind} agent "${agent.name}" (id ${agent.id}) at ${agent.dir}`);
  console.log(`Start it: clawdling spawn ${agent.id} "<first task>"`);
}

async function cmdLs(args) {
  const ctx = context(args.flags);
  let list;
  let stale = false;
  try {
    list = await api(ctx, 'GET', '/api/sessions');
  } catch (e) {
    const data = readJson(ctx.paths.sessions, null);
    if (!data) throw e;
    list = data.sessions || [];
    stale = true;
  }
  if (!args.flags.all) list = list.filter((s) => s.status !== 'ended');
  if (args.flags.json) return console.log(JSON.stringify(list, null, 2));
  if (stale) console.error('(the cockpit is not running: showing the last saved state)');
  if (!list.length) return console.log(args.flags.all ? 'No sessions yet.' : 'No live sessions. `clawdling ls --all` shows ended ones.');
  console.log(`${pad('SID', 10)}${pad('AGENT', 14)}${pad('STATUS', 11)}${pad('TITLE', 40)}ACTIVE`);
  for (const s of list) {
    console.log(`${pad(s.sid.slice(0, 8), 10)}${pad(s.agent, 14)}${pad(s.status, 11)}${pad(s.title || 'new session', 40)}${rel(s.last_activity_at)}`);
  }
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
  const s = await api(ctx, 'POST', '/api/sessions', { agent, prompt, model: args.flags.model, title: args.flags.title, ...size });
  if (args.flags.json) return console.log(JSON.stringify(s, null, 2));
  console.log(`Started ${s.agent} session ${s.sid} (${s.title || 'new session'})`);
  console.log(`Watch it in the cockpit, or in a terminal: clawdling attach ${s.sid.slice(0, 8)}`);
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
  console.log(`Ended ${s.agent} session ${s.sid.slice(0, 8)} (resume it with: clawdling resume ${s.sid.slice(0, 8)}).`);
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
    if (args.flags.disable) return console.log('Telegram is off. Re-enable with: clawdling donna telegram --pair');
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
    if (args.flags.json) return console.log(JSON.stringify(c, null, 2));
    const t = c.telegram;
    const bot = t.bot_username ? `@${t.bot_username}` : 'your bot';
    console.log(`Telegram: ${!t.configured ? 'not set up (clawdling donna telegram --token ...)' : t.paired ? `${bot} paired with ${t.chat_id_masked}${t.enabled ? '' : ' (off)'}` : `send /pair ${t.pairing_code || '<code>'} to ${bot}${t.pairing_code ? '' : ' (run clawdling donna telegram --pair for a code)'}`}${t.error ? ` [${t.error}]` : ''}`);
    const i = c.imessage;
    console.log(`iMessage: ${!i.supported ? 'macOS only' : i.enabled ? `on for ${i.handle}` : 'off'}${i.error ? ` [${i.error}]` : ''}`);
    console.log(`Donna's text-message session: ${c.donna.session || 'not started yet'}${c.donna.busy ? ' (working)' : ''}`);
    return;
  }
  throw new CliError('usage: clawdling donna telegram|imessage|status');
}

export function launchdPlist({ label, node, cli, home, port, logFile, envPath, socket }) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const envEntries = { PATH: envPath, CLAWDLING_HOME: home, ...(socket && socket !== 'clawdling' ? { CLAWDLING_TMUX_SOCKET: socket } : {}) };
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

export function systemdUnit({ node, cli, home, port, envPath }) {
  return `[Unit]
Description=Clawdling cockpit
After=network.target

[Service]
ExecStart=${node} ${cli} start --home ${home} --port ${port}
Environment=PATH=${envPath}
Environment=CLAWDLING_HOME=${home}
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

async function cmdService(args) {
  const sub = args._[1];
  if (sub !== 'install' && sub !== 'uninstall') throw new CliError('usage: clawdling service install|uninstall [--dry-run]');
  const home = resolveHome(args.flags.home);
  const port = String(args.flags.port || DEFAULT_PORT);
  const node = stableNodePath();
  const cli = path.join(PKG_ROOT, 'bin', 'clawdling.js');
  const envPath = process.env.PATH || '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin';
  if (process.platform === 'darwin') {
    const label = 'com.clawdling.cockpit';
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    const uid = process.getuid();
    if (sub === 'install') {
      const plist = launchdPlist({ label, node, cli, home, port, logFile: path.join(runtimePaths(home).logs, 'launchd.log'), envPath, socket: process.env.CLAWDLING_TMUX_SOCKET });
      if (args.flags['dry-run']) return console.log(`# would write ${plistPath}\n${plist}`);
      if (!fs.existsSync(runtimePaths(home).orgJson)) throw new CliError(`No org at ${home}. Run \`clawdling init\` first.`);
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.mkdirSync(runtimePaths(home).logs, { recursive: true, mode: 0o700 });
      spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' });
      fs.writeFileSync(plistPath, plist);
      const r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { encoding: 'utf8' });
      if (r.status !== 0) throw new CliError(`launchctl bootstrap failed: ${(r.stderr || '').trim()}`);
      console.log(`Installed ${plistPath}. The cockpit starts at login and is starting now on port ${port}.`);
      console.log('Open it with: clawdling open');
    } else {
      if (args.flags['dry-run']) return console.log(`# would run launchctl bootout gui/${uid}/${label} and remove ${plistPath}`);
      spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' });
      try {
        fs.unlinkSync(plistPath);
      } catch {
        // not installed
      }
      console.log('Removed the login item. Your sessions keep running in tmux until you end them.');
    }
    return;
  }
  const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', 'clawdling.service');
  if (sub === 'install') {
    console.log(`# Save this as ${unitPath}, then run:\n#   systemctl --user daemon-reload && systemctl --user enable --now clawdling\n`);
    console.log(systemdUnit({ node, cli, home, port, envPath }));
  } else {
    console.log(`Run: systemctl --user disable --now clawdling && rm ${unitPath}`);
  }
}

function versionAtLeast(v, major, minor) {
  const m = String(v || '').match(/(\d+)\.(\d+)/);
  if (!m) return false;
  return Number(m[1]) > major || (Number(m[1]) === major && Number(m[2]) >= minor);
}

async function cmdDoctor(args) {
  const ctx = context(args.flags);
  let bad = 0;
  const ok = (m) => console.log(`  ok    ${m}`);
  const warn = (m) => console.log(`  note  ${m}`);
  const fail = (m) => {
    bad++;
    console.log(`  FIX   ${m}`);
  };
  console.log(`clawdling ${VERSION} doctor\n`);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor >= 20) ok(`node ${process.version}`);
  else fail(`node ${process.version} is too old: install Node 20 or newer (brew install node)`);

  const env = childEnv();
  const tmuxBin = which(process.env.CLAWDLING_TMUX_BIN || 'tmux');
  if (!tmuxBin) fail('tmux not found: brew install tmux (macOS) or apt install tmux (Linux)');
  else {
    const r = spawnSync(tmuxBin, ['-V'], { encoding: 'utf8', env });
    const v = (r.stdout || '').trim();
    if (versionAtLeast(v.replace(/^tmux\s+/, ''), 3, 2)) ok(v);
    else fail(`${v || 'tmux'} is too old: Clawdling needs tmux 3.2 or newer`);
  }

  const claudeName = process.env.CLAWDLING_CLAUDE_BIN || 'claude';
  const claudeBin = which(claudeName);
  if (!claudeBin) fail('claude CLI not found: install Claude Code, then run `claude` once to sign in');
  else {
    const r = spawnSync(claudeBin, ['--version'], { encoding: 'utf8', env, timeout: 15000 });
    const v = (r.stdout || '').trim().split('\n')[0];
    if (r.status === 0 && versionAtLeast(v, 2, 1)) ok(`claude ${v}`);
    else if (r.status === 0) warn(`claude ${v}: Clawdling is tested with 2.1 or newer`);
    else fail('`claude --version` failed: reinstall Claude Code');
    // Ask the CLI itself; Clawdling never reads credential files. Output is discarded.
    const a = spawnSync(claudeBin, ['auth', 'status'], { stdio: 'ignore', env, timeout: 20000 });
    if (a.status === 0) ok('claude reports it is signed in');
    else warn('could not confirm claude is signed in: run `claude` once and log in if sessions fail to start');
  }

  if (fs.existsSync(ctx.paths.orgJson)) {
    let n = 0;
    try {
      n = new OrgStore(ctx.paths).agents().length;
    } catch {
      // counted below
    }
    ok(`org at ${ctx.home} (${n} agents)`);
  } else fail(`no org at ${ctx.home}: run \`clawdling init\` (or set CLAWDLING_HOME)`);

  const h = await serverUp(ctx);
  if (h && h.home === ctx.home) {
    ok(`cockpit running at ${baseUrl(ctx)}${ctx.info ? ` (pid ${ctx.info.pid})` : ''}`);
    try {
      const c = await api(ctx, 'GET', '/api/channels');
      const t = c.telegram;
      const bot = t.bot_username ? `@${t.bot_username}` : 'your bot';
      if (t.configured && t.paired) ok(`Telegram: ${bot} is paired with chat ${t.chat_id_masked}${t.enabled ? '' : ' (turned off)'}${t.error ? ` [${t.error}]` : ''}`);
      else if (t.configured) warn(`Telegram: open ${bot} in Telegram and send ${t.pairing_code ? `/pair ${t.pairing_code}` : 'the code from `clawdling donna telegram --pair`'}${t.error ? ` [${t.error}]` : ''}`);
      else warn('Telegram: not set up (optional): clawdling donna telegram --token <token from @BotFather>');
      if (c.imessage.enabled) (c.imessage.error ? fail : ok)(`iMessage: ${c.imessage.error || `on for ${c.imessage.handle}`}`);
    } catch {
      // ignore
    }
  } else if (h) {
    fail(`port ${ctx.port} answers for a different org (${h.home}): start this org's cockpit on another port with clawdling start --port <n>`);
  } else if (ctx.info) {
    fail(`the cockpit (pid ${ctx.info.pid}) should be on port ${ctx.info.port} but does not answer: stop it and run clawdling start`);
  } else {
    fail('the cockpit is not running: clawdling start (or clawdling service install to start it at login)');
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
    open: cmdOpen,
    new: cmdNew,
    ls: cmdLs,
    spawn: cmdSpawn,
    send: cmdSend,
    attach: cmdAttach,
    end: cmdEnd,
    resume: cmdResume,
    donna: cmdDonna,
    service: cmdService,
  };
  const fn = table[cmd];
  if (!fn) throw new CliError(`unknown command "${cmd}". Run \`clawdling help\`.`);
  return fn(args);
}

const invokedDirectly = (() => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
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

// The Clawdling server: HTTP API + static cockpit + terminal WebSockets + SSE, all on 127.0.0.1.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { WebSocketServer } from 'ws';
import {
  COOKIE_NAME,
  TOKEN_HEADER,
  allowedHosts,
  cookieHeader,
  cookieValues,
  deviceCookieHeader,
  extractToken,
  hostAllowed,
  isLoopback,
  loadOrCreateToken,
  originAllowed,
  parseCookies,
  tokenEquals,
} from './auth.js';
import {
  AccessVerifier,
  DEVICE_COOKIE,
  DEVICE_KEY_HEADER,
  DeviceStore,
  MAX_HOSTS,
  PAIRING_TTL_MS,
  Pairings,
  RemoteError,
  RemoteStore,
  Throttle,
  answerable,
  checkCloudflare,
  checkTailscale,
  deviceLabel,
  funnelState,
  onlyCockpit,
  loopbackPeer,
  parseRemoteUrl,
  remoteOriginAllowed,
  servePath,
  statusText,
  stripServePath,
  tailscaleBin,
} from './remote.js';
import { DonnaRouter } from './channels/donna.js';
import { IMessageGateway } from './channels/imessage.js';
import { TelegramGateway } from './channels/telegram.js';
import { EventBus } from './events.js';
import { BACKEND_LABEL, createBackend } from './backend.js';
import { cliParts } from './hints.js';
import { buildHooksSettings, supportsStopFailure } from './hooks.js';
import { parseModeChoices } from './permissions.js';
import { OrgStore } from './org.js';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  PKG_ROOT,
  TELEGRAM_OFFICIAL_BASE,
  VERSION,
  childEnv,
  isTestMode,
  resolveHome,
  stableNodePath,
  runtimePaths,
  telegramApiBase,
  tmuxSocketName,
  which,
} from './paths.js';
import { commandFor, envGet, portablePath, spawnOptions } from './platform.js';
import { discover, findSubagent, scanSetup } from './discover.js';
import { importGroup, importProject, promoteSubagent } from './importer.js';
import { SessionManager } from './sessions.js';
import { claudeConfigDir, findTranscript } from './transcripts.js';
import { NeedsYouPinger } from './needs-you.js';
import { Reports } from './report.js';
import { Checks } from './checks.js';
import { Evals, parseCells } from './evals/runner.js';
import { fixMessage } from './claims.js';
import { commitHooks, detectStack } from './stack.js';
import { Digest } from './digest.js';
import { Cto } from './cto.js';
import { KINDS as OTLP_KINDS, INGEST_MAX_BYTES, OtelState, RateLimit, SECRET_HEADER, TraceStore, enrich, envBlock, normalize, preflight, sessionHeaders } from './otel.js';
import { Accounts } from './accounts.js';
import { HttpError, badRequest, ensureDir, execFileP, isUuid, isValidAgentId, notFound, readJson, shq, writeFileAtomic, writeJson } from './util.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
};

// Browser modules served straight out of node_modules (no bundler, no build step).
export const VENDOR = {
  'preact.mjs': ['preact', 'dist/preact.mjs'],
  'preact-hooks.mjs': ['preact', 'hooks/dist/hooks.mjs'],
  'htm.mjs': ['htm', 'dist/htm.mjs'],
  'xterm.mjs': ['@xterm/xterm', 'lib/xterm.mjs'],
  'xterm.css': ['@xterm/xterm', 'css/xterm.css'],
  'addon-fit.mjs': ['@xterm/addon-fit', 'lib/addon-fit.mjs'],
  'addon-web-links.mjs': ['@xterm/addon-web-links', 'lib/addon-web-links.mjs'],
};

const requireHere = createRequire(import.meta.url);

/** Directory of an installed package, found the way Node would find it (global, npx or repo). */
export function packageDir(name, req = requireHere) {
  try {
    return path.dirname(req.resolve(`${name}/package.json`));
  } catch {
    // package.json not exported: walk up from the main entry
  }
  let dir = path.dirname(req.resolve(name));
  for (;;) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name === name) return dir;
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`cannot locate package ${name}`);
    dir = parent;
  }
}

export function resolveVendor(file) {
  const v = VENDOR[file];
  if (!v) return null;
  try {
    const p = path.join(packageDir(v[0]), v[1]);
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

const FALLBACK_INDEX = `<!doctype html><meta charset="utf-8"><title>Clawdling</title>
<body style="font:16px system-ui;background:#111;color:#eee;padding:2rem">
<h1>Clawdling is running</h1><p>The web cockpit files (web/index.html) are not installed in this copy.</p></body>`;

function makeLogger({ quiet = false, file } = {}) {
  const write = (level, msg) => {
    const line = `${new Date().toISOString()} ${level} ${msg}\n`;
    if (!quiet || level !== 'info') process.stderr.write(line);
    if (file) {
      try {
        fs.appendFileSync(file, line, { mode: 0o600 });
      } catch {
        // ignore
      }
    }
  };
  return {
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
  };
}

/** The `clawdling` command inside sessions: a POSIX sh shim, plus .cmd and .ps1 ones on Windows. */
export function cliShims({ nodePath, cliPath, platform = process.platform }) {
  if (platform !== 'win32') {
    return { clawdling: `#!/bin/sh\n# Generated by Clawdling: runs this install's CLI.\nexec ${shq(nodePath)} ${shq(cliPath)} "$@"\n` };
  }
  const ps = (p) => `'${String(p).replace(/'/g, "''")}'`;
  return {
    // Git Bash (Claude Code's Bash tool on Windows)
    clawdling: `#!/bin/sh\n# Generated by Clawdling: runs this install's CLI.\nexec ${shq(portablePath(nodePath, 'win32'))} ${shq(portablePath(cliPath, 'win32'))} "$@"\n`,
    // PowerShell (Claude Code's shell tool when Git for Windows is not installed)
    'clawdling.ps1': `# Generated by Clawdling: runs this install's CLI.\r\n& ${ps(nodePath)} ${ps(cliPath)} @args\r\nexit $LASTEXITCODE\r\n`,
    // cmd.exe and everything else
    'clawdling.cmd': `@echo off\r\nrem Generated by Clawdling: runs this install's CLI.\r\n"${nodePath}" "${cliPath}" %*\r\n`,
  };
}

function sendJson(res, status, body) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function noContent(res) {
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function jsonBody(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  const ct = String(req.headers['content-type'] || '');
  if (!/^application\/json\b/i.test(ct)) throw new HttpError(415, 'send JSON with Content-Type: application/json');
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw badRequest('invalid JSON body');
  }
}

function param(m, i) {
  try {
    return decodeURIComponent(m[i]);
  } catch {
    throw badRequest('bad path');
  }
}

function agentParam(m) {
  const id = param(m, 1);
  if (!isValidAgentId(id)) throw badRequest('invalid agent id');
  return id;
}

function sidParam(m) {
  const sid = param(m, 1);
  if (!isUuid(sid)) throw badRequest('invalid session id');
  return sid;
}

/** Non-internal IPv4 addresses of this machine (for pairing a phone on the same network). */
export function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
    }
  }
  return out;
}

export function pairingInfo({ host, port, token, lan = lanAddresses() }) {
  const lanUrls = lan.map((ip) => `http://${ip}:${port}`);
  let url;
  if (host === '0.0.0.0' || host === '::') url = lanUrls[0] || `http://127.0.0.1:${port}`;
  else if (isLoopback(host)) url = `http://127.0.0.1:${port}`;
  else url = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  return {
    url,
    token,
    link: `clawdling://connect?url=${encodeURIComponent(url)}&t=${token}`,
    // Opens the cockpit in a phone's browser already signed in (the server swaps ?t= for a cookie).
    browser_link: `${url}/?t=${token}`,
    lan: lanUrls,
    bind: host,
  };
}

/** SVG QR code for a string, via the MIT `qrcode-generator` package (server-side only). */
export function qrSvg(text) {
  const qrcode = requireHere('qrcode-generator');
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true, title: 'Clawdling pairing code', alt: 'Clawdling pairing code' });
}

/**
 * Start a server. Resolves once it is listening.
 * @param {object} opts {home, port, host, env, quiet, webDir}
 */
export async function startServer(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home;
  if (!home) throw new Error('startServer needs a home');
  const paths = runtimePaths(home);
  if (!fs.existsSync(paths.orgJson)) throw new Error(`No org at ${home}. Run \`clawdling init\` first.`);
  for (const d of [paths.rt, paths.logs, paths.run, paths.ctx, paths.bin]) ensureDir(d, 0o700);

  const logger = opts.logger || makeLogger({ quiet: opts.quiet, file: path.join(paths.logs, 'server.log') });
  // A server driving the fake claude is a test server, whatever else the environment says: it must
  // never reach the official Telegram API, the real osascript or the real Messages database.
  const testMode = isTestMode(env) || /fake-claude/.test(env.CLAWDLING_CLAUDE_BIN || '');
  const socket = tmuxSocketName(env);
  const claudeBin = env.CLAWDLING_CLAUDE_BIN || 'claude';
  if (testMode) {
    if (socket === 'clawdling') throw new Error('test mode: set CLAWDLING_TMUX_SOCKET to a unique test socket');
    if (!env.CLAWDLING_CLAUDE_BIN) throw new Error('test mode: set CLAWDLING_CLAUDE_BIN to the fake claude');
  }
  const token = loadOrCreateToken(paths.token);

  // Nothing below may touch this org's state (registry, hooks file, shim, tmux clients) while
  // another server owns it: refuse if one is running for this home, and bind the port first.
  const running = await liveServer(paths, home);
  if (running) {
    const e = new Error(`Clawdling is already running for ${home} (pid ${running.pid}, port ${running.port}). Open it with: clawdling open`);
    e.code = 'EALREADYRUNNING';
    e.running = running;
    throw e;
  }
  let port = Number.isInteger(opts.port) ? opts.port : DEFAULT_PORT;
  const host = opts.host || DEFAULT_HOST;
  let onRequest = (req, res) => {
    securityHeaders(res);
    sendJson(res, 503, { error: 'Clawdling is starting' });
  };
  let onUpgrade = (req, sock) => {
    sock.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    sock.destroy();
  };
  const server = http.createServer((req, res) => onRequest(req, res));
  server.keepAliveTimeout = 5000;
  server.on('upgrade', (req, sock, head) => onUpgrade(req, sock, head));
  try {
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListen);
        reject(err);
      };
      const onListen = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListen);
      server.listen(port, host);
    });
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      const e = new Error(`port ${port} on ${host} is already in use by another program. Pick another with --port.`);
      e.code = 'EADDRINUSE';
      throw e;
    }
    throw err;
  }
  port = server.address().port;
  try {
    return await initServer();
  } catch (err) {
    await new Promise((r) => server.close(() => r()));
    throw err;
  }

  async function initServer() {
    const cEnv = childEnv(env);
    /** `claude --version`'s first line, or null (not found, or it failed). */
    async function claudeVersionLine() {
      const out = await claudeOutput(['--version']);
      return out ? out.trim().split('\n')[0] || null : null;
    }
    /** stdout of `claude <args>`, or null (not found, or it failed). */
    async function claudeOutput(args) {
      const bin = which(claudeBin, cEnv.PATH || '');
      if (!bin) return null;
      try {
        const cmd = commandFor(bin, args, { env: cEnv });
        const { stdout } = await execFileP(cmd.file, cmd.args, { timeout: 8000, env: cEnv, spawn: spawnOptions(cmd) });
        return stdout;
      } catch {
        return null;
      }
    }
    // tmux when it is installed (sessions survive restarts), else a pty per session (server/backend.js).
    // How a person types this install's CLI (attach hints, and every command the cockpit prints).
    const { cli: cliCmd, homeFlag } = cliParts({ home, envPath: cEnv.PATH || '' });
    const cli = cliCmd + homeFlag;
    const backend = await createBackend({ env, childEnv: cEnv, paths, socket, logger, attachPrefix: cliCmd, attachSuffix: homeFlag });

    // The --settings file every session gets: our hooks + the clawdling allow-list.
    const hookScript = path.join(PKG_ROOT, 'bin', 'clawdling-hook.js');
    const nodePath = stableNodePath(env);
    // The version decides which hooks to register; the help lists the --permission-mode names.
    const [versionLine, helpText] = await Promise.all([claudeVersionLine(), claudeOutput(['--help'])]);
    const modeChoices = parseModeChoices(helpText);
    writeJson(paths.hooksSettings, buildHooksSettings({ nodePath, hookScript, stopFailure: supportsStopFailure(versionLine), home }), 0o600);
    writeJson(paths.hooksSettingsRemote, buildHooksSettings({ nodePath, hookScript, stopFailure: supportsStopFailure(versionLine), home, guardScript: path.join(PKG_ROOT, 'bin', 'clawdling-guard.js') }), 0o600);
    // `clawdling` on PATH inside every session and Donna turn.
    for (const [name, text] of Object.entries(cliShims({ nodePath, cliPath: path.join(PKG_ROOT, 'bin', 'clawdling.js') }))) {
      writeFileAtomic(path.join(paths.bin, name), text, 0o700);
    }

    const events = new EventBus({ file: paths.events, logger });
    const org = new OrgStore(paths, { events });
    const accounts = new Accounts({ env });
    const sessions = new SessionManager({
      paths, org, events, backend, claudeBin, socket, shimDir: paths.bin, env: cEnv, logger, getPort: () => port, accounts, modeChoices,
    });
    await sessions.init();

    const donna = new DonnaRouter({ paths, org, sessions, events, claudeBin, env: cEnv, getPort: () => port, shimDir: paths.bin, logger });
    const apiBase = telegramApiBase(env);
    const telegram = new TelegramGateway({
      paths, org, donna, events, logger, apiBase,
      pollTimeoutSec: Number(env.CLAWDLING_TELEGRAM_POLL_TIMEOUT) || 25,
      blocked: testMode && apiBase === TELEGRAM_OFFICIAL_BASE ? 'test mode: TELEGRAM_API_BASE must point at a local stub' : null,
    });
    const imessage = new IMessageGateway({ paths, org, donna, events, logger, env: testMode ? { ...env, CLAWDLING_TEST: '1' } : env });
    const pinger = new NeedsYouPinger({ paths, org, sessions, telegram, imessage, events, logger, delayMs: testMode && Number(env.CLAWDLING_PING_DELAY_MS) >= 0 && env.CLAWDLING_PING_DELAY_MS ? Number(env.CLAWDLING_PING_DELAY_MS) : 4000 });
    sessions.onNeedsYou = (rec) => pinger.onNeedsYou(rec);
    // The report card (1.5): receipts under .clawdling/ledger, written when a session ends.
    const reports = new Reports({ paths, org, sessions, env: cEnv, logger });
    donna.reports = reports; // Donna answers "what got done today" from the report card
    sessions.onEnded = (rec) => setImmediate(() => reports.sessionEnded(rec));
    sessions.onTranscriptSwitch = (rec, oldPath) => setImmediate(() => reports.transcriptSwitched(rec, oldPath));
    // Verified done (1.6): the ship check and agent check-ups; claim receipts read both.
    const checks = new Checks({ paths, org, events, logger, env: cEnv });
    const evals = new Evals({ paths, org, sessions, reports, checks, events, claudeBin, env: cEnv, logger });
    const stackCache = new Map(); // repo -> {at, commands}: detectStack for claim receipts, a minute at a time
    reports.claimContext = (agentId) => {
      const a = org.agent(agentId);
      if (!a) return {};
      let detected = [];
      let hooks = false;
      if (a.repo) {
        const hit = stackCache.get(a.repo);
        if (hit && Date.now() - hit.at < 60000) ({ commands: detected, hooks } = hit);
        else {
          try {
            detected = detectStack(a.repo).commands;
          } catch {
            detected = [];
          }
          hooks = commitHooks(a.repo);
          stackCache.set(a.repo, { at: Date.now(), commands: detected, hooks });
        }
      }
      let approved = [];
      let shipRuns = [];
      try {
        const c = a.kind === 'project' && a.repo ? checks.config(agentId) : null;
        approved = c && c.config && c.approved ? c.config.checks : [];
        shipRuns = a.kind === 'project' ? checks.evidence(agentId) : [];
      } catch {
        // no ship check
      }
      return { approved, detected, shipRuns, commitHooks: hooks };
    };
    reports.verifyInfo = (agentId) => {
      const a = org.agent(agentId);
      let ship = null;
      try {
        if (a && a.kind === 'project') {
          const v = checks.view(agentId);
          ship = { available: v.available, configured: v.exists && !!v.config, approved: v.approved, last: v.last ? { at: v.last.started_at, ok: v.last.ok, error: v.last.error, results: v.last.results.map((r) => ({ name: r.name, cmd: r.cmd, ok: r.ok, setup: r.setup })) } : null };
        }
      } catch {
        ship = null;
      }
      return { ship, checkup: evals.latest(agentId), checkup_previous: evals.previous(agentId), cheaper: evals.cheaper(agentId) };
    };
    const transcripts = sessions.transcripts;
    const configDir = claudeConfigDir(cEnv);

    // The Monday report (1.5, opt-in): one message a week to the paired channel, through the pinger.
    const digest = new Digest({ paths, org, reports, pinger, events, logger });
    // The CTO seat (1.7): its launch settings, the weekly review (opt-in), its line in the Monday report.
    const cto = new Cto({ paths, org, sessions, reports, events, logger });
    sessions.seatLaunch = (rec, target) => cto.launchSettings(rec, target, { nodePath, hookScript, stopFailure: supportsStopFailure(versionLine) });
    // A CTO turn ended (Stop, SessionEnd, or a "No" that stopped it): keep its week's record now.
    sessions.onTurnEnd = (rec) => {
      if (rec.kind === 'cto') setImmediate(() => cto.record(rec));
    };
    digest.ctoLine = () => {
      try {
        return cto.digestLine();
      } catch (err) {
        logger.warn(`cto: monday report line: ${err.message}`);
        return null;
      }
    };
    try {
      if (org.refreshCtoSettings()) logger.info("cto: rewrote the CTO folder's settings file from this version's template");
    } catch (err) {
      logger.warn(`cto: could not refresh the CTO folder's settings: ${err.message}`);
    }

    // The detailed timeline (1.5, beta, off by default): Claude Code's own OpenTelemetry, received on
    // /otlp from this computer only, with this org's secret. Its settings go only into Clawdling's own
    // --settings file, and never where the user already has telemetry settings (otel.js preflight).
    const otelState = new OtelState(paths.otel);
    const traces = new TraceStore(paths.traces);
    // Test mode may lower the rate (CLAWDLING_OTLP_RATE) so a test can cross it on any machine.
    const otelLimit = new RateLimit(testMode && Number(env.CLAWDLING_OTLP_RATE) > 0 ? Number(env.CLAWDLING_OTLP_RATE) : undefined);
    const OTLP_INFLIGHT_MAX = 4;
    let otelInflight = 0;
    // Agents must be kept out of .clawdling (its secret is there): with an org path Claude Code's file
    // rules cannot express, the detailed timeline stays off, like the needs-you ping and the report.
    const otelGuarded = () => pinger.guarded();
    const managedOverride = testMode && typeof env.CLAWDLING_MANAGED_SETTINGS === 'string' ? env.CLAWDLING_MANAGED_SETTINGS.split(path.delimiter).filter(Boolean) : null;
    function otelPreflight(extraDirs = []) {
      return preflight({
        env,
        configDirs: [configDir, ...accounts.list().map((a) => a.dir).filter(Boolean), ...extraDirs],
        // Every folder a session runs in or adds: the org, each agent's own folder, each repo.
        projectDirs: [home, ...org.agents().flatMap((a) => [a.dir, a.repo, ...(Array.isArray(a.repos) ? a.repos : [])]).filter(Boolean)],
        ...(managedOverride ? { managed: managedOverride, profiles: [] } : {}),
      });
    }
    const OTEL_BLOCKED = 'Your Claude Code already has telemetry settings, so the detailed timeline stays off and Clawdling uses transcripts.';
    const OTEL_UNGUARDED = "Clawdling cannot keep agents out of its own settings in a folder whose path has characters like ( ) ' or accents, so the detailed timeline stays off here.";
    const otelOn = (extraDirs = []) => otelState.read().enabled && otelGuarded() && otelPreflight(extraDirs).clear;
    // The shared --settings file never carries the telemetry block: a session that gets the detailed
    // timeline gets its own file (beforeLaunch), decided by its own preflight.
    function writeHooks() {
      writeJson(paths.hooksSettings, buildHooksSettings({ nodePath, hookScript, stopFailure: supportsStopFailure(versionLine), home }), 0o600);
    }
    // Before every launch and resume: the preflight runs again (settings may have changed since), and
    // a session started while it is on gets its own telemetry credential, never the org's secret.
    sessions.beforeLaunch = (rec) => {
      if (rec.guard === 'remote-access') return {};
      let on = false;
      try {
        // Including the exact Claude Code folder this launch uses (a login folder behind a link too).
        on = otelOn([sessions.configDirFor(rec, configDir)].filter((d) => typeof d === 'string' && d));
      } catch (err) {
        logger.warn(`detailed timeline: preflight failed (${err.message}); off for this launch`);
        on = false;
      }
      const st = otelState.read();
      if (!on || !st.enabled) return {}; // the shared file, with no telemetry block
      // Named per launch: a late end event from an earlier run never deletes this one (sessions.js).
      const settingsPath = path.join(paths.run, `${rec.sid}.${crypto.randomBytes(4).toString('hex')}.settings.json`);
      writeJson(settingsPath, buildHooksSettings({ nodePath, hookScript, stopFailure: supportsStopFailure(versionLine), home, env: envBlock({ port }) }), 0o600);
      return { settingsPath, env: { OTEL_EXPORTER_OTLP_HEADERS: sessionHeaders(st.secret, rec.sid) } };
    };
    function otelStatus() {
      const st = otelState.read();
      const pf = otelPreflight();
      const guarded = otelGuarded();
      return {
        enabled: st.enabled,
        active: st.enabled && pf.clear && guarded,
        blocked: !pf.clear || !guarded,
        ...(!guarded ? { reason: OTEL_UNGUARDED } : pf.clear ? {} : { reason: OTEL_BLOCKED, found: pf.found.map(({ where, key }) => ({ where, key })) }),
        note: "It takes effect at each session's next start: sessions started earlier keep their setting until they restart.",
      };
    }
    try {
      writeHooks();
    } catch (err) {
      logger.warn(`could not write the detailed timeline's settings: ${err.message}`);
    }
    // Orgs from before 1.2 get the /onboard-project skill (repo-rooted sessions find skills at the org root).
    try {
      org.ensureSkills();
    } catch (err) {
      logger.warn(`could not install the org's skills: ${err.message}`);
    }

    // "Bring in your projects": discovery is read-only and local (plus the user's own gh). It runs
    // in a worker thread (its folder walk is synchronous), and its answer is cached for 30 s;
    // anything that changes the org clears the cache, and a scan that started before the change
    // is never stored.
    const userHome = (process.platform === 'win32' ? envGet(env, 'USERPROFILE') : envGet(env, 'HOME')) || os.homedir();
    const found = { at: 0, key: null, body: null, gen: 0, pending: null, worker: null };
    let lastCloneRoot = null; // what the import screen showed: kept when the cache is cleared
    const forgetDiscovery = () => Object.assign(found, { at: 0, key: null, body: null, gen: found.gen + 1, pending: null });
    function discoverOffThread(args) {
      return new Promise((resolve, reject) => {
        let w;
        try {
          w = new Worker(new URL('./discover-worker.js', import.meta.url), { workerData: args });
        } catch {
          discover(args).then(resolve, reject);
          return;
        }
        found.worker = w;
        let settled = false;
        const done = (fn, v) => {
          if (settled) return;
          settled = true;
          if (found.worker === w) found.worker = null;
          fn(v);
        };
        w.once('message', (m) => (m && m.ok ? done(resolve, m.body) : done(reject, new Error((m && m.error) || 'discovery failed'))));
        w.once('error', (err) => done(reject, err));
        w.once('exit', (code) => done(reject, new Error(`discovery stopped (exit ${code})`)));
      });
    }
    async function discovery({ github, refresh }) {
      const key = github ? 'gh' : 'local';
      if (!refresh && found.body && found.key === key && Date.now() - found.at < 30000) return found.body;
      if (!refresh && found.pending && found.pending.key === key) return found.pending.promise;
      const gen = found.gen;
      const promise = discoverOffThread({ env: { ...cEnv }, homedir: userHome, configDir, orgHome: home, agents: org.agents(), github }).then((body) => {
        if (body && body.clone_root) lastCloneRoot = body.clone_root;
        if (found.gen === gen) Object.assign(found, { at: Date.now(), key, body });
        return body;
      });
      const pending = { key, promise };
      found.pending = pending;
      promise.finally(() => {
        if (found.pending === pending) found.pending = null;
      }).catch(() => {});
      return promise;
    }
    const cloneRoot = () => lastCloneRoot || path.join(userHome, 'code');
    // One import at a time: ids and new domains are allocated without a race.
    let importQueue = Promise.resolve();
    const serially = (fn) => {
      const run = importQueue.then(fn, fn);
      importQueue = run.catch(() => {});
      return run;
    };
    const projectRepos = () => org.agents().filter((a) => a.kind === 'project').flatMap((a) => [a.repo, ...(a.repos || [])]).filter(Boolean);

    const versions = { at: 0, claude: null, tmux: null };
    const backendInfo = { ...backend.describe(), reason: backend.reason || null, label: BACKEND_LABEL[backend.kind] || backend.kind };
    async function toolVersions() {
      // A failed check is cached for 3 s, not 60: "Check again" in the cockpit must see a fix.
      // tmux only counts when it runs the sessions; with the pty backend it is optional.
      const healthy = versions.claude?.ok && (versions.tmux?.ok || versions.tmux?.optional);
      if (versions.claude && Date.now() - versions.at < (healthy ? 60000 : 3000)) return versions;
      // With the pty backend tmux is optional: report what the start-up probe found.
      const probe = backend.tmuxProbe || {};
      const tv = backend.kind === 'tmux' ? await backend.version() : { ok: !!probe.ok, version: probe.version || null, ...(probe.ok ? {} : { error: probe.error || 'not installed' }), optional: true };
      let claude = { ok: false, version: null };
      const bin = which(claudeBin, cEnv.PATH || '');
      if (bin) {
        try {
          const cmd = commandFor(bin, ['--version'], { env: cEnv });
          const { stdout } = await execFileP(cmd.file, cmd.args, { timeout: 8000, env: cEnv, spawn: spawnOptions(cmd) });
          claude = { ok: true, version: stdout.trim().split('\n')[0] };
        } catch (e) {
          claude = { ok: false, version: null, error: String(e.message).slice(0, 200) };
        }
      } else claude.error = `${claudeBin} not found on PATH`;
      Object.assign(versions, { at: Date.now(), claude, tmux: { ok: tv.ok, version: tv.version, ...(tv.error ? { error: tv.error } : {}), ...(tv.optional ? { optional: true } : {}) } });
      return versions;
    }

    function channelsStatus() {
      const o = org.read();
      return {
        telegram: telegram.status(o),
        imessage: imessage.status(o),
        donna: { session: o.donna_session || null, busy: donna.busy },
        recent: events.recent({ type: 'channel', limit: 30 }),
      };
    }

    function orgView() {
      const o = org.read();
      const stats = sessions.agentStats();
      const agents = org.agents().map((a) => ({ ...a, live: stats[a.id]?.live || 0, needs_you: stats[a.id]?.needs_you || 0, last_activity_at: stats[a.id]?.last_activity_at || null }));
      return { org: o, agents, channels: channelsStatus(), org_trusted: sessions.orgTrusted };
    }

    function publishOrg(reason, id) {
      forgetDiscovery();
      try {
        events.publish('org', { reason, id, ...orgView() });
      } catch (err) {
        logger.warn(`org event failed: ${err.message}`);
      }
    }
    // The first-run "Trust my org folder" card stays until this flips (sessions.markOrgTrusted).
    sessions.onOrgTrust = () => publishOrg('org_trusted');
    telegram.onChange = () => events.publish('channel', { channel: 'telegram', ...channelsStatus() });
    imessage.onChange = () => events.publish('channel', { channel: 'imessage', ...channelsStatus() });

    // ------------------------------------------------------------- Use from anywhere (1.3)
    /**
     * A personal skill or command that would answer /remote-access instead of the org's: a skill
     * folder or a SKILL.md whose name is remote-access, or a remote-access.md command at any depth.
     */
    function personalRemoteAccess(dir, { vetted = null } = {}) {
      const skills = path.join(dir, 'skills');
      try {
        for (const e of fs.readdirSync(skills, { withFileTypes: true }).slice(0, 500)) {
          if (!e.isDirectory() && !e.isSymbolicLink()) continue;
          if (vetted && path.join(skills, e.name) === vetted) continue;
          const f = path.join(skills, e.name, 'SKILL.md');
          if (e.name === 'remote-access') return path.join(skills, e.name);
          try {
            const head = fs.readFileSync(f, 'utf8').slice(0, 2000);
            if (/^name:\s*["']?remote-access["']?\s*$/m.test(head)) return f;
          } catch {
            // no SKILL.md
          }
        }
      } catch {
        // no skills folder
      }
      const walk = (d, depth) => {
        if (depth > 4) return null;
        let list = [];
        try {
          list = fs.readdirSync(d, { withFileTypes: true }).slice(0, 500);
        } catch {
          return null;
        }
        for (const e of list) {
          const f = path.join(d, e.name);
          let isFile = e.isFile();
          let isDir = e.isDirectory();
          if (e.isSymbolicLink()) {
            try {
              const st = fs.statSync(f);
              isFile = st.isFile();
              isDir = st.isDirectory();
            } catch {
              continue;
            }
          }
          if (isFile && e.name === 'remote-access.md') return f;
          if (isDir) {
            const hit = walk(f, depth + 1);
            if (hit) return hit;
          }
        }
        return null;
      };
      return walk(path.join(dir, 'commands'), 0);
    }

    // The server stays on 127.0.0.1. A request whose Host is a registered remote address came
    // through the user's Tailscale Serve entry or Cloudflare Tunnel: it is answered only while
    // Use from anywhere is on, only if that address passed its last check, and only for a paired
    // device. Everything else about the cockpit is unchanged.
    const remote = new RemoteStore(paths.remote);
    const devices = new DeviceStore(paths.remoteDevices);
    const pairings = new Pairings({ ttlMs: testMode && Number(env.CLAWDLING_PAIRING_TTL_MS) > 0 ? Number(env.CLAWDLING_PAIRING_TTL_MS) : PAIRING_TTL_MS });
    const throttle = new Throttle(testMode && Number(env.CLAWDLING_REMOTE_THROTTLE_MAX) > 0 ? { max: Number(env.CLAWDLING_REMOTE_THROTTLE_MAX) } : {});
    const access = new AccessVerifier(testMode && env.CLAWDLING_CF_CERTS_URL ? { certsUrl: () => env.CLAWDLING_CF_CERTS_URL } : {});
    const checkNonces = new Set();
    const helloSeen = new Map(); // nonce -> {login}: what our own hello handler saw
    let remoteGen = 0; // bumped by Turn off and remove: an add whose check spans one does not turn it back on
    const remoteConns = new Set(); // live SSE and terminal connections through a remote address
    // Headers only a proxy adds. On a loopback Host they mean a tunnel rewrote the Host header,
    // which would make a remote request look local: refused.
    const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'cf-access-jwt-assertion', 'tailscale-user-login', 'tailscale-funnel-request'];

    async function classify(req, url) {
      const entry = remote.match(req.headers.host);
      if (entry) {
        // Only the tunnel or serve process on this computer may use a remote name: with
        // --host 0.0.0.0, a computer on the Wi-Fi sending that Host is not on the tailnet.
        if (!loopbackPeer(req.socket.remoteAddress)) return { refused: 'unexpected Host header' };
        if (entry.kind === 'tailscale') {
          // Tailscale Serve forwards to this address's private path; anything else that connects to
          // 127.0.0.1 does not know it. Strip it: handlers see the real path.
          const rest = stripServePath(url.pathname, entry.path);
          if (rest === null) return { refused: 'unexpected path: set the Tailscale serve entry up with `clawdling remote serve`' };
          url.pathname = rest;
          req.url = rest + url.search;
        }
        // The one exception to "on and checked": our own check reaching us through the address.
        if (url.pathname === '/api/remote/hello') return checkNonces.has(url.searchParams.get('nonce')) ? { remote: true, hello: true, entry } : { refused: 'unexpected Host header' };
        const st = remote.read();
        if (!st.enabled) return { refused: 'Use from anywhere is turned off on this computer.' };
        if (!answerable(entry)) return { refused: `Clawdling does not answer ${entry.url}: ${statusText(entry)}.` };
        if (entry.kind === 'tailscale') {
          if (req.headers['tailscale-funnel-request'] !== undefined) return { refused: 'Clawdling never answers through Tailscale Funnel.' };
          // Tailscale Serve sets this for a signed-in user's device, strips any copy a client
          // sent, and never sets it for Funnel: only the owner's own account gets through.
          const login = req.headers['tailscale-user-login'];
          if (typeof login !== 'string' || login !== entry.login) return { refused: 'Clawdling answers this address only for your own Tailscale account.' };
          return { remote: true, entry, ident: login, source: firstForwarded(req.headers['x-forwarded-for']) };
        }
        const v = await access.verify(req.headers['cf-access-jwt-assertion'], entry.access);
        if (!v.ok) return { refused: `Cloudflare Access did not sign this request in (${v.reason}).` };
        // The owner's email, pinned by the first pairing (or --email): an Access policy that lets
        // others sign in still does not let them reach the cockpit.
        if (entry.email && v.email !== entry.email) return { refused: 'Clawdling answers this address only for your own email address.' };
        return { remote: true, entry, ident: v.email || null, source: firstForwarded(req.headers['cf-connecting-ip']) };
      }
      if (!hostAllowed(req, allowed)) return { refused: 'unexpected Host header' };
      // Whatever the bind address (--host 0.0.0.0 included): a request a tunnel or proxy carried
      // in for a name that is not registered is not a local request.
      const proxied = PROXY_HEADERS.some((h) => req.headers[h] !== undefined) || req.headers['cf-ray'] !== undefined || Object.keys(req.headers).some((k) => k.startsWith('tailscale-'));
      if (proxied) return { refused: 'this request came through a proxy or tunnel for an address Clawdling does not know. Register the address with `clawdling remote add` instead.' };
      const hostName = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
      if (loopbackPeer(req.socket.remoteAddress) && !isLoopback(hostName)) return { refused: 'unexpected Host header' };
      return { remote: false };
    }

    function firstForwarded(v) {
      return typeof v === 'string' ? v.split(',')[0].trim().slice(0, 64) : '';
    }

    function refuse(res, msg) {
      res.setHeader('X-Clawdling-Refused', '1'); // lets a Cloudflare check tell "reached Clawdling" from "stopped by Access"
      sendJson(res, 403, { error: msg });
    }

    /**
     * The credential a remote request presents: the app's device token in the header, or a
     * browser's cookie plus its key (a header; `k=` on the event stream and terminal sockets,
     * which cannot set headers). Never the long-lived token.
     */
    function remoteCredential(req, url) {
      const h = req.headers[TOKEN_HEADER];
      if (typeof h === 'string' && h) return { tokens: [h], via: 'header' };
      const values = cookieValues(req.headers.cookie, DEVICE_COOKIE);
      if (!values.length) return null;
      let key = req.headers[DEVICE_KEY_HEADER];
      let keyVia = typeof key === 'string' ? 'header' : null;
      if (!keyVia && url && (url.pathname === '/api/events' || url.pathname.startsWith('/ws/'))) {
        key = url.searchParams.get('k');
        keyVia = typeof key === 'string' ? 'query' : null;
      }
      return { tokens: values, via: 'cookie', key: typeof key === 'string' ? key : null, keyVia };
    }

    const verifyCred = (cred, who) => {
      if (!cred) return null;
      for (const t of cred.tokens) {
        const d = devices.verify(t, { host: who.entry.url, via: cred.via, key: cred.key });
        if (d) return d;
      }
      return null;
    };
    const deviceFor = (req, url) => verifyCred(remoteCredential(req, url), req.who);

    function remoteAuth(req, who, url) {
      const cred = remoteCredential(req, url);
      if (!cred) return { status: 401, error: 'This device is not signed in. On your computer, open Settings, Use from anywhere, and add this device.' };
      const d = verifyCred(cred, who);
      if (d) {
        devices.touch(d);
        return { device: d };
      }
      // A cookie with no key is a page that lost its storage (or a cookie seen elsewhere): signed
      // out, but not a guess worth counting.
      // A key in a URL (k=) can come from any same-site page (an <img> or EventSource on another
      // tailnet machine): refused, not counted. Only a header key, which no other page can send
      // without our consent (CORS), counts as a real attempt.
      if (cred.via === 'cookie' && cred.keyVia !== 'header') return { status: 401, error: 'This device is signed out. On your computer, open Settings, Use from anywhere, and add it again.' };
      const key = throttleKey(who);
      if (throttle.blocked(key)) return { status: 429, error: 'Too many failed sign-ins through this address. Wait a few minutes, then try again.', retryAfter: throttle.retryAfter(key) };
      throttle.fail(key);
      if (throttle.blocked(key)) logger.warn(`remote: too many failed sign-ins through ${key}; refusing new ones for a few minutes`);
      return { status: 401, error: 'This device is signed out. On your computer, open Settings, Use from anywhere, and add it again.' };
    }

    // Failed sign-ins are counted per address AND per signed-in Tailscale or Access identity, so
    // someone else on the tailnet (or in the Access policy) cannot hold pairing shut for the owner.
    // And per source address (the tailnet IP Tailscale Serve reports, or Cloudflare's client IP):
    // another device, or a process on this computer, that fails on purpose fills its own bucket.
    const throttleKey = (who) => `${who.entry.url} ${who.ident || ''} ${who.source || ''}`;

    function trackRemote(who, close, emitter) {
      const c = { host: who.entry.url, device: who.device?.id, close };
      remoteConns.add(c);
      emitter.once('close', () => remoteConns.delete(c));
    }

    /** Close every remote connection whose address or device is no longer allowed. */
    function sweepRemote() {
      const st = remote.read();
      const live = new Set(devices.list().map((d) => d.id));
      for (const c of [...remoteConns]) {
        const e = st.hosts.find((h) => h.url === c.host);
        if (st.enabled && e && answerable(e) && live.has(c.device)) continue;
        remoteConns.delete(c);
        try {
          c.close();
        } catch {
          // already closed
        }
      }
    }

    function remoteView(who = {}) {
      const st = remote.read();
      return {
        enabled: st.enabled,
        invalid: st.invalid,
        port,
        pairing_minutes: Math.round(pairings.ttlMs / 60000),
        hosts: st.hosts.map((h) => ({ url: h.url, kind: h.kind, status: h.status, status_text: statusText(h), detail: h.detail, checked_at: h.checked_at, answering: st.enabled && answerable(h) })),
        devices: devices.list(),
        here: { remote: !!who.remote, url: who.entry?.url || null, device: who.device?.id || null },
      };
    }

    function remoteChanged(reason) {
      sweepRemote();
      events.record({ type: 'remote', action: reason });
    }

    const tsBin = () => tailscaleBin({ env, which: (c) => which(c, cEnv.PATH || '') });
    // `tailscale serve status --json`, the only Tailscale command Clawdling itself ever runs.
    const runReadOnly = (bin, args, o = {}) => {
      const cmd = commandFor(bin, args, { env: cEnv });
      return execFileP(cmd.file, cmd.args, { ...o, env: cEnv, spawn: spawnOptions(cmd) });
    };

    /** One check of one address: {status, detail, access?, checked_at}. Never sends a credential. */
    async function runCheck(entry) {
      const nonce = crypto.randomBytes(16).toString('hex');
      checkNonces.add(nonce);
      try {
        const r = entry.kind === 'tailscale'
          ? await checkTailscale(entry, { nonce, bin: tsBin(), run: runReadOnly, env, testMode, port, seen: () => helloSeen.get(nonce) || null })
          : await checkCloudflare(entry, { env, testMode });
        return { ...r, checked_at: new Date().toISOString() };
      } finally {
        checkNonces.delete(nonce);
        helloSeen.delete(nonce);
      }
    }

    // Every check (Check again, Turn on, an add, the timers) runs one at a time, so an older
    // result can never overwrite a newer verdict.
    let checkChain = Promise.resolve();
    function exclusive(fn) {
      const run = checkChain.then(fn, fn);
      checkChain = run.catch(() => {});
      return run;
    }

    const checkAll = () => exclusive(checkAllNow);

    async function checkAllNow() {
      const st = remote.read();
      const results = new Map();
      for (const h of st.hosts) results.set(h.url, await runCheck(h));
      remote.update((s) => {
        for (const h of s.hosts) {
          const r = results.get(h.url);
          if (!r) continue;
          // A Cloudflare address that passed before and simply could not be reached now keeps
          // its status: every request through it must still carry a valid Access token.
          if (h.kind === 'cloudflare' && h.status === 'access' && r.status === 'unreachable') {
            Object.assign(h, { checked_at: r.checked_at, detail: `${r.detail} It passed its last check, and Clawdling still requires a Cloudflare Access sign-in on every request.` });
            continue;
          }
          // Never the Access pins: those come only from the owner, at add.
          Object.assign(h, { status: r.status, detail: r.detail, checked_at: r.checked_at, ...(r.login ? { login: r.login } : {}) });
        }
      });
      for (const [url, r] of results) unsafeSignOut(url, r);
      remoteChanged('checked');
    }

    /**
     * An address found public, shared with another app, or with a raw forward onto the cockpit:
     * whatever reached it meanwhile may have seen a device's cookie and key, so every device
     * paired through it signs out, and its pairing links stop working.
     */
    function unsafeSignOut(url, r) {
      if (!['public', 'unconfirmed', 'unprotected', 'unverified'].includes(r.status)) return;
      const n = devices.revokeHost(url);
      pairings.clear();
      if (n) {
        logger.warn(`remote: ${url} is no longer private (${r.status}); signed out ${n} device(s)`);
        remote.update((s) => {
          const h = s.hosts.find((x) => x.url === url);
          if (h) h.detail = `${h.detail || ''} Every device paired through it was signed out: pair them again once it is fixed.`.trim();
        });
      }
    }

    /** The cheap half of a Tailscale check (serve status only, no request), run every minute. */
    const quickServeCheck = () => exclusive(quickServeCheckNow);

    async function quickServeCheckNow() {
      const st = remote.read();
      if (!st.enabled) return;
      for (const h of st.hosts) {
        if (h.kind !== 'tailscale' || !answerable(h)) continue;
        const f = await funnelState(h, { bin: tsBin(), run: runReadOnly, port });
        let bad = null;
        if (f.known && f.funnel) bad = { status: 'public', detail: 'Tailscale Funnel was turned on for this address. Clawdling stopped answering it.' };
        else if (f.known && f.tcp.length) bad = { status: 'unconfirmed', detail: `A Tailscale TCP forward on port ${f.tcp.join(', ')} now lands on the cockpit. Clawdling stopped answering this address.` };
        else if (f.known && f.handlers.length && !onlyCockpit(f.handlers, { port, path: h.path })) bad = { status: 'unconfirmed', detail: `Something else is now served on ${h.url} too. Clawdling stopped answering it: give the cockpit a port of its own, then check again.` };
        if (!bad) continue;
        remote.update((s) => {
          const x = s.hosts.find((y) => y.url === h.url);
          if (x) Object.assign(x, { ...bad, checked_at: new Date().toISOString() });
        });
        unsafeSignOut(h.url, bad);
        remoteChanged('checked');
      }
    }

    const addHost = (b) => exclusive(() => addHostNow(b));

    async function addHostNow(b) {
      if (!b.kind) throw new RemoteError('send --kind tailscale or --kind cloudflare');
      const p = parseRemoteUrl(b.url, b.kind);
      let access = null;
      // Cloudflare: the owner's own Access team and application, pinned here and only here. A
      // check compares the sign-in redirect against them and never changes them.
      if (b.kind === 'cloudflare' && (!b.team_domain || !b.access_aud)) {
        throw new RemoteError('a Cloudflare address needs --team-domain <team>.cloudflareaccess.com and --access-aud <AUD tag> (Zero Trust, Access, Applications, your app, Overview)');
      }
      if (b.team_domain !== undefined || b.access_aud !== undefined) {
        if (b.kind !== 'cloudflare') throw new RemoteError('--team-domain and --access-aud are for Cloudflare addresses');
        const team = String(b.team_domain || '').trim().toLowerCase().replace(/\/+$/, '');
        const teamUrl = team.startsWith('https://') ? team : `https://${team}`;
        const aud = String(b.access_aud || '').trim();
        if (!/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(teamUrl)) throw new RemoteError('--team-domain is your <team>.cloudflareaccess.com name');
        if (!/^[A-Za-z0-9_-]{16,128}$/.test(aud)) throw new RemoteError('--access-aud is the application AUD tag from Cloudflare Zero Trust');
        access = { team_domain: teamUrl, aud };
      }
      const cur = remote.read();
      const prev = cur.hosts.find((h) => h.url === p.url) || null;
      if (!prev && cur.hosts.length >= MAX_HOSTS) throw new RemoteError(`Clawdling keeps at most ${MAX_HOSTS} remote addresses: remove one first`);
      let email = null;
      if (b.email !== undefined) {
        if (b.kind !== 'cloudflare') throw new RemoteError('--email is for Cloudflare addresses (Tailscale knows your account)');
        email = String(b.email).trim();
        if (!/^[^\s@]{1,200}@[^\s@]{1,200}$/.test(email)) throw new RemoteError('--email is the address you sign in to Cloudflare Access with');
      }
      const draftPath = b.kind === 'tailscale' ? servePath(token, p.url) : null;
      const draft = { path: draftPath, email: email || (prev?.kind === 'cloudflare' && b.kind === 'cloudflare' ? prev.email : null), url: p.url, host: p.host, port: p.port, kind: b.kind, status: 'pending', added_at: prev?.added_at || new Date().toISOString(), checked_at: null, detail: null, access, login: null };
      // New pins for an address that had others: nothing paired under the old ones carries over.
      if (prev && (prev.kind !== b.kind || JSON.stringify(prev.access || null) !== JSON.stringify(access))) devices.revokeHost(p.url);
      remote.update((s) => {
        s.hosts = s.hosts.filter((h) => h.url !== p.url);
        s.hosts.push(draft);
      });
      const gen = remoteGen;
      let r;
      try {
        r = await runCheck(draft);
      } catch (err) {
        r = { status: 'unreachable', detail: `The check failed: ${err.message}` };
      }
      const done = { ...draft, status: r.status, detail: r.detail, checked_at: r.checked_at || new Date().toISOString(), access: draft.access, login: r.login || null };
      // Added only once it is reachable and safe (a later "Not reachable" keeps it: that may pass).
      if (!answerable(done) || done.status === 'unreachable') {
        // Not safe or not reachable: leave remote.json the way it was (unless it was removed
        // meanwhile), except that an address already registered and now found unsafe keeps that
        // verdict, and its devices sign out.
        const unsafe = ['public', 'unconfirmed', 'unprotected', 'unverified'].includes(r.status);
        remote.update((s) => {
          const ours = s.hosts.some((h) => h.url === p.url && h.status === 'pending');
          s.hosts = s.hosts.filter((h) => h.url !== p.url);
          if (prev && ours) s.hosts.push(unsafe ? { ...prev, status: r.status, detail: r.detail, checked_at: done.checked_at } : prev);
        });
        if (prev && unsafe) unsafeSignOut(p.url, r);
        const e = new HttpError(422, `Not added: ${r.detail}`);
        e.body = { status: r.status, status_text: statusText(done) };
        if (b.kind === 'tailscale' && r.status !== 'public') e.body.next = `clawdling remote serve ${p.url}`;
        throw e;
      }
      // Turned off (or an address removed) while this check ran: that wins.
      if (gen !== remoteGen) {
        // Only undo our own draft: if a remove already took it out, the address stays removed.
        remote.update((s) => {
          const ours = s.hosts.some((h) => h.url === p.url && h.status === 'pending');
          s.hosts = s.hosts.filter((h) => h.url !== p.url);
          if (prev && ours) s.hosts.push(prev);
        });
        throw new HttpError(409, 'Use from anywhere was turned off while this address was being checked. Nothing was added.');
      }
      // Off to on: nothing paired before comes back.
      if (!remote.read().enabled) {
        devices.revokeAll();
        pairings.clear();
      }
      remote.update((s) => {
        s.hosts = s.hosts.map((h) => (h.url === p.url ? done : h));
        s.enabled = true;
      });
      logger.info(`remote: added ${p.url} (${b.kind}, ${statusText(done)}); Use from anywhere is on`);
      remoteChanged('added');
      return done;
    }

    function removeHosts({ url, all }) {
      remoteGen++;
      if (all === true) {
        const n = remote.read().hosts.length;
        remote.update((s) => {
          s.hosts = [];
          s.enabled = false;
        });
        devices.revokeAll();
        pairings.clear();
        logger.info('remote: removed every remote address; Use from anywhere is off');
        remoteChanged('removed');
        return n;
      }
      const p = parseRemoteUrl(url);
      const st = remote.read();
      if (!st.hosts.some((h) => h.url === p.url)) throw notFound(`${p.url} is not a remote address of this Clawdling (see \`clawdling remote list\`)`);
      remote.update((s) => {
        s.hosts = s.hosts.filter((h) => h.url !== p.url);
        if (!s.hosts.length) s.enabled = false;
      });
      devices.revokeHost(p.url);
      pairings.clear(); // a code works on every address: a leaked link must stop everywhere
      if (!remote.read().hosts.length) devices.revokeAll();
      logger.info(`remote: removed ${p.url}`);
      remoteChanged('removed');
      return 1;
    }

    function turnOff() {
      remoteGen++;
      remote.update((s) => {
        s.enabled = false;
      });
      devices.revokeAll();
      pairings.clear();
      logger.info('remote: Use from anywhere turned off; every paired device is signed out');
      remoteChanged('off');
    }

    function remoteRoutes() {
      return [
        ['GET', /^\/api\/remote$/, (req) => [200, remoteView(req.who)]],
        // Our own check, reaching this server through the remote address. Answers only a nonce
        // this process is waiting for, and says nothing else.
        ['GET', /^\/api\/remote\/hello$/, (req, m, res, url) => {
          const nonce = url.searchParams.get('nonce');
          if (!req.who.hello || !checkNonces.has(nonce)) throw notFound('no such API route');
          const login = req.headers['tailscale-user-login'];
          // What the check trusts is this record, made here, not the reply it reads back.
          helloSeen.set(nonce, { login: typeof login === 'string' && login ? login : null });
          return [200, { clawdling: true, nonce }];
        }, { public: true, hello: true }],
        ['POST', /^\/api\/remote\/hosts$/, async (req) => {
          const b = await jsonBody(req);
          const h = await addHost(b);
          return [201, { ...remoteView(req.who), added: h.url }];
        }, { local: true }],
        ['POST', /^\/api\/remote\/remove$/, async (req) => {
          const b = await jsonBody(req);
          if (b.all !== true && typeof b.url !== 'string') throw badRequest('send {url} or {all: true}');
          const removed = removeHosts(b);
          return [200, { ...remoteView(req.who), removed }];
        }, { local: true }],
        ['POST', /^\/api\/remote\/check$/, async (req) => {
          await checkAll();
          return [200, remoteView(req.who)];
        }],
        // Off works from anywhere (you may be out when you want it off). On: only at the computer.
        ['POST', /^\/api\/remote\/enabled$/, async (req) => {
          const b = await jsonBody(req);
          if (typeof b.enabled !== 'boolean') throw badRequest('send {enabled: true|false}');
          if (!b.enabled) {
            turnOff();
            return [200, remoteView(req.who)];
          }
          if (req.who.remote) throw new HttpError(403, 'Only the computer Clawdling runs on can turn this on.');
          if (!remote.read().hosts.length) throw new HttpError(409, 'There is no remote address yet: set it up first.');
          if (!remote.read().enabled) {
            // Off to on: every device pairs again.
            devices.revokeAll();
            pairings.clear();
          }
          remote.update((s) => {
            s.enabled = true;
          });
          await checkAll();
          logger.info('remote: Use from anywhere turned on');
          return [200, remoteView(req.who)];
        }],
        // A one-time link per address. The QR codes hold that link, never the long-lived token.
        ['POST', /^\/api\/remote\/pairing$/, () => {
          const st = remote.read();
          const hosts = st.enabled ? st.hosts.filter(answerable) : [];
          if (!hosts.length) throw new HttpError(409, 'Use from anywhere is off, or no address passed its check.');
          const { code, expires_at } = pairings.create();
          const links = hosts.map((h) => {
            const link = `${h.url}/?pair=${code}`;
            let qr_svg = null;
            try {
              qr_svg = qrSvg(link);
            } catch {
              // QR unavailable: the link still works
            }
            return { url: h.url, kind: h.kind, link, qr_svg };
          });
          return [201, { expires_at, minutes: Math.round(pairings.ttlMs / 60000), links }];
        }, { local: true }],
        // The phone's side of a pairing link: one code, once, through a remote address only.
        ['POST', /^\/api\/remote\/pair$/, async (req, m, res) => {
          const who = req.who;
          if (!who.remote) throw new HttpError(403, 'Pairing links work only through your remote address.');
          const key = throttleKey(who);
          const b = await jsonBody(req);
          // A valid code always pairs (it is single use and 192 bits: a lockout guards nothing
          // for it); only failures count, so nobody can hold the owner's pairing shut.
          if (!pairings.consume(b.code)) {
            if (throttle.blocked(key)) {
              const e = new HttpError(429, 'Too many failed sign-ins through this address. Wait a few minutes, then try again.');
              e.retryAfter = throttle.retryAfter(key);
              throw e;
            }
            throttle.fail(key);
            throw new HttpError(401, 'This link has expired or was already used. On your computer, open Settings, Use from anywhere, and make a new one.');
          }
          if (who.entry.kind === 'cloudflare' && !who.entry.email) {
            // The first pairing through a Cloudflare address pins the owner's Access email.
            if (!who.ident) throw new HttpError(403, 'Cloudflare Access did not say who signed in, so this device cannot be paired.');
            remote.update((s) => {
              const h = s.hosts.find((x) => x.url === who.entry.url);
              if (h && !h.email) h.email = who.ident;
            });
          }
          const app = b.client === 'app';
          const { token: deviceToken, key: deviceKey, device } = devices.add({ label: deviceLabel(req.headers['user-agent']), host: who.entry.url, kind: app ? 'app' : 'browser' });
          logger.info(`remote: paired ${device.label} through ${who.entry.url}`);
          remoteChanged('paired');
          const out = { ok: true, device: { id: device.id, label: device.label, expires_at: device.expires_at } };
          // The app keeps its credential itself (a header). A browser gets the cookie, and a key
          // for its own localStorage that the cookie is useless without.
          if (app) return [201, { ...out, device_token: deviceToken }];
          res.setHeader('Set-Cookie', deviceCookieHeader(deviceToken));
          return [201, { ...out, device_key: deviceKey }];
        }, { public: true }],
        ['DELETE', /^\/api\/remote\/devices$/, () => {
          const n = devices.revokeAll();
          remoteChanged('signed_out');
          return [200, { signed_out: n }];
        }],
        ['DELETE', /^\/api\/remote\/devices\/([0-9a-f]{12})$/, (req, m, res) => {
          if (!devices.revoke(m[1])) throw notFound('no such device');
          if (req.who.device && req.who.device.id === m[1]) res.setHeader('Set-Cookie', deviceCookieHeader('', 0));
          remoteChanged('signed_out');
          return [200, { ok: true }];
        }],
      ];
    }

    // The CTO seat (1.7) takes instructions from the owner only: the cockpit (its cookie) or a paired
    // device. A request with the raw token is the CLI, which every agent and Donna can run without a
    // prompt (`clawdling send`, `spawn`): it may not start the CTO, type into it or answer for it.
    const ownerOnlyCto = (req, sid) => {
      const rec = sid ? sessions.get(sid) : null;
      if ((sid ? rec && rec.kind === 'cto' : true) && !req.who.remote && typeof req.headers[TOKEN_HEADER] === 'string' && req.headers[TOKEN_HEADER]) {
        throw new HttpError(403, 'Only you can talk to the CTO, from the cockpit: agents and Donna cannot start it, message it or answer for it.');
      }
    };
    const routes = [
      ['GET', /^\/api\/health$/, async (req, m, res, url) => {
        // Through a remote address, a device that has not signed in learns nothing about this computer.
        if (req.who.remote && !deviceFor(req, url)) return [200, { ok: true, remote: true, signed_in: false }];
        const v = await toolVersions();
        return [200, { ok: true, version: VERSION, backend: backendInfo, tmux: v.tmux, claude: v.claude, permission_modes: modeChoices, home, cli, platform: process.platform, remote: !!req.who.remote }];
      }, { public: true }],
      ['GET', /^\/api\/me$/, () => [200, { ok: true, version: VERSION }]],
      // `clawdling stop`: a clean stop on every OS (Windows has no SIGTERM for another process).
      ['POST', /^\/api\/shutdown$/, () => {
        if (typeof opts.onShutdown !== 'function') throw new HttpError(501, 'this server cannot be stopped over the API');
        setImmediate(() => opts.onShutdown('clawdling stop'));
        return [202, { ok: true, stopping: true, sessions_keep_running: backend.persistent !== false }];
      }, { local: true }],
      ['GET', /^\/api\/org$/, () => [200, orgView()]],
      ['POST', /^\/api\/agents$/, async (req) => {
        const body = await jsonBody(req);
        const agent = org.createAgent(body);
        events.record({ type: 'agent', action: 'created', id: agent.id });
        publishOrg('agent_created', agent.id);
        return [201, { ...agent, live: 0, needs_you: 0, last_activity_at: null }];
      }],
      ['GET', /^\/api\/agents\/([^/]+)$/, (req, m) => {
        const id = agentParam(m);
        const a = org.require(id);
        const ctx = org.context(id);
        const stats = sessions.agentStats()[id] || {};
        return [200, { ...a, live: stats.live || 0, needs_you: stats.needs_you || 0, last_activity_at: stats.last_activity_at || null, ...ctx, sessions: sessions.list().filter((s) => s.agent === id) }];
      }],
      ['PUT', /^\/api\/agents\/([^/]+)\/context$/, async (req, m) => {
        const id = agentParam(m);
        const body = await jsonBody(req);
        org.writeContext(id, body);
        events.record({ type: 'agent', action: 'context', id });
        publishOrg('context_updated', id);
        return [204];
      }],
      ['DELETE', /^\/api\/agents\/([^/]+)$/, (req, m) => {
        const id = agentParam(m);
        if (sessions.list().some((s) => s.agent === id && s.status !== 'ended')) {
          throw new HttpError(409, `end ${id}'s live sessions before archiving it`);
        }
        const out = org.archiveAgent(id);
        events.record({ type: 'agent', action: 'archived', id });
        publishOrg('agent_archived', id);
        return [200, { ok: true, ...out }];
      }],
      // Bring in your projects (SPEC-1.2): candidates, the Claude Code setup, imports, standing agents.
      ['GET', /^\/api\/discover$/, async (req, m, res, url) => [200, await discovery({ github: url.searchParams.get('github') !== '0', refresh: url.searchParams.get('refresh') === '1' })]],
      ['GET', /^\/api\/setup$/, () => [200, scanSetup({ configDir, agents: org.agents(), homedir: userHome, env: cEnv })]],
      ['POST', /^\/api\/import$/, async (req) => {
        const b = await jsonBody(req);
        const r = await serially(() => (b.group ? importGroup(org, { ...b.group, items: b.items }, { env: cEnv }) : importProject(org, b, { env: cEnv, cloneRoot: cloneRoot() })));
        if (r.skipped) return [200, r];
        if (r.domain_created) {
          events.record({ type: 'agent', action: 'created', id: r.domain_created.id });
          publishOrg('agent_created', r.domain_created.id);
        }
        events.record({ type: 'agent', action: 'imported', id: r.agent.id });
        publishOrg('agent_created', r.agent.id);
        return [201, r];
      }],
      ['POST', /^\/api\/setup\/promote$/, async (req) => {
        const b = await jsonBody(req);
        if (b.scope !== 'user' && b.scope !== 'repo') throw badRequest('scope must be "user" or "repo"');
        if (typeof b.name !== 'string' || !b.name.trim()) throw badRequest('send the subagent name');
        if (b.scope === 'repo' && (typeof b.repo !== 'string' || !projectRepos().includes(b.repo))) throw badRequest("repo must be one of your project agents' repos");
        const subagent = findSubagent({ configDir, scope: b.scope, repo: b.repo, name: b.name.trim(), repos: projectRepos() });
        if (!subagent) throw notFound(`no Claude Code subagent named "${b.name.trim()}"`);
        const agent = promoteSubagent(org, { subagent, scope: b.scope, repo: b.repo, name: typeof b.as === 'string' ? b.as : undefined });
        events.record({ type: 'agent', action: 'created', id: agent.id });
        publishOrg('agent_created', agent.id);
        return [201, { ...agent, live: 0, needs_you: 0, last_activity_at: null }];
      }],
      ['GET', /^\/api\/sessions$/, () => [200, sessions.list()]],
      ['POST', /^\/api\/sessions$/, async (req) => {
        const b = await jsonBody(req);
        if (b.agent === 'cto' && org.cto()) ownerOnlyCto(req, null);
        // A remote-access setup chat runs exactly the skill text this version ships.
        if (typeof b.prompt === 'string' && /^\s*\/remote-access\b/.test(b.prompt)) {
          org.ensureSkills();
          // Claude Code prefers a personal skill or command of the same name over the org's.
          const dirs = [configDir, ...(b.account && b.account !== 'default' ? [sessions.configDirFor({ account: b.account }, configDir)] : [])];
          // The org's own .claude too: another skill or command there named remote-access.
          const orgHit = personalRemoteAccess(path.join(home, '.claude'), { vetted: path.join(home, '.claude', 'skills', 'remote-access') });
          if (orgHit) throw new HttpError(409, `The org folder has a second "remote-access" skill or command (${orgHit}). Remove it, then start the setup again.`);
          for (const d of dirs) {
            const f = personalRemoteAccess(d);
            if (f) throw new HttpError(409, `Your own Claude Code setup has a "remote-access" skill or command (${f}), which Claude Code would run instead of Clawdling's. Rename it, then start the setup again.`);
          }
        }
        return [201, await sessions.spawn({ agent: b.agent, prompt: b.prompt, model: b.model, effort: b.effort, account: b.account, title: b.title, cols: b.cols, rows: b.rows })];
      }],
      // Model / effort chips: the session restarts on the same conversation (--resume) with the new --model / --effort, only between turns.
      ['POST', /^\/api\/sessions\/([^/]+)\/settings$/, async (req, m) => {
        const sid = sidParam(m);
        const b = await jsonBody(req);
        return [200, await sessions.settings(sid, { model: b.model, effort: b.effort })];
      }],
      ['GET', /^\/api\/accounts$/, () => [200, { accounts: accounts.list() }]],
      ['POST', /^\/api\/accounts$/, async (req) => {
        const b = await jsonBody(req);
        const a = accounts.create(b.name);
        events.record({ type: 'account', action: 'created', id: a.id });
        return [201, a];
      }],
      // Sign in: a plain claude in the org folder with the account's own CLAUDE_CONFIG_DIR, where the user runs /login.
      ['POST', /^\/api\/accounts\/([^/]+)\/signin$/, async (req, m) => {
        const id = decodeURIComponent(m[1]);
        const b = await jsonBody(req).catch(() => ({}));
        accounts.configDir(id);
        const title = !id || id === 'default' ? 'Sign in' : `Sign in: ${id}`; // default = your own Claude login
        return [201, await sessions.spawn({ agent: 'scratch', account: id, purpose: 'signin', title, cols: b.cols, rows: b.rows })];
      }],
      // "Start again" for a session stuck on "not signed in" (or a stalled start): a new claude.
      ['POST', /^\/api\/sessions\/([^/]+)\/restart$/, async (req, m) => {
        const sid = sidParam(m);
        const b = await jsonBody(req).catch(() => ({}));
        return [200, await sessions.restart(sid, { cols: b.cols, rows: b.rows })];
      }],
      ['GET', /^\/api\/sessions\/([^/]+)$/, (req, m) => [200, sessions.view(sessions.require(sidParam(m)))]],
      ['PATCH', /^\/api\/sessions\/([^/]+)$/, async (req, m) => {
        const sid = sidParam(m);
        const b = await jsonBody(req);
        if (!('title' in b)) throw badRequest('send {title}');
        return [200, sessions.rename(sid, b.title)];
      }],
      ['DELETE', /^\/api\/sessions\/([^/]+)$/, async (req, m) => [200, await sessions.end(sidParam(m))]],
      ['POST', /^\/api\/sessions\/([^/]+)\/resume$/, async (req, m) => {
        const sid = sidParam(m);
        const b = await jsonBody(req);
        return [200, await sessions.resume(sid, { cols: b.cols, rows: b.rows })];
      }],
      ['POST', /^\/api\/sessions\/([^/]+)\/send$/, async (req, m) => {
        const sid = sidParam(m);
        ownerOnlyCto(req, sid);
        const b = await jsonBody(req);
        if (typeof b.text !== 'string') throw badRequest('send {text, enter}');
        await sessions.send(sid, b.text, b.enter !== false);
        return [204];
      }],
      ['POST', /^\/api\/sessions\/([^/]+)\/answer$/, async (req, m) => {
        const sid = sidParam(m);
        ownerOnlyCto(req, sid);
        const b = await jsonBody(req);
        if (Array.isArray(b.answers)) return [200, await sessions.answer(sid, null, { answers: b.answers, toolId: b.tool_id })];
        if (!('option' in b)) throw badRequest('send {option: 1|2}');
        return [200, await sessions.answer(sid, b.option, { text: typeof b.text === 'string' ? b.text : null, toolId: typeof b.tool_id === 'string' ? b.tool_id : null })];
      }],
      ['POST', /^\/api\/hooks$/, async (req) => {
        const b = await jsonBody(req);
        if (!isUuid(b.sid)) throw badRequest('invalid sid');
        sessions.applyHook(String(b.event), b.sid, b.payload && typeof b.payload === 'object' ? b.payload : {}, b.ts, b.launch);
        return [204];
      }, { local: true }],
      ['GET', /^\/api\/events$/, (req, m, res) => {
        events.attachSse(req, res);
        if (req.who.remote) trackRemote(req.who, () => res.destroy(), res);
        return null;
      }],
      ['GET', /^\/api\/sessions\/([^/]+)\/messages$/, (req, m, res, url) => {
        const rec = sessions.require(sidParam(m));
        const afterRaw = url.searchParams.get('after');
        const after = afterRaw === null || afterRaw === '' ? -1 : Number(afterRaw);
        if (!Number.isInteger(after) || after < -1) throw badRequest('after must be an integer >= -1');
        const limitRaw = Number(url.searchParams.get('limit') || 200);
        const limit = Number.isInteger(limitRaw) ? Math.max(1, Math.min(1000, limitRaw)) : 200;
        const file = findTranscript({ ids: [rec.claude_session_id, rec.sid].filter(Boolean), hint: rec.transcript_path, configDir: sessions.configDirFor(rec, configDir) });
        const all = file ? transcripts.read(file) : [];
        const page = [];
        for (const e of all) {
          if (e.n <= after) continue;
          if (page.length >= limit) break;
          page.push(e);
        }
        const next = page.length ? page[page.length - 1].n : after;
        return [200, { messages: page, next, more: all.length > 0 && all[all.length - 1].n > next, status: rec.status }];
      }],
      // The report card (1.5), read-only: an agent's four blocks, the org's totals, a session's Timeline.
      ['GET', /^\/api\/agents\/([^/]+)\/report$/, async (req, m, res, url) => [200, await reports.agentReport(agentParam(m), { window: url.searchParams.get('window') || '7d' })]],
      ['GET', /^\/api\/org\/report$/, (req, m, res, url) => [200, reports.orgReport({ window: url.searchParams.get('window') || '7d' })]],
      // Verified done (1.6). Approving commands, running them and spending the plan happen only from
      // the computer itself (a paired device can read results and send "fix it", nothing more).
      ['GET', /^\/api\/agents\/([^/]+)\/checks$/, (req, m) => [200, checks.view(agentParam(m))]],
      ['PUT', /^\/api\/agents\/([^/]+)\/checks$/, async (req, m) => [200, checks.approve(agentParam(m), await jsonBody(req))], { local: true }],
      ['POST', /^\/api\/agents\/([^/]+)\/checks\/run$/, (req, m) => [202, checks.start(agentParam(m))], { local: true }],
      ['GET', /^\/api\/agents\/([^/]+)\/evals$/, (req, m) => [200, evals.view(agentParam(m))]],
      ['GET', /^\/api\/agents\/([^/]+)\/evals\/estimate$/, (req, m, res, url) => {
        const id = agentParam(m);
        const k = Number(url.searchParams.get('k') || 1);
        if (![1, 3].includes(k)) throw badRequest('k is 1 or 3');
        // models: "default" (the Try-a-cheaper-model matrix) or "model:effort,model:effort"; none = the agent as it is.
        const models = url.searchParams.get('models');
        const cells = models === 'default' ? evals.view(id).matrix : parseCells(models, org.require(id));
        return [200, evals.estimate(id, { k, cells: cells || undefined, judgeModel: url.searchParams.get('judge') || null })];
      }],
      ['POST', /^\/api\/agents\/([^/]+)\/evals\/draft$/, async (req, m) => [200, await evals.draft(agentParam(m))], { local: true }],
      ['POST', /^\/api\/agents\/([^/]+)\/evals\/approve$/, async (req, m) => [200, evals.approve(agentParam(m), await jsonBody(req))], { local: true }],
      ['POST', /^\/api\/agents\/([^/]+)\/evals\/settings$/, async (req, m) => [200, evals.saveSettings(agentParam(m), await jsonBody(req))], { local: true }],
      ['POST', /^\/api\/agents\/([^/]+)\/evals\/run$/, async (req, m) => {
        const b = await jsonBody(req);
        return [202, evals.start(agentParam(m), { k: b.k, maxCostUsd: b.maxCostUsd ?? b.max_cost_usd, models: b.models, judgeModel: b.judgeModel ?? b.judge_model })];
      }, { local: true }],
      ['POST', /^\/api\/agents\/([^/]+)\/evals\/apply$/, async (req, m) => {
        const id = agentParam(m);
        const b = await jsonBody(req);
        const r = evals.apply(id, { model: b.model, effort: b.effort });
        publishOrg('agent_updated', id);
        return [200, r];
      }, { local: true }],
      ['PUT', /^\/api\/agents\/([^/]+)\/evals\/([a-z0-9][a-z0-9-]{0,59})$/, async (req, m) => [200, evals.saveCase(agentParam(m), m[2], await jsonBody(req))], { local: true }],
      ['DELETE', /^\/api\/agents\/([^/]+)\/evals\/([a-z0-9][a-z0-9-]{0,59})$/, (req, m) => [200, evals.removeCase(agentParam(m), m[2])], { local: true }],
      // Claim receipts for one session's chat, and "Ask the agent to fix it" (the exact text shown).
      ['GET', /^\/api\/sessions\/([^/]+)\/claims$/, (req, m) => [200, reports.sessionClaims(sessions.require(sidParam(m)))]],
      ['POST', /^\/api\/sessions\/([^/]+)\/fix$/, async (req, m) => {
        const rec = sessions.require(sidParam(m));
        const b = await jsonBody(req);
        const c = reports.sessionClaims(rec);
        const last = c.claims[c.claims.length - 1];
        if (!last || last.label !== 'contradicted') throw new HttpError(409, 'The last claim in this session is not contradicted any more.');
        const text = fixMessage(last.check);
        if (b.text !== text) throw new HttpError(409, 'The message changed since it was shown. Look at it again before sending.');
        if (rec.status === 'ended') await sessions.resume(rec.sid, {});
        await sessions.send(rec.sid, text, true);
        events.record({ type: 'claims', action: 'fix-sent', sid: rec.sid });
        return [200, { sent: true, text }];
      }],
      ['GET', /^\/api\/sessions\/([^/]+)\/timeline$/, (req, m, res, url) => {
        const sid = sidParam(m);
        const afterRaw = url.searchParams.get('after');
        const after = afterRaw === null || afterRaw === '' ? -1 : Number(afterRaw);
        if (!Number.isInteger(after) || after < -1) throw badRequest('after must be an integer >= -1');
        const limitRaw = Number(url.searchParams.get('limit') || 500);
        const limit = Number.isInteger(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 500;
        // With the detailed timeline on: who approved each tool, and each turn's API requests.
        let out;
        try {
          out = reports.timeline(sid, { after, limit, enrich: (all) => enrich(all, traces.read(sid)), enrichStamp: () => traces.stamp(sid) });
        } catch (err) {
          if (err instanceof HttpError) throw err;
          logger.warn(`timeline ${sid}: ${err.message}`);
          out = { entries: [], next: after, more: false, total: 0, transcript: 'unreadable', status: sessions.get(sid)?.status || null };
        }
        return [200, { ...out, detailed: otelState.read().enabled }];
      }],
      // The whole org for the CTO seat (1.7), schema 2: computed status, receipts, links. Read-only.
      ['GET', /^\/api\/report\/all$/, async (req, m, res, url) => [200, await reports.allReport({ window: url.searchParams.get('window') || '7d', thresholds: cto.state().thresholds })]],
      // The CTO seat. Adding it, running a review (it spends the plan) and its schedule work only on
      // the computer itself; a paired device can read reviews.
      ['GET', /^\/api\/cto$/, async () => [200, await cto.view()]],
      ['POST', /^\/api\/cto$/, () => {
        const a = cto.create();
        publishOrg('agent_created', a.id);
        return [201, a];
      }, { local: true }],
      ['GET', /^\/api\/cto\/estimate$/, async () => [200, await cto.estimate()]],
      ['POST', /^\/api\/cto\/review$/, async () => [201, await cto.startReview()], { local: true }],
      ['GET', /^\/api\/cto\/reviews\/(\d{4}-W\d{2})$/, (req, m) => [200, cto.review(m[1])]],
      ['POST', /^\/api\/cto\/settings$/, async (req) => {
        cto.configure(await jsonBody(req));
        return [200, await cto.view()];
      }, { local: true }],
      // The Monday report: status with the exact text it would send now; {enabled?, day?, hour?}.
      ['GET', /^\/api\/digest$/, () => [200, digest.status()]],
      ['POST', /^\/api\/digest$/, async (req) => [200, digest.configure(await jsonBody(req))]],
      // The detailed timeline (beta): only from the computer itself.
      ['GET', /^\/api\/otel$/, () => [200, otelStatus()]],
      ['POST', /^\/api\/otel$/, async (req) => {
        // The computer itself only: not through a remote address, nor from the Wi-Fi with --host 0.0.0.0.
        if (!loopbackPeer(req.socket.remoteAddress) && req.socket.remoteAddress !== req.socket.localAddress) throw new HttpError(403, 'Only the computer Clawdling runs on can do this. Open Settings there.');
        const b = await jsonBody(req);
        if (typeof b.enabled !== 'boolean') throw badRequest('send {enabled: true|false}');
        if (b.enabled) {
          if (!otelGuarded()) throw new HttpError(409, OTEL_UNGUARDED);
          const pf = otelPreflight();
          if (!pf.clear) {
            const e = new HttpError(409, OTEL_BLOCKED);
            e.body = { found: pf.found.map(({ where, key }) => ({ where, key })) };
            throw e;
          }
        }
        otelState.set(b.enabled);
        writeHooks();
        events.record({ type: 'otel', enabled: b.enabled });
        return [200, otelStatus()];
      }, { local: true }],
      ['POST', /^\/api\/donna\/chat$/, async (req) => {
        const b = await jsonBody(req);
        const text = typeof b.text === 'string' ? b.text.replace(/\0/g, '').trim() : '';
        if (!text) throw badRequest('send {text}');
        if (text.length > 8000) throw new HttpError(413, 'message is longer than 8000 characters');
        events.publish('channel', { channel: 'app', direction: 'in', text: text.slice(0, 500), ts: new Date().toISOString() });
        try {
          const reply = (await donna.handle({ channel: 'app', text })) || 'Done.';
          events.publish('channel', { channel: 'app', direction: 'out', text: reply.slice(0, 500), ts: new Date().toISOString() });
          return [200, { reply }];
        } catch (err) {
          const reason = String(err.message || err).slice(0, 200);
          return [200, { reply: `Donna hit an error: ${reason}`, error: reason }];
        }
      }],
      ['GET', /^\/api\/donna\/messages$/, (req, m, res, url) => {
        const limit = Number(url.searchParams.get('limit') || 50);
        return [200, { messages: donna.messages(Number.isInteger(limit) ? limit : 50) }];
      }],
      // These carry the long-lived token: never through a remote address.
      ['GET', /^\/api\/pair$/, () => [200, pairingInfo({ host, port, token })], { local: true }],
      ['GET', /^\/api\/pair\/qr\.svg$/, (req, m, res, url) => {
        let svg;
        try {
          const info = pairingInfo({ host, port, token });
          // ?target=browser: the link that opens the cockpit in a phone's browser. Default: the app's link.
          svg = qrSvg(url.searchParams.get('target') === 'browser' ? info.browser_link : info.link);
        } catch (err) {
          throw new HttpError(503, `QR code unavailable (${err.code === 'MODULE_NOT_FOUND' ? 'run npm install' : err.message})`);
        }
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(svg) });
        res.end(req.method === 'HEAD' ? undefined : svg);
        return null;
      }, { local: true }],
      ...remoteRoutes(),
      ['GET', /^\/api\/channels$/, () => [200, channelsStatus()]],
      // "Message me when an agent needs me": off by default; {needs_you: true|false}.
      ['GET', /^\/api\/notify$/, () => [200, pinger.status()]],
      ['POST', /^\/api\/notify$/, async (req) => {
        const b = await jsonBody(req);
        if (typeof b.needs_you !== 'boolean') throw badRequest('send {needs_you: true|false}');
        return [200, pinger.setEnabled(b.needs_you)];
      }],
      ['POST', /^\/api\/channels\/telegram$/, async (req) => {
        const b = await jsonBody(req);
        const out = await telegram.configure({ token: b.token, enabled: b.enabled, pair: b.pair });
        return [200, { ...channelsStatus().telegram, ...out }];
      }],
      ['POST', /^\/api\/channels\/imessage$/, async (req) => {
        const b = await jsonBody(req);
        await imessage.configure({ handle: b.handle, enabled: b.enabled });
        return [200, channelsStatus().imessage];
      }],
    ];

    let allowed = null;
    const webDir = path.resolve(opts.webDir || env.CLAWDLING_WEB_DIR || path.join(PKG_ROOT, 'web'));
    // CSP hashes of index.html's inline scripts (the import map), read once.
    let scriptHashes = null;
    function inlineScriptHashes() {
      if (scriptHashes !== null) return scriptHashes;
      let html = '';
      try {
        html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
      } catch {
        // fallback page: no inline scripts
      }
      const out = [];
      for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) out.push(`'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
      scriptHashes = out.join(' ');
      return scriptHashes;
    }

    async function handleApi(req, res, url) {
      const who = req.who;
      const matches = routes.filter(([, re]) => re.test(url.pathname));
      if (!matches.length) return sendJson(res, 404, { error: 'no such API route' });
      const route = matches.find(([method]) => method === req.method || (method === 'GET' && req.method === 'HEAD'));
      if (!route) return sendJson(res, 405, { error: 'method not allowed' });
      const [, re, fn, meta] = route;
      if (who.hello && !meta?.hello) return refuse(res, 'unexpected Host header');
      if (who.remote) {
        // A remote address takes only a paired device's credential, never the long-lived token.
        if (!meta?.public) {
          const a = remoteAuth(req, who, url);
          if (!a.device) {
            if (a.retryAfter) res.setHeader('Retry-After', String(a.retryAfter));
            return sendJson(res, a.status, { error: a.error });
          }
          who.device = a.device;
        }
        if (meta?.local) return sendJson(res, 403, { error: 'Only the computer Clawdling runs on can do this. Open Settings there.' });
        if (req.method !== 'GET' && req.method !== 'HEAD' && !remoteOriginAllowed(req, who.entry)) return sendJson(res, 403, { error: 'cross-origin request refused' });
      } else {
        if (!meta?.public) {
          if (!tokenEquals(extractToken(req, url), token)) return sendJson(res, 401, { error: 'missing or wrong token: open the link printed by `clawdling start`' });
        }
        if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req)) return sendJson(res, 403, { error: 'cross-origin request refused' });
        // Served on a LAN address (--host), the token alone is not "this computer": the request must come
        // from the computer itself (loopback, or a connection to one of its own addresses).
        if (meta?.local && !loopbackPeer(req.socket.remoteAddress) && req.socket.remoteAddress !== req.socket.localAddress) return sendJson(res, 403, { error: 'Only the computer Clawdling runs on can do this. Open Settings there.' });
      }
      const out = await fn(req, url.pathname.match(re), res, url);
      if (out === null) return; // handler streamed its own response
      const [status, body] = out;
      if (status === 204) return noContent(res);
      return sendJson(res, status, body);
    }

    function serveFile(req, res, file, { cache }) {
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        return false;
      }
      if (!st.isFile()) return false;
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': cache,
      });
      if (req.method === 'HEAD') {
        res.end();
        return true;
      }
      fs.createReadStream(file).pipe(res);
      return true;
    }

    function handleStatic(req, res, url) {
      if (req.who.hello) return refuse(res, 'unexpected Host header');
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
      if (url.pathname === '/' && url.searchParams.has('t')) {
        const headers = { Location: '/', 'Cache-Control': 'no-store' };
        // The long-lived token signs in a local browser only; a remote address pairs instead.
        if (!req.who.remote && tokenEquals(url.searchParams.get('t'), token)) headers['Set-Cookie'] = cookieHeader(token);
        res.writeHead(302, headers);
        return res.end();
      }
      if (url.pathname.startsWith('/vendor/')) {
        const file = resolveVendor(url.pathname.slice('/vendor/'.length));
        if (file && serveFile(req, res, file, { cache: 'public, max-age=3600' })) return;
        return sendJson(res, 404, { error: 'not found' });
      }
      let rel;
      try {
        rel = decodeURIComponent(url.pathname);
      } catch {
        return sendJson(res, 400, { error: 'bad path' });
      }
      if (rel.includes('\0') || rel.split('/').some((seg) => seg === '..')) return sendJson(res, 400, { error: 'bad path' });
      if (rel === '/' || rel === '') rel = '/index.html';
      const file = path.resolve(webDir, '.' + rel);
      if (file !== webDir && !file.startsWith(webDir + path.sep)) return sendJson(res, 400, { error: 'bad path' });
      if (serveFile(req, res, file, { cache: 'no-cache' })) return;
      if (rel === '/index.html') {
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        return res.end(req.method === 'HEAD' ? undefined : FALLBACK_INDEX);
      }
      return sendJson(res, 404, { error: 'not found' });
    }

    /**
     * POST /otlp/v1/{logs,metrics,traces}: Claude Code's own telemetry from the sessions on this
     * computer. Loopback peer and loopback Host only, never through a remote address, no browser
     * Origin, the org's secret header (constant time), JSON only, 1 MB, 50 requests a second, and
     * only while the detailed timeline is on. Identity and content attributes are dropped (otel.js).
     */
    async function handleOtlp(req, res, url) {
      if (req.who.remote || req.who.hello) return refuse(res, 'Telemetry is accepted only from this computer.');
      if (!loopbackPeer(req.socket.remoteAddress)) return sendJson(res, 403, { error: 'Telemetry is accepted only from this computer.' });
      if (req.headers.origin !== undefined) return sendJson(res, 403, { error: 'cross-origin request refused' });
      const kind = OTLP_KINDS[url.pathname];
      if (!kind) return sendJson(res, 404, { error: 'not found' });
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      if (!otelState.read().enabled) return sendJson(res, 404, { error: 'the detailed timeline is off' });
      if (!otelGuarded()) return sendJson(res, 404, { error: 'the detailed timeline is off here' });
      const sid = otelState.sidFor(req.headers[SECRET_HEADER]);
      const rec = sid ? sessions.get(sid) : null;
      if (!rec) return sendJson(res, 401, { error: 'missing or wrong telemetry secret' });
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return sendJson(res, 415, { error: 'send OTLP/JSON (OTEL_EXPORTER_OTLP_PROTOCOL=http/json)' });
      if (Number(req.headers['content-length']) > INGEST_MAX_BYTES) {
        res.setHeader('Connection', 'close');
        return sendJson(res, 413, { error: 'telemetry request over 1 MB' });
      }
      if (!otelLimit.allow(sid)) return sendJson(res, 429, { error: 'too many telemetry requests' });
      // At most a few uploads in flight (so at most a few MB buffered), each finished within 10 s.
      if (otelInflight >= OTLP_INFLIGHT_MAX) return sendJson(res, 429, { error: 'too many telemetry requests in flight' });
      otelInflight++;
      let deadline;
      let text;
      try {
        text = await Promise.race([
          readBody(req, INGEST_MAX_BYTES),
          new Promise((resolve, reject) => {
            deadline = setTimeout(() => {
              reject(new HttpError(408, 'telemetry upload took too long'));
              req.destroy();
            }, 10000);
            req.once('close', () => { if (!req.complete) reject(new HttpError(400, 'telemetry upload was cut off')); });
          }),
        ]);
      } finally {
        clearTimeout(deadline);
        otelInflight--;
      }
      let items;
      try {
        // Only this session's own records (its Clawdling id, or Claude Code's id for it after a resume).
        const ids = new Set([sid, rec.claude_session_id].filter((x) => isUuid(x)));
        items = normalize(kind, JSON.parse(text), { only: ids }).map((x) => ({ sid, rec: x.rec }));
      } catch {
        return sendJson(res, 400, { error: 'invalid OTLP/JSON' }); // a bad payload is never logged
      }
      traces.append(items);
      return sendJson(res, 200, {});
    }

    const handleRequest = (req, res) => {
      securityHeaders(res);
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        return sendJson(res, 400, { error: 'bad url' });
      }
      const work = classify(req, url).then((who) => {
        if (who.refused) return refuse(res, who.refused);
        req.who = who;
        if (who.remote) {
          res.setHeader('Strict-Transport-Security', 'max-age=31536000');
          // Through a remote address, only this cockpit's own scripts run (an edge that injects a
          // script into pages could otherwise read the device key) and it talks only to itself.
          // Only the cockpit's own script paths, so even a script an edge serves from this origin
          // (Cloudflare's /cdn-cgi/...) does not run.
          const origin = `${who.entry.port === 443 ? who.entry.host : `${who.entry.host}:${who.entry.port}`}`;
          const own = ['/app.js', '/components/', '/lib/', '/vendor/'].map((p) => `https://${origin}${p}`).join(' ');
          res.setHeader('Content-Security-Policy', `frame-ancestors 'none'; object-src 'none'; base-uri 'self'; script-src ${own} ${inlineScriptHashes()}; worker-src 'none'; connect-src 'self' wss://${origin}`);
        }
        if (url.pathname.startsWith('/otlp/')) return handleOtlp(req, res, url);
        return url.pathname.startsWith('/api/') ? handleApi(req, res, url) : handleStatic(req, res, url);
      });
      work.catch((err) => {
        const status = err instanceof HttpError || err instanceof RemoteError ? err.status : 500;
        if (status >= 500) logger.error(`${req.method} ${url.pathname}: ${err.stack || err.message}`);
        if (err.retryAfter && !res.headersSent) res.setHeader('Retry-After', String(err.retryAfter));
        if (!res.headersSent) sendJson(res, status, { error: status >= 500 && !(err instanceof HttpError) ? 'internal error' : err.message, ...(err.body || {}) });
        else res.end();
      });
    };

    const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    const handleUpgrade = (req, sock, head) => {
      const reject = (code, text) => {
        sock.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        sock.destroy();
      };
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        return reject(400, 'Bad Request');
      }
      classify(req, url).then((who) => {
        if (who.refused || who.hello) return reject(403, 'Forbidden');
        if (who.remote) {
          if (!remoteOriginAllowed(req, who.entry)) return reject(403, 'Forbidden');
          const a = remoteAuth(req, who, url);
          if (!a.device) return reject(a.status, a.status === 429 ? 'Too Many Requests' : 'Unauthorized');
          who.device = a.device;
        } else {
          if (!originAllowed(req)) return reject(403, 'Forbidden');
          if (!tokenEquals(extractToken(req, url, { allowQuery: true }), token)) return reject(401, 'Unauthorized');
        }
        const m = url.pathname.match(/^\/ws\/term\/([^/]+)$/);
        if (!m || !isUuid(m[1]) || !sessions.get(m[1])) return reject(404, 'Not Found');
        const size = { cols: url.searchParams.get('cols'), rows: url.searchParams.get('rows') };
        wss.handleUpgrade(req, sock, head, (ws) => {
          if (who.remote) trackRemote(who, () => ws.terminate(), ws);
          sessions.attachViewer(m[1], ws, size);
        });
      }).catch((err) => {
        logger.error(`upgrade ${url.pathname}: ${err.stack || err.message}`);
        reject(500, 'Internal Server Error');
      });
    };

    const extra = String(env.CLAWDLING_ALLOWED_HOSTS || '').split(',').filter(Boolean);
    allowed = allowedHosts({ host, port, extra });
    if (!isLoopback(host)) logger.warn(`listening on ${host}: anyone who can reach this address and has the token can drive your sessions`);

    // Use from anywhere: a change to remote.json made outside this process (a hand edit, or
    // `clawdling remote remove` while this server was briefly unreachable) still closes remote
    // connections within two seconds.
    let remoteStamp = remote.read() && remote.stamp;
    const remoteWatch = setInterval(() => {
      remote.read();
      if (remote.stamp !== remoteStamp) {
        remoteStamp = remote.stamp;
        sweepRemote();
      }
    }, 2000);
    remoteWatch.unref?.();
    // While it is on, every address is checked again every 10 minutes, so a Funnel or a TCP
    // forward turned on later (by anyone) stops the address without waiting for Check again.
    let rechecking = false;
    const remoteRecheck = setInterval(() => {
      if (rechecking || !remote.read().enabled) return;
      rechecking = true;
      checkAll().catch((err) => logger.warn(`remote: periodic check failed: ${err.message}`)).finally(() => {
        rechecking = false;
      });
    }, Number(env.CLAWDLING_REMOTE_RECHECK_MS) > 0 && testMode ? Number(env.CLAWDLING_REMOTE_RECHECK_MS) : 10 * 60 * 1000);
    remoteRecheck.unref?.();
    let quickRunning = false;
    const remoteQuick = setInterval(() => {
      if (quickRunning || rechecking) return;
      quickRunning = true;
      quickServeCheck().catch((err) => logger.warn(`remote: serve check failed: ${err.message}`)).finally(() => {
        quickRunning = false;
      });
    }, Number(env.CLAWDLING_REMOTE_QUICK_MS) > 0 && testMode ? Number(env.CLAWDLING_REMOTE_QUICK_MS) : 60 * 1000);
    remoteQuick.unref?.();

    onRequest = handleRequest;
    onUpgrade = handleUpgrade;
    writeJson(paths.server, { pid: process.pid, port, host, version: VERSION, home, backend: backend.kind, socket, started_at: new Date().toISOString() }, 0o600);
    sessions.replaySpool(); // hooks that got a 503 while we were starting were spooled
    telegram.start();
    imessage.start();
    reports.backfill();
    // Scratch worktrees and copies a crash left behind (ship checks, check-ups).
    checks.sweep().catch((err) => logger.warn(`checks: ${err.message}`));
    evals.sweep().catch((err) => logger.warn(`evals: ${err.message}`));
    // The detailed timeline's records: 14 days, 50 MB, checked at start and every hour.
    const tracePrune = () => {
      try {
        traces.trim();
        traces.prune();
      } catch (err) {
        logger.warn(`traces: ${err.message}`);
      }
    };
    tracePrune();
    const traceTimer = setInterval(tracePrune, 3600000);
    traceTimer.unref?.();
    digest.start(testMode && Number(env.CLAWDLING_DIGEST_CHECK_MS) > 0 ? Number(env.CLAWDLING_DIGEST_CHECK_MS) : undefined);
    cto.start(testMode && Number(env.CLAWDLING_CTO_CHECK_MS) > 0 ? Number(env.CLAWDLING_CTO_CHECK_MS) : undefined);

    const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
    const baseUrl = `http://${urlHost}:${port}`;
    let stopped = false;

    async function stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(remoteWatch);
      clearInterval(remoteRecheck);
      clearInterval(remoteQuick);
      telegram.stop();
      imessage.stop();
      pinger.stop();
      digest.stop();
      cto.stop();
      clearInterval(traceTimer);
      reports.stopped = true;
      checks.stop();
      evals.stop();
      donna.stop();
      found.worker?.terminate().catch(() => {});
      await sessions.shutdown();
      events.closeAll();
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections?.();
      });
      const cur = readJson(paths.server, null);
      if (cur && cur.pid === process.pid) {
        try {
          fs.unlinkSync(paths.server);
        } catch {
          // ignore
        }
      }
    }

    logger.info(`Clawdling ${VERSION} listening on ${baseUrl} (home ${home}, sessions: ${backend.kind === 'tmux' ? `tmux -L ${socket}` : `pty, ${backendInfo.version}`})`);
    return {
      port,
      host,
      url: baseUrl,
      openUrl: `${baseUrl}/?t=${token}`,
      token,
      home,
      socket,
      paths,
      sessions,
      org,
      events,
      telegram,
      imessage,
      donna,
      reports,
      checks,
      evals,
      digest,
      cto,
      otel: { state: otelState, traces },
      backend,
      tmux: backend,
      stop,
      cookieName: COOKIE_NAME,
    };
  }
}

/** The server that owns this home right now, if any: a live pid in server.json that answers /api/health. */
export async function liveServer(paths, home) {
  const info = readJson(paths.server, null);
  if (!info || !Number.isInteger(info.pid) || !Number.isInteger(info.port) || info.pid === process.pid) return null;
  try {
    process.kill(info.pid, 0);
  } catch (e) {
    if (e.code !== 'EPERM') return null;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/health`, { signal: AbortSignal.timeout(2000) });
    const h = res.ok ? await res.json() : null;
    return h && h.home === home ? { pid: info.pid, port: info.port, host: info.host } : null;
  } catch {
    return null;
  }
}

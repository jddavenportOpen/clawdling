// The setup safety audit (1.8): for each agent, and for the user-level Claude Code setup every agent
// inherits, which of the three legs of the "lethal trifecta" its sessions load:
//   private   it can read private data,
//   untrusted it reads content someone else wrote (a web page, an email, an issue),
//   sends     it can send data out.
// An agent with all three can be tricked by the second into leaking the first through the third
// (Simon Willison's framing: https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/).
//
// A pure function over the names-only scan in discover.js (scanSafety) and Clawdling's own state:
// it reads no file, opens no socket and starts no process. Classification is by NAME
// (capabilities.json); a name it does not know is "unknown: review", never safe, and the verdict
// says "no trifecta found by name", never "secure". Fixes are text: Clawdling changes nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { permissionSetting, PERMISSION_LABEL } from './permissions.js';

const TABLE = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'capabilities.json'), 'utf8'));
export const CAPS = ['private', 'untrusted', 'sends'];
export const CAP_LABEL = { private: 'Private data', untrusted: 'Untrusted input', sends: 'Sends out' };
export const USER_ROW = '_user';
const MAX_FIXES = 3;

// ---------------------------------------------------------------------------- names

/** A name as words: lower case, every run of other characters one dash ("@x/Gmail_MCP" -> "x-gmail-mcp"). */
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Does the name hold the word (or the dashed phrase) as whole words? */
function hasWord(name, word) {
  const n = `-${norm(name)}-`;
  return n.includes(`-${norm(word)}-`);
}

/**
 * What the table knows about a name (an MCP server's key, command or package; a plugin's name):
 * `{known, caps: Set, labels: []}`. A name matching only "local helper" is known with no caps.
 */
export function classifyName(...names) {
  const caps = new Set();
  const labels = [];
  let known = false;
  for (const entry of TABLE.servers) {
    if (!names.some((n) => n && entry.words.some((w) => hasWord(n, w)))) continue;
    known = true;
    for (const c of entry.caps) caps.add(c);
    if (entry.caps.length && !labels.includes(entry.label)) labels.push(entry.label);
  }
  return { known, caps, labels };
}

// ---------------------------------------------------------------------------- permission rules

/** `Bash(curl:*)` -> {tool: 'Bash', content: 'curl:*'}; `WebFetch` -> {tool: 'WebFetch', content: null}. */
export function parseRule(rule) {
  const m = /^\s*([A-Za-z_][\w-]*)\s*(?:\((.*)\))?\s*$/s.exec(String(rule || ''));
  if (!m) return null;
  return { tool: m[1], content: m[2] === undefined ? null : m[2] };
}

const SHELLS = new Set(['Bash', 'PowerShell']);

/**
 * Does a Bash/PowerShell rule let the agent send data out? `{why}` or null. A rule with no command
 * (`Bash`, `Bash(*)`, `Bash(:*)`) is unrestricted.
 */
export function shellRuleSends(content) {
  if (content === null || /^\s*:?\*?\s*$/.test(content)) return { why: 'runs any command' };
  const raw = content.trim();
  // `cur*` (no space or colon before the star): every command whose name starts with "cur".
  const partial = /^[^\s:*]+\*$/.test(raw) ? raw.slice(0, -1).split(/[\\/]/).pop().toLowerCase() : null;
  if (partial !== null) {
    for (const e of TABLE.commands) {
      const hit = e.match !== 'verbs' && e.words.find((w) => w.startsWith(partial));
      if (hit) return { why: `${e.why} (covers ${hit})` };
    }
  }
  let c = raw;
  let wildcard = false;
  if (/:\*$/.test(c)) {
    wildcard = true;
    c = c.slice(0, -2);
  }
  if (c.includes('*')) wildcard = true;
  // Command chains inside one rule: judge every part.
  for (const part of c.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean)) {
    const toks = part.replace(/\*/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (!toks.length) return wildcard ? { why: 'runs any command' } : null;
    const word = toks[0].split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
    const rest = toks.slice(1).map((t) => t.toLowerCase());
    for (const e of TABLE.commands) {
      if (!e.words.includes(word)) continue;
      if (e.match === 'any' && wildcard) return { why: e.why };
      if (e.match === 'verbs' && ((wildcard && rest.length === 0) || rest.some((r) => e.verbs.includes(r)))) return { why: e.why };
      if (e.match === 'bare' && wildcard && (rest.length === 0 || (e.flags || []).includes(rest[0]))) return { why: e.why };
    }
  }
  return null;
}

/** Is an absolute or home Read rule (`Read(//x/**)`, `Read(~/**)`) outside the agent's folder? */
function readOutside(content, folder, home, orgHome) {
  if (!content) return null;
  const c = content.trim();
  let target = null;
  if (c.startsWith('//')) target = c.slice(1);
  else if (/^~(?:\/|$)/.test(c)) target = home ? `${home.replace(/[\\/]+$/, '')}${c.slice(1)}` : c;
  else return null;
  const base = target.replace(/\/?\*\*?$/, '').replace(/\/+$/, '') || '/';
  const inside = (dir) => {
    if (!dir) return false;
    const d = String(dir).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, x) => `/${x.toLowerCase()}`).replace(/\/+$/, '');
    return base === d || base.startsWith(`${d}/`);
  };
  if (inside(folder)) return null;
  if (orgHome && inside(orgHome)) return { text: `\`Read(${c})\` allowed (every agent's folder in the org)` };
  return { text: `\`Read(${c})\` allowed (files outside this agent's folder)` };
}

/** Does deny rule `d` take away allow rule `a`? Same tool, and the deny covers the allow's content. */
function denies(d, a) {
  if (!d || !a || d.tool !== a.tool) return false;
  if (d.content === null || /^\s*:?\*\s*$/.test(d.content)) return true;
  if (a.content === null) return false;
  const strip = (s) => s.trim().replace(/:\*$/, '').replace(/\s*\*$/, '');
  const dc = strip(d.content);
  const ac = strip(a.content);
  return ac === dc || ac.startsWith(`${dc} `) || (/\*$/.test(d.content.trim()) && ac.startsWith(dc));
}

/** Is MCP server `name` denied by a rule like `mcp__name` or `mcp__name__*`? */
function mcpDenied(name, denyRules) {
  const want = `mcp__${name}`.toLowerCase();
  return denyRules.some((r) => {
    const t = String(r.tool || '').toLowerCase();
    return (t === want || t === `${want}__*`) && r.content === null;
  });
}

// ---------------------------------------------------------------------------- one agent's view

/**
 * What one agent's sessions load: `layers` = [{label, facts}] settings files (user, managed, the
 * folder's settings.json and settings.local.json), `mcp` = [{...mcpFacts, scope, source}],
 * `plugins` = [{name, marketplace, enabled}] (user-level ones, when user settings load), plus the
 * permission mode it runs in and what Clawdling itself gives it (`own`: capabilities by source).
 */
function capsFor(view, { tags = {} } = {}) {
  const chips = { private: [], untrusted: [], sends: [] };
  const unknown = [];
  const add = (cap, text, source, fix) => {
    if (!chips[cap].some((x) => x.text === text && x.source === source)) chips[cap].push({ text, source, ...(fix ? { fix } : {}) });
  };
  const allRules = (kind) => view.layers.flatMap((l) => (l.facts ? (l.facts[kind] || []).map((r) => ({ rule: r, parsed: parseRule(r), layer: l })) : []));
  const deny = allRules('deny').map((x) => x.parsed).filter(Boolean);
  const allowed = allRules('allow').filter((x) => x.parsed && !deny.some((d) => denies(d, x.parsed)));
  const toolDenied = (tool) => deny.some((d) => d.tool === tool && (d.content === null || /^\s*:?\*\s*$/.test(d.content)));

  for (const { rule, parsed, layer } of allowed) {
    const where = layer.file;
    // A rule from your own (or managed) settings reaches every agent: on an agent, the narrower fix
    // is a deny rule in its own folder, which wins over an allow from any layer.
    const shared = (layer.kind === 'user' || layer.kind === 'managed') && !view.isUserRow;
    const removeFix = shared ? `stop this agent using \`${rule}\`: add it to \`permissions.deny\` in ${view.denyFile}` : `remove \`${rule}\` from \`allow\` in ${where}`;
    if (parsed.tool === 'WebFetch') {
      add('untrusted', `\`${rule}\` allowed`, where, `turn off WebFetch for this agent: add "WebFetch" to \`permissions.deny\` in ${view.denyFile}`);
      add('sends', `\`${rule}\` allowed (a URL is a channel)`, where, `turn off WebFetch for this agent: add "WebFetch" to \`permissions.deny\` in ${view.denyFile}`);
    } else if (parsed.tool === 'WebSearch') {
      add('untrusted', `\`${rule}\` allowed`, where, `turn off WebSearch for this agent: add "WebSearch" to \`permissions.deny\` in ${view.denyFile}`);
    } else if (SHELLS.has(parsed.tool)) {
      const s = shellRuleSends(parsed.content);
      if (s) add('sends', `\`${rule}\` allowed (${s.why})`, where, removeFix);
    } else if (parsed.tool === 'Read') {
      const r = readOutside(parsed.content, view.folderPosix, view.homePosix, view.orgPosix);
      if (r) add('private', r.text, where, removeFix);
    } else if (/^mcp__/i.test(parsed.tool)) {
      // An allowed MCP tool: classified with its server below (the server's own entry carries it).
    }
  }

  // The permission mode the sessions run in.
  const mode = view.mode;
  if (mode && mode.name === 'bypassPermissions') {
    add('sends', 'Bypass permissions mode (any command runs without asking)', mode.source, mode.fix);
    if (!toolDenied('WebFetch')) add('untrusted', 'Bypass permissions mode (WebFetch runs without asking)', mode.source, mode.fix);
  } else if (mode && mode.name === 'auto') {
    add('sends', 'Auto mode (commands run when its classifier allows them)', mode.source, mode.fix);
    if (!toolDenied('WebFetch')) add('untrusted', 'Auto mode (WebFetch can run without asking)', mode.source, mode.fix);
  }

  // Extra folders that are the home folder (or a big folder in it).
  for (const l of view.layers) for (const d of (l.facts && l.facts.home_dirs) || []) add('private', `extra folder ${d} (additionalDirectories)`, l.file, `remove ${d} from \`additionalDirectories\` in ${l.file}`);
  for (const d of view.homeAddDirs || []) add('private', `your home folder (\`--add-dir ${d}\`: the org folder is your home folder)`, 'Clawdling', null);

  // MCP servers, by name.
  for (const s of view.mcp) {
    if (mcpDenied(s.name, deny)) continue;
    const tagged = Array.isArray(tags[s.name]) ? tags[s.name].filter((c) => CAPS.includes(c)) : null;
    const k = tagged ? { known: true, caps: new Set(tagged), labels: ['tagged by you'] } : classifyName(s.name, s.command, s.package, s.host);
    const what = `${s.name} MCP server${k.labels.length ? ` (${k.labels.join(', ')})` : ''}`;
    const fix = s.scope === 'user'
      ? `stop this agent loading the ${s.name} MCP server: add "mcp__${s.name}" to \`permissions.deny\` in ${view.denyFile}`
      : `remove the ${s.name} server from ${s.source}`;
    if (!k.known) {
      unknown.push({ text: what, source: s.source, why: 'unknown: review what it can do' });
      continue;
    }
    for (const c of k.caps) add(c, what, s.source, fix);
  }

  // Plugins (user level): by name, the same table. A plugin can bring its own MCP servers and hooks.
  for (const p of view.plugins) {
    if (!p.enabled) continue;
    const k = classifyName(p.name);
    const what = `${p.name} plugin${k.labels.length ? ` (${k.labels.join(', ')})` : ''}`;
    const src = view.pluginSource;
    if (!k.known) {
      unknown.push({ text: what, source: src, why: 'unknown: a plugin can add MCP servers and hooks' });
      continue;
    }
    for (const c of k.caps) add(c, what, src, `turn off the ${p.name} plugin (\`/plugin\` in Claude Code) if this agent does not need it`);
  }

  // What Clawdling itself gives this agent (Donna's channel, the CTO's report).
  for (const o of view.own || []) add(o.cap, o.text, o.source, o.fix || null);
  return { chips, unknown };
}

/** The risks (US-88 in the spec, US-93 here) one agent's setup carries. */
function risksFor(view) {
  const risks = [];
  const add = (id, text, file) => {
    if (!risks.some((r) => r.id === id && r.file === file && r.text === text)) risks.push({ id, text, file });
  };
  const userLevel = (l) => l.kind === 'user' || l.kind === 'managed';
  for (const l of view.layers) {
    const f = l.facts;
    if (!f) continue;
    // A user-level switch shows on the user-level row, and on an agent only when it applies to its
    // sessions (the agent uses "Your Claude Code setting"); the agent's own files always show.
    const show = !(userLevel(l) && view.overridesMode) && !(userLevel(l) && !view.isUserRow && !view.inheritsMode);
    const note = view.overridesMode ? ` Clawdling starts this agent in "${view.overridesMode}" mode, so it applies when you run claude here yourself.` : '';
    if (show && (f.default_mode === 'bypassPermissions' || f.skip_bypass_prompt)) {
      const what = f.default_mode === 'bypassPermissions' ? 'turns on bypass permissions mode (`defaultMode: bypassPermissions`)' : 'turns off the warning before bypass permissions mode (`skipDangerousModePermissionPrompt`)';
      add('bypass', `This settings file ${what}.${note}`, l.file);
    }
    if (show && f.default_mode === 'auto') {
      add('auto_mode', `This settings file turns on auto mode (\`defaultMode: auto\`): commands run when Claude Code's classifier allows them, and prompt injection has beaten it in public tests.${note}`, l.file);
    }
    if (l.repo && l.kind === 'project') {
      const ss = (f.hooks || []).find((h) => h.event === 'SessionStart');
      if (ss) add('session_start', `This repo runs ${ss.count === 1 ? 'a command' : `${ss.count} commands`} whenever a session starts (a SessionStart hook in its own settings), before you type anything. A package or a pull request can plant one: read it before you trust the folder.`, l.file);
    }
  }
  for (const s of view.mcp) {
    if (s.scope === 'project') add('repo_mcp', `This repo defines the ${s.name} MCP server in .mcp.json: code the repo controls, which runs once you approve it.`, s.source);
  }
  if (view.localNotIgnored) add('local_not_ignored', 'This repo has a .claude/settings.local.json that no .gitignore rule covers: your personal allow rules (and anything pasted into them) can be committed and published.', view.localNotIgnored);
  // Plugins load in every agent that loads your settings: listed once, on the user-level row.
  if (view.isUserRow) {
    for (const p of view.plugins) {
      if (p.official) continue;
      add('marketplace', p.claims
        ? `The ${p.name} plugin comes from a marketplace named "${p.marketplace}" whose source is not Anthropic's: check where it came from.`
        : `The ${p.name} plugin comes from ${p.marketplace ? `the "${p.marketplace}" marketplace` : 'a marketplace Clawdling could not name'}, not Anthropic's official one.`, view.pluginSource);
    }
  }
  return risks;
}

/** One plain sentence: what could happen, naming one item from each leg. */
function trifectaSentence(chips) {
  // "`Bash(curl:*)` allowed (can send data out)" -> "Bash(curl:*)"; "gmail MCP server (mail)" -> "gmail MCP server".
  const root = (x) => x.text.replace(/\s+\([^()]*\)$/, '').replace(/`/g, '').replace(/ allowed$/, '');
  const used = new Set();
  const pick = (c) => {
    const x = chips[c].find((y) => !used.has(root(y))) || chips[c][0];
    used.add(root(x));
    return root(x);
  };
  const u = pick('untrusted');
  const p = pick('private');
  const out = pick('sends');
  return `Text this agent reads through ${u} could tell it to take your data from ${p} and send it out with ${out}.`;
}

/** Up to three fixes, from the leg that is cheapest to remove (the fewest items). */
function fixesFor(chips) {
  const legs = [...CAPS].sort((a, b) => chips[a].length - chips[b].length || CAPS.indexOf(b) - CAPS.indexOf(a));
  for (const leg of legs) {
    const fixes = [...new Set(chips[leg].map((x) => x.fix).filter(Boolean))];
    // Only a leg whose every item has a fix can be cut with text alone.
    if (fixes.length && fixes.length <= MAX_FIXES && chips[leg].every((x) => x.fix)) {
      return fixes.map((f) => f.charAt(0).toUpperCase() + f.slice(1));
    }
  }
  const leg = legs[0];
  const out = [...new Set(chips[leg].map((x) => x.fix).filter(Boolean))].slice(0, MAX_FIXES - 1);
  out.push(`Or start this agent in a folder without ${CAP_LABEL[leg].toLowerCase()} (${chips[leg].length} sources): give it only what this job needs`);
  return out.map((f) => f.charAt(0).toUpperCase() + f.slice(1));
}

function verdictOf(row) {
  if (row.trifecta && !row.accepted) return 'red';
  if (row.trifecta || row.risks.length || row.unknown.length) return 'amber';
  return 'green';
}

const SUMMARY = {
  red: 'Lethal trifecta',
  amber: 'Review',
  green: 'No trifecta found by name',
};

function finish(base, view, opts) {
  const { chips, unknown } = capsFor(view, opts);
  const trifecta = CAPS.every((c) => chips[c].length > 0);
  const risks = risksFor(view);
  const accepted = opts.accepted && opts.accepted[base.id] ? { reason: String(opts.accepted[base.id].reason || ''), at: opts.accepted[base.id].at || null } : null;
  const row = {
    ...base,
    mode: view.mode ? view.mode.label : null,
    loads: view.layers.filter((l) => l.facts).map((l) => l.file),
    chips: Object.fromEntries(CAPS.map((c) => [c, chips[c].map(({ text, source }) => ({ text, source }))])),
    unknown,
    trifecta,
    risks,
    notes: view.notes || [],
    accepted: trifecta ? accepted : null,
  };
  row.sentence = trifecta ? trifectaSentence(chips) : null;
  row.fixes = trifecta ? fixesFor(chips) : [];
  row.verdict = verdictOf(row);
  row.summary = row.verdict === 'amber' && row.trifecta ? 'Lethal trifecta (accepted)' : row.verdict === 'amber' ? (row.risks.length ? `${row.risks.length} setup risk${row.risks.length === 1 ? '' : 's'}` : `${row.unknown.length} unknown to review`) : SUMMARY[row.verdict];
  return row;
}

// ---------------------------------------------------------------------------- the audit

const posix = (p) => (p ? String(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, d) => `/${d.toLowerCase()}`).replace(/\/+$/, '') : null);

function modeFrom(layers) {
  // Claude Code's precedence: managed, then local, then project, then user.
  for (const kind of ['managed', 'local', 'project', 'user']) {
    for (const l of layers) if (l.kind === kind && l.facts && l.facts.default_mode) return { name: l.facts.default_mode, source: l.file, fix: `remove \`defaultMode\` from ${l.file}, or pick a mode for this agent in Clawdling` };
  }
  return null;
}

/**
 * The audit. `scan` = discover.scanSafety(); `agents` = the org's agents (Donna and the CTO
 * included: kind 'chief' and 'cto'); `org` = {home, channels: {telegram: {configured, paired,
 * enabled}, imessage: {enabled, saved}}, donnaTools: [rules], cto: {allow, ask, deny}}; `opts` =
 * {accepted: {id: {reason, at}}, tags: {server: caps[]}, home}. Returns {took_ms, rows: [...]},
 * the user level first.
 */
export function auditSafety({ scan, agents = [], org = {}, accepted = {}, tags = {}, home = null, platform = process.platform } = {}) {
  const t0 = performance.now();
  const opts = { accepted, tags };
  const u = scan.user || {};
  const official = new Set(TABLE.official_marketplaces);
  const repoOf = new Map((u.marketplaces || []).map((m) => [m.name, m.repo]));
  const plugins = (u.plugins || []).map((p) => {
    const named = !!p.marketplace && official.has(p.marketplace);
    const repo = p.marketplace ? repoOf.get(p.marketplace) : null;
    const ownerOk = !repo || TABLE.official_owners.includes(String(repo).split('/')[0].toLowerCase());
    return { ...p, official: named && ownerOk, claims: named && !ownerOk };
  });
  const pluginSource = `${u.config_dir || '~/.claude'}${platform === 'win32' ? '\\' : '/'}settings.json (plugins)`;
  const userLayers = [
    ...(u.managed || []).map((f) => ({ kind: 'managed', file: f.file, facts: f })),
    ...(u.settings ? [{ kind: 'user', file: u.settings.file, facts: u.settings }] : []),
  ];
  const userMcp = (u.mcp || []).map((s) => ({ ...s, scope: 'user', source: '~/.claude.json (mcpServers)' }));
  const homePosix = posix(home);
  const orgPosix = posix(org.home);
  const rows = [];

  // Everything (user level): what a plain `claude` anywhere on this computer loads.
  const userView = {
    layers: userLayers, mcp: userMcp, plugins, pluginSource, homePosix, orgPosix, folderPosix: null, isUserRow: true,
    denyFile: u.settings ? u.settings.file : `${u.config_dir || '~/.claude'}/settings.json`,
    mode: (() => {
      const m = modeFrom(userLayers);
      return m ? { ...m, label: m.name } : null;
    })(),
  };
  rows.push(finish({ id: USER_ROW, name: 'Everything (user level)', kind: 'user', folder: u.config_dir || null }, userView, opts));

  for (const a of agents) {
    if (!a || typeof a.id !== 'string') continue;
    const cwd = a.cwd || a.dir;
    const d = (scan.dirs && scan.dirs[cwd]) || {};
    const isRepo = a.kind === 'project' && !!a.repo && cwd === a.repo;
    const folderLayers = [
      ...(d.settings ? [{ kind: 'project', file: d.settings.file, facts: d.settings, repo: isRepo && d.in_repo }] : []),
      ...(d.local ? [{ kind: 'local', file: d.local.file, facts: d.local, repo: isRepo && d.in_repo }] : []),
    ];
    // A deny rule wins over an allow from any layer: in a repo, the personal (local) file; in an
    // agent's own folder, its settings.json.
    const denyFile = `${d.path || cwd}${platform === 'win32' ? '\\' : '/'}.claude${platform === 'win32' ? '\\' : '/'}${isRepo ? 'settings.local.json' : 'settings.json'}`;
    const folderMcp = [
      ...(d.mcp_json || []).map((s) => ({ ...s, scope: isRepo ? 'project' : 'folder', source: `${d.path || cwd}${platform === 'win32' ? '\\' : '/'}.mcp.json` })),
      ...(d.mcp_local || []).map((s) => ({ ...s, scope: 'local', source: `~/.claude.json (this folder's mcpServers)` })),
    ];
    const base = { id: a.id, name: a.name || a.id, kind: a.kind, folder: d.path || cwd };
    let view;
    if (a.kind === 'chief') {
      // Donna's text-message turns: only her folder's settings (no user level), no MCP servers at
      // all, "dontAsk" with her own allow-list, and her channel.
      const own = [];
      const notes = [];
      const tg = (org.channels && org.channels.telegram) || {};
      const im = (org.channels && org.channels.imessage) || {};
      if (im.enabled) own.push({ cap: 'private', text: 'iMessage: reads your Messages to find your texts', source: 'Clawdling (Donna\'s channel)' });
      if (tg.configured && tg.enabled !== false) own.push({ cap: 'sends', text: 'Telegram: replies to your chat', source: 'Clawdling (Donna\'s channel)' });
      if (im.enabled) own.push({ cap: 'sends', text: 'iMessage: replies to your handle', source: 'Clawdling (Donna\'s channel)' });
      if ((tg.configured && tg.paired) || im.enabled) notes.push('Only your own paired Telegram chat and your own iMessage handle reach Donna, so what she is sent is not untrusted input.');
      if (tg.configured && !tg.paired) notes.push('Telegram is not paired yet: until it is, Donna answers nobody.');
      notes.push('Your own Claude Code settings and MCP servers do not load in her text-message turns.');
      view = {
        layers: [...(u.managed || []).map((f) => ({ kind: 'managed', file: f.file, facts: f })), ...folderLayers, { kind: 'clawdling', file: 'Clawdling (Donna\'s allow-list)', facts: { allow: org.donnaTools || [] } }],
        mcp: [], plugins: [], pluginSource, homePosix, orgPosix, folderPosix: posix(cwd), denyFile, own, notes,
        mode: { name: 'dontAsk', label: "Don't ask (only her allow-list)", source: 'Clawdling' },
      };
    } else if (a.kind === 'cto') {
      const cto = org.cto || {};
      view = {
        layers: [...(u.managed || []).map((f) => ({ kind: 'managed', file: f.file, facts: f })), ...folderLayers.filter((l) => l.kind === 'project'), { kind: 'clawdling', file: 'Clawdling (the CTO seat)', facts: { allow: cto.allow || [], ask: cto.ask || [], deny: cto.deny || [] } }],
        mcp: [], plugins: [], pluginSource, homePosix, orgPosix, folderPosix: posix(cwd), denyFile,
        own: [
          { cap: 'private', text: 'the org report: every agent\'s session titles and last lines', source: 'Clawdling (the CTO seat)' },
          { cap: 'untrusted', text: 'agent-written text in that report (Clawdling marks it as data, not instructions)', source: 'Clawdling (the CTO seat)' },
        ],
        notes: ['Messages to other agents (`clawdling send`, `clawdling spawn`) always ask you first. The web is denied.', 'Your own Claude Code settings and MCP servers do not load in its sessions.'],
        mode: { name: 'default', label: PERMISSION_LABEL.ask, source: 'Clawdling' },
      };
    } else {
      const setting = permissionSetting(a.permission_mode);
      const layers = [...userLayers, ...folderLayers];
      let mode;
      let overridesMode = null;
      if (setting === 'inherit') {
        const m = modeFrom(layers);
        mode = m ? { ...m, label: `${PERMISSION_LABEL.inherit}: ${m.name}` } : { name: 'default', label: PERMISSION_LABEL.inherit, source: 'Claude Code' };
      } else {
        mode = { name: setting === 'ask' ? 'default' : setting, label: PERMISSION_LABEL[setting], source: 'Clawdling', clawdling: true };
        overridesMode = PERMISSION_LABEL[setting];
      }
      const homeAddDirs = (a.addDirs || []).filter((x) => x && home && posix(x) === homePosix).map(() => '~');
      view = {
        layers, mcp: [...userMcp, ...folderMcp], plugins, pluginSource, homePosix, orgPosix, folderPosix: posix(cwd), denyFile, mode, overridesMode, homeAddDirs, inheritsMode: setting === 'inherit',
        notes: ['It also loads everything at the user level (the first row).'],
        localNotIgnored: isRepo && d.local_not_ignored ? d.local ? d.local.file : `${d.path}/.claude/settings.local.json` : null,
      };
    }
    rows.push(finish(base, view, opts));
  }
  return { took_ms: Math.round((performance.now() - t0) * 10) / 10, rows };
}

/** `{trifecta, risks, verdict}` per agent id, for the report JSON and the shields. */
export function verdicts(audit) {
  const out = {};
  for (const r of (audit && audit.rows) || []) out[r.id] = { verdict: r.verdict, trifecta: r.trifecta, accepted: !!r.accepted, risks: r.risks.map((x) => x.id), unknown: r.unknown.length };
  return out;
}

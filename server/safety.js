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
  const m = /^\s*([A-Za-z_][\w*-]*)\s*(?:\((.*)\))?\s*$/s.exec(String(rule || ''));
  if (!m) return null;
  return { tool: m[1], content: m[2] === undefined ? null : m[2] };
}

const SHELLS = new Set(['Bash', 'PowerShell']);
const ALL = ['private', 'untrusted', 'sends'];
const WRAPPERS = new Set(TABLE.wrappers || []);

/** The words of one command, with wrappers (sudo, env A=b, timeout 30, nice -n 5) skipped. */
// Wrapper options that take a value (`sudo -u root`, `nice -n 5`, `timeout -s KILL`).
const WRAPPER_VALUE_FLAGS = new Set(['-u', '-g', '-n', '-s', '-k', '-C', '-h', '-p', '-U', '-D', '-I', '-L', '-P', '-d']);

function unwrap(toks) {
  let i = 0;
  const assignments = () => {
    while (i < toks.length - 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
  };
  assignments(); // `FOO=1 curl ...`
  let wrapped = false;
  while (i < toks.length && WRAPPERS.has(toks[i].split(/[\\/]/).pop().toLowerCase())) {
    wrapped = true;
    i++;
    while (i < toks.length && (/^-/.test(toks[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]) || /^\d+[smhd]?$/.test(toks[i]))) {
      if (WRAPPER_VALUE_FLAGS.has(toks[i])) i++;
      i++;
    }
  }
  // Only a wrapper and its options (`sudo -u root:*`, `timeout 30:*`): whatever command follows.
  if (wrapped && i >= toks.length) return [];
  return toks.slice(i);
}

/**
 * What a Bash/PowerShell allow rule lets the agent do without asking: `{caps: [..], why}` or null.
 * A rule with no command (`Bash`, `Bash(*)`, `Bash(:*)`) is unrestricted: all three. Only commands in
 * capabilities.json are classified (names only); a fixed command with no wildcard is what it says.
 */
export function shellRuleCaps(content) {
  if (content === null || /^\s*:?\*?\s*$/.test(content)) return { caps: [...ALL], why: 'runs any command' };
  const raw = content.trim();
  const caps = new Set();
  let why = null;
  let widest = 0;
  const hit = (list, w) => {
    for (const c of list) caps.add(c);
    if (list.length > widest) {
      widest = list.length;
      why = w; // the widest entry explains the rule
    }
  };
  // `cur*` (no space or colon before the star): every command whose name starts with "cur".
  const partial = /^[^\s:*]+\*$/.test(raw) ? raw.slice(0, -1).split(/[\\/]/).pop().toLowerCase() : null;
  if (partial !== null) {
    for (const e of TABLE.commands) {
      const w = e.words.find((x) => x.startsWith(partial));
      if (w) hit(e.match === 'verbs' ? e.bare_caps || e.caps : e.caps, `${e.why} (covers ${w})`);
    }
    if (WRAPPERS.has(partial) || [...WRAPPERS].some((x) => x.startsWith(partial))) hit(ALL, 'runs any command');
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
    const all = part.replace(/\*/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (!all.length) {
      if (wildcard) hit(ALL, 'runs any command');
      continue;
    }
    const toks = unwrap(all);
    if (!toks.length) {
      if (wildcard) hit(ALL, 'runs any command');
      continue;
    }
    const first = toks[0].split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
    // A wrapper with nothing after it but the wildcard (`sudo:*`, `env *`): any command.
    if (toks.length === 1 && WRAPPERS.has(first) && wildcard) {
      hit(ALL, 'runs any command');
      continue;
    }
    const rest = toks.slice(1).map((t) => t.toLowerCase());
    // The words, without options and their values (`gh --repo o/r pr view`, `aws --profile x s3 cp`).
    const words = [];
    for (let k = 0; k < rest.length; k++) {
      if (/^--?(repo|profile|region|project|hostname|account|context)$/.test(rest[k]) || rest[k] === '-r' || rest[k] === '-R') {
        k++;
        continue;
      }
      if (!rest[k].startsWith('-')) words.push(rest[k]);
    }
    const isVerb = (list, w) => list.includes(w) || (w.includes('-') && list.includes(w.split('-')[0]));
    for (const e of TABLE.commands) {
      if (!e.words.includes(first)) continue;
      if (e.match === 'any' && wildcard) hit(e.caps, e.why);
      else if (e.match === 'verbs') {
        const reads = e.read_verbs || [];
        // `gh pr:*`, `aws s3:*`: a wildcard after one subcommand group is as wide as the command.
        const group = e.groups && wildcard && words.length === 1 && !isVerb(e.verbs, words[0]) && !isVerb(reads, words[0]);
        if (wildcard && (words.length === 0 || group)) hit(e.bare_caps || e.caps, e.why);
        else if (e.wildcard) {
          // `npm run:*`, `uv pip install:*`, `uv tool run:*`: a runner verb, then only the wildcard.
          if (wildcard && words.length >= 1 && words.length <= 2 && isVerb(e.verbs, words[words.length - 1]) && words.slice(0, -1).every((w) => isVerb(e.verbs, w))) hit(e.caps, e.why);
        } else {
          if (words.some((r) => isVerb(e.verbs, r))) hit(e.caps, e.why);
          if (words.some((r) => isVerb(reads, r))) hit(e.read_caps || ['untrusted'], 'reads what others wrote');
        }
      } else if (e.match === 'bare' && wildcard && (rest.length === 0 || (rest.length === 1 && (e.flags || []).includes(rest[0])))) hit(e.caps, e.why);
    }
  }
  return caps.size ? { caps: ALL.filter((x) => caps.has(x)), why } : null;
}

/** Does a Bash/PowerShell rule let the agent send data out? `{why}` or null. */
export function shellRuleSends(content) {
  const r = shellRuleCaps(content);
  return r && r.caps.includes('sends') ? { why: r.why } : null;
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

/**
 * Does deny rule `d` take away allow rule `a`? Claude Code's own matching: a deny with no content (or
 * `*`) takes the whole tool; `cmd:*` takes `cmd` and `cmd ...`; `cmd *` takes `cmd ...`; `cm*` takes
 * anything starting `cm`; anything else takes only the identical rule. A deny whose text was redacted
 * is never assumed to match (two different rules can redact to the same text): the allow stays.
 */
export function denies(d, a) {
  if (!d || !a || d.tool !== a.tool) return false;
  if (d.content === null || /^\s*:?\*\s*$/.test(d.content)) return true;
  if (a.content === null) return false;
  const dr = d.content.trim();
  const ar = a.content.trim();
  if (dr.includes('[redacted]')) return false;
  if (dr === ar) return true;
  const base = ar.replace(/:\*$/, '').replace(/\s+\*$/, '');
  if (/:\*$/.test(dr) || /\s\*$/.test(dr)) {
    const p = dr.replace(/:\*$/, '').replace(/\s+\*$/, '');
    return (/:\*$/.test(dr) && base === p) || base.startsWith(`${p} `);
  }
  if (/\*$/.test(dr)) return ar.startsWith(dr.slice(0, -1));
  return false;
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
  for (const g of view.grantUnknowns || []) {
    if (g.unreadable) unknown.push({ text: `the ${g.kind} "${g.name}" has \`allowed-tools\` Clawdling could not read`, source: g.file, why: 'unknown: read what it lets Claude use' });
    if (g.cut) unknown.push({ text: `${g.kind}s Clawdling did not read (more files or folders than it reads)`, source: g.file, why: 'unknown: read the rest of the folder' });
    if (g.mcp_unreadable) unknown.push({ text: `the subagent "${g.name}" defines MCP servers Clawdling could not read`, source: g.file, why: 'unknown: read its mcpServers' });
    if (g.mode === 'other') unknown.push({ text: `the subagent "${g.name}" sets a \`permissionMode\` Clawdling does not know`, source: g.file, why: 'unknown: check the mode name' });
  }
  for (const f of view.profiles || []) unknown.push({ text: 'a device-management policy for Claude Code', source: f, why: 'unknown: your organization can add settings and MCP servers there that Clawdling cannot read' });
  for (const l of view.layers) if (l.facts && l.facts.default_mode === 'other') unknown.push({ text: '`defaultMode` set to a mode Clawdling does not know', source: l.file, why: 'unknown: check the mode name' });
  // A rule Clawdling cannot read once a secret in it is hidden (or cut short) is never assumed harmless.
  for (const x of allRules('allow')) if (!x.parsed) unknown.push({ text: `\`${x.rule}\` allowed`, source: x.layer.file, why: 'unknown: a rule Clawdling could not read after hiding a secret in it' });
  const toolDenied = (tool) => deny.some((d) => d.tool === tool && (d.content === null || /^\s*:?\*\s*$/.test(d.content)));

  for (const { rule, parsed, layer } of allowed) {
    const where = layer.file;
    // A rule from your own (or managed) settings reaches every agent: on an agent, the narrower fix
    // is a deny rule in its own folder, which wins over an allow from any layer.
    const shared = (layer.kind === 'user' || layer.kind === 'managed' || (layer.kind === 'grant' && layer.shared)) && !view.isUserRow;
    const removeFix = shared ? `stop this agent using \`${rule}\`: add it to \`permissions.deny\` in ${view.denyFile}`
      : layer.kind === 'grant' && /[\\/]skills[\\/]synced[\\/]/.test(layer.path) ? `change the skill on claude.ai (the next sync rewrites ${layer.path}), or set \`"syncClaudeAiSkills": false\``
      : layer.kind === 'grant' ? `remove \`${rule}\` from \`allowed-tools\` in ${layer.path}`
      : `remove \`${rule}\` from \`allow\` in ${where}`;
    if (parsed.tool === 'WebFetch') {
      add('untrusted', `\`${rule}\` allowed`, where, `turn off WebFetch for this agent: add "WebFetch" to \`permissions.deny\` in ${view.denyFile}`);
      add('sends', `\`${rule}\` allowed (a URL is a channel)`, where, `turn off WebFetch for this agent: add "WebFetch" to \`permissions.deny\` in ${view.denyFile}`);
    } else if (parsed.tool === 'WebSearch') {
      add('untrusted', `\`${rule}\` allowed`, where, `turn off WebSearch for this agent: add "WebSearch" to \`permissions.deny\` in ${view.denyFile}`);
    } else if (SHELLS.has(parsed.tool)) {
      const s = shellRuleCaps(parsed.content);
      if (s) for (const c of s.caps) add(c, `\`${rule}\` allowed (${s.why})`, where, removeFix);
    } else if ((parsed.tool === 'Read' || parsed.tool === 'Grep' || parsed.tool === 'Glob') && (parsed.content === null || /^\s*\*?\s*$/.test(parsed.content))) {
      add('private', `\`${rule}\` allowed (reads any file without asking)`, where, removeFix);
    } else if (parsed.tool === 'Read') {
      const r = readOutside(parsed.content, view.folderPosix, view.homePosix, view.orgPosix);
      if (r) add('private', r.text, where, removeFix);
    } else if (/^mcp__/i.test(parsed.tool)) {
      // An allowed MCP tool: classified with its server below (the server's own entry carries it).
    }
  }

  // The permission mode the sessions run in.
  const mode = view.mode;
  // The web is closed only when every way to it is denied.
  const webClosed = toolDenied('WebFetch') && toolDenied('WebSearch') && toolDenied('Bash') && toolDenied('PowerShell');
  if (mode && mode.name === 'bypassPermissions') {
    // Nothing asks: every tool, every file, every command.
    add('private', 'Bypass permissions mode (any file is read without asking)', mode.source, mode.fix);
    if (!webClosed) add('untrusted', 'Bypass permissions mode (the web is read without asking)', mode.source, mode.fix);
    add('sends', 'Bypass permissions mode (any command runs without asking)', mode.source, mode.fix);
  } else if (mode && mode.name === 'auto') {
    const what = mode.isDefault ? "Auto mode, Claude Code's default" : 'Auto mode';
    add('sends', `${what} (commands run when its classifier allows them)`, mode.source, mode.fix);
    if (!webClosed) add('untrusted', `${what} (the web can be read without asking)`, mode.source, mode.fix);
  }

  // A subagent's own permissionMode applies when the session asks first (default, manual, dontAsk).
  if (mode && ['default', 'manual', 'dontAsk'].includes(mode.name)) {
    for (const g of view.subagentModes || []) {
      const fix = `remove \`permissionMode\` from ${g.file}`;
      const what = `the ${g.name} subagent runs in ${g.mode === 'auto' ? 'auto mode' : 'bypass permissions mode'} (\`permissionMode\`)`;
      add('sends', what, g.file, fix);
      if (!webClosed) add('untrusted', what, g.file, fix);
      if (g.mode === 'bypassPermissions') add('private', what, g.file, fix);
    }
  }

  // Every agent but the CTO also gets the org folder (--add-dir): you, and every agent's notes.
  if (view.orgFolder) add('private', 'the org folder: your me.md and every agent\'s notes (`--add-dir`, Clawdling)', 'Clawdling', null);

  // Extra folders that are the home folder (or a big folder in it).
  for (const l of view.layers) for (const d of (l.facts && l.facts.home_dirs) || []) add('private', `extra folder ${d} (additionalDirectories)`, l.file, `remove ${d} from \`additionalDirectories\` in ${l.file}`);
  for (const d of view.homeAddDirs || []) add('private', `your home folder (\`--add-dir ${d}\`: the org folder is your home folder)`, 'Clawdling', null);

  // MCP servers, by name.
  for (const s of view.mcp) {
    if (mcpDenied(s.name, deny)) continue;
    const tagged = Object.hasOwn(tags, s.name) && Array.isArray(tags[s.name]) ? tags[s.name].filter((c) => CAPS.includes(c)) : null;
    let k = tagged ? { known: true, caps: new Set(tagged), labels: ['tagged by you'] } : classifyName(s.name, s.command, s.package, s.host);
    // A remote server called "memory" is someone else's computer: a local-helper name counts only for
    // a server that runs here.
    if (!tagged && k.known && !k.caps.size && s.type !== 'stdio') k = { known: false, caps: new Set(), labels: [] };
    const what = `${s.name} MCP server${k.labels.length ? ` (${k.labels.join(', ')})` : ''}`;
    const fix = s.scope === 'chrome'
      ? `${view.isUserRow ? 'stop every session using it' : 'stop this agent using it'}: add "mcp__claude-in-chrome" to \`permissions.deny\` in ${view.denyFile}, or turn "Enabled by default" off in Claude in Chrome`
      : view.isUserRow
      ? `stop every session using the ${s.name} MCP server: add "mcp__${s.name}" to \`permissions.deny\` in ${view.denyFile}, or remove it with \`claude mcp remove ${s.name}\``
      : s.viaSubagent
        ? `remove the ${s.name} server from the "${s.viaSubagent}" subagent (${s.source.replace(/ \(subagent.*$/, '')}), or add "mcp__${s.name}" to \`permissions.deny\` in ${view.denyFile}`
      : s.scope === 'user'
        ? `stop this agent using the ${s.name} MCP server: add "mcp__${s.name}" to \`permissions.deny\` in ${view.denyFile}`
        : `remove the ${s.name} server from ${s.source}`;
    if (!k.known) {
      unknown.push({ text: what, source: s.source, why: 'unknown: review what it can do' });
      continue;
    }
    for (const c of k.caps) add(c, what, s.source, fix);
  }

  // Plugins (user level): by name, the same table. A plugin can bring its own MCP servers and hooks.
  for (const p of [...view.plugins, ...(view.folderPlugins || [])]) {
    if (!p.enabled) continue;
    const ptag = Object.hasOwn(tags, p.name) && Array.isArray(tags[p.name]) ? tags[p.name].filter((c) => CAPS.includes(c)) : null;
    const k = ptag ? { known: true, caps: new Set(ptag), labels: ['tagged by you'] } : classifyName(p.name);
    const what = `${p.name} plugin${k.labels.length ? ` (${k.labels.join(', ')})` : ''}`;
    const src = p.source || view.pluginSource;
    if (!k.known) {
      unknown.push({ text: what, source: src, why: 'unknown: a plugin can add MCP servers and hooks' });
      continue;
    }
    for (const c of k.caps) add(c, what, src, `turn off the ${p.name} plugin (\`/plugin\` in Claude Code) if this agent does not need it`);
  }

  // claude.ai connectors: MCP servers on your claude.ai account load in every session signed in with it.
  // Clawdling cannot see which without asking claude.ai, so it says so, unless a settings file turns them
  // off; you can say what yours do (a tag named "claude.ai").
  const connectorsOn = !view.layers.some((l) => l.facts && l.facts.connectors_off);
  // Plugins turned on for your claude.ai account (or your organization) sync in after a session starts.
  const syncOn = !view.layers.some((l) => l.facts && l.facts.sync_plugins_off);
  // Skills on your claude.ai account sync into ~/.claude/skills/synced/ while sessions run (user, local
  // or managed settings can turn that off).
  const skillsOn = !view.layers.some((l) => l.facts && l.facts.sync_skills_off && ['user', 'local', 'managed'].includes(l.kind));
  if (view.connectors && (connectorsOn || syncOn || skillsOn)) {
    const parts = [connectorsOn ? 'connectors' : null, syncOn ? 'plugins' : null, skillsOn ? 'skills' : null].filter(Boolean);
    const which = `${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]} (yours, and any your organization turns on)`;
    const what = `claude.ai MCP server (your claude.ai account's ${which}: Clawdling cannot see which)`;
    const ctag = Object.hasOwn(tags, 'claude.ai') && Array.isArray(tags['claude.ai']) ? tags['claude.ai'].filter((c) => CAPS.includes(c)) : null;
    if (ctag) for (const c of ctag) add(c, 'claude.ai MCP server (your claude.ai connectors, plugins and skills, tagged by you)', 'your claude.ai account', `turn them off for this agent: set \`"disableClaudeAiConnectors": true\`, \`"syncClaudeAiPlugins": false\` and \`"syncClaudeAiSkills": false\` in ${view.denyFile}`);
    else unknown.push({ text: what, source: 'your claude.ai account', why: 'unknown: check `/mcp`, `/plugin` and `/skills` in Claude Code, or set "disableClaudeAiConnectors": true, "syncClaudeAiPlugins": false and "syncClaudeAiSkills": false' });
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
    // ...and only from the layer whose mode wins (a folder's own mode beats yours).
    const show = !(userLevel(l) && view.overridesMode) && !(userLevel(l) && !view.isUserRow && !view.inheritsMode) && !(!view.overridesMode && view.mode && view.mode.source !== l.file && (f.default_mode === 'auto' || f.default_mode === 'bypassPermissions'));
    const note = view.overridesMode ? ` Clawdling starts this agent in "${view.overridesMode}" mode, so it applies when you run claude here yourself.` : '';
    if (show && (f.default_mode === 'bypassPermissions' || f.skip_bypass_prompt)) {
      const what = f.default_mode === 'bypassPermissions' ? 'turns on bypass permissions mode (`defaultMode: bypassPermissions`)' : 'turns off the warning before bypass permissions mode (`skipDangerousModePermissionPrompt`)';
      add('bypass', `This settings file ${what}.${note}`, l.file);
    }
    if (show && f.default_mode === 'auto') {
      add('auto_mode', `This settings file turns on auto mode (\`defaultMode: auto\`): commands run when Claude Code's classifier allows them, and prompt injection has beaten it in public tests.${note}`, l.file);
    }
    if (l.repo && (l.kind === 'project' || l.kind === 'local')) {
      const ss = (f.hooks || []).find((h) => h.event === 'SessionStart');
      if (ss) add('session_start', `This repo runs ${ss.count === 1 ? 'a command' : `${ss.count} commands`} whenever a session starts (a SessionStart hook in its own settings), before you type anything. A package or a pull request can plant one: read it before you trust the folder.`, l.file);
    }
  }
  if (view.mode && view.mode.isDefault && (view.isUserRow || view.inheritsMode)) {
    add('auto_mode', "No settings file picks a permission mode, so Claude Code uses its own default: auto mode on current versions. Commands run when its classifier allows them, and prompt injection has beaten it in public tests.", view.mode.source);
  }
  for (const p of view.folderPlugins || []) {
    if (p.official) continue;
    add('marketplace', `This folder's settings turn on the ${p.name} plugin, from ${p.marketplace ? `the "${p.marketplace}" marketplace` : 'a marketplace Clawdling could not name'}, not Anthropic's official one.`, p.source);
  }
  for (const g of view.repoGrants || []) {
    if (g.allowed.length) add('repo_grants', `This repo's ${g.kind} "${g.name}" lets Claude use ${g.allowed.slice(0, 3).map((r) => `\`${r}\``).join(', ')}${g.allowed.length > 3 ? ` and ${g.allowed.length - 3} more` : ''} without asking (\`allowed-tools\`), even before you trust the folder: read it.`, g.file);
    if (g.mode) add('repo_grants', `This repo's subagent "${g.name}" sets its own permission mode (\`permissionMode: ${g.mode}\`).`, g.file);
    if (g.hooks) add('repo_grants', `This repo's ${g.kind} "${g.name}" registers its own hooks, which run commands while it is in use: read it.`, g.file);
    if (g.unreadable) add('repo_grants', `This repo's ${g.kind} "${g.name}" has \`allowed-tools\` Clawdling could not read: read it.`, g.file);
  }
  for (const s of view.mcp) {
    if (s.scope === 'project') add('repo_mcp', s.viaSubagent ? `This repo's subagent "${s.viaSubagent}" starts the ${s.name} MCP server (\`mcpServers\`): code the repo controls.` : `This repo defines the ${s.name} MCP server in .mcp.json: code the repo controls, which runs once you approve it.`, s.source);
  }
  if (view.localNotIgnored) add('local_not_ignored', 'This repo has a .claude/settings.local.json that no .gitignore rule covers: your personal allow rules (and anything pasted into them) can be committed and published.', view.localNotIgnored);
  // Plugins load in every agent that loads your settings: listed once, on the user-level row.
  if (view.isUserRow) {
    for (const p of view.plugins) {
      if (p.official || p.marketplace === 'synced' || p.marketplace === 'skills-dir') continue;
      add('marketplace', p.claims
        ? `The ${p.name} plugin comes from a marketplace named "${p.marketplace}" whose source is not Anthropic's: check where it came from.`
        : `The ${p.name} plugin comes from ${p.marketplace ? `the "${p.marketplace}" marketplace` : 'a marketplace Clawdling could not name'}, not Anthropic's official one.`, view.pluginSource);
    }
  }
  return risks;
}

/** One plain sentence: what could happen, naming one item from each leg. */
function trifectaSentence(chips, who = 'this agent') {
  // "`Bash(curl:*)` allowed (can send data out)" -> "Bash(curl:*)"; "gmail MCP server (mail)" -> "gmail MCP server".
  const root = (x) => {
    const r = x.text.replace(/\s+\([^()]*\)$/, '').replace(/`/g, '').replace(/ allowed$/, '');
    return / (MCP server|plugin)$/.test(r) ? `the ${r}` : r;
  };
  const used = new Set();
  const pick = (c) => {
    const x = chips[c].find((y) => !used.has(root(y))) || chips[c][0];
    used.add(root(x));
    return root(x);
  };
  const u = pick('untrusted');
  const p = pick('private');
  const out = pick('sends');
  return `Text ${who} reads through ${u} could tell it to take your data from ${p} and send it out with ${out}.`;
}

/**
 * Up to three fixes, from the leg that is cheapest to cut: the fewest items, among legs whose every
 * item has a text fix (the org folder, Donna's channel and the CTO's report have none). A leg with more
 * than three gets two fixes and a line for the rest.
 */
function fixesFor(chips) {
  const cap = (f) => f.charAt(0).toUpperCase() + f.slice(1);
  const legs = [...CAPS].sort((a, b) => chips[a].length - chips[b].length || CAPS.indexOf(b) - CAPS.indexOf(a));
  const leg = legs.find((l) => chips[l].length && chips[l].every((x) => x.fix));
  if (!leg) return [...new Set(CAPS.flatMap((l) => chips[l].map((x) => x.fix)).filter(Boolean))].slice(0, MAX_FIXES).map(cap);
  const fixes = [...new Set(chips[leg].map((x) => x.fix))];
  if (fixes.length <= MAX_FIXES) return fixes.map(cap);
  return [...fixes.slice(0, MAX_FIXES - 1).map(cap), `And ${fixes.length - (MAX_FIXES - 1)} more like these: cut every "${CAP_LABEL[leg].toLowerCase()}" source above and the trifecta is gone`];
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
  const accepted = opts.accepted && Object.hasOwn(opts.accepted, base.id) && opts.accepted[base.id] ? { reason: String(opts.accepted[base.id].reason || ''), at: opts.accepted[base.id].at || null } : null;
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
  row.sentence = trifecta ? trifectaSentence(chips, view.isUserRow ? 'a session' : 'this agent') : null;
  row.fixes = trifecta ? fixesFor(chips) : [];
  row.verdict = verdictOf(row);
  row.summary = row.verdict === 'amber' && row.trifecta ? 'Lethal trifecta (accepted)' : row.verdict === 'amber' ? (row.risks.length ? `${row.risks.length} setup risk${row.risks.length === 1 ? '' : 's'}` : `${row.unknown.length} unknown to review`) : SUMMARY[row.verdict];
  return row;
}

// ---------------------------------------------------------------------------- the audit

const posix = (p) => (p ? String(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, d) => `/${d.toLowerCase()}`).replace(/\/+$/, '') : null);

/** Skills, commands and subagents with `allowed-tools`, as allow layers (`shared`: not the agent's own). */
function grantLayers(grants, shared) {
  return grants.filter((g) => g.allowed && g.allowed.length).map((g) => ({ kind: 'grant', shared, path: g.file, file: `${g.file} (${g.kind} "${g.name}", allowed-tools)`, facts: { allow: g.allowed } }));
}
const subagentModes = (grants) => grants.filter((g) => g.kind === 'subagent' && (g.mode === 'auto' || g.mode === 'bypassPermissions'));
/** The inline MCP servers subagents define, as MCP entries sourced to their file. */
const subagentMcp = (grants, scope) => grants.flatMap((g) => (g.mcp || []).map((m) => ({ ...m, scope, source: `${g.file} (subagent "${g.name}", mcpServers)`, viaSubagent: g.name })));

// What Claude Code runs in when nothing picks a mode: auto mode on current versions (permissions.js).
export const CLI_DEFAULT_MODE = 'auto';

function modeFrom(layers, userFile) {
  // Claude Code's precedence: managed, then local, then project, then user.
  for (const kind of ['managed', 'local', 'project', 'user']) {
    for (const l of layers) if (l.kind === kind && l.facts && l.facts.default_mode && l.facts.default_mode !== 'other') return { name: l.facts.default_mode, source: l.file, fix: `remove \`defaultMode\` from ${l.file}, or pick a mode for this agent in Clawdling` };
  }
  return { name: CLI_DEFAULT_MODE, isDefault: true, source: "Claude Code's default (no settings file picks a mode)", fix: `set \`defaultMode\` in ${userFile} to the mode that asks first ("manual" on recent versions, "default" before), or pick a mode for this agent in Clawdling` };
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
  // An official marketplace name counts only with Anthropic's own source, when its source is listed.
  const sourceOk = (mk) => {
    if (!repoOf.has(mk)) return true;
    const repo = repoOf.get(mk);
    return !!repo && TABLE.official_owners.includes(String(repo).split('/')[0].toLowerCase());
  };
  const plugins = (u.plugins || []).map((p) => {
    const named = !!p.marketplace && official.has(p.marketplace);
    const ownerOk = sourceOk(p.marketplace);
    return { ...p, official: named && ownerOk, claims: named && !ownerOk };
  });
  const pluginSource = `${u.config_dir || '~/.claude'}${platform === 'win32' ? '\\' : '/'}settings.json (plugins)`;
  const userLayers = [
    ...(u.managed || []).map((f) => ({ kind: 'managed', file: f.file, facts: f })),
    ...(u.settings ? [{ kind: 'user', file: u.settings.file, facts: u.settings }] : []),
  ];
  const userMcp = [
    ...(u.mcp || []).map((s) => ({ ...s, scope: 'user', source: '~/.claude.json (mcpServers)' })),
    // Servers your organization gives every session: managed settings (managedMcpServers), managed-mcp.json.
    ...(u.managed || []).flatMap((f) => (f.managed_mcp || []).map((s) => ({ ...s, scope: 'managed', source: `${f.file} (managedMcpServers)` }))),
    ...(u.managed_mcp || []).map((s) => ({ ...s, scope: 'managed', source: s.file })),
    // Claude in Chrome: your signed-in browser, on in every interactive session when it is turned on.
    ...(u.chrome || [u.settings, ...(u.managed || [])].some((f) => f && f.chrome_env)
      ? [{ name: 'claude-in-chrome', type: 'builtin', command: null, package: null, host: null, scope: 'chrome', source: u.chrome ? '~/.claude.json (claudeInChromeDefaultEnabled)' : 'your settings (CLAUDE_CODE_ENABLE_CFC)' }]
      : []),
  ];
  const homePosix = posix(home);
  const orgPosix = posix(org.home);
  const userFile = u.settings ? u.settings.file : `${u.config_dir || '~/.claude'}${platform === 'win32' ? '\\' : '/'}settings.json`;
  const rows = [];

  // Everything (user level): what a plain `claude` anywhere on this computer loads.
  const userGrants = u.grants || [];
  const userView = {
    layers: [...userLayers, ...grantLayers(userGrants, true)], subagentModes: subagentModes(userGrants), grantUnknowns: userGrants, connectors: true, profiles: u.profiles || [], mcp: [...userMcp, ...subagentMcp(userGrants, 'user')], plugins, pluginSource, homePosix, orgPosix, folderPosix: null, isUserRow: true,
    denyFile: u.settings ? u.settings.file : `${u.config_dir || '~/.claude'}/settings.json`,
    mode: (() => {
      const m = modeFrom(userLayers, userFile);
      return { ...m, label: m.isDefault ? `${m.name} (Claude Code's default)` : m.name };
    })(),
  };
  rows.push(finish({ id: USER_ROW, name: 'Everything (user level)', kind: 'user', folder: u.config_dir || null }, userView, opts));

  const pending = [];
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
    if (a.kind === 'cto') {
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
        const m = modeFrom(layers, userFile);
        mode = { ...m, label: `${PERMISSION_LABEL.inherit}: ${m.name}${m.isDefault ? " (Claude Code's default)" : ''}` };
      } else {
        mode = { name: setting === 'ask' ? 'default' : setting, label: PERMISSION_LABEL[setting], source: 'Clawdling', clawdling: true };
        overridesMode = PERMISSION_LABEL[setting];
      }
      const homeAddDirs = (a.addDirs || []).filter((x) => x && home && posix(x) === homePosix).map(() => '~');
      const orgFolder = !!org.home && (a.addDirs || []).some((x) => posix(x) === orgPosix);
      // Skills, commands and subagents of every --add-dir folder load too; a group's repos are repos.
      const extra = (a.addDirs || []).map((x) => [path.resolve(x), (scan.add_dirs || {})[path.resolve(x)]]).filter(([, v]) => v);
      const extraGrants = extra.flatMap(([, v]) => v.grants || []);
      const extraRepoGrants = extra.filter(([k, v]) => v.in_repo && posix(k) !== orgPosix).flatMap(([, v]) => v.grants || []);
      // Plugins this folder's own settings turn on (a repo can enable one for its sessions).
      const folderPlugins = folderLayers.flatMap((l) => (l.facts.plugins || []).map(([key, on]) => {
        const at = key.lastIndexOf('@');
        const name = at > 0 ? key.slice(0, at) : key;
        const mk = at > 0 ? key.slice(at + 1) : null;
        const named = !!mk && official.has(mk);
        const ownerOk = !mk || sourceOk(mk);
        return { name, marketplace: mk, enabled: on, official: named && ownerOk, source: `${l.file} (plugins)` };
      })).filter((x) => !plugins.some((p) => p.name === x.name && p.marketplace === x.marketplace && p.enabled));
      view = {
        layers: [...layers, ...grantLayers(userGrants, true), ...grantLayers(extraGrants, false), ...grantLayers(d.grants || [], false)],
        subagentModes: subagentModes([...userGrants, ...extraGrants, ...(d.grants || [])]),
        grantUnknowns: [...userGrants, ...extraGrants, ...(d.grants || [])],
        connectors: true,
        profiles: u.profiles || [],
        repoGrants: [...(isRepo && d.in_repo ? d.grants || [] : []), ...extraRepoGrants],
        mcp: [...userMcp, ...folderMcp, ...subagentMcp(userGrants, 'user'), ...subagentMcp(extraGrants.filter((g) => !extraRepoGrants.includes(g)), 'folder'), ...subagentMcp(extraRepoGrants, 'project'), ...subagentMcp(d.grants || [], isRepo && d.in_repo ? 'project' : 'folder')], plugins, folderPlugins, pluginSource, homePosix, orgPosix, folderPosix: posix(cwd), denyFile, mode, overridesMode, homeAddDirs, inheritsMode: setting === 'inherit',
        orgFolder,
        notes: ['It also loads everything at the user level (the first row).'],
        localNotIgnored: isRepo && d.local_not_ignored ? d.local ? d.local.file : `${d.path}/.claude/settings.local.json` : null,
      };
      if (a.kind === 'chief') {
        // Donna, twice over: her text-message turns (only her folder's settings, no MCP server, "dontAsk"
        // with her allow-list, her channel) and the sessions you open with her in the cockpit, which
        // load your setup like any agent's. The row is the worse of both: everything together.
        const tg = (org.channels && org.channels.telegram) || {};
        const im = (org.channels && org.channels.imessage) || {};
        const own = [];
        if (im.enabled) own.push({ cap: 'private', text: 'iMessage: reads your Messages to find your texts', source: 'Clawdling (Donna\'s channel)' });
        if (tg.configured && tg.enabled !== false) own.push({ cap: 'sends', text: 'Telegram: replies to your chat', source: 'Clawdling (Donna\'s channel)' });
        if (im.enabled) own.push({ cap: 'sends', text: 'iMessage: replies to your handle', source: 'Clawdling (Donna\'s channel)' });
        const notes = [];
        if ((tg.configured && tg.paired) || im.enabled) notes.push('Only your own paired Telegram chat and your own iMessage handle reach Donna, so what she is sent is not untrusted input.');
        if (tg.configured && !tg.paired) notes.push('Telegram is not paired yet: until it is, Donna answers nobody.');
        notes.push('Her text-message turns load none of your Claude Code setup (only her allow-list); the sessions you open with her in the cockpit load it like any agent\'s. This row covers both.');
        view.layers = [...view.layers, { kind: 'clawdling', file: 'Clawdling (Donna\'s allow-list)', facts: { allow: org.donnaTools || [] } }];
        view.own = own;
        view.notes = notes;
      }
    }
    pending.push({ base, view, kind: a.kind });
  }
  // Text one agent writes reaches the others: the org folder's notes, `clawdling report` (every agent may
  // run it), Donna's "today so far". It is untrusted input for them when the agent that wrote it reads
  // untrusted input itself (by name). The CTO's row already says so for its report.
  const readsUntrusted = new Map();
  for (const p of pending) {
    if (p.kind !== 'domain' && p.kind !== 'project' && p.kind !== 'chief') continue;
    if (capsFor(p.view, opts).chips.untrusted.length) readsUntrusted.set(p.base.id, p.base.name);
  }
  for (const p of pending) {
    if (p.kind !== 'domain' && p.kind !== 'project' && p.kind !== 'chief') continue;
    const others = [...readsUntrusted].filter(([id]) => id !== p.base.id).map(([, n]) => n);
    if (!others.length) continue;
    const who = others.length > 3 ? `${others.slice(0, 3).join(', ')} and ${others.length - 3} more` : others.join(', ');
    const where = p.kind === 'chief' ? 'her "today so far" context' : 'the org folder\'s notes and `clawdling report`';
    p.view.own = [...(p.view.own || []), { cap: 'untrusted', text: `text written by agents that read untrusted input (${who}), in ${where}`, source: 'Clawdling (other agents)' }];
    if (p.kind === 'chief') p.view.notes = p.view.notes.map((n) => (/not untrusted input/.test(n) ? 'Only your own paired Telegram chat and your own iMessage handle reach Donna; what other agents wrote reaches her too, in her "today so far" context.' : n));
  }
  for (const p of pending) rows.push(finish(p.base, p.view, opts));
  return { took_ms: Math.round((performance.now() - t0) * 10) / 10, rows };
}

/** `{trifecta, risks, verdict}` per agent id, for the report JSON and the shields. */
export function verdicts(audit) {
  const out = {};
  for (const r of (audit && audit.rows) || []) out[r.id] = { verdict: r.verdict, trifecta: r.trifecta, accepted: !!r.accepted, risks: r.risks.map((x) => x.id), unknown: r.unknown.length };
  return out;
}

// The org is a folder. This module reads and writes it: org.json, agent folders, templates.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { absPathRule, cliAllow, runtimeDeny } from './hooks.js';
import { cleanInput } from './receipts.js';
import { PKG_ROOT, runtimePaths } from './paths.js';
import {
  HttpError,
  badRequest,
  clampText,
  conflict,
  ensureDir,
  isValidAgentId,
  isValidEffort, isValidModel,
  notFound,
  oneLine,
  readJson,
  slugify,
  writeFileAtomic,
  writeJson,
} from './util.js';

export const TEMPLATES_DIR = path.join(PKG_ROOT, 'templates');
export const CONTEXT_MAX_BYTES = 200 * 1024;
export const RESERVED_IDS = new Set(['donna', 'scratch', 'cto']);
// The CTO seat (1.7): one per org, in <org>/cto, beside Donna.
export const CTO_ID = 'cto';
export const CTO_UNGUARDED = "Clawdling cannot write the CTO's file rules for a folder whose path has characters like ( ) ' or accents, so it will not add or start a CTO here.";
// Stored agent permission modes (null = ask; see permissions.js). 'default' is Claude Code's own
// name for asking first, kept from 1.1.0.
const PERMISSION_MODES = new Set(['ask', 'default', 'acceptEdits', 'plan', 'inherit']);
const KIND_DIRS = { domain: 'domains', project: 'projects' };

const PALETTE = ['#E5484D', '#30A46C', '#0091FF', '#F76B15', '#8E4EC6', '#12A594', '#D6409F', '#FFB224', '#3E63DD', '#AB4ABA'];
// Whole words only: "readiness" is not about reading, "homework" is not about home.
const ICON_HINTS = [
  [/\b(health|fitness|sleep|body|medical|gym)\b/, 'heart'],
  [/\b(work|job|career|office|business)\b/, 'briefcase'],
  [/\b(money|finances?|budget|tax(es)?|invest(ing|ments?)?|bank(ing)?)\b/, 'coins'],
  [/\b(home|house|chores?|garden(ing)?)\b/, 'home'],
  [/\b(family|kids|partner|parents?|friends|people)\b/, 'users'],
  [/\b(learn(ing)?|school|study|courses?|read(ing)?|books?)\b/, 'book'],
  [/\b(travel|trips?)\b/, 'plane'],
  [/\b(write|writing|blog|content|newsletter)\b/, 'pen'],
];

export const DEFAULT_MISSIONS = {
  work: "Keep {owner}'s work moving: priorities, deadlines, meetings and follow-ups",
  health: 'Help {owner} stay healthy: training, sleep, nutrition and appointments',
  money: "Keep {owner}'s finances clear: budget, bills, savings and big decisions",
  home: "Run {owner}'s home: chores, repairs, groceries and household logistics",
  family: 'Help {owner} show up for family: plans, birthdays, school and shared logistics',
  learning: 'Help {owner} learn on purpose: courses, reading and skills in progress',
};

export function defaultMission(name, owner) {
  const key = slugify(name, '');
  const tpl = DEFAULT_MISSIONS[key] || `Own ${owner}'s ${name} area: keep it on track and tell ${owner} what needs attention`;
  return tpl.replaceAll('{owner}', owner);
}

export function styleFor(id, name) {
  const text = `${id} ${name}`.toLowerCase();
  let icon = 'star';
  for (const [re, ic] of ICON_HINTS) {
    if (re.test(text)) {
      icon = ic;
      break;
    }
  }
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { icon, color: PALETTE[h % PALETTE.length] };
}

export function readTemplate(rel) {
  // LF everywhere, even if this copy was checked out with CRLF (Windows git with autocrlf).
  return fs.readFileSync(path.join(TEMPLATES_DIR, rel), 'utf8').replace(/\r\n/g, '\n');
}

/** Replace {{var}} placeholders. Unknown placeholders are an error, never silently blank. */
export function renderTemplate(src, vars) {
  return src.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k) => {
    if (!Object.prototype.hasOwnProperty.call(vars, k)) throw new Error(`template variable {{${k}}} has no value`);
    return String(vars[k]);
  });
}

const today = (d = new Date()) => d.toISOString().slice(0, 10);

/** The org's .claude/settings.json; on Windows the allow-list also covers the PowerShell tool. */
export function orgSettings(platform = process.platform) {
  const text = readTemplate('org/claude/settings.json');
  if (platform !== 'win32') return text;
  const json = JSON.parse(text);
  json.permissions.allow = cliAllow('win32');
  return JSON.stringify(json, null, 2) + '\n';
}

/**
 * The CTO seat's permissions (1.7), from templates/cto/settings.json: the report and session list
 * run without asking; reviews/ may be written; `clawdling send` and `clawdling spawn` are ASK rules,
 * which beat an allow rule from any other settings layer, so every cross-agent message shows Claude
 * Code's own prompt; the web, its own CLAUDE.md and its settings are denied. File rules need an
 * absolute-path rule for the seat's folder (hooks.js absPathRule): a path with rule syntax in it gets
 * none, and then the CTO asks before writing its review (fileRules: false).
 */
export function ctoPermissions({ dir, home, platform = process.platform }) {
  const tpl = JSON.parse(readTemplate('cto/settings.json')).permissions;
  const base = absPathRule('X', dir, platform); // "X(//abs/dir/**)" or null
  const root = base ? base.slice(2, -4) : null; // "//abs/dir"
  const expand = (list) => {
    const out = [];
    for (const r of list) {
      if (r.includes('{{cto}}')) {
        if (root) out.push(r.replace('{{cto}}', root));
        continue;
      }
      out.push(r);
      // On Windows the agent's shell may be PowerShell: the same command rules for that tool.
      if (platform === 'win32' && r.startsWith('Bash(')) out.push(r.replace(/^Bash\(/, 'PowerShell('));
    }
    return out;
  };
  return {
    allow: expand(tpl.allow),
    ask: expand(tpl.ask),
    deny: [...expand(tpl.deny), ...runtimeDeny(home, platform)],
    fileRules: !!root,
  };
}

/** The text of the CTO folder's .claude/settings.json. */
export function ctoSettingsText({ dir, home, platform = process.platform }) {
  const { allow, ask, deny } = ctoPermissions({ dir, home, platform });
  return JSON.stringify({ $schema: 'https://json.schemastore.org/claude-code-settings.json', permissions: { allow, ask, deny } }, null, 2) + '\n';
}

function writeIfMissing(file, content) {
  if (fs.existsSync(file)) return false;
  fs.writeFileSync(file, content);
  return true;
}

function backupThenWrite(file, content, backupDir, home) {
  try {
    const old = fs.readFileSync(file, 'utf8');
    if (old === content) return;
    if (backupDir) {
      const dest = path.join(backupDir, path.relative(home, file));
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, old);
    }
  } catch {
    // no previous file
  }
  ensureDir(path.dirname(file));
  writeFileAtomic(file, content, 0o644);
}

// Skills each folder gets. onboard-project is for project agents; the org root carries it too so a
// project agent that runs in its repo (with the org added as a directory) finds it.
const BASE_SKILLS = ['handoff', 'new-agent'];
// Skills whose text the cockpit vouches for: kept exactly as this version ships them.
const FRESH_SKILLS = new Set(['remote-access']);
// The CTO gets none: it does not create agents, and its memory is its reviews.
const SKILLS_FOR = { root: [...BASE_SKILLS, 'onboard-project', 'remote-access'], project: [...BASE_SKILLS, 'onboard-project'], domain: BASE_SKILLS, chief: BASE_SKILLS, cto: [] };

function skillFile(dir, skill) {
  return path.join(dir, '.claude', 'skills', skill, 'SKILL.md');
}

function installSkills(dir, backupDir, home, kind = 'root') {
  for (const skill of SKILLS_FOR[kind] || BASE_SKILLS) {
    backupThenWrite(skillFile(dir, skill), readTemplate(`skills/${skill}/SKILL.md`), backupDir, home);
  }
}

/** Create (or, with backupDir, refresh) one agent folder. Memory files are never overwritten. */
function scaffoldAgent({ home, kind, agent, owner, domainName, agentIds, backupDir, date = today() }) {
  const dir = kind === 'chief' ? path.join(home, 'donna') : kind === 'cto' ? path.join(home, CTO_ID) : path.join(home, KIND_DIRS[kind], agent.id);
  ensureDir(path.join(dir, 'memory'));
  const tplDir = kind === 'chief' ? 'donna' : kind;
  const vars = {
    owner,
    name: agent.name,
    mission: agent.mission,
    date,
    repo: agent.repo || 'none yet',
    domain: domainName || 'no parent domain',
    agent_ids: agentIds.length ? agentIds.join(', ') : 'none yet',
  };
  const existing = readJson(path.join(dir, 'agent.json'), null);
  // A re-render (init --force) keeps what an import recorded (source, repos).
  const kept = {};
  for (const k of ['source', 'repos']) if (existing?.[k] !== undefined && agent[k] === undefined) kept[k] = existing[k];
  writeJson(path.join(dir, 'agent.json'), { ...agent, ...kept, created_at: existing?.created_at || agent.created_at });
  backupThenWrite(path.join(dir, 'CLAUDE.md'), renderTemplate(readTemplate(`${tplDir}/CLAUDE.md`), vars), backupDir, home);
  writeIfMissing(path.join(dir, 'memory', 'NOW.md'), renderTemplate(readTemplate(`${tplDir}/NOW.md`), vars));
  writeIfMissing(path.join(dir, 'memory', 'LOG.md'), renderTemplate(readTemplate('LOG.md'), vars));
  installSkills(dir, backupDir, home, kind);
  if (kind === 'cto') {
    ensureDir(path.join(dir, 'reviews'));
    backupThenWrite(path.join(dir, '.claude', 'settings.json'), ctoSettingsText({ dir, home }), backupDir, home);
  }
  return dir;
}

function uniqueId(base, taken) {
  let id = base;
  if (RESERVED_IDS.has(id)) id = `${base}-2`;
  let n = 2;
  while (taken.has(id)) {
    const suffix = `-${n++}`;
    id = base.slice(0, 40 - suffix.length).replace(/-+$/, '') + suffix;
  }
  taken.add(id);
  return id;
}

/** Validate and fill in an answers.json object (see SETUP.md). */
export function normalizeAnswers(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('answers must be a JSON object');
  const owner = oneLine(raw.owner || os.userInfo().username || 'Owner', 80);
  if (!owner) throw new Error('answers.owner is required');
  const about = clampText(String(raw.about ?? '').trim(), 4000);
  const list = (v, label) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new Error(`answers.${label} must be an array`);
    if (v.length > 30) throw new Error(`answers.${label}: at most 30 entries`);
    return v;
  };
  const domains = list(raw.domains, 'domains').map((d, i) => {
    const name = oneLine(typeof d === 'string' ? d : d?.name, 60);
    if (!name) throw new Error(`answers.domains[${i}].name is required`);
    const mission = oneLine(typeof d === 'string' ? '' : d?.mission, 500) || defaultMission(name, owner);
    return { name, mission };
  });
  const projects = list(raw.projects, 'projects').map((p, i) => {
    const name = oneLine(p?.name, 60);
    if (!name) throw new Error(`answers.projects[${i}].name is required`);
    const goal = oneLine(p?.goal ?? p?.mission, 500) || `Ship ${name}`;
    let repo = p?.repo ? String(p.repo).trim() : null;
    if (repo) {
      if (repo.startsWith('~/')) repo = path.join(os.homedir(), repo.slice(2));
      if (!path.isAbsolute(repo)) throw new Error(`answers.projects[${i}].repo must be an absolute path`);
      repo = path.resolve(repo);
    }
    return { name, goal, repo, domain: p?.domain ? String(p.domain) : null };
  });
  // "Later" is how the interview words "not now": the same as none (Claude Code writes the JSON).
  let channel = raw.donna?.channel ?? 'none';
  if (typeof channel === 'string') channel = channel.trim().toLowerCase();
  if (channel === 'later' || channel === '' || channel === null) channel = 'none';
  if (!['telegram', 'imessage', 'none'].includes(channel)) throw new Error('answers.donna.channel must be telegram, imessage or none (or later)');
  // ask = "Ask before editing files" ("default" and "manual" are Claude Code's own names for it,
  // and 1.1.0's SETUP wrote "default"); inherit = the owner's own Claude Code setting, no flag.
  let permission_mode = raw.permission_mode ?? 'ask';
  if (permission_mode === 'default' || permission_mode === 'manual') permission_mode = 'ask';
  if (!['ask', 'acceptEdits', 'inherit'].includes(permission_mode)) throw new Error('answers.permission_mode must be ask, acceptEdits or inherit');
  return { owner, about, domains, projects, donna: { channel }, permission_mode };
}

export function defaultAnswers() {
  const user = os.userInfo().username || 'Owner';
  const owner = user.charAt(0).toUpperCase() + user.slice(1);
  return { owner, about: '', domains: ['Work', 'Health', 'Money', 'Home'].map((name) => ({ name })), projects: [], donna: { channel: 'none' } };
}

/**
 * Scaffold an org from answers. With force, re-render org and agent files over an existing org
 * (previous versions go to .archive/init-<timestamp>/); memory/ is never touched.
 */
export function initOrg({ home, answers, force = false, now = new Date() }) {
  const paths = runtimePaths(home);
  const exists = fs.existsSync(paths.orgJson);
  if (exists && !force) {
    throw new Error(`An org already exists at ${home}. Re-run with --force to re-render its templates (memory files are never overwritten).`);
  }
  const a = normalizeAnswers(answers);
  const date = today(now);
  ensureDir(home);
  ensureDir(paths.rt, 0o700);
  ensureDir(paths.logs, 0o700);
  const backupDir = exists ? path.join(paths.archive, `init-${now.toISOString().replace(/[:.]/g, '-')}`) : null;

  const taken = new Set(['donna']);
  // Keep ids of agents that already exist so --force re-renders instead of duplicating.
  const domainAgents = a.domains.map((d) => ({ ...d, id: uniqueId(slugify(d.name, 'area'), taken) }));
  const projectAgents = a.projects.map((p) => ({ ...p, id: uniqueId(slugify(p.name, 'project'), taken) }));
  const agentIds = [...domainAgents.map((d) => d.id), ...projectAgents.map((p) => p.id)];
  const created = now.toISOString();
  const pm = a.permission_mode === 'ask' ? null : a.permission_mode; // null = ask (permissions.js)

  const prev = exists ? readJson(paths.orgJson, {}) : {};
  const org = {
    version: 1,
    name: `${a.owner}'s org`,
    owner: a.owner,
    chief: 'donna',
    channels: prev.channels || { telegram: { enabled: false, chat_id: null }, imessage: { enabled: false, handle: null } },
    created_at: prev.created_at || created,
  };
  if (prev.donna_session) org.donna_session = prev.donna_session;
  writeJson(paths.orgJson, org);

  const areas = domainAgents.length ? domainAgents.map((d) => `- ${d.name}: ${d.mission}`).join('\n') : '- (none yet)';
  const projectsList = projectAgents.length ? projectAgents.map((p) => `- ${p.name}: ${p.goal}`).join('\n') : '- (none yet)';
  const orgVars = {
    owner: a.owner,
    org_name: org.name,
    about: a.about || `(Write a few lines about ${a.owner}: role, what matters right now, how to help.)`,
    areas,
    projects: projectsList,
  };
  backupThenWrite(paths.orgClaudeMd, renderTemplate(readTemplate('org/CLAUDE.md'), orgVars), backupDir, home);
  if (!exists || answers?.about || force) backupThenWrite(paths.meMd, renderTemplate(readTemplate('org/me.md'), orgVars), backupDir, home);
  writeIfMissing(path.join(home, '.gitignore'), readTemplate('org/gitignore'));
  backupThenWrite(path.join(home, '.claude', 'settings.json'), orgSettings(), backupDir, home);
  installSkills(home, backupDir, home, 'root');

  const donna = {
    id: 'donna',
    kind: 'chief',
    name: 'Donna',
    mission: `${a.owner}'s chief of staff: routes every request to the right agent and reports back`,
    icon: 'chat',
    color: '#FFB224',
    repo: null,
    domain: null,
    model: null,
    permission_mode: pm,
    created_at: created,
  };
  scaffoldAgent({ home, kind: 'chief', agent: donna, owner: a.owner, agentIds, backupDir, date });
  for (const d of domainAgents) {
    const agent = { id: d.id, kind: 'domain', name: d.name, mission: d.mission, ...styleFor(d.id, d.name), repo: null, domain: null, model: null, permission_mode: pm, created_at: created };
    scaffoldAgent({ home, kind: 'domain', agent, owner: a.owner, agentIds, backupDir, date });
  }
  for (const p of projectAgents) {
    const parent = p.domain ? domainAgents.find((d) => d.id === p.domain || d.id === slugify(p.domain, '') || d.name.toLowerCase() === p.domain.toLowerCase()) : null;
    const agent = {
      id: p.id, kind: 'project', name: p.name, mission: p.goal, ...styleFor(p.id, p.name),
      repo: p.repo, domain: parent ? parent.id : null, model: null, permission_mode: pm, created_at: created,
    };
    scaffoldAgent({ home, kind: 'project', agent, owner: a.owner, domainName: parent?.name, agentIds, backupDir, date });
  }
  return { home, owner: a.owner, channel: a.donna.channel, agents: ['donna', ...agentIds], backupDir };
}

// An import records remote, remote_key, github; a promoted Claude Code subagent records subagent
// (its name) and subagent_scope ('user' or 'repo'); both record imported_at.
const SOURCE_FIELDS = ['remote', 'remote_key', 'github', 'imported_at', 'subagent', 'subagent_scope'];

/** Where an imported or promoted agent came from: only these string fields, or null. */
function normalizeSource(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const k of SOURCE_FIELDS) if (typeof raw[k] === 'string' && raw[k].trim()) out[k] = oneLine(raw[k], 500);
  return Object.keys(out).length ? out : null;
}

// A repo path is written into the agent's session context (inside a code span): no line breaks,
// control characters or backticks, which could end the span or start a heading.
const UNSAFE_PATH_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029`]/;

/** A group project agent's repos: absolute paths only (no control characters or backticks), deduplicated, at most 20. */
function normalizeRepos(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (typeof r !== 'string' || !r || UNSAFE_PATH_RE.test(r) || !path.isAbsolute(r)) continue;
    const p = path.resolve(r);
    if (!out.includes(p)) out.push(p);
    if (out.length >= 20) break;
  }
  return out;
}

function normalizeAgent(raw, kind, dir) {
  return {
    id: raw.id,
    kind,
    name: oneLine(raw.name || raw.id, 80),
    mission: clampText(String(raw.mission || ''), 500),
    icon: raw.icon || null,
    color: raw.color || null,
    repo: kind === 'project' ? raw.repo || null : null,
    domain: kind === 'project' ? raw.domain || null : null,
    model: typeof raw.model === 'string' && isValidModel(raw.model) ? raw.model : null,
    // The default effort for new sessions (1.6: set by "Use this" after "Try a cheaper model").
    effort: isValidEffort(raw.effort) ? raw.effort : null,
    permission_mode: PERMISSION_MODES.has(raw.permission_mode) ? raw.permission_mode : null,
    created_at: raw.created_at || null,
    source: normalizeSource(raw.source),
    repos: kind === 'project' ? normalizeRepos(raw.repos) : [],
    dir,
  };
}

export class OrgStore {
  constructor(paths, { events } = {}) {
    this.paths = paths;
    this.home = paths.home;
    this.events = events;
  }

  exists() {
    return fs.existsSync(this.paths.orgJson);
  }

  read() {
    const org = readJson(this.paths.orgJson, null);
    if (!org || typeof org !== 'object') throw new HttpError(500, `no org at ${this.home}: run \`clawdling init\``);
    org.channels = org.channels || {};
    org.channels.telegram = { enabled: false, chat_id: null, ...(org.channels.telegram || {}) };
    org.channels.imessage = { enabled: false, handle: null, ...(org.channels.imessage || {}) };
    return org;
  }

  update(fn) {
    const org = this.read();
    const next = fn(org) || org;
    writeJson(this.paths.orgJson, next);
    return next;
  }

  /** Where an agent lives, or null. Never builds a path from an unvalidated id. */
  locate(id) {
    if (!isValidAgentId(id)) return null;
    const candidates =
      id === 'donna'
        ? [['chief', path.join(this.home, 'donna')]]
        : [
            // An org from before 1.7 may have a domain or project with the id "cto": it keeps it
            // (createCto refuses to add the seat until it is renamed or archived).
            ...(id === CTO_ID ? [['cto', path.join(this.home, CTO_ID)]] : []),
            ['domain', path.join(this.home, 'domains', id)],
            ['project', path.join(this.home, 'projects', id)],
          ];
    for (const [kind, dir] of candidates) {
      if (fs.existsSync(path.join(dir, 'agent.json'))) return { kind, dir };
    }
    return null;
  }

  agent(id) {
    const loc = this.locate(id);
    if (!loc) return null;
    const raw = readJson(path.join(loc.dir, 'agent.json'), null);
    if (!raw || typeof raw !== 'object') return null;
    return normalizeAgent({ ...raw, id }, loc.kind, loc.dir);
  }

  agents() {
    const out = [];
    const donna = this.agent('donna');
    if (donna) out.push(donna);
    const cto = this.cto();
    if (cto) out.push(cto);
    for (const kind of ['domain', 'project']) {
      const base = path.join(this.home, KIND_DIRS[kind]);
      let names = [];
      try {
        names = fs.readdirSync(base);
      } catch {
        continue;
      }
      const list = [];
      for (const id of names) {
        if (!isValidAgentId(id)) continue;
        const a = this.agent(id);
        if (a && a.kind === kind) list.push(a);
      }
      list.sort((x, y) => x.name.localeCompare(y.name));
      out.push(...list);
    }
    return out;
  }

  createAgent(input = {}) {
    const kind = input.kind;
    if (kind !== 'domain' && kind !== 'project') throw badRequest('kind must be "domain" or "project"');
    // Written into the agent's CLAUDE.md, which its sessions load as instructions: nothing hidden.
    const name = oneLine(cleanInput(input.name ?? ''), 60);
    if (!name) throw badRequest('name is required');
    const owner = this.read().owner || 'the owner';
    const mission = oneLine(cleanInput(input.mission ?? input.goal ?? ''), 500) || (kind === 'domain' ? defaultMission(name, owner) : `Ship ${name}`);
    let id = input.id === undefined || input.id === null || input.id === '' ? slugify(name, '') : input.id;
    if (!isValidAgentId(id)) throw badRequest('id must match ^[a-z0-9][a-z0-9-]{0,39}$');
    if (RESERVED_IDS.has(id)) throw conflict(`"${id}" is reserved`);
    if (this.locate(id) || fs.existsSync(path.join(this.home, 'domains', id)) || fs.existsSync(path.join(this.home, 'projects', id))) {
      throw conflict(`an agent with id "${id}" already exists`);
    }
    let repo = null;
    let domain = null;
    let domainName;
    if (kind === 'project') {
      if (input.repo) {
        repo = String(input.repo).trim();
        if (repo.startsWith('~/')) repo = path.join(os.homedir(), repo.slice(2));
        if (!path.isAbsolute(repo)) throw badRequest('repo must be an absolute path');
        repo = path.resolve(repo);
        let st;
        try {
          st = fs.statSync(repo);
        } catch {
          throw badRequest(`repo path does not exist: ${repo}`);
        }
        if (!st.isDirectory()) throw badRequest('repo must be a directory');
      }
      if (input.domain) {
        const parent = this.agent(String(input.domain));
        if (!parent || parent.kind !== 'domain') throw badRequest(`unknown domain "${input.domain}"`);
        domain = parent.id;
        domainName = parent.name;
      }
    }
    if (input.model !== undefined && input.model !== null && input.model !== '' && !isValidModel(input.model)) throw badRequest('invalid model');
    const agent = {
      id, kind, name, mission, ...styleFor(id, name), repo, domain,
      model: input.model || null,
      permission_mode: PERMISSION_MODES.has(input.permission_mode) ? input.permission_mode : null,
      created_at: new Date().toISOString(),
    };
    const agentIds = this.agents().map((x) => x.id).filter((x) => x !== 'donna').concat(id);
    scaffoldAgent({ home: this.home, kind, agent, owner, domainName, agentIds });
    return this.agent(id);
  }

  /** The CTO seat, or null when the org has none. */
  cto() {
    const a = this.agent(CTO_ID);
    return a && a.kind === 'cto' ? a : null;
  }

  /** "Add a CTO" (1.7): the seat's folder from templates/cto, beside Donna. One per org. */
  createCto() {
    if (this.cto()) throw conflict('This org already has a CTO.');
    // Fail closed, like the needs-you ping: no seat where its file rules cannot be written.
    if (!ctoPermissions({ dir: path.join(this.home, CTO_ID), home: this.home }).fileRules || !runtimeDeny(this.home).length) throw badRequest(CTO_UNGUARDED);
    if (this.locate(CTO_ID)) throw conflict('An agent called "cto" already exists. Rename or archive it first, then add the CTO.');
    const owner = this.read().owner || 'the owner';
    const agent = {
      id: CTO_ID,
      kind: 'cto',
      name: 'CTO',
      mission: `${owner}'s CTO: reads every project's receipts each week and asks ${owner} the decisions that matter`,
      icon: 'compass',
      color: '#3E63DD',
      repo: null,
      domain: null,
      model: null,
      // Always "Ask before editing": the seat never runs in another mode (sessions.js).
      permission_mode: null,
      created_at: new Date().toISOString(),
    };
    scaffoldAgent({ home: this.home, kind: 'cto', agent, owner, agentIds: [] });
    return this.cto();
  }

  /** Rewrite the CTO folder's settings file from this version's template (an older or edited copy). */
  refreshCtoSettings() {
    const a = this.cto();
    if (!a) return false;
    const file = path.join(a.dir, '.claude', 'settings.json');
    try {
      if (fs.lstatSync(path.dirname(file)).isSymbolicLink()) return false; // the seat refuses to start (cto.js)
    } catch {
      // no .claude yet
    }
    const want = ctoSettingsText({ dir: a.dir, home: this.home });
    let have = null;
    try {
      have = fs.readFileSync(file, 'utf8');
    } catch {
      // missing
    }
    if (have === want) return false;
    ensureDir(path.dirname(file));
    if (have !== null) {
      // Never through a link: the old copy is replaced, not written into whatever it points at.
      try {
        if (fs.lstatSync(`${file}.old`).isSymbolicLink()) fs.unlinkSync(`${file}.old`);
      } catch {
        // no old copy
      }
      writeFileAtomic(`${file}.old`, have, 0o644);
    }
    writeFileAtomic(file, want, 0o644);
    return true;
  }

  require(id) {
    const a = this.agent(id);
    if (!a) throw notFound(`no agent "${id}"`);
    return a;
  }

  /**
   * Merge extra fields into an agent's agent.json (an import records `source` and `repos` this
   * way). id, kind and created_at are kept as they are. Returns the normalized agent.
   */
  updateAgentJson(id, patch = {}) {
    const loc = this.locate(id);
    if (!loc) throw notFound(`no agent "${id}"`);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw badRequest('patch must be an object');
    const file = path.join(loc.dir, 'agent.json');
    const raw = readJson(file, null);
    if (!raw || typeof raw !== 'object') throw notFound(`no agent "${id}"`);
    const next = { ...raw };
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id' || k === 'kind' || k === 'created_at') continue;
      if (v === undefined) delete next[k];
      else next[k] = v;
    }
    writeJson(file, next);
    return this.agent(id);
  }

  /**
   * Install any skill file that is missing at the org root and in agent folders (an org made by
   * an older version has no onboard-project). Never overwrites a skill file that exists.
   */
  ensureSkills() {
    const write = (dir, kind) => {
      for (const skill of SKILLS_FOR[kind] || BASE_SKILLS) {
        const file = skillFile(dir, skill);
        if (FRESH_SKILLS.has(skill)) {
          // The setup sheet promises what this skill does: an edited or older copy is replaced
          // with this version's text (the old one is kept beside it as SKILL.md.old).
          try {
            const want = readTemplate(`skills/${skill}/SKILL.md`);
            const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
            if (have === want) continue;
            ensureDir(path.dirname(file));
            if (have !== null) fs.writeFileSync(`${file}.old`, have);
            fs.writeFileSync(file, want);
          } catch {
            // best effort
          }
          continue;
        }
        if (fs.existsSync(file)) continue;
        try {
          ensureDir(path.dirname(file));
          fs.writeFileSync(file, readTemplate(`skills/${skill}/SKILL.md`));
        } catch {
          // best effort: a read-only folder keeps working without the skill
        }
      }
    };
    write(this.home, 'root');
    for (const a of this.agents()) write(a.dir, a.kind);
  }

  context(id) {
    const a = this.require(id);
    const read = (f) => {
      try {
        return fs.readFileSync(f, 'utf8');
      } catch {
        return '';
      }
    };
    const log = read(path.join(a.dir, 'memory', 'LOG.md'));
    const logTail = log.split('\n').filter((l) => l.trim()).slice(-20);
    return { claude_md: read(path.join(a.dir, 'CLAUDE.md')), now_md: read(path.join(a.dir, 'memory', 'NOW.md')), log_tail: logTail };
  }

  writeContext(id, body = {}) {
    const a = this.require(id);
    const writes = [];
    for (const [key, rel] of [['claude_md', 'CLAUDE.md'], ['now_md', path.join('memory', 'NOW.md')]]) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== 'string') throw badRequest(`${key} must be a string`);
      if (Buffer.byteLength(body[key]) > CONTEXT_MAX_BYTES) throw new HttpError(413, `${key} is larger than 200 KB`);
      writes.push([path.join(a.dir, rel), body[key]]);
    }
    if (!writes.length) throw badRequest('nothing to write: send claude_md and/or now_md');
    for (const [file, text] of writes) {
      ensureDir(path.dirname(file));
      writeFileAtomic(file, text, 0o644);
    }
    return a;
  }

  archiveAgent(id) {
    if (id === 'donna') throw badRequest("Donna is the chief of staff and can't be archived");
    const a = this.require(id);
    ensureDir(this.paths.archive);
    const dest = path.join(this.paths.archive, `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.renameSync(a.dir, dest);
    return { id, archived_to: dest };
  }
}

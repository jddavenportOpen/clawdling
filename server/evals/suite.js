// Agent check-up suites (1.6), in Anthropic's `claude plugin eval` file format, a deliberate subset:
//
//   <agent folder>/evals/<case>/prompt.md           frontmatter: name, description, max_turns,
//                                                   timeout_seconds, allowed_tools; body = the prompt
//   <agent folder>/evals/<case>/graders/<name>.md   type: llm | regex | tool_used | tool_order |
//                                                   file_exists (+ that type's keys); body = criteria
//                                                   (llm) or pattern (regex)
//   <agent folder>/evals/<case>/reference.md        Clawdling only: a good answer, for the judge control
//   <agent folder>/evals/.clawdling-suite.yaml      Clawdling only: runs, judge model, cost cap
//   <agent folder>/evals/results/<ts>.json          Clawdling's results
//
// prompt.md and grader frontmatter use only keys plugin eval's loader accepts (it refuses unknown
// keys), so these files also load with `claude plugin eval`. The key lists are pinned below from
// Claude Code 2.1.308 and held by test/unit/evals.test.js.
//
// The agent can edit its own folder, so a case runs only while it is exactly what the owner
// approved in the cockpit: a fingerprint per case is kept in .clawdling/evals/<agent>/approved.json.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, badRequest, isValidAgentId, notFound, readJson, writeFileAtomic, writeJson } from '../util.js';
import { YamlError, joinFrontmatter, parseYaml, splitFrontmatter, stringifyYaml } from '../yaml-lite.js';

// plugin eval's own lists (Claude Code 2.1.308): prompt.md frontmatter = top-level keys + execution keys.
export const PLUGIN_EVAL_PROMPT_KEYS = ['schema_version', 'name', 'description', 'tags', 'plugins', 'runs', 'expected_outcome', 'model', 'max_turns', 'timeout_seconds', 'allowed_tools', 'disallowed_tools', 'artifact_publish', 'growthbook_overrides', 'append_system_prompt', 'env'];
// Its grader schemas (strict, per type); `name` comes from the file name, criteria/pattern from the body.
export const PLUGIN_EVAL_GRADER_KEYS = {
  regex: ['type', 'name', 'target', 'pattern', 'flags', 'match', 'weight', 'arm'],
  tool_order: ['type', 'name', 'before', 'after', 'weight', 'arm'],
  tool_used: ['type', 'name', 'tool', 'input_match', 'min', 'max', 'weight', 'arm'],
  file_exists: ['type', 'name', 'path', 'exists', 'weight', 'arm'],
  llm: ['type', 'name', 'criteria', 'focus', 'weight', 'arm'],
  baseline: ['type', 'name', 'baseline_file', 'criteria', 'weight', 'arm'],
};
// What Clawdling reads and honours (the subset). Other plugin-eval keys load but are refused with a
// plain reason rather than silently ignored.
export const PROMPT_KEYS = ['name', 'description', 'tags', 'max_turns', 'timeout_seconds', 'allowed_tools', 'model'];
export const GRADER_TYPES = ['regex', 'tool_used', 'tool_order', 'file_exists', 'llm'];
export const GRADER_KEYS = Object.fromEntries(GRADER_TYPES.map((t) => [t, PLUGIN_EVAL_GRADER_KEYS[t].filter((k) => k !== 'arm' && k !== 'name')]));
export const SUITE_FILE = '.clawdling-suite.yaml';
export const SUITE_DEFAULTS = { runs: 1, judge_model: 'haiku', max_cost_usd: 2, created_by_draft_version: null };
const CASE_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const GRADER_RE = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const MAX_CASES = 20;
const MAX_FILE = 64 * 1024;
export const DEFAULT_TOOLS = ['Read', 'Glob', 'Grep'];
// Read-only tools a case may allow. No Bash in 1.6: a command pattern cannot be made safe here,
// because Claude Code merges allow rules from every settings layer and the first word of a command
// says little about what it runs (`git -c alias...`, `npx`, `/bin/sh`).
const SAFE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'TodoWrite']);

/** Is this allowed_tools entry one a 1.6 check-up runs with? Returns null, or why not. */
export function toolProblem(t) {
  if (typeof t !== 'string' || !t) return 'empty tool name';
  if (SAFE_TOOLS.has(t)) return null;
  if (/^(Bash|PowerShell)\b/.test(t)) return `${t}: a 1.6 check-up cannot run commands (read-only tools: Read, Glob, Grep, LS). Ship checks run your test commands.`;
  return `${t} is not available in a 1.6 check-up (read-only tools: Read, Glob, Grep, LS)`;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** The evals folder of an agent folder. */
export const evalsDir = (agentDir) => path.join(agentDir, 'evals');

/**
 * Is `dir` a real folder (not a link, not a file)? Makes it when missing and `create` is set. Every
 * read listing and every write under evals/ goes through this, so a link the agent planted (evals ->
 * your home folder) is refused instead of listed, written into or deleted.
 */
export function realDir(dir, { create = false } = {}) {
  let st = null;
  try {
    st = fs.lstatSync(dir);
  } catch {
    st = null;
  }
  if (st && !st.isDirectory()) throw badRequest(`${path.basename(dir)} is a link or a file, not a folder: Clawdling reads and writes check-ups only in real folders inside the agent folder`);
  if (!st && create) fs.mkdirSync(dir, { mode: 0o755 });
  return !!st || create;
}

/** The folder of one case, every step a real folder (evals/<case>[/graders]). */
export function caseDir(agentDir, id, { create = false, graders = false } = {}) {
  if (!CASE_RE.test(String(id || ''))) throw badRequest('a case name is lower-case letters, numbers and -, at most 60');
  const evals = evalsDir(agentDir);
  if (!realDir(evals, { create })) return null;
  const cdir = path.join(evals, id);
  if (!realDir(cdir, { create })) return null;
  if (graders && !realDir(path.join(cdir, 'graders'), { create })) return null;
  return cdir;
}

function readSmall(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Parse and check one grader file. Returns {name, type, ...keys, criteria|pattern} or throws. */
export function parseGrader(name, text) {
  if (!GRADER_RE.test(name)) throw badRequest(`grader file name "${name}" must be lower-case letters, numbers, - or _`);
  let parsed;
  try {
    parsed = splitFrontmatter(text);
  } catch (err) {
    throw badRequest(`graders/${name}.md: ${err.message}`);
  }
  const { fm, body } = parsed;
  if (!parsed.had) throw badRequest(`graders/${name}.md: needs frontmatter with a type (${GRADER_TYPES.join(', ')})`);
  if (typeof fm.type !== 'string') throw badRequest(`graders/${name}.md: frontmatter must include type: (${GRADER_TYPES.join(' | ')})`);
  if (!GRADER_TYPES.includes(fm.type)) throw badRequest(`graders/${name}.md: type "${fm.type}" is not supported in 1.6 (${GRADER_TYPES.join(', ')})`);
  const allowed = new Set(GRADER_KEYS[fm.type]);
  for (const k of Object.keys(fm)) if (!allowed.has(k)) throw badRequest(`graders/${name}.md: unknown frontmatter key "${k}" for a ${fm.type} grader (expected one of: ${[...allowed].join(', ')})`);
  const g = { name, ...fm };
  const text2 = String(body || '').trim();
  if (fm.type === 'llm' && g.criteria === undefined) g.criteria = text2;
  if (fm.type === 'regex' && g.pattern === undefined) g.pattern = text2;
  g.weight = g.weight === undefined ? 1 : g.weight;
  if (!(typeof g.weight === 'number' && g.weight > 0)) throw badRequest(`graders/${name}.md: weight must be a positive number`);
  const target = (v, key) => {
    if (v === undefined) return 'last_message';
    if (['last_message', 'trace', 'files'].includes(v)) return v;
    if (v && typeof v === 'object' && v.source === 'file' && typeof v.path === 'string' && Object.keys(v).length === 2) {
      if (path.isAbsolute(v.path) || v.path.split(/[\\/]/).includes('..')) throw badRequest(`graders/${name}.md: ${key} file path must stay inside the run folder`);
      return v;
    }
    throw badRequest(`graders/${name}.md: ${key} must be last_message, trace, files or {source: file, path: ...}`);
  };
  if (fm.type === 'llm') {
    if (typeof g.criteria !== 'string' || !g.criteria.trim()) throw badRequest(`graders/${name}.md: an llm grader needs its criteria in the body`);
    g.focus = target(g.focus, 'focus');
  } else if (fm.type === 'regex') {
    if (typeof g.pattern !== 'string' || !g.pattern) throw badRequest(`graders/${name}.md: a regex grader needs its pattern in the body`);
    g.target = target(g.target, 'target');
    g.flags = g.flags === undefined ? '' : g.flags;
    if (typeof g.flags !== 'string' || !/^[dgimsuvy]*$/.test(g.flags)) throw badRequest(`graders/${name}.md: flags must be JS RegExp flags (d g i m s u v y)`);
    g.match = g.match === undefined ? 'contains' : g.match;
    if (!(g.match === 'contains' || g.match === 'not_contains' || /^count:\d+$/.test(String(g.match)))) throw badRequest(`graders/${name}.md: match must be contains | not_contains | count:N`);
    try {
      new RegExp(g.pattern, g.flags); // eslint-disable-line no-new
    } catch (err) {
      throw badRequest(`graders/${name}.md: the pattern is not a valid regular expression (${err.message})`);
    }
  } else if (fm.type === 'tool_used') {
    if (typeof g.tool !== 'string' || !g.tool) throw badRequest(`graders/${name}.md: tool_used needs tool:`);
    for (const k of ['min', 'max']) if (g[k] !== undefined && !(Number.isInteger(g[k]) && g[k] >= 0)) throw badRequest(`graders/${name}.md: ${k} must be a whole number`);
    if (g.input_match !== undefined) {
      if (typeof g.input_match !== 'string') throw badRequest(`graders/${name}.md: input_match must be a regular expression`);
      try {
        new RegExp(g.input_match); // eslint-disable-line no-new
      } catch (err) {
        throw badRequest(`graders/${name}.md: input_match is not a valid regular expression (${err.message})`);
      }
    }
  } else if (fm.type === 'tool_order') {
    const spec = (v, k) => {
      if (typeof v === 'string' && v) return { tool: v };
      if (v && typeof v === 'object' && typeof v.tool === 'string' && Object.keys(v).every((x) => x === 'tool' || x === 'input_match')) return v;
      throw badRequest(`graders/${name}.md: ${k} must be a tool name or {tool, input_match}`);
    };
    g.before = spec(g.before, 'before');
    g.after = spec(g.after, 'after');
  } else if (fm.type === 'file_exists') {
    if (typeof g.path !== 'string' || !g.path) throw badRequest(`graders/${name}.md: file_exists needs path:`);
    g.exists = g.exists === undefined ? true : g.exists;
    if (typeof g.exists !== 'boolean') throw badRequest(`graders/${name}.md: exists must be true or false`);
  }
  return g;
}

/** Parse and check prompt.md. Returns {fm, prompt} (fm with defaults) or throws. */
export function parsePrompt(text, { caseId = 'case' } = {}) {
  let parsed;
  try {
    parsed = splitFrontmatter(text);
  } catch (err) {
    throw badRequest(`${caseId}/prompt.md: ${err.message}`);
  }
  const fm = parsed.fm || {};
  for (const k of Object.keys(fm)) {
    if (!PLUGIN_EVAL_PROMPT_KEYS.includes(k)) throw badRequest(`${caseId}/prompt.md: unknown frontmatter key "${k}" (expected one of: ${PROMPT_KEYS.join(', ')})`);
    if (!PROMPT_KEYS.includes(k)) throw badRequest(`${caseId}/prompt.md: "${k}" is a plugin-eval setting Clawdling does not run in 1.6; remove it`);
  }
  const prompt = String(parsed.body || '').trim();
  if (!prompt) throw badRequest(`${caseId}/prompt.md: the prompt (the text under the frontmatter) is empty`);
  if (/^TODO: describe what the agent should do/m.test(prompt)) throw badRequest(`${caseId}/prompt.md: still the blank template; write the prompt to test`);
  const out = {
    name: typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim().slice(0, 80) : caseId,
    description: typeof fm.description === 'string' ? fm.description.trim().slice(0, 300) : '',
    max_turns: fm.max_turns === undefined ? 6 : fm.max_turns,
    timeout_seconds: fm.timeout_seconds === undefined ? 180 : fm.timeout_seconds,
    allowed_tools: fm.allowed_tools === undefined ? [...DEFAULT_TOOLS] : fm.allowed_tools,
    model: fm.model === undefined ? null : fm.model,
  };
  if (!Number.isInteger(out.max_turns) || out.max_turns < 1 || out.max_turns > 50) throw badRequest(`${caseId}/prompt.md: max_turns must be a whole number from 1 to 50`);
  if (!Number.isInteger(out.timeout_seconds) || out.timeout_seconds < 10 || out.timeout_seconds > 1800) throw badRequest(`${caseId}/prompt.md: timeout_seconds must be from 10 to 1800`);
  if (!Array.isArray(out.allowed_tools) || out.allowed_tools.length > 20) throw badRequest(`${caseId}/prompt.md: allowed_tools must be a list`);
  for (const t of out.allowed_tools) {
    const why = toolProblem(t);
    if (why) throw badRequest(`${caseId}/prompt.md: ${why}`);
  }
  if (out.model !== null && (typeof out.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/.test(out.model))) throw badRequest(`${caseId}/prompt.md: model must be a model name`);
  return { fm: out, prompt };
}

/** The Clawdling-only suite settings (.clawdling-suite.yaml), with defaults. */
export function parseSettings(text) {
  if (!text) return { ...SUITE_DEFAULTS };
  let raw;
  try {
    raw = parseYaml(text) || {};
  } catch (err) {
    throw badRequest(`${SUITE_FILE}: ${err.message}`);
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw badRequest(`${SUITE_FILE}: must be key: value lines`);
  const out = { ...SUITE_DEFAULTS };
  if (raw.runs !== undefined) out.runs = raw.runs;
  if (raw.judge_model !== undefined) out.judge_model = raw.judge_model;
  if (raw.max_cost_usd !== undefined) out.max_cost_usd = raw.max_cost_usd;
  if (raw.created_by_draft_version !== undefined) out.created_by_draft_version = raw.created_by_draft_version;
  if (![1, 3].includes(out.runs)) throw badRequest(`${SUITE_FILE}: runs is 1 or 3`);
  if (typeof out.judge_model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/.test(out.judge_model)) throw badRequest(`${SUITE_FILE}: judge_model must be a model name`);
  if (!(typeof out.max_cost_usd === 'number' && out.max_cost_usd > 0 && out.max_cost_usd <= 50)) throw badRequest(`${SUITE_FILE}: max_cost_usd must be more than 0 and at most 50`);
  return out;
}

/** The fingerprint of a case: every file the run and graders read. */
function caseHash(files) {
  return sha(JSON.stringify(Object.keys(files).sort().map((k) => [k, files[k]])));
}

/**
 * The suite in an agent folder: cases (parsed, or with the error that stops each one), settings,
 * and per case whether it is still what the owner approved.
 */
export function loadSuite(agentDir, approvals = {}) {
  const dir = evalsDir(agentDir);
  const out = { dir, exists: false, cases: [], settings: { ...SUITE_DEFAULTS }, settings_error: null, settings_text: null };
  let names = [];
  try {
    if (!realDir(dir)) return out;
  } catch (err) {
    return { ...out, exists: true, settings_error: err.message };
  }
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && CASE_RE.test(e.name) && e.name !== 'results' && e.name !== 'mocks').map((e) => e.name).sort();
    out.exists = true;
  } catch {
    return out;
  }
  const settingsText = readSmall(path.join(dir, SUITE_FILE));
  out.settings_text = settingsText;
  try {
    out.settings = parseSettings(settingsText);
  } catch (err) {
    out.settings_error = err.message;
  }
  for (const id of names.slice(0, MAX_CASES)) {
    const cdir = path.join(dir, id);
    const files = {};
    const promptText = readSmall(path.join(cdir, 'prompt.md'));
    if (promptText !== null) files['prompt.md'] = promptText;
    let graderNames = [];
    try {
      if (!realDir(path.join(cdir, 'graders'))) throw new Error('no graders folder');
      graderNames = fs.readdirSync(path.join(cdir, 'graders'), { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name).sort();
    } catch {
      graderNames = [];
    }
    for (const g of graderNames.slice(0, 20)) {
      const t = readSmall(path.join(cdir, 'graders', g));
      if (t !== null) files[`graders/${g}`] = t;
    }
    const ref = readSmall(path.join(cdir, 'reference.md'));
    if (ref !== null) files['reference.md'] = ref;
    const c = { id, files, hash: caseHash(files), error: null, prompt: null, fm: null, graders: [], reference: ref === null ? null : ref.trim() };
    try {
      if (promptText === null) throw badRequest(`${id}: prompt.md is missing`);
      const p = parsePrompt(promptText, { caseId: id });
      c.prompt = p.prompt;
      c.fm = p.fm;
      for (const g of graderNames) {
        const t = files[`graders/${g}`];
        if (t === undefined) continue;
        c.graders.push(parseGrader(g.replace(/\.md$/, ''), t));
      }
      if (!c.graders.length) throw badRequest(`${id}: add at least one grader in graders/`);
    } catch (err) {
      c.error = err instanceof HttpError ? err.message : `could not read: ${err.message}`;
    }
    c.approved = approvals[id] === c.hash;
    out.cases.push(c);
  }
  out.truncated = names.length > MAX_CASES;
  out.settings_approved = approvals[SUITE_FILE] === sha(settingsText || '');
  return out;
}

/** Approvals live in .clawdling/evals/<agent>/approved.json: {case id: fingerprint}. */
export class Approvals {
  constructor(rtDir) {
    this.root = path.join(rtDir, 'evals');
  }

  file(agent) {
    if (!isValidAgentId(agent)) throw badRequest('invalid agent id');
    return path.join(this.root, agent, 'approved.json');
  }

  read(agent) {
    const o = readJson(this.file(agent), null);
    return o && typeof o === 'object' && o.cases && typeof o.cases === 'object' ? o.cases : {};
  }

  set(agent, entries) {
    const cur = this.read(agent);
    for (const [k, v] of Object.entries(entries)) {
      if (v === null) delete cur[k];
      else cur[k] = v;
    }
    fs.mkdirSync(path.dirname(this.file(agent)), { recursive: true, mode: 0o700 });
    writeJson(this.file(agent), { cases: cur, updated_at: new Date().toISOString() }, 0o600);
    return cur;
  }

  settingsHash(text) {
    return sha(text || '');
  }
}

/**
 * Write one case from the cockpit's editor: prompt.md, its graders and an optional reference.md.
 * Everything is validated first; nothing is written when any file is wrong. Grader files the edit
 * no longer has are removed.
 */
export function writeCase(agentDir, id, { prompt, graders, reference }) {
  if (!CASE_RE.test(String(id || ''))) throw badRequest('a case name is lower-case letters, numbers and -, at most 60');
  if (typeof prompt !== 'string' || prompt.length > MAX_FILE) throw badRequest('send prompt.md as text (at most 64 KB)');
  parsePrompt(prompt, { caseId: id });
  if (!graders || typeof graders !== 'object' || Array.isArray(graders) || !Object.keys(graders).length) throw badRequest('send at least one grader: {graders: {name: text}}');
  if (Object.keys(graders).length > 20) throw badRequest('at most 20 graders');
  for (const [name, text] of Object.entries(graders)) {
    if (typeof text !== 'string' || text.length > MAX_FILE) throw badRequest(`graders/${name}.md must be text (at most 64 KB)`);
    parseGrader(name, text);
  }
  if (reference !== undefined && reference !== null && (typeof reference !== 'string' || reference.length > MAX_FILE)) throw badRequest('reference.md must be text (at most 64 KB)');
  const cdir = caseDir(agentDir, id, { create: true, graders: true });
  writeFileAtomic(path.join(cdir, 'prompt.md'), prompt.endsWith('\n') ? prompt : `${prompt}\n`, 0o644);
  for (const [name, text] of Object.entries(graders)) writeFileAtomic(path.join(cdir, 'graders', `${name}.md`), text.endsWith('\n') ? text : `${text}\n`, 0o644);
  for (const f of fs.readdirSync(path.join(cdir, 'graders'))) {
    if (f.endsWith('.md') && !Object.hasOwn(graders, f.replace(/\.md$/, ''))) fs.unlinkSync(path.join(cdir, 'graders', f));
  }
  const refFile = path.join(cdir, 'reference.md');
  if (typeof reference === 'string' && reference.trim()) writeFileAtomic(refFile, reference.endsWith('\n') ? reference : `${reference}\n`, 0o644);
  else if (reference === null || reference === '') fs.rmSync(refFile, { force: true });
}

/** Write the suite settings file. */
export function writeSettings(agentDir, settings) {
  const s = parseSettings(stringifyYaml({ ...SUITE_DEFAULTS, ...settings }));
  const text = `# Clawdling check-up settings (not part of the plugin-eval format).\n${stringifyYaml({ runs: s.runs, judge_model: s.judge_model, max_cost_usd: s.max_cost_usd, ...(s.created_by_draft_version ? { created_by_draft_version: s.created_by_draft_version } : {}) })}`;
  realDir(evalsDir(agentDir), { create: true });
  writeFileAtomic(path.join(evalsDir(agentDir), SUITE_FILE), text, 0o644);
  return text;
}

/** A prompt.md written by Clawdling (only plugin-eval keys). */
export function promptFile({ name, description, max_turns = 6, timeout_seconds = 180, allowed_tools = DEFAULT_TOOLS }, body) {
  return joinFrontmatter({ name, description, max_turns, timeout_seconds, allowed_tools }, body);
}

/** A grader file written by Clawdling. */
export function graderFile(fm, body) {
  return joinFrontmatter(fm, body);
}

export function requireCase(suite, id) {
  const c = suite.cases.find((x) => x.id === id);
  if (!c) throw notFound(`no case "${id}"`);
  return c;
}

export { YamlError };

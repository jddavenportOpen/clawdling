#!/usr/bin/env node
// Mock Clawdling server for the cockpit E2E suite.
//
// Implements the SPEC §4 HTTP/WS/SSE contract in memory (fake org, fake
// sessions with statuses, SSE events, a WS terminal that echoes input and
// streams ANSI output) and serves web/ plus /vendor/* exactly like the real
// server. Nothing here talks to claude, tmux, Telegram or iMessage.
//
// Test-only control routes live under /__mock/* (reset to a fixture, read the
// recorded requests, push a channel event). The real server has none of them.
//
//   node test/e2e/mock-server.mjs [--port 4848] [--fixture default|small|big|empty] [--token T]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
// The real server's own words, so the suite asserts what real users see.
import { IMPORTS_NOTICE, LOGIN_NOTICE, SIGNED_IN_NOTICE, trustNotice } from '../../server/sessions.js';
import { COST_LABEL, nextOf, windowRange } from '../../server/report.js';
import { localDay } from '../../server/ledger.js';
import { digestText } from '../../server/digest.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const WEB = path.join(ROOT, 'web');
const NM = path.join(ROOT, 'node_modules');

export const VENDOR = {
  '/vendor/preact.mjs': 'preact/dist/preact.mjs',
  '/vendor/preact-hooks.mjs': 'preact/hooks/dist/hooks.mjs',
  '/vendor/htm.mjs': 'htm/dist/htm.mjs',
  '/vendor/xterm.mjs': '@xterm/xterm/lib/xterm.mjs',
  '/vendor/xterm.css': '@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.mjs': '@xterm/addon-fit/lib/addon-fit.mjs',
  '/vendor/addon-web-links.mjs': '@xterm/addon-web-links/lib/addon-web-links.mjs',
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

const MIN = 60e3;
const REMOTE_GOOD = new Set(['private', 'unconfirmed', 'access']);
const REMOTE_TEXT = {
  private: 'Private to your devices ✓', access: 'Behind Cloudflare Access ✓', unreachable: 'Not reachable',
  unconfirmed: 'Reachable on your tailnet (Funnel not confirmed off)', public: 'Public: Tailscale Funnel is on ✗', unprotected: 'Not behind Cloudflare Access ✗',
};
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const CLAUDE = '\x1b[38;2;217;119;87m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const STARTUP_DIALOG_KINDS = new Set(['trust', 'imports', 'login']);
// Questions POST /answer may answer (the real server's ANSWERABLE), and the waits during which
// POST /send is refused with 409 (its ANSWER_IN_TERMINAL).
const ANSWERABLE = new Set(['trust', 'imports', 'permission_prompt']);
const ANSWER_FIRST = new Set(['trust', 'imports', 'login', 'startup', 'permission_prompt', 'elicitation_dialog']);
// A Claude Code permission prompt as the real server reads it off the screen (numbered labels).
const permissionChoices = (what = 'npm') => ['1. Yes', `2. Yes, and don't ask again for ${what} commands in this project`, '3. No, and tell Claude what to do differently (esc)']
  .map((label, i) => ({ option: i + 1, label }));
const HOME = '/Users/ada/clawdling';
// What /api/health reports; /__mock/health overrides parts of it until the next reset.
const baseHealth = () => ({
  ok: true, version: '1.1.0-mock',
  backend: { kind: 'tmux', socket: 'clawdling', persistent: true, reason: 'tmux 3.6a is installed', label: 'tmux (sessions keep running when Clawdling stops)' },
  tmux: { ok: true, version: '3.6a' }, claude: { ok: true, version: '2.1.0 (mock)' }, home: HOME,
  cli: 'node ~/clawdling-app/bin/clawdling.js', platform: 'darwin',
});

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function slug(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
}

export function deriveTitle(text) {
  let t = String(text || '').replace(/https?:\/\/\S+/g, '').replace(/[`*_#>[\]()~]/g, '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.+?[.!?])(\s|$)/);
  if (m) t = m[1];
  t = t.replace(/[.!?]+$/, '');
  if (t.length > 48) t = `${t.slice(0, 47).replace(/\s+\S*$/, '')}…`;
  if (!t) return null;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function defaultClaudeMd(a, owner) {
  return [`# ${a.name} agent`, `You are the ${a.name} agent in ${owner}'s org. Mission: ${a.mission}.`, '## How you work',
    `- Stay in your lane: ${a.name}. If a request belongs to another agent, say which one.`,
    '- Keep your memory current: before you finish, update memory/NOW.md (state, open threads, next steps; under 40 lines) and append one dated line to memory/LOG.md. The /handoff skill does this.',
    '- Ask before anything irreversible or outward-facing (sending messages, spending money, deleting).', '## Current state', '@memory/NOW.md', ''].join('\n');
}

function defaultNow(a) {
  return [`# ${a.name}: now`, '', '## State', `- ${a.mission}`, '', '## Open threads', '- Nothing open yet.', '', '## Next steps', '- Wait for the first request.', ''].join('\n');
}

// ---------------------------------------------------------------- fixtures
const DOMAIN_STYLE = {
  work: ['briefcase', '#7aa2f7'], health: ['heart', '#e5484d'], money: ['coin', '#3fb27f'], home: ['home', '#e09f3e'],
  family: ['users', '#c17be0'], learning: ['book', '#5bc0be'], writing: ['book', '#d6869d'],
};

function mkAgent(id, kind, name, mission, extra = {}) {
  const style = DOMAIN_STYLE[id] || [];
  return {
    id, kind, name, mission,
    icon: extra.icon !== undefined ? extra.icon : (kind === 'chief' ? 'chat' : kind === 'project' ? 'folder' : style[0] || null),
    color: extra.color !== undefined ? extra.color : (style[1] || null),
    repo: extra.repo || null, domain: extra.domain || null, model: extra.model || null, permission_mode: null,
    created_at: iso(extra.age || 30 * DAY),
    _now: extra.now || null, _claude: extra.claude || null,
    _log: extra.log || [`${new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10)} Created ${name}.`],
  };
}

function baseAgents() {
  return [
    mkAgent('donna', 'chief', 'Donna', "Ada's chief of staff: routes every request to the right agent and reports back", {
      now: ['# Donna: now', '', '## State', '- Morning brief sent at 07:30.', '- Work is waiting on a Bash permission for the roadmap draft.', '',
        '## Open threads', "- Health: confirm Thursday's long run.", '- Home: dishwasher quotes due Friday.', '', '## Next steps', '- Check in with Work after lunch.', ''].join('\n'),
      log: ['2026-10-20 Routed "book the dentist" to Home.', '2026-10-21 Sent the morning brief; 3 items.', '2026-10-22 Routed "Q4 roadmap draft" to Work.'],
    }),
    mkAgent('work', 'domain', 'Work', 'Run my product work: roadmap, hiring and the weekly review'),
    mkAgent('health', 'domain', 'Health', 'Keep training, sleep and food on track for a spring half marathon', {
      now: ['# Health: now', '', '## State', '- Week 6 of 14. Long run Sunday: 14 km.', '- Sleep average 7h05 this week.', '', '## Open threads',
        '- Knee felt tight after Tuesday intervals.', '', '## Next steps', "- Plan this week's sessions around Thursday travel.", ''].join('\n'),
      log: ['2026-10-19 Logged long run, 13 km, easy.', '2026-10-21 Moved intervals to Wednesday.', "2026-10-22 Started planning this week's training."],
    }),
    mkAgent('money', 'domain', 'Money', 'Budget, bills and taxes, without surprises'),
    mkAgent('home', 'domain', 'Home', 'Repairs, appliances and the household calendar'),
  ];
}

function sess(agentsById, agent, title, status, opts = {}) {
  const a = agentsById[agent];
  const sid = opts.sid || crypto.randomUUID();
  const ended = status === 'ended';
  const last = opts.last ?? 5 * MIN;
  return {
    sid, agent, agent_name: a ? a.name : agent, kind: a ? a.kind : 'domain', title: title || null, status,
    model: opts.model || (a && a.model) || null,
    cwd: a ? (a.repo || `${HOME}/${a.kind === 'chief' ? a.id : a.kind === 'project' ? `projects/${a.id}` : `domains/${a.id}`}`) : HOME,
    tmux_name: `cl-${agent}-${sid.slice(0, 6)}`,
    created_at: iso((opts.age ?? last) + 20 * MIN),
    last_activity_at: iso(ended ? (opts.ended ?? last) : last),
    ended_at: ended ? iso(opts.ended ?? 2 * HOUR) : null,
    notification: opts.notification || null,
    waiting_on: status === 'needs_you' ? (opts.waiting_on || 'notification') : null,
    choices: status === 'needs_you' && opts.choices ? opts.choices : null,
    resumable: opts.resumable ?? true,
    permission_mode: null,
    last_message: opts.last_message || null,
    transcript_path: null,
    effort: opts.effort || null,
    account: opts.account || null,
    purpose: null,
    attach_cmd: `tmux -L clawdling attach -t cl-${agent}-${sid.slice(0, 6)}`,
    get name() { return `${this.agent_name}: ${this.title || 'new session'}`; },
  };
}

const FIXTURES = {
  default() {
    const agents = [
      ...baseAgents(),
      mkAgent('site', 'project', 'Launch the website', 'Ship the new marketing site with a working signup form', { domain: 'work', repo: '/Users/ada/code/site' }),
      mkAgent('marathon', 'project', 'Spring half marathon', 'Finish the April half marathon under 1:50', { domain: 'health' }),
    ];
    const by = Object.fromEntries(agents.map((a) => [a.id, a]));
    const sessions = [
      sess(by, 'health', "Plan this week's training", 'working', { last: 15e3 }),
      sess(by, 'work', 'Draft the Q4 roadmap', 'needs_you', { last: 2 * MIN, notification: 'Claude needs your permission to use Bash', waiting_on: 'permission_prompt', choices: permissionChoices() }),
      sess(by, 'donna', 'Morning brief', 'ready', { last: 6 * MIN, last_message: 'Morning brief sent: three things need you today.' }),
      sess(by, 'site', 'Fix the hero layout on mobile', 'working', { last: 4e3, model: 'sonnet' }),
      sess(by, 'home', 'Compare dishwasher quotes', 'ready', { last: 40 * MIN, last_message: 'Three quotes compared. The Bosch one is cheapest to run.' }),
      sess(by, 'work', null, 'starting', { last: 50e3 }),
      sess(by, 'money', 'Reconcile September', 'ended', { ended: 2 * HOUR }),
      sess(by, 'money', 'Tax documents checklist', 'ended', { ended: 3 * DAY }),
      sess(by, 'health', 'Sleep log review', 'ended', { ended: 20 * DAY }),
    ];
    return { agents, sessions };
  },
  small() {
    const agents = baseAgents().filter((a) => a.id !== 'home');
    const by = Object.fromEntries(agents.map((a) => [a.id, a]));
    return {
      agents,
      sessions: [
        sess(by, 'health', "Plan this week's training", 'working', { last: 15e3 }),
        sess(by, 'work', 'Draft the Q4 roadmap', 'needs_you', { last: 2 * MIN, notification: 'Claude needs your permission to use Bash' }),
        sess(by, 'money', 'Reconcile September', 'ended', { ended: 2 * HOUR }),
      ],
    };
  },
  big() {
    const agents = [
      ...baseAgents(),
      mkAgent('family', 'domain', 'Family', 'School runs, birthdays and the family calendar'),
      mkAgent('learning', 'domain', 'Learning', 'Courses and languages, a little every day'),
      mkAgent('writing', 'domain', 'Writing', 'The newsletter and the long-form backlog'),
    ];
    const proj = [
      ['work', ['Q4 roadmap', 'Hiring pipeline', 'Launch the website', 'Customer interviews', 'Pricing page', 'Board deck']],
      ['health', ['Spring half marathon', 'Meal prep system', 'Sleep reset']],
      ['money', ['Tax return 2026', 'Emergency fund']],
      ['home', ['Kitchen remodel']],
      ['family', ['Summer trip to Lisbon', 'School applications', "Grandma's 80th"]],
      ['learning', ['Spanish B1', 'Statistics course']],
      ['writing', ['Newsletter', 'Book outline']],
      [null, ['Garage sale', 'Car purchase', 'Old laptop backup']],
    ];
    for (const [domain, names] of proj) {
      for (const name of names) agents.push(mkAgent(slug(name), 'project', name, `Get ${name.toLowerCase()} done`, { domain }));
    }
    const by = Object.fromEntries(agents.map((a) => [a.id, a]));
    const sessions = [
      sess(by, 'health', "Plan this week's training", 'working', { last: 15e3 }),
      sess(by, 'work', 'Draft the Q4 roadmap', 'needs_you', { last: 2 * MIN, notification: 'Claude needs your permission to use Bash' }),
      sess(by, 'donna', 'Morning brief', 'ready', { last: 6 * MIN, last_message: 'Morning brief sent.' }),
      sess(by, 'pricing-page', 'Compare three pricing layouts', 'working', { last: 8e3 }),
      sess(by, 'summer-trip-to-lisbon', 'Find flights for July', 'ready', { last: 30 * MIN, last_message: 'Two flights fit your dates.' }),
      sess(by, 'spanish-b1', 'Daily practice', 'working', { last: 3e3 }),
      sess(by, 'tax-return-2026', 'Collect the 1099s', 'needs_you', { last: 9 * MIN, notification: 'Which brokerage accounts should I include?' }),
      sess(by, 'newsletter', 'Draft issue 14', 'ready', { last: 52 * MIN, last_message: 'Draft 1 is in drafts/14.md.' }),
    ];
    return { agents, sessions };
  },
  empty() {
    return { agents: baseAgents(), sessions: [] };
  },
  // 1.5, the report card: Lou-style data for the website project (Done with commits, a week of
  // usage, NOW.md next steps), a session with a 2,000-turn Timeline, a transcript Claude Code deleted.
  report() {
    const fx = FIXTURES.default();
    const by = Object.fromEntries(fx.agents.map((a) => [a.id, a]));
    by.site.repo = '/Users/ada/code/site';
    by.site._now = ['# Launch the website: now', '_Last updated: by the agent_', '', '## State', '- Signup form live on staging; the home page loads in 1.1 s.', '',
      '## Next steps', '- Get the hero to stack properly on phones (in progress).', '- Ask Ada to approve the pricing copy before Friday.', '- Point the domain at the new site after the approval.', '',
      '## Open threads', '- Waiting on the logo files from the designer.', ''].join('\n');
    by.site._nowAge = 3 * HOUR;
    by.marathon._now = ''; // a project that has not written its next steps yet (the empty state)
    const hero = fx.sessions.find((s) => s.agent === 'site');
    rep(hero, { line: 'The hero now stacks on phones under 400 px wide; checking Safari next.', files: 3, cost: [1.84], models: { 'claude-opus-5-5': 0.8, 'claude-sonnet-5': 0.2 } });
    const extra = [
      rep(sess(by, 'site', 'Add the signup form', 'ended', { ended: 3 * HOUR, model: 'opus' }), { line: 'The signup form works: it saves to the waitlist and sends the welcome email. All 24 tests pass.', outcome: 'All 24 tests pass.', errors: 2, files: 6, commits: [['Add the signup form with email checks', 3.4 * HOUR], ['Send the welcome email from the waitlist', 3.1 * HOUR]], cost: [0.62, 2.18], models: { 'claude-opus-5-5': 0.85, 'claude-sonnet-5': 0.15 } }),
      rep(sess(by, 'site', 'Speed up the home page', 'ended', { ended: 26 * HOUR }), { line: 'The home page now loads in 1.1 s instead of 3.4 s: images are resized and load as you scroll.', files: 9, errors: 1, commits: [['Resize and lazy-load the hero images', 27 * HOUR]], cost: [0, 0.94, 0, 2.47], models: { 'claude-opus-5-5': 0.7, 'claude-sonnet-5': 0.3 }, tl: 2000 }),
      rep(sess(by, 'site', 'Write the launch checklist', 'ended', { ended: 4 * DAY }), { line: 'The launch checklist is in docs/launch.md: 14 items, 9 done.', files: 1, commits: [['Add the launch checklist', 4 * DAY + HOUR]], cost: [0, 0, 0, 0, 0.96, 0, 1.21], models: { 'claude-sonnet-5': 1 }, gone: true }),
      rep(sess(by, 'health', 'Plan the taper week', 'ended', { ended: 2 * DAY }), { line: 'Taper week planned: three short runs and one rest day.', files: 1, cost: [0, 0, 0.31], models: { 'claude-sonnet-5': 1 } }),
    ];
    for (const s of fx.sessions.filter((x) => x.agent === 'money')) rep(s, { line: s.title === 'Reconcile September' ? 'September is reconciled: two card charges were duplicates and are now flagged.' : 'The checklist lists eleven tax documents; four are still missing.', files: 1, cost: s.title === 'Reconcile September' ? [0.44] : [0, 0, 0, 0.29], models: { 'claude-sonnet-5': 1 } });
    rep(fx.sessions.find((s) => s.agent === 'home'), { line: 'Three quotes compared. The Bosch one is cheapest to run.', files: 0, cost: [0.12], models: { 'claude-haiku-4-5': 1 } });
    return { agents: fx.agents, sessions: [...fx.sessions, ...extra], otherCommits: { site: [['Fix a typo in the footer', 2 * DAY]] } };
  },
  // A brand-new install: no session yet and no folder trusted, so Claude Code asks about every
  // folder it opens in, unless a folder above it was trusted already (like the real CLI).
  fresh() {
    return { agents: baseAgents(), sessions: [], trustSim: true };
  },
};

/** Report-card data for a mock session, kept off its JSON (non-enumerable). */
function rep(s, data) {
  if (s) Object.defineProperty(s, '_rep', { value: data, enumerable: false, configurable: true });
  return s;
}

// ---------------------------------------------------------------- 1.2: discover + setup
// What GET /api/discover finds on Ada's computer: folders from Claude Code's history, git repos
// under ~/code and ~/projects, and her GitHub repos through `gh` (some not cloned). Ages are from
// "now" at request time, so "recent" (90 days) stays true whenever the suite runs.
const CODE = '/Users/ada/code';
const DISCOVER = [
  { name: 'site', path: `${CODE}/site`, nwo: 'ada/site', private: true, lang: 'TypeScript', desc: 'Marketing site for the spring launch', age: 2 * HOUR, claude: 2 * HOUR, has: { claude_md: true, dot_claude: true } },
  { name: 'recipe-box', path: `${CODE}/recipe-box`, nwo: 'ada/recipe-box', private: false, lang: 'JavaScript', desc: 'Family recipes, searchable, with a shopping list', age: 1 * DAY, claude: 1 * DAY, has: { claude_md: true } },
  { name: 'shop', path: `${CODE}/shop`, nwo: 'ada-studio/shop', private: true, lang: 'TypeScript', desc: 'Online shop: storefront, admin and the order worker', age: 6 * HOUR, claude: 8 * HOUR, monorepo: true, has: { claude_md: true, agents_md: true, dot_claude: true, mcp_json: true } },
  { name: 'garden-sensors', path: '/Users/ada/projects/garden-sensors', lang: 'Python', localDesc: 'Soil moisture sensors on a Raspberry Pi that water the tomatoes', age: 3 * DAY, claude: 3 * DAY },
  { name: 'notes', path: '/Users/ada/Documents/notes', git: false, lang: 'Markdown', localDesc: 'Meeting notes and drafts', age: 2 * DAY, claude: 2 * DAY },
  { name: 'dotfiles', path: `${CODE}/dotfiles`, nwo: 'ada/dotfiles', private: false, lang: 'Shell', desc: 'My shell, git and editor settings', age: 60 * DAY },
  { name: 'family-photos', nwo: 'ada/family-photos', private: true, lang: 'Swift', desc: 'iPhone app that sorts the family photo backups', age: 5 * DAY },
  { name: 'ada.github.io', nwo: 'ada/ada.github.io', private: false, lang: 'HTML', desc: 'My personal page', age: 20 * DAY },
  { name: 'old-blog', nwo: 'ada/old-blog', private: false, lang: 'Ruby', desc: 'The blog before the blog', age: 40 * DAY, archived: true },
  { name: 'tax-scripts', path: `${CODE}/tax-scripts`, lang: 'Python', localDesc: 'Scripts that sort the receipts for taxes', age: 200 * DAY },
  { name: 'ml-course', path: `${CODE}/ml-course`, lang: 'Jupyter Notebook', localDesc: 'Notebooks from the machine learning course', age: 150 * DAY, claude: 150 * DAY },
];
const ghKey = (nwo) => `github.com/${nwo.toLowerCase()}`;

// What GET /api/setup reads from ~/.claude: names and descriptions only, never a value.
const SETUP_USER = {
  config_dir: '~/.claude',
  claude_md: { exists: true, lines: ['# How I like to work', '- Explain the trade-off before any big change.', '- Prefer small pull requests with a clear title.', '- Use pnpm, not npm, in my JavaScript projects.', '- Ask before adding a new dependency.'] },
  skills: [
    ['deploy', 'Ship the current branch to staging, then production after a check'], ['changelog', 'Write the CHANGELOG entry for the last release'],
    ['pdf', 'Read, fill and merge PDF files'], ['spreadsheet', 'Make and edit spreadsheets with formulas'], ['frontend-design', 'Distinctive, intentional visual design for new UI'],
    ['standup', 'Summarize what changed since yesterday'], ['bug-triage', 'Sort new issues by how bad and how easy they are'], ['research', 'Look something up on the web and cite sources'],
    ['translate', 'Translate a document and keep its formatting'],
  ].map(([name, description]) => ({ name, description, source: 'user' })),
  agents: [
    ['code-reviewer', 'Reviews a diff for bugs, unclear names and missing tests before you merge'], ['test-writer', 'Writes the missing tests for a module and runs them'],
    ['release-notes', 'Turns merged pull requests into release notes people want to read'],
    ['health', 'Checks a training week against sleep and recovery before it is final'], // same id as the Health domain, made by hand
  ].map(([name, description]) => ({ name, description, file: `${name}.md`, source: 'user' })),
  commands: [['review', 'Review the staged changes'], ['ship', 'Run the tests, then open a pull request'], ['fix-issue', 'Read a GitHub issue and fix it'], ['git:sync', 'Rebase on main and push']]
    .map(([name, description]) => ({ name, description })),
  plugins: [{ name: 'superpowers', marketplace: 'obra', enabled: true }, { name: 'frontend-design', marketplace: 'claude-plugins', enabled: false }],
  hooks: [{ event: 'PreToolUse', count: 2 }, { event: 'Stop', count: 1 }, { event: 'SessionStart', count: 1 }],
  mcp: [{ name: 'github', scope: 'user' }, { name: 'linear', scope: 'user' }, { name: 'postgres', scope: 'local' }],
};
// What each repo adds on top, by path (only repos a project agent owns are reported).
const SETUP_REPOS = {
  [`${CODE}/site`]: { claude_md: true, agents_md: false, skills: [{ name: 'lighthouse', description: 'Run Lighthouse on the preview build and list what to fix', source: 'repo' }],
    agents: [{ name: 'copy-editor', description: 'Tightens marketing copy without losing the voice', file: 'copy-editor.md', source: 'repo' }],
    commands: [{ name: 'preview', description: 'Build and open a preview' }], hooks: [{ event: 'PostToolUse', count: 1 }], mcp: [{ name: 'figma', scope: 'project' }] },
  [`${CODE}/shop`]: { claude_md: true, agents_md: true, skills: [], agents: [{ name: 'db-migrator', description: 'Writes and checks database migrations', file: 'db-migrator.md', source: 'repo' }],
    commands: [{ name: 'seed', description: 'Fill the local database with test orders' }], hooks: [], mcp: [{ name: 'db', scope: 'project' }, { name: 'stripe', scope: 'project' }] },
};

const humanize = (id) => { const s = String(id).replace(/[-_]+/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1); };

function importedClaudeMd(a, c, owner) {
  return [`# ${a.name} agent`, `You are the ${a.name} project agent in ${owner}'s org. Goal: ${a.mission}.`, '## How you work',
    '- Keep your memory current: before you finish, update memory/NOW.md and append one dated line to memory/LOG.md. The /handoff skill does this.',
    '- Ask before anything irreversible or outward-facing (pushing, publishing, deleting).', '## The repo',
    `- Path: ${a.repo || '(several repos)'}`, c && c.remote ? `- Remote: ${c.remote}` : '- Remote: none', c && c.language ? `- Stack: ${c.language}` : '',
    '## How to run it', '- install: `npm install`', '- test: `npm test`', '## Context', '- (Deep onboard fills this in.)', '@memory/NOW.md', ''].filter((l) => l !== '').join('\n');
}

function importedNow(a, c) {
  const day = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
  return [`# ${a.name}: now`, '', '## State', `- Imported from ${a.repo || 'several repos'}${c && c.remote ? ` (${c.remote})` : ''}.`, '', '## Recent commits',
    `- ${day(0)} a1b2c3d Fix the signup form on small screens`, `- ${day(1)} 9f8e7d6 Add the pricing section`, `- ${day(3)} 4c5d6e7 Update dependencies`, '',
    '## Open threads', '- None yet.', '', '## Next steps', `- Ask Ada what she wants next from ${a.name}.`, ''].join('\n');
}

// ---------------------------------------------------------------- fake TUI
const WORK_SCRIPT = [
  `${CLAUDE}⏺${RESET} Reading the agent's memory to pick up where we left off.`,
  `${DIM}  ⎿  Read memory/NOW.md (18 lines)${RESET}`,
  `${CLAUDE}⏺${RESET} ${BOLD}Search${RESET}(pattern: "TODO", path: "src/")`,
  `${DIM}  ⎿  Found 4 matches${RESET}`,
  `${CLAUDE}⏺${RESET} Drafting the plan. Three options, ranked by effort:`,
  `   ${GREEN}1.${RESET} Keep the current structure, tighten the copy`,
  `   ${GREEN}2.${RESET} Split the page into two sections`,
  `   ${GREEN}3.${RESET} Rebuild the layout grid`,
  `${CLAUDE}✻${RESET} ${DIM}Thinking…${RESET}`,
  `${CLAUDE}⏺${RESET} ${BOLD}Update${RESET}(memory/NOW.md)`,
  `${DIM}  ⎿  Updated memory/NOW.md with 3 additions${RESET}`,
];

function bannerFor(s, agent) {
  const lines = [
    `${CLAUDE}✻${RESET} Welcome to ${BOLD}Claude Code${RESET} ${DIM}(mock)${RESET}`,
    `${DIM}  /help for help · cwd: ${s.cwd.replace('/Users/ada', '~')}${RESET}`,
    '',
  ];
  if (s.title) {
    lines.push(`${DIM}>${RESET} ${s.title}`, '');
    lines.push(`${CLAUDE}⏺${RESET} On it. I'll check ${agent ? `${agent.name}'s` : 'my'} NOW.md first.`);
    lines.push(`${DIM}  ⎿  Read memory/NOW.md (14 lines)${RESET}`);
  }
  if (s.status === 'needs_you') {
    lines.push('', `${BOLD}Bash command${RESET}`, `   ${CYAN}npm run build${RESET}`, '', ` Do you want to proceed?`, ...permissionChoices().map((c, i) => `${i ? '  ' : ` ${CLAUDE}❯${RESET}`} ${c.label}`), '');
  } else if (s.status === 'ready') {
    lines.push(`${CLAUDE}⏺${RESET} Done. Summary is in NOW.md; tell me what to do next.`, '');
  }
  return `${lines.join('\r\n')}\r\n${DIM}›${RESET} `;
}

// A QR-looking placeholder (not a decodable code): the real server renders the real one.
function placeholderQr(seed) {
  const n = 25;
  let h = 2166136261;
  const bits = [];
  for (let i = 0; i < n * n; i += 1) {
    h ^= seed.charCodeAt(i % seed.length) + i;
    h = Math.imul(h, 16777619) >>> 0;
    bits.push(h & 1);
  }
  const finder = (x, y) => `<path d="M${x} ${y}h7v7h-7z M${x + 1} ${y + 1}v5h5v-5z" fill-rule="evenodd"/><path d="M${x + 2} ${y + 2}h3v3h-3z"/>`;
  const inFinder = (x, y) => (x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9);
  let cells = '';
  for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) if (!inFinder(x, y) && bits[y * n + x]) cells += `M${x} ${y}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><g fill="#111">${finder(0, 0)}${finder(n - 7, 0)}${finder(0, n - 7)}<path d="${cells}"/></g></svg>`;
}

// ---------------------------------------------------------------- server
export async function startMockServer({ port = 0, host = '127.0.0.1', token = 'mock-token-0123456789abcdef', fixture = 'default', quiet = true } = {}) {
  const st = {
    org: null, agents: [], sessions: new Map(), terms: new Map(), requests: [],
    channels: { telegram: { configured: false, enabled: false, paired: false, chat_id_masked: null }, imessage: { supported: true, enabled: false, handle: null } },
    pairing: null, health: baseHealth(), trustSim: false, trusted: [], orgTrusted: true, fail: {}, transcripts: new Map(), accounts: [],
    disc: null, cloned: new Map(),
  };
  // /__mock/discover changes these until the next reset: how gh answers, how long discovery
  // takes, and an import that fails `times` times (by candidate name or group name). `quiet`:
  // imports publish no org event (this browser is not told, like a CLI import it missed).
  // `cloneTaken`: names whose <clone_root>/<name> already holds something else, so a clone lands
  // in <name>-2 like core's cloneRepo; `cloneRoot`: where clones go (discover's clone_root).
  // `legacyGroup409`: a group whose repos all have agents answers 409, like servers before 1.2.0.
  const discDefaults = () => ({ gh: 'ok', delay: 450, importDelay: 300, cloneDelay: 900, failImport: null, quiet: false, cloneTaken: [], cloneRoot: CODE, legacyGroup409: false });
  const publishImport = (id) => { if (!st.disc.quiet) publishOrg('agent_created', id); };
  const sse = new Set();
  const timers = new Set();
  const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };

  function reset(name = 'default') {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    for (const term of st.terms.values()) {
      clearInterval(term.stream);
      for (const ws of term.viewers) { try { ws.close(1000, 'reset'); } catch { /* ignore */ } }
    }
    const fx = (FIXTURES[name] || FIXTURES.default)();
    st.org = { version: 1, name: "Ada's org", owner: 'Ada', chief: 'donna', channels: { telegram: { enabled: false, chat_id: null }, imessage: { enabled: false, handle: null } } };
    st.agents = fx.agents;
    st.sessions = new Map(fx.sessions.map((s) => [s.sid, s]));
    st.terms = new Map();
    st.requests = [];
    st.pairing = null;
    st.recent = [];
    st.bind = '127.0.0.1';
    st.health = baseHealth();
    st.trustSim = !!fx.trustSim;
    st.trusted = [];
    // Like core's trust.json: a brand-new org has not trusted its folder; a used one has.
    st.orgTrusted = !(name === 'empty' || name === 'fresh');
    st.fail = {};
    st.transcripts = new Map();
    st.otherCommits = fx.otherCommits || {};
    st.digest = { enabled: false, day: 1, hour: 8, last_sent_at: null };
    st.otel = { enabled: false, blocked: false };
    st.accounts = [];
    st.disc = discDefaults();
    st.cloned = new Map();
    // Use from anywhere (1.3): off by default, like core. /__mock/remote stands in for the setup
    // agent's `clawdling remote add`; /__mock/remote-pair for a phone using its pairing link.
    st.remote = { enabled: false, hosts: [], devices: [], pairing: null };
    st.donnaSession = name === 'empty' ? null : '7f3c2a9e-1b4d-4c8e-9a51-0d6e2f8b3c17';
    st.channels = { telegram: { configured: false, enabled: false, paired: false, chat_id_masked: null }, imessage: { supported: true, enabled: false, handle: null } };
    for (const s of fx.sessions) ensureTerm(s);
    publishOrg('reset', null);
  }

  const agentById = (id) => st.agents.find((a) => a.id === id);
  const publicAgent = (a) => {
    const out = {};
    for (const [k, v] of Object.entries(a)) if (!k.startsWith('_')) out[k] = v;
    return out;
  };
  const agentWithStats = (a) => {
    let live = 0;
    let needs = 0;
    let last = null;
    for (const s of st.sessions.values()) {
      if (s.agent !== a.id) continue;
      if (s.status !== 'ended') live += 1;
      if (s.status === 'needs_you') needs += 1;
      if (!last || s.last_activity_at > last) last = s.last_activity_at;
    }
    return { ...publicAgent(a), live, needs_you: needs, last_activity_at: last };
  };
  const claudeMd = (a) => a._claude || defaultClaudeMd(a, st.org.owner);
  const nowMd = (a) => (a._now != null ? a._now : defaultNow(a));

  const orgView = () => ({ org: st.org, agents: st.agents.map(agentWithStats), channels: channelStatus(), org_trusted: st.orgTrusted });
  const publishOrg = (reason, id) => broadcast('org', { reason, id, ...orgView() });

  function broadcast(type, data) {
    const frame = `data: ${JSON.stringify({ type, data })}\n\n`;
    for (const res of sse) { try { res.write(frame); } catch { /* client gone */ } }
  }

  // ---- terminals
  function ensureTerm(s) {
    let term = st.terms.get(s.sid);
    if (term) return term;
    term = { buf: bannerFor(s, agentById(s.agent)), line: '', viewers: new Set(), stream: null, step: 0, cols: 100, rows: 30 };
    st.terms.set(s.sid, term);
    syncStream(s);
    return term;
  }

  function out(s, data) {
    const term = ensureTerm(s);
    term.buf = (term.buf + data).slice(-200000);
    s.last_activity_at = new Date().toISOString();
    const frame = JSON.stringify({ t: 'out', data });
    for (const ws of term.viewers) if (ws.readyState === 1) ws.send(frame);
  }

  function syncStream(s) {
    const term = st.terms.get(s.sid);
    if (!term) return;
    if (s.status === 'working' && !term.stream) {
      term.stream = setInterval(() => {
        const line = WORK_SCRIPT[term.step % WORK_SCRIPT.length];
        term.step += 1;
        out(s, `\r\x1b[2K${line}\r\n${DIM}›${RESET} `);
      }, 1100);
    } else if (s.status !== 'working' && term.stream) {
      clearInterval(term.stream);
      term.stream = null;
    }
  }

  function setStatus(s, status, extra = {}) {
    Object.assign(s, extra, { status });
    if (status !== 'needs_you') { s.notification = extra.notification || null; s.waiting_on = null; s.choices = null; s.asking = null; }
    if (status === 'ended') { s.ended_at = new Date().toISOString(); }
    else s.ended_at = null;
    s.last_activity_at = new Date().toISOString();
    syncStream(s);
    broadcast('session', s);
    const term = st.terms.get(s.sid);
    if (term) {
      for (const ws of term.viewers) {
        if (ws.readyState !== 1) continue;
        ws.send(JSON.stringify({ t: 'status', status }));
        if (status === 'ended') ws.send(JSON.stringify({ t: 'ended' })); // like core: the socket stays open
      }
    }
  }

  // Hook events drive status exactly like the real server's status machine.
  function applyHook(s, event, payload = {}) {
    if (typeof payload.permission_mode === 'string') s.live_mode = payload.permission_mode; // like core's hooks
    if (event === 'SessionStart') {
      // Started in the org folder itself: Claude Code trusts it now (core's markOrgTrusted).
      if (s.cwd === HOME && !s.account && !st.orgTrusted) { st.orgTrusted = true; publishOrg('org_trusted'); }
      if (payload.source === 'compact') return;
      const term = st.terms.get(s.sid);
      setStatus(s, term && term.pendingPrompt ? 'starting' : 'ready');
      return;
    }
    if (event === 'UserPromptSubmit') {
      if (!s.title && payload.prompt) s.title = deriveTitle(payload.prompt);
      setStatus(s, 'working');
      return;
    }
    if (event === 'Stop') {
      if (typeof payload.last_assistant_message === 'string' && payload.last_assistant_message.trim()) s.last_message = payload.last_assistant_message.trim().slice(0, 280);
      setStatus(s, 'ready');
      return;
    }
    if (event === 'Notification') {
      const kind = payload.notification_type || 'notification';
      // Signed in from inside a session (/login): that session goes on, and every other session of
      // the same login stuck on "not signed in" can be started again (like core's signedIn()).
      if (kind === 'auth_success') {
        if (s.status === 'needs_you' && s.waiting_on === 'login') setStatus(s, 'ready');
        for (const o of st.sessions.values()) {
          if (o === s || (o.account || null) !== (s.account || null) || o.status !== 'needs_you' || o.waiting_on !== 'login') continue;
          o.signed_in = true;
          o.notification = SIGNED_IN_NOTICE;
          broadcast('session', o);
        }
        return;
      }
      setStatus(s, 'needs_you', { notification: payload.message || 'Claude needs your attention', waiting_on: kind,
        choices: kind === 'permission_prompt' ? (payload.choices || permissionChoices()) : null });
      return;
    }
    if (event === 'SessionEnd') setStatus(s, 'ended');
  }

  function handleLine(s, line) {
    const text = line.trim();
    out(s, '\r\n');
    if (!text) { out(s, `${DIM}›${RESET} `); return; }
    if (text === '/exit') { out(s, `${DIM}Goodbye.${RESET}\r\n`); applyHook(s, 'SessionEnd'); return; }
    applyHook(s, 'UserPromptSubmit', { prompt: text });
    later(250, () => out(s, `${CLAUDE}⏺${RESET} You said: ${text}\r\n`));
    const chat = st.transcripts.get(s.sid);
    if (chat) {
      chat.push({ n: chat.length, role: 'user', text, tools: [], ts: new Date().toISOString() });
      later(300, () => chat.push({ n: chat.length, role: 'assistant', text: `You said: **${text}**`, tools: [], ts: new Date().toISOString(), model: 'claude-sonnet-5' }));
    }
    later(500, () => out(s, `${DIM}  ⎿  (mock) echoing your message back${RESET}\r\n`));
    if (/\b(un)?watch\?/i.test(text)) {
      // Like core's Watching: background work the turn started, read from the transcript.
      s.background = /unwatch\?/i.test(text) ? { count: 0, tasks: [] } : { count: 2, tasks: [
        { id: 'bmock01', kind: 'shell', description: 'Wait for the build', started_at: new Date().toISOString(), expires_at: null },
        { id: 'bmock02', kind: 'watcher', description: 'Watch the deploy log', started_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600000).toISOString() },
      ] };
    }
    const ask = /plan\?/i.test(text) ? 'plan' : /ask2\?/i.test(text) ? 'question2' : /ask\?/i.test(text) ? 'question' : null;
    if (ask) {
      later(800, () => askQuestion(s, ask));
      return;
    }
    later(800, () => {
      if (/permission\?/i.test(text)) {
        out(s, `\r\n${BOLD}Bash command${RESET}\r\n   ${CYAN}rm -rf build/${RESET}\r\n\r\n Do you want to proceed?\r\n ${CLAUDE}❯${RESET} 1. Yes\r\n   2. Yes, and don't ask again for rm commands in this project\r\n   3. No, and tell Claude what to do differently (esc)\r\n`);
        applyHook(s, 'Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt', choices: permissionChoices('rm') });
      } else {
        applyHook(s, 'Stop', { last_assistant_message: `You said: ${text}` });
        out(s, `${DIM}›${RESET} `);
      }
    });
  }

  // Claude asks (AskUserQuestion) or wants a plan approved (ExitPlanMode), the way core reports it:
  // a transcript entry with the tool's input, then needs_you / permission_prompt with `asking`.
  const MOCK_QUESTIONS = {
    question: [{ question: 'Which color do you like best?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'A warm, bold color.' }, { label: 'Green', description: 'A calm, natural color.' }, { label: 'Blue', description: 'A cool, steady color.' }] }],
  };
  MOCK_QUESTIONS.question2 = [...MOCK_QUESTIONS.question, { question: 'Which pets do you like?', header: 'Pets', multiSelect: true, options: [{ label: 'Cat', description: 'Independent.' }, { label: 'Dog', description: 'Loyal.' }, { label: 'Fish', description: 'Quiet.' }] }];
  const MOCK_PLAN = '# Make hello.txt\n\n## Plan\n1. Create `hello.txt`.\n2. Write **hi** into it.';
  function askQuestion(s, kind) {
    const id = `toolu_mock${Math.random().toString(36).slice(2, 10)}`;
    const chat = st.transcripts.get(s.sid) || [];
    st.transcripts.set(s.sid, chat);
    const plan = kind === 'plan';
    const tool = plan
      ? { name: 'ExitPlanMode', summary: '', detail: MOCK_PLAN, id, ask: { kind: 'plan', plan: MOCK_PLAN } }
      : { name: 'AskUserQuestion', summary: MOCK_QUESTIONS[kind][0].question, detail: '', id, ask: { kind: 'question', questions: MOCK_QUESTIONS[kind] } };
    // Like Claude Code 2.1.283, the tool's transcript line comes only with its answer (answerAsk);
    // until then the card comes from `asking.card` (core: the PreToolUse hook).
    s.pendingTool = tool;
    out(s, `\r\n${BOLD}${plan ? 'Ready to code?' : MOCK_QUESTIONS[kind][0].question}${RESET}\r\n`);
    const choices = plan ? ['1. Yes, auto-accept edits', '2. Yes, manually approve edits', '3. Tell Claude what to change shift+tab to approve with this feedback'].map((label, i) => ({ option: i + 1, label })) : null;
    setStatus(s, 'needs_you', {
      waiting_on: 'permission_prompt', choices,
      notification: plan ? 'Claude has a plan ready and asks you to approve it.' : `Claude asks: ${MOCK_QUESTIONS[kind][0].question}`,
      asking: { kind: plan ? 'plan' : 'question', tool_id: id, questions: plan ? 0 : MOCK_QUESTIONS[kind].length, card: tool.ask },
    });
  }
  function answerAsk(s, entry, said) {
    const chat = st.transcripts.get(s.sid) || [];
    if (s.pendingTool) chat.push({ n: chat.length, role: 'assistant', text: '', tools: [s.pendingTool], ts: new Date().toISOString(), model: 'claude-sonnet-5' });
    s.pendingTool = null;
    chat.push({ n: chat.length, role: 'answer', text: '', tools: [], ts: new Date().toISOString(), ...entry });
    s.asking = null;
    setStatus(s, 'working');
    later(400, () => {
      chat.push({ n: chat.length, role: 'assistant', text: said, tools: [], ts: new Date().toISOString(), model: 'claude-sonnet-5' });
      if (s.status === 'working') applyHook(s, 'Stop', { last_assistant_message: said });
    });
  }

  function feedInput(s, data) {
    if (s.status === 'ended') return;
    const term = ensureTerm(s);
    if (s.status === 'needs_you' && STARTUP_DIALOG_KINDS.has(s.waiting_on)) {
      term.dialogKeys = (term.dialogKeys || '') + data; // like the real dialog: keys go to it
      for (const ch of data) if (ch >= ' ') out(s, ch);
      return;
    }
    if (data.startsWith('\x1b')) {
      if (data === '\x1b\r') { term.line += '\n'; out(s, '\r\n  '); }
      return; // arrows and other escape sequences: ignored by the mock
    }
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') { const line = term.line; term.line = ''; handleLine(s, line); }
      else if (ch === '\x7f' || ch === '\b') { if (term.line) { term.line = term.line.slice(0, -1); out(s, '\b \b'); } }
      else if (ch === '\x03') { term.line = ''; out(s, `^C\r\n${DIM}›${RESET} `); }
      else if (ch >= ' ') { term.line += ch; out(s, ch); }
    }
  }

  function createSession(body) {
    const scratch = body.agent === 'scratch';
    const a = scratch ? { id: 'scratch', kind: 'scratch', name: 'Scratch', model: null, repo: '/Users/ada/clawdling' } : agentById(body.agent);
    if (!a) return null;
    const s = sess({ [a.id]: a }, a.id, body.title || (body.prompt ? deriveTitle(body.prompt) : null), 'starting', { last: 0, age: 0, model: body.model });
    s.effort = body.effort || null;
    s.account = body.account || null;
    s.purpose = body.purpose || null;
    s.created_at = new Date().toISOString();
    s.last_activity_at = s.created_at;
    st.sessions.set(s.sid, s);
    const term = ensureTerm(s);
    if (Number.isInteger(body.cols) && Number.isInteger(body.rows)) { term.cols = body.cols; term.rows = body.rows; }
    term.buf = `${CLAUDE}✻${RESET} Welcome to ${BOLD}Claude Code${RESET} ${DIM}(mock)${RESET}\r\n${DIM}  /help for help · cwd: ${s.cwd.replace('/Users/ada', '~')}${RESET}\r\n\r\n${DIM}›${RESET} `;
    broadcast('session', s);
    term.pendingPrompt = !!body.prompt;
    // Like the real claude: SessionStart fires once it is up, then the first prompt (if any) runs.
    // On a fresh install it first asks whether to trust the folder.
    later(180, () => {
      if (s.status === 'ended') return;
      if (st.trustSim && !trustedFor(s.cwd)) {
        term.afterTrust = body.prompt || null;
        raiseDialog(s, 'trust');
        return;
      }
      applyHook(s, 'SessionStart', { source: 'startup' });
      if (body.prompt) { term.pendingPrompt = false; out(s, body.prompt); handleLine(s, body.prompt); }
    });
    return s;
  }

  function trustedFor(cwd) {
    return st.trusted.some((t) => cwd === t || cwd.startsWith(`${t}/`));
  }

  // Claude Code's own startup screens, shaped like 2.1.283: the trust dialog hides its numbers and
  // lists "No, exit" first with the pointer on it. `choices` is what core reads off that screen.
  function raiseDialog(s, kind) {
    const labels = kind === 'trust' ? ['No, exit', 'Yes, I trust this folder']
      : kind === 'imports' ? ['Yes, allow external imports', 'No, disable external imports'] : null;
    const screen = kind === 'trust'
      ? `\x1b[2J\x1b[HAccessing workspace:\r\n${s.cwd}\r\n\r\nQuick safety check: Is this a project you created or one you trust?\r\n\r\n ${CLAUDE}❯${RESET} ${labels[0]}\r\n   ${labels[1]}\r\n`
      : kind === 'imports'
        ? `\x1b[2J\x1b[HAllow external CLAUDE.md file imports?\r\n\r\n ${CLAUDE}❯${RESET} 1. ${labels[0]}\r\n   2. ${labels[1]}\r\n`
        : `\x1b[2J\x1b[H Select login method:\r\n\r\n ${CLAUDE}❯${RESET} 1. Claude account with subscription\r\n   2. Anthropic Console account\r\n`;
    out(s, screen);
    const notice = kind === 'trust' ? trustNotice(s.cwd) : kind === 'imports' ? IMPORTS_NOTICE : LOGIN_NOTICE;
    setStatus(s, 'needs_you', { waiting_on: kind, notification: notice, choices: labels ? labels.map((label, i) => ({ option: i + 1, label })) : null });
  }

  function sessionList() {
    const cutoff = Date.now() - 14 * DAY;
    return [...st.sessions.values()]
      .filter((s) => s.status !== 'ended' || Date.parse(s.ended_at || s.last_activity_at) >= cutoff)
      .sort((a, b) => (b.last_activity_at || '').localeCompare(a.last_activity_at || ''));
  }

  // ---- 1.5 report card (mock data from the fixture's _rep, ages relative to now)
  const sessionCost = (s, w) => {
    const r = s._rep;
    let total = 0;
    const days = {};
    (r.cost || []).forEach((usd, ago) => {
      const d = localDay(Date.now() - ago * DAY);
      days[d] = (days[d] || 0) + usd;
    });
    for (const d of w.list) total += days[d] || 0;
    return { total, days };
  };
  const whenOf = (s) => (s.status === 'ended' ? s.ended_at : s.last_activity_at);
  function agentReport(a, win) {
    const now = Date.now();
    const w = windowRange(win, now);
    const mine = [...st.sessions.values()].filter((s) => s.agent === a.id && s._rep);
    const done = mine.filter((s) => Date.parse(whenOf(s)) >= w.start).sort((x, y) => whenOf(y).localeCompare(whenOf(x))).map((s) => ({
      sid: s.sid, title: s.title, line: s._rep.line, outcome: s._rep.outcome || null, files_changed: s._rep.files || 0, tool_errors: s._rep.errors || 0, turns: 3, when: whenOf(s),
      live: s.status !== 'ended', status: s.status, transcript: s._rep.gone ? 'gone' : 'ok',
      commits: a.repo ? (s._rep.commits || []).map(([subject, ago], i) => ({ hash: `${s.sid.slice(0, 6)}${i}a1b2c`, subject, at: iso(ago) })) : null,
    }));
    const byDay = Object.fromEntries(w.list.map((d) => [d, 0]));
    const byModel = {};
    const tops = [];
    let total = 0;
    for (const s of mine) {
      const c = sessionCost(s, w);
      if (!c.total) continue;
      total += c.total;
      for (const d of w.list) byDay[d] += c.days[d] || 0;
      for (const [model, share] of Object.entries(s._rep.models || {})) byModel[model] = (byModel[model] || 0) + c.total * share;
      tops.push({ sid: s.sid, title: s.title, usd: c.total, account: null });
    }
    tops.sort((x, y) => y.usd - x.usd);
    const other = a.repo ? (st.otherCommits[a.id] || []).filter(([, ago]) => now - ago >= w.start).map(([subject, ago], i) => ({ hash: `0ther${i}9f8e7`, subject, at: iso(ago) })) : [];
    return {
      schema: 1, generated_at: new Date(now).toISOString(), window: { key: win, from: new Date(w.start).toISOString(), to: new Date(now).toISOString(), days: w.list },
      agent: { id: a.id, name: a.name, kind: a.kind, has_repo: !!a.repo }, done,
      repo_commits: a.repo ? { other, errors: [] } : null,
      needs: [],
      cost: {
        total_usd: total, label: COST_LABEL, complete: true, unknown_models: [], sessions_without_cost: 0,
        by_day: w.list.map((d) => ({ day: d, usd: byDay[d] })),
        by_model: Object.entries(byModel).map(([model, usd]) => ({ model, usd })).sort((x, y) => y.usd - x.usd),
        by_account: [], top_sessions: tops.slice(0, 3),
      },
      next: nextOf(nowMd(a), now - (a._nowAge ?? (a._now ? 2 * DAY : 9 * DAY)), now),
    };
  }
  function orgReport() {
    const now = Date.now();
    const week = windowRange('7d', now);
    const today = windowRange('today', now);
    const all = [...st.sessions.values()].filter((s) => s._rep);
    const sum = (list, w) => list.reduce((n, s) => n + sessionCost(s, w).total, 0);
    const agents = st.agents.map((a) => {
      const mine = all.filter((s) => s.agent === a.id);
      // Like core: an ended session by its end, a running one by its last finished turn.
      const ended = mine.map((s) => (s.status === 'ended' ? s.ended_at : s.last_message ? s.last_activity_at : null)).filter(Boolean).sort().reverse();
      const needs = [...st.sessions.values()].filter((s) => s.agent === a.id && (s.status === 'needs_you' || (s.status === 'ready' && s.last_message))).length;
      return { id: a.id, name: a.name, kind: a.kind, cost_usd: sum(mine, week), cost_complete: true, done: mine.filter((s) => Date.parse(whenOf(s)) >= week.start).length, needs, last_done_at: ended[0] || null };
    });
    return { schema: 1, generated_at: new Date(now).toISOString(), window: { key: '7d' }, label: COST_LABEL, totals: { today_usd: sum(all, today), week_usd: sum(all, week), complete: true }, agents };
  }
  function timelineOf(s, after) {
    const r = s._rep;
    const t0 = Date.parse(s.created_at);
    const all = [];
    const turns = r && r.tl ? r.tl : 3;
    const push = (e) => all.push({ ...e, n: all.length });
    for (let i = 0; i < turns; i++) {
      const at = (k) => new Date(t0 + i * 60000 + k * 1000).toISOString();
      push({ kind: 'prompt', ts: at(0), text: i === 0 ? (s.title || 'Get started') : `Keep going: step ${i + 1}`, turn: i + 1, depth: 0, cost: 0.0123 + (i % 7) * 0.002, cost_complete: true, ...(st.otel.enabled ? { api: { requests: 2, ms: 3400 } } : {}) });
      push({ kind: 'say', ts: at(1), text: i === 0 ? 'Let me look at how the page is built first.' : 'Running the next check.', depth: 0 });
      push({ kind: 'tool', id: `toolu_${i}a`, name: 'Bash', summary: i % 5 === 1 ? 'npm test' : 'git status', ts: at(2), depth: 0, ms: 1400 + (i % 3) * 600, ok: i % 5 !== 1, ...(st.otel.enabled ? { approval: { decision: 'accept', source: 'user_temporary', text: 'you allowed it once' } } : {}) });
      if (i === 0) {
        push({ kind: 'tool', id: 'toolu_agent', name: 'Agent', summary: 'Check the page on small phones', ts: at(3), depth: 0, ms: 41000, ok: true });
        push({ kind: 'subagent', ts: at(4), description: 'Check the page on small phones', agent_type: 'general-purpose', depth: 1, parent: 'toolu_agent' });
        push({ kind: 'tool', id: 'toolu_sub1', name: 'Read', summary: 'src/components/Hero.tsx', ts: at(5), depth: 1, ms: 120, ok: true });
        push({ kind: 'say', ts: at(6), text: 'The hero uses a fixed 1200 px width, so it overflows on phones.', depth: 1 });
      }
      push({ kind: 'tool', id: `toolu_${i}b`, name: 'Edit', summary: 'src/components/Hero.tsx', ts: at(8), depth: 0, ms: 300, ok: true });
    }
    if (r && r.gone) return { entries: [], next: after, more: false, total: 0, transcript: 'gone', summary: { turns: 6, tools: 21, last_line: r.line, cost: { usd: 2.17, complete: true } }, status: s.status, detailed: st.otel.enabled };
    const page = all.filter((e) => e.n > after).slice(0, 500);
    const next = page.length ? page[page.length - 1].n : after;
    return { entries: page, next, more: all.length > 0 && all[all.length - 1].n > next, total: all.length, transcript: 'ok', status: s.status, cost: { usd: all.filter((e) => e.kind === 'prompt').reduce((n, e) => n + e.cost, 0), source: 'repriced', complete: true }, label: COST_LABEL, detailed: st.otel.enabled };
  }
  function digestStatus() {
    const ch = channelStatus();
    const channel = ch.telegram.paired ? 'telegram' : ch.imessage.enabled ? 'imessage' : null;
    const labels = Object.fromEntries(st.agents.map((a) => [a.id, a.name]));
    return { enabled: st.digest.enabled, day: st.digest.day, day_name: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][st.digest.day], hour: st.digest.hour, channel,
      preview: digestText(orgReport(), { labels }), labels: st.digest.enabled ? labels : {}, ...(st.digest.enabled ? {} : { preview_labels: labels }), last_sent_at: null, last_error: null,
      next_at: st.digest.enabled ? new Date(Date.now() + 3 * DAY).toISOString() : null };
  }
  function otelStatus() {
    return { enabled: st.otel.enabled, active: st.otel.enabled && !st.otel.blocked, blocked: st.otel.blocked,
      ...(st.otel.blocked ? { reason: 'Your Claude Code already has telemetry settings, so the detailed timeline stays off and Clawdling uses transcripts.', found: [{ where: 'your Claude Code settings', key: 'OTEL_EXPORTER_OTLP_ENDPOINT' }] } : {}),
      note: "It takes effect at each session's next start: sessions started earlier keep their setting until they restart." };
  }

  function channelStatus() {
    const c = JSON.parse(JSON.stringify(st.channels));
    const t = c.telegram;
    const p = st.pairing && Date.now() < st.pairing.expires ? st.pairing : null;
    Object.assign(t, { bot_username: t.configured ? 'ada_donna_bot' : null, pairing_code: !t.paired && p ? p.code : null,
      pairing_expires_at: !t.paired && p ? new Date(p.expires).toISOString() : null, polling: t.configured && t.enabled, error: null });
    return { ...c, donna: { session: st.donnaSession, busy: false }, recent: st.recent.slice(-30) };
  }
  const publishChannels = (channel) => broadcast('channel', { channel, ...channelStatus() });

  // ---- 1.2: discover, import, setup
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const uniqueId = (base) => {
    const b = slug(base);
    if (!agentById(b)) return b;
    for (let i = 2; ; i += 1) if (!agentById(`${b}-${i}`)) return `${b}-${i}`;
  };
  // The project agent that already owns a folder or a remote, like core's importer checks.
  const agentFor = (c) => st.agents.find((a) => a.kind === 'project' && ((c.path && (a.repo === c.path || (a.repos || []).includes(c.path)))
    || (a.source && a.source.remote_key && a.source.remote_key === c.key)));

  function candidates(withGh) {
    const now = Date.now();
    const out = [];
    for (const d of DISCOVER) {
      const key = d.nwo ? ghKey(d.nwo) : `path:${d.path}`;
      const path0 = d.path || st.cloned.get(key) || null;
      if (!path0 && !withGh) continue; // GitHub-only: invisible without gh
      const gh = d.nwo && withGh ? { nameWithOwner: d.nwo, url: `https://github.com/${d.nwo}`, private: !!d.private, description: d.desc || '',
        pushed_at: iso(d.age), archived: !!d.archived, fork: false } : null;
      const sources = [...(d.claude ? ['claude'] : []), ...(path0 ? ['local'] : []), ...(gh ? ['github'] : [])];
      const c = {
        key, name: d.name, path: path0, cloned: !!path0, remote: d.nwo ? `https://github.com/${d.nwo}.git` : null, github: gh,
        language: d.lang || null, description: (gh && gh.description) || d.localDesc || d.desc || null, git: d.git !== false,
        last_activity_at: iso(d.age), last_claude_session_at: d.claude ? iso(d.claude) : null, sources,
        recent: d.age <= 90 * DAY, agent: null,
        has: { claude_md: false, agents_md: false, dot_claude: false, mcp_json: false, ...(d.has || {}) }, monorepo: !!d.monorepo,
      };
      const a = agentFor(c);
      c.agent = a ? { id: a.id, name: a.name } : null;
      out.push(c);
    }
    return out;
  }

  function discoverBody(askGh) {
    const mode = askGh ? st.disc.gh : 'skipped';
    const list = candidates(mode === 'ok');
    const github = mode === 'ok' ? { installed: true, authed: true, user: 'ada', found: list.filter((c) => c.github).length, error: null }
      : mode === 'missing' ? { installed: false, authed: false, user: null, found: 0, error: null }
      : mode === 'unauthed' ? { installed: true, authed: false, user: null, found: 0, error: null }
      : mode === 'error' ? { installed: true, authed: true, user: 'ada', found: 0, error: 'gh repo list timed out after 15 s' }
      : { installed: null, authed: null, user: null, found: 0, error: null, skipped: true };
    return {
      candidates: list,
      sources: {
        claude: { dir: '~/.claude/projects', found: list.filter((c) => c.sources.includes('claude')).length },
        local: { roots: ['~/code', '~/projects'], found: list.filter((c) => c.cloned && c.git && c.sources.includes('local')).length },
        github,
      },
      clone_root: st.disc.cloneRoot,
      took_ms: askGh ? st.disc.delay : 120,
    };
  }

  function resolveDomain(body) {
    if (body.domain) {
      const d = agentById(String(body.domain));
      if (!d || d.kind !== 'domain') throw Object.assign(new Error(`no domain called "${body.domain}"`), { status: 400 });
      return d.id;
    }
    const name = typeof body.new_domain === 'string' ? body.new_domain.trim() : '';
    if (!name) return null;
    const same = st.agents.find((a) => a.kind === 'domain' && a.name.toLowerCase() === name.toLowerCase());
    if (same) return same.id;
    const d = mkAgent(uniqueId(name), 'domain', name, `Own everything about ${name} and keep its projects moving`, { age: 0, icon: null, color: null });
    st.agents.push(d);
    return d.id;
  }

  function failing(name) {
    const f = st.disc.failImport;
    if (!f || f.times <= 0 || String(f.name).toLowerCase() !== String(name).toLowerCase()) return null;
    f.times -= 1;
    return f.error || `Couldn't reach GitHub for ${name}: the connection timed out. Check your internet connection and try again.`;
  }

  async function importOne(body) {
    const all = candidates(true);
    const c = (body.path && all.find((x) => x.path === body.path))
      || (body.github && all.find((x) => x.github && x.github.nameWithOwner.toLowerCase() === String(body.github).toLowerCase()))
      || (body.url && all.find((x) => x.remote === body.url || (x.github && x.github.url === body.url)));
    if (!c && !body.path) return [400, { error: 'send the path of a folder, or a GitHub repo to clone' }];
    if (c && !c.cloned && body.clone !== true) return [400, { error: `${c.name} is not on this computer yet: tick it to clone it first` }];
    const existing = c ? agentFor(c) : st.agents.find((a) => a.kind === 'project' && a.repo === body.path);
    if (existing) return [200, { agent: publicAgent(existing), skipped: true, reason: `already an agent: ${existing.name}` }];
    const cloning = !!(c && !c.cloned);
    await pause(cloning ? st.disc.cloneDelay : st.disc.importDelay);
    const err = failing((c && c.name) || path.basename(body.path));
    if (err) return [500, { error: err }];
    let domain;
    try { domain = resolveDomain(body); } catch (e) { return [e.status || 400, { error: e.message }]; }
    const name = String(body.name || (c && c.name) || path.basename(body.path)).trim();
    const taken = (st.disc.cloneTaken || []).map((x) => String(x).toLowerCase());
    const repo = cloning ? `${st.disc.cloneRoot}/${c.name}${taken.includes(c.name.toLowerCase()) ? '-2' : ''}` : (c ? c.path : body.path);
    if (cloning) st.cloned.set(c.key, repo);
    // Generic unless the person gave one: a repo's description is data, not the agent's goal.
    const mission = String(body.mission || `Own the ${name} codebase: know how it works, keep it healthy and move the next change forward`).trim();
    const a = mkAgent(uniqueId(name), 'project', name, mission, { age: 0, repo, domain, icon: 'folder', color: null });
    a.source = { remote: c ? c.remote : null, remote_key: c && c.github ? c.key : null, github: c && c.github ? c.github.nameWithOwner : null, imported_at: new Date().toISOString() };
    a._claude = importedClaudeMd(a, c, st.org.owner);
    a._now = importedNow(a, c);
    a._log = [`${new Date().toISOString().slice(0, 10)} Imported from ${repo}.`];
    st.agents.push(a);
    publishImport(a.id);
    return [201, { agent: publicAgent(a), created: true, cloned: cloning }];
  }

  async function importGroup(body) {
    const g = body.group || {};
    const name = String(g.name || '').trim();
    const items = Array.isArray(body.items) ? body.items : [];
    if (!name) return [400, { error: 'give the agent a name' }];
    if (items.length < 2 || items.length > 12) return [400, { error: 'one agent can hold 2 to 12 repos' }];
    const all = candidates(true);
    const picked = items.map((it) => all.find((x) => x.path && x.path === it.path) || { name: path.basename(String(it.path || '')), path: it.path, key: `path:${it.path}` });
    if (picked.some((x) => !x.path)) return [400, { error: 'every repo in a group must already be on this computer' }];
    const covered = picked.map((x) => agentFor(x));
    if (covered.every(Boolean)) {
      const owners = [...new Map(covered.map((a) => [a.id, a])).values()];
      const reason = `every one of these repos already has an agent (${owners.map((a) => a.name).join(', ')})`;
      if (st.disc.legacyGroup409) return [409, { error: reason }];
      return [200, { agent: publicAgent(owners[0]), agents: owners.map(publicAgent), skipped: true, reason }];
    }
    await pause(st.disc.importDelay);
    const err = failing(name);
    if (err) return [500, { error: err }];
    let domain;
    try { domain = resolveDomain(g); } catch (e) { return [e.status || 400, { error: e.message }]; }
    const mission = String(g.mission || `Own the ${name} codebases (${picked.map((x) => x.name).join(', ')}): know how they fit together, keep them healthy and move the next change forward`).trim();
    const a = mkAgent(uniqueId(name), 'project', name, mission, { age: 0, domain, icon: 'folder', color: null });
    a.repos = picked.map((x) => x.path);
    a.source = { remote: null, remote_key: null, github: null, imported_at: new Date().toISOString() };
    a._claude = importedClaudeMd(a, null, st.org.owner);
    a._now = importedNow(a, null);
    st.agents.push(a);
    publishImport(a.id);
    return [201, { agent: publicAgent(a), created: true, cloned: false }];
  }

  function setupBody() {
    const projects = [];
    for (const a of st.agents) {
      if (a.kind !== 'project') continue;
      for (const repo of a.repo ? [a.repo] : (a.repos || [])) {
        const r = SETUP_REPOS[repo] || { claude_md: false, agents_md: false, skills: [], agents: [], commands: [], hooks: [], mcp: [] };
        projects.push({ path: repo, agent: a.id, ...JSON.parse(JSON.stringify(r)) });
      }
    }
    return { ...JSON.parse(JSON.stringify(SETUP_USER)), projects };
  }

  // ---- http helpers
  const send = (res, code, body, headers = {}) => {
    if (body === undefined || code === 204) { res.writeHead(code, headers); res.end(); return; }
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(code, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(data);
  };
  const readBody = (req) => new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({ __invalid: true }); } });
  });
  const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  const safeEq = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  const authed = (req, url) => {
    const h = req.headers['x-clawdling-token'];
    if (h && safeEq(h, token)) return true;
    const c = cookies(req).cl_token;
    if (c && safeEq(c, token)) return true;
    const q = url && url.searchParams.get('t');
    return !!(q && url.pathname.startsWith('/ws/') && safeEq(q, token));
  };
  const originOk = (req) => {
    const o = req.headers.origin;
    if (!o) return true;
    return o === `http://${req.headers.host}`;
  };

  function serveFile(res, file, method) {
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) { send(res, 404, 'Not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': stat.size, 'cache-control': 'no-cache' });
      if (method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).pipe(res);
    });
  }

  function serveStatic(req, res, p) {
    if (VENDOR[p]) { serveFile(res, path.join(NM, VENDOR[p]), req.method); return; }
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
    const file = path.resolve(WEB, rel);
    if (!file.startsWith(WEB + path.sep)) { send(res, 403, 'Forbidden'); return; }
    serveFile(res, file, req.method);
  }

  async function onApi(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    if (p === '/api/health' && m === 'GET') {
      send(res, 200, st.health);
      return;
    }
    if (!authed(req, null)) { send(res, 401, { error: 'unauthorized' }); return; }
    if (m !== 'GET' && m !== 'HEAD' && !originOk(req)) { send(res, 403, { error: 'cross-origin request refused' }); return; }
    const body = m === 'GET' || m === 'HEAD' ? null : await readBody(req);
    if (body && body.__invalid) { send(res, 400, { error: 'invalid JSON' }); return; }
    if (m !== 'GET') st.requests.push({ method: m, path: p, body, at: Date.now() });

    if (p === '/api/me' && m === 'GET') { send(res, 200, { ok: true, owner: st.org.owner, org: st.org.name, version: '1.0.0-mock' }); return; }
    if (st.fail[p]) { send(res, st.fail[p].status || 500, { error: st.fail[p].error || 'internal error' }); return; }
    if (p === '/api/org' && m === 'GET') { send(res, 200, orgView()); return; }
    if (p === '/api/events' && m === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 1500\n\n');
      sse.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15000);
      req.on('close', () => { clearInterval(ping); sse.delete(res); });
      return;
    }
    if (p === '/api/agents' && m === 'POST') {
      const kind = body.kind;
      const name = String(body.name || '').trim();
      if (kind !== 'domain' && kind !== 'project') { send(res, 400, { error: 'kind must be "domain" or "project"' }); return; }
      if (!name) { send(res, 400, { error: 'name is required' }); return; }
      const id = body.id || slug(name);
      if (!ID_RE.test(id)) { send(res, 400, { error: 'invalid agent id' }); return; }
      if (agentById(id)) { send(res, 409, { error: `an agent called "${id}" already exists` }); return; }
      const a = mkAgent(id, kind, name, String(body.mission || '').trim(), { age: 0, repo: body.repo || null, domain: body.domain || null, model: body.model || null, icon: kind === 'project' ? 'folder' : null, color: null });
      a._log = [`${new Date().toISOString().slice(0, 10)} Created ${name}.`];
      a._nowAge = 0; // like core: its NOW.md is written when it is created
      st.agents.push(a);
      publishOrg('agent_created', id);
      send(res, 201, publicAgent(a));
      return;
    }
    let mm = p.match(/^\/api\/agents\/([^/]+)(\/context)?$/);
    if (mm) {
      const id = decodeURIComponent(mm[1]);
      if (!ID_RE.test(id)) { send(res, 400, { error: 'invalid agent id' }); return; }
      const a = agentById(id);
      if (!a) { send(res, 404, { error: 'no such agent' }); return; }
      if (mm[2] && m === 'PUT') {
        for (const k of ['claude_md', 'now_md']) {
          if (body[k] != null && Buffer.byteLength(String(body[k])) > 200 * 1024) { send(res, 413, { error: `${k} is over 200 KB` }); return; }
        }
        if (typeof body.claude_md === 'string') a._claude = body.claude_md;
        if (typeof body.now_md === 'string') a._now = body.now_md;
        publishOrg('context_updated', id);
        send(res, 204);
        return;
      }
      if (!mm[2] && m === 'GET') {
        const sessions = sessionList().filter((s) => s.agent === id);
        send(res, 200, { ...agentWithStats(a), claude_md: claudeMd(a), now_md: nowMd(a), log_tail: a._log.slice(-20), sessions });
        return;
      }
      if (!mm[2] && m === 'DELETE') {
        if (id === 'donna' || a.kind === 'chief') { send(res, 400, { error: "Donna is the chief of staff and can't be archived" }); return; }
        if ([...st.sessions.values()].some((x) => x.agent === id && x.status !== 'ended')) { send(res, 409, { error: `end ${id}'s live sessions before archiving it` }); return; }
        st.agents = st.agents.filter((x) => x.id !== id);
        publishOrg('agent_archived', id);
        send(res, 200, { ok: true, archived: `.archive/${id}-${Date.now()}` });
        return;
      }
    }
    if (p === '/api/sessions' && m === 'GET') { send(res, 200, sessionList()); return; }
    if (p === '/api/sessions' && m === 'POST') {
      if (!body.agent) { send(res, 400, { error: 'agent is required' }); return; }
      const s = createSession(body);
      if (!s) { send(res, 404, { error: `no agent called "${body.agent}"` }); return; }
      send(res, 201, s);
      return;
    }
    mm = p.match(/^\/api\/sessions\/([^/]+)\/(messages|settings)$/);
    if (mm) {
      const s = st.sessions.get(decodeURIComponent(mm[1]));
      if (!s) { send(res, 404, { error: 'no such session' }); return; }
      if (mm[2] === 'messages' && m === 'GET') {
        const raw = url.searchParams.get('after');
        const after = raw === null || raw === '' ? -1 : Number(raw);
        if (!Number.isInteger(after) || after < -1) { send(res, 400, { error: 'after must be an integer >= -1' }); return; }
        const all = st.transcripts.get(s.sid) || [];
        const page = all.filter((e) => e.n > after).slice(0, 200);
        const next = page.length ? page[page.length - 1].n : after;
        send(res, 200, { messages: page, next, more: all.length > 0 && all[all.length - 1].n > next, status: s.status });
        return;
      }
      if (mm[2] === 'settings' && m === 'POST') {
        const model = body.model ? String(body.model) : null;
        const effort = body.effort ? String(body.effort) : null;
        if (!model && !effort) { send(res, 400, { error: 'send {model} or {effort}' }); return; }
        if (model && !/^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,79}$/.test(model)) { send(res, 400, { error: 'invalid model' }); return; }
        if (effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) { send(res, 400, { error: 'effort must be low, medium, high, xhigh or max' }); return; }
        if (s.status !== 'ready') { send(res, 409, { error: 'wait for your turn: model and effort change between turns' }); return; }
        // Like core: the session's claude is resumed with the new session-only flags.
        if (model) s.model = model;
        if (effort) s.effort = effort;
        out(s, `\r\n${DIM}── resumed with claude --resume ${s.sid.slice(0, 8)}${s.model ? ` --model=${s.model}` : ''}${s.effort ? ` --effort=${s.effort}` : ''} ──${RESET}\r\n${DIM}›${RESET} `);
        broadcast('session', s);
        send(res, 200, s);
        return;
      }
    }
    if (p === '/api/accounts' && m === 'GET') {
      send(res, 200, { accounts: [{ id: 'default', name: 'Your Claude login', default: true, dir: null },
        ...st.accounts.map((id) => ({ id, name: id, default: false, dir: `~/.clawdling-accounts/${id}` }))] });
      return;
    }
    if (p === '/api/accounts' && m === 'POST') {
      const id = String(body.name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
      if (!id || id === 'default') { send(res, 400, { error: 'give the account a name, like "work"' }); return; }
      if (st.accounts.includes(id)) { send(res, 409, { error: `there is already an account called "${id}"` }); return; }
      st.accounts.push(id);
      send(res, 201, { id, name: id, default: false, dir: `~/.clawdling-accounts/${id}` });
      return;
    }
    mm = p.match(/^\/api\/accounts\/([^/]+)\/signin$/);
    if (mm && m === 'POST') {
      const id = decodeURIComponent(mm[1]);
      if (id !== 'default' && !st.accounts.includes(id)) { send(res, 404, { error: `no account called "${id}"` }); return; }
      send(res, 201, createSession({ agent: 'scratch', title: id === 'default' ? 'Sign in' : `Sign in: ${id}`, account: id === 'default' ? null : id, purpose: 'signin' }));
      return;
    }
    mm = p.match(/^\/api\/sessions\/([^/]+)(\/resume|\/send|\/answer|\/restart)?$/);
    if (mm) {
      const s = st.sessions.get(decodeURIComponent(mm[1]));
      if (!s) { send(res, 404, { error: 'no such session' }); return; }
      if (!mm[2] && m === 'PATCH') {
        const t = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : null;
        s.title = t || null;
        broadcast('session', s);
        send(res, 200, s);
        return;
      }
      if (!mm[2] && m === 'DELETE') {
        if (s.status !== 'ended') setStatus(s, 'ended');
        send(res, 200, s);
        return;
      }
      if (!mm[2] && m === 'GET') { send(res, 200, s); return; }
      if (mm[2] === '/resume' && m === 'POST') {
        if (s.resumable === false) { send(res, 409, { error: 'this session cannot be resumed' }); return; }
        if (s.status === 'ended') {
          if (Number.isInteger(body.cols) && Number.isInteger(body.rows)) { const term = ensureTerm(s); term.cols = body.cols; term.rows = body.rows; }
          setStatus(s, 'starting');
          out(s, `\r\n${DIM}── resumed with claude --resume ${s.sid.slice(0, 8)} ──${RESET}\r\n${DIM}›${RESET} `);
          const term = ensureTerm(s); // viewers still attached get a fresh cut, like core
          for (const ws of term.viewers) if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'snapshot', data: term.buf.replace(/\r\n/g, '\n') }));
          later(400, () => { if (s.status === 'starting') applyHook(s, 'SessionStart', { source: 'resume' }); });
        }
        send(res, 200, s);
        return;
      }
      if (mm[2] === '/restart' && m === 'POST') {
        if (!(s.status === 'needs_you' && (s.waiting_on === 'login' || s.waiting_on === 'startup'))) {
          send(res, 409, { error: 'only a session waiting for a sign-in (or stuck starting) can be started again' });
          return;
        }
        s.signed_in = false;
        setStatus(s, 'starting');
        out(s, `\r\n${DIM}── started again ──${RESET}\r\n${DIM}›${RESET} `);
        later(400, () => { if (s.status === 'starting') applyHook(s, 'SessionStart', { source: 'startup' }); });
        send(res, 200, s);
        return;
      }
      if (mm[2] === '/answer' && m === 'POST' && Array.isArray(body.answers)) {
        // A question card: {tool_id, answers: [{choices} | {text}]} (core: sessions.answerQuestion).
        if (s.status !== 'needs_you' || s.asking?.kind !== 'question' || body.tool_id !== s.asking.tool_id) { send(res, 409, { error: 'that question has already been answered or replaced' }); return; }
        const qs = s.pendingTool.ask.questions;
        if (body.answers.length !== qs.length) { send(res, 400, { error: `send one answer per question (${qs.length})` }); return; }
        const labels = body.answers.map((a, i) => (a.text ? String(a.text) : (a.choices || []).map((c) => qs[i].options[c]?.label).join(', ')));
        const answers = Object.fromEntries(qs.map((q, i) => [q.question, labels[i]]));
        answerAsk(s, { tool_id: body.tool_id, kind: 'question', answers }, `You chose ${labels.join(' / ')}.`);
        send(res, 200, { ...s, answered: { tool_id: body.tool_id, answers: labels } });
        return;
      }
      if (mm[2] === '/answer' && m === 'POST' && s.asking?.kind === 'plan') {
        const option = body.option;
        const choice = (s.choices || []).find((c) => c.option === option);
        if (!choice) { send(res, 400, { error: 'option must be the number of a choice' }); return; }
        if (typeof body.text === 'string' && !/Tell Claude/.test(choice.label)) { send(res, 400, { error: 'that choice does not take text' }); return; }
        const id = s.asking.tool_id;
        if (typeof body.text === 'string') answerAsk(s, { tool_id: id, kind: 'plan', feedback: body.text }, `Changing the plan: ${body.text}`);
        else answerAsk(s, { tool_id: id, kind: 'plan', approved: true }, 'Plan approved. Starting.');
        send(res, 200, { ...s, answered: { option, label: choice.label } });
        return;
      }
      if (mm[2] === '/answer' && m === 'POST') {
        const option = body.option;
        if (!Number.isInteger(option) || option < 1 || option > 9) { send(res, 400, { error: 'option must be the number of a choice (1 or 2)' }); return; }
        if (s.status !== 'needs_you' || !ANSWERABLE.has(s.waiting_on)) { send(res, 409, { error: 'no dialog is waiting for an answer' }); return; }
        const choice = (s.choices || []).find((c) => c.option === option);
        if (!choice) { send(res, 400, { error: `there are only ${(s.choices || []).length} choices` }); return; }
        const kind = s.waiting_on;
        const no = /^(\d+\.\s*)?no\b/i.test(choice.label);
        s.choices = null;
        out(s, `\r\n${DIM}(${choice.label})${RESET}\r\n`);
        if (kind === 'permission_prompt') {
          setStatus(s, 'working');
          later(400, () => { if (s.status === 'working') applyHook(s, 'Stop', { last_assistant_message: `Permission answered (${choice.label.replace(/^\d+\.\s*/, '')}).` }); });
        } else if (kind === 'trust' && no) {
          out(s, `${DIM}Exiting.${RESET}\r\n`);
          setStatus(s, 'ended');
        } else {
          if (kind === 'trust' && st.trustSim) st.trusted.push(s.cwd);
          s.waiting_on = null;
          s.notification = null;
          out(s, `${CLAUDE}✻${RESET} Welcome to ${BOLD}Claude Code${RESET} ${DIM}(mock)${RESET}\r\n${DIM}›${RESET} `);
          const term = ensureTerm(s);
          const prompt = term.afterTrust;
          term.afterTrust = null;
          term.pendingPrompt = !!prompt;
          applyHook(s, 'SessionStart', { source: 'startup' });
          if (prompt) { term.pendingPrompt = false; out(s, prompt); handleLine(s, prompt); }
        }
        send(res, 200, s);
        return;
      }
      if (mm[2] === '/send' && m === 'POST') {
        if (s.status === 'ended') { send(res, 409, { error: 'that session has ended; resume it first' }); return; }
        if (s.status === 'needs_you' && ANSWER_FIRST.has(s.waiting_on)) { send(res, 409, { error: 'the session is waiting for your answer in the terminal; answer it in the cockpit first' }); return; }
        feedInput(s, `${String(body.text || '')}${body.enter === false ? '' : '\r'}`);
        send(res, 204);
        return;
      }
    }
    if (p === '/api/hooks' && m === 'POST') {
      const s = st.sessions.get(body.sid);
      if (!s) { send(res, 404, { error: 'no such session' }); return; }
      applyHook(s, body.event, body.payload || {});
      send(res, 204);
      return;
    }
    if (p === '/api/pair' && m === 'GET') {
      // Same shape as the real server: lan is a list of URLs, link is the app's deep link.
      const port = (req.headers.host || '').split(':')[1] || '4747';
      const lan = [`http://192.168.1.20:${port}`];
      const url = st.bind === '127.0.0.1' ? `http://127.0.0.1:${port}` : lan[0];
      send(res, 200, { url, token, link: `clawdling://connect?url=${encodeURIComponent(url)}&t=${token}`, browser_link: `${url}/?t=${token}`, lan, bind: st.bind });
      return;
    }
    if (p === '/api/pair/qr.svg' && m === 'GET') {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      res.end(placeholderQr(url.searchParams.get('target') === 'browser' ? `browser:${token}` : token));
      return;
    }
    if (p === '/api/remote' && m === 'GET') { send(res, 200, remoteView()); return; }
    if (p === '/api/remote/check' && m === 'POST') {
      for (const h of st.remote.hosts) h.checked_at = new Date().toISOString();
      await pause(250);
      send(res, 200, remoteView());
      return;
    }
    if (p === '/api/remote/enabled' && m === 'POST') {
      if (body.enabled === true && !st.remote.hosts.length) { send(res, 409, { error: 'There is no remote address yet: set it up first.' }); return; }
      st.remote.enabled = body.enabled === true;
      if (!st.remote.enabled) { st.remote.devices = []; st.remote.pairing = null; }
      send(res, 200, remoteView());
      return;
    }
    if (p === '/api/remote/pairing' && m === 'POST') {
      const hosts = st.remote.enabled ? st.remote.hosts.filter((h) => REMOTE_GOOD.has(h.status)) : [];
      if (!hosts.length) { send(res, 409, { error: 'Use from anywhere is off, or no address passed its check.' }); return; }
      const code = crypto.randomBytes(24).toString('base64url');
      st.remote.pairing = code;
      send(res, 201, { expires_at: new Date(Date.now() + 10 * MIN).toISOString(), minutes: 10, links: hosts.map((h) => ({ url: h.url, kind: h.kind, link: `${h.url}/?pair=${code}`, qr_svg: placeholderQr(code) })) });
      return;
    }
    mm = p.match(/^\/api\/remote\/devices\/([0-9a-f]{12})$/);
    if (mm && m === 'DELETE') {
      const before = st.remote.devices.length;
      st.remote.devices = st.remote.devices.filter((d) => d.id !== mm[1]);
      if (st.remote.devices.length === before) { send(res, 404, { error: 'no such device' }); return; }
      send(res, 200, { ok: true });
      return;
    }
    if (p === '/api/discover' && m === 'GET') {
      const askGh = url.searchParams.get('github') !== '0';
      await pause(askGh ? st.disc.delay : 120);
      send(res, 200, discoverBody(askGh));
      return;
    }
    if (p === '/api/import' && m === 'POST') {
      const [code, out] = body.group ? await importGroup(body) : await importOne(body);
      send(res, code, out);
      return;
    }
    if (p === '/api/setup' && m === 'GET') { send(res, 200, setupBody()); return; }
    if (p === '/api/setup/promote' && m === 'POST') {
      const name = String(body.name || '');
      const list = body.scope === 'repo' ? ((SETUP_REPOS[body.repo] || {}).agents || []) : SETUP_USER.agents;
      const sub = list.find((x) => x.name === name);
      if (!sub) { send(res, 404, { error: `no Claude Code subagent called "${name}"` }); return; }
      // `as`: the person's own name for it, when the subagent's id is taken (the id is its slug).
      const as = typeof body.as === 'string' ? body.as.trim().replace(/\s+/g, ' ').slice(0, 60) : '';
      const id = slug(as || name);
      if (agentById(id) || id === 'scratch') { send(res, 409, { error: `an agent with id "${id}" already exists` }); return; }
      const a = mkAgent(id, 'domain', as || humanize(name), sub.description, { age: 0, icon: null, color: null });
      a.source = { subagent: name, subagent_scope: body.scope === 'repo' ? 'repo' : 'user', imported_at: new Date().toISOString() };
      a._claude = `${defaultClaudeMd(a, st.org.owner)}\n## Working instructions (from your Claude Code subagent "${name}")\n${sub.description}\n\nCopied from ~/.claude/agents/${sub.file} on ${new Date().toISOString().slice(0, 10)}. Editing this file does not change the original.\n`;
      st.agents.push(a);
      publishOrg('agent_created', id);
      send(res, 201, publicAgent(a));
      return;
    }
    // 1.5: the report card, the org's totals, a session's Timeline, the Monday report, the detailed timeline.
    mm = p.match(/^\/api\/agents\/([^/]+)\/report$/);
    if (mm && m === 'GET') {
      const a = agentById(decodeURIComponent(mm[1]));
      if (!a) { send(res, 404, { error: `no agent "${mm[1]}"` }); return; }
      const win = url.searchParams.get('window') || '7d';
      if (!['today', '7d', '30d'].includes(win)) { send(res, 400, { error: 'window must be today, 7d or 30d' }); return; }
      send(res, 200, agentReport(a, win));
      return;
    }
    if (p === '/api/org/report' && m === 'GET') { send(res, 200, orgReport()); return; }
    mm = p.match(/^\/api\/sessions\/([^/]+)\/timeline$/);
    if (mm && m === 'GET') {
      const s = st.sessions.get(decodeURIComponent(mm[1]));
      if (!s) { send(res, 404, { error: 'no such session' }); return; }
      const raw = url.searchParams.get('after');
      const after = raw === null || raw === '' ? -1 : Number(raw);
      if (!Number.isInteger(after) || after < -1) { send(res, 400, { error: 'after must be an integer >= -1' }); return; }
      send(res, 200, timelineOf(s, after));
      return;
    }
    if (p === '/api/digest' && m === 'GET') { send(res, 200, digestStatus()); return; }
    if (p === '/api/digest' && m === 'POST') {
      if (body.enabled === true && !channelStatus().telegram.paired && !channelStatus().imessage.enabled) { send(res, 400, { error: 'Pair Telegram or iMessage with Donna first: the Monday report goes to that chat.' }); return; }
      if (typeof body.enabled === 'boolean') st.digest.enabled = body.enabled;
      if (Number.isInteger(body.day)) st.digest.day = body.day;
      if (Number.isInteger(body.hour)) st.digest.hour = body.hour;
      send(res, 200, digestStatus());
      return;
    }
    if (p === '/api/otel' && m === 'GET') { send(res, 200, otelStatus()); return; }
    if (p === '/api/otel' && m === 'POST') {
      if (st.otel.blocked && body.enabled) { send(res, 409, { error: 'Your Claude Code already has telemetry settings, so the detailed timeline stays off and Clawdling uses transcripts.', found: [{ where: 'your Claude Code settings', key: 'OTEL_EXPORTER_OTLP_ENDPOINT' }] }); return; }
      st.otel.enabled = !!body.enabled;
      send(res, 200, otelStatus());
      return;
    }
    if (p === '/api/channels' && m === 'GET') { send(res, 200, channelStatus()); return; }
    if (p === '/api/notify' && m === 'GET') { send(res, 200, { needs_you: !!st.notifyNeedsYou, channel: st.org.channels?.telegram?.chat_id ? 'telegram' : null }); return; }
    if (p === '/api/notify' && m === 'POST') {
      if (typeof body.needs_you !== 'boolean') { send(res, 400, { error: 'send {needs_you: true|false}' }); return; }
      st.notifyNeedsYou = body.needs_you;
      send(res, 200, { needs_you: st.notifyNeedsYou, channel: st.org.channels?.telegram?.chat_id ? 'telegram' : null });
      return;
    }
    if (p === '/api/channels/telegram' && m === 'POST') {
      const t = st.channels.telegram;
      if (typeof body.token === 'string' && body.token.trim()) { t.configured = true; t.paired = false; t.chat_id_masked = null; }
      if (typeof body.enabled === 'boolean') t.enabled = body.enabled;
      if (!t.configured) { send(res, 400, { error: 'send a bot token first' }); return; }
      if (!t.paired && (!st.pairing || body.token || body.pair === true)) st.pairing = { code: String(crypto.randomInt(100000, 1000000)), expires: Date.now() + 10 * MIN };
      publishChannels('telegram');
      send(res, 200, { ...channelStatus().telegram });
      return;
    }
    if (p === '/api/channels/imessage' && m === 'POST') {
      const im = st.channels.imessage;
      if (typeof body.handle === 'string') im.handle = body.handle.trim() || null;
      if (typeof body.enabled === 'boolean') im.enabled = body.enabled && !!im.handle;
      publishChannels('imessage');
      send(res, 200, channelStatus().imessage);
      return;
    }
    send(res, 404, { error: 'not found' });
  }

  function remoteView() {
    const r = st.remote;
    return {
      enabled: r.enabled, invalid: null, port: 4747, pairing_minutes: 10,
      hosts: r.hosts.map((h) => ({ ...h, status_text: REMOTE_TEXT[h.status] || h.status, answering: r.enabled && h.status !== 'public' && h.status !== 'unprotected' })),
      devices: r.devices, here: { remote: false, url: null, device: null },
    };
  }

  async function onMock(req, res, url) {
    const p = url.pathname;
    if (p === '/__mock/reset' && req.method === 'POST') {
      const body = await readBody(req);
      reset(body.fixture || url.searchParams.get('fixture') || 'default');
      send(res, 200, { ok: true, sessions: sessionList(), agents: st.agents.map(publicAgent) });
      return;
    }
    if (p === '/__mock/requests') { send(res, 200, st.requests); return; }
    // 1.5: the detailed timeline's preflight finds the user's own telemetry settings ({blocked}).
    if (p === '/__mock/otel' && req.method === 'POST') {
      const b = await readBody(req);
      st.otel.blocked = !!(b && b.blocked);
      if (st.otel.blocked) st.otel.enabled = false;
      send(res, 200, { ok: true });
      return;
    }
    if (p === '/__mock/transcript' && req.method === 'POST') {
      // A chat transcript for one session: [{role, text, tools?, model?}] (what the server reads from Claude Code's JSONL).
      const b = await readBody(req);
      const list = (Array.isArray(b.messages) ? b.messages : []).map((e, n) => ({ n, role: e.role, text: e.text || '', tools: e.tools || [], ts: e.ts || new Date().toISOString(), model: e.model || null }));
      st.transcripts.set(b.sid, list);
      send(res, 200, { ok: true, n: list.length });
      return;
    }
    if (p === '/__mock/accounts' && req.method === 'POST') {
      const b = await readBody(req);
      st.accounts = Array.isArray(b.accounts) ? b.accounts.map(String) : [];
      send(res, 200, { ok: true });
      return;
    }
    if (p === '/__mock/channel' && req.method === 'POST') {
      const body = await readBody(req);
      const msg = { channel: body.channel || 'telegram', direction: body.direction || 'in', text: body.text || '', ts: new Date().toISOString() };
      st.recent.push({ type: 'channel', ...msg });
      broadcast('channel', msg);
      send(res, 204);
      return;
    }
    if (p === '/__mock/drop' && req.method === 'POST') {
      // Simulate a network blip: kill every terminal socket without a close frame.
      let n = 0;
      for (const term of st.terms.values()) for (const ws of term.viewers) { ws.terminate(); n += 1; }
      send(res, 200, { dropped: n });
      return;
    }
    if (p === '/__mock/dialog' && req.method === 'POST') {
      const body = await readBody(req);
      const sess1 = st.sessions.get(body.sid);
      if (!sess1) { send(res, 404, { error: 'no such session' }); return; }
      raiseDialog(sess1, body.kind || 'trust');
      send(res, 204);
      return;
    }
    if (p === '/__mock/health' && req.method === 'POST') {
      // Merge a partial /api/health (e.g. {claude: {ok: false, ...}}) until the next reset.
      const body = await readBody(req);
      st.health = { ...st.health, ...body };
      send(res, 204);
      return;
    }
    if (p === '/__mock/fail' && req.method === 'POST') {
      // Make one API path answer with an error ({path, status, error}); {path, off: true} clears it.
      const body = await readBody(req);
      if (body.off) delete st.fail[body.path];
      else st.fail[body.path] = { status: body.status || 500, error: body.error || 'internal error' };
      send(res, 204);
      return;
    }
    if (p === '/__mock/discover' && req.method === 'POST') {
      // {gh: 'ok'|'missing'|'unauthed'|'error', delay, importDelay, cloneDelay,
      //  failImport: {name, times, error}, quiet, cloneTaken: [name], cloneRoot, legacyGroup409} until the next reset.
      const body = await readBody(req);
      Object.assign(st.disc, body);
      if (body.failImport) st.disc.failImport = { times: 1, ...body.failImport };
      send(res, 204);
      return;
    }
    if (p === '/__mock/remote' && req.method === 'POST') {
      const body = await readBody(req);
      const ago = (min) => new Date(Date.now() - min * MIN).toISOString();
      st.remote.hosts = (body.hosts || []).map((h) => ({ detail: null, checked_at: ago(h.ago ?? 1), ...h }));
      st.remote.enabled = body.enabled ?? st.remote.hosts.length > 0;
      st.remote.devices = (body.devices || []).map((d, i) => ({ id: `${'0'.repeat(11)}${i}`, host: st.remote.hosts[0]?.url || null, created_at: ago(d.ago ?? 60), expires_at: ago(-30 * 24 * 60), last_seen_at: ago(d.seen ?? 5), ...d }));
      send(res, 204);
      return;
    }
    if (p === '/__mock/remote-pair' && req.method === 'POST') {
      const body = await readBody(req);
      if (!st.remote.pairing) { send(res, 409, { error: 'no pairing link' }); return; }
      st.remote.pairing = null;
      st.remote.devices.push({ id: crypto.randomBytes(6).toString('hex'), label: body.label || 'iPhone · Safari', host: st.remote.hosts[0]?.url || null, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30 * DAY).toISOString(), last_seen_at: new Date().toISOString() });
      send(res, 204);
      return;
    }
    if (p === '/__mock/bind' && req.method === 'POST') {
      const body = await readBody(req);
      st.bind = body.bind || '127.0.0.1';
      send(res, 204);
      return;
    }
    if (p === '/__mock/pair' && req.method === 'POST') {
      Object.assign(st.channels.telegram, { paired: true, enabled: true, chat_id_masked: '••4821' });
      st.pairing = null;
      st.recent.push({ ts: new Date().toISOString(), type: 'channel', channel: 'telegram', event: 'paired', chat: '••4821' });
      publishChannels('telegram');
      send(res, 204);
      return;
    }
    send(res, 404, { error: 'unknown mock route' });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    const p = url.pathname;
    Promise.resolve().then(async () => {
      if (p.startsWith('/__mock/')) return onMock(req, res, url);
      if (p === '/' && url.searchParams.has('t')) {
        const ok = safeEq(url.searchParams.get('t'), token);
        const headers = { location: '/', 'cache-control': 'no-store' };
        if (ok) headers['set-cookie'] = `cl_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`;
        res.writeHead(302, headers);
        res.end();
        return undefined;
      }
      if (p.startsWith('/api/')) return onApi(req, res, url);
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
      send(res, 405, 'Method not allowed');
      return undefined;
    }).catch((e) => {
      if (!quiet) console.error(e);
      try { send(res, 500, { error: String(e && e.message) }); } catch { /* ignore */ }
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://mock');
    const m = url.pathname.match(/^\/ws\/term\/([^/]+)$/);
    if (!m || !authed(req, url) || !originOk(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    const s = st.sessions.get(decodeURIComponent(m[1]));
    if (!s) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const term = ensureTerm(s);
      // Like tmux capture-pane: "\n"-joined lines (the client must turn them into CR+LF).
      ws.send(JSON.stringify({ t: 'snapshot', data: term.buf.replace(/\r\n/g, '\n') }));
      ws.send(JSON.stringify({ t: 'status', status: s.status }));
      if (s.status === 'ended') ws.send(JSON.stringify({ t: 'ended' }));
      term.viewers.add(ws);
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.t === 'in' && typeof msg.data === 'string') feedInput(s, msg.data);
        else if (msg.t === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
          term.cols = msg.cols;
          term.rows = msg.rows;
          st.requests.push({ method: 'WS', path: `/ws/term/${s.sid}`, body: msg, at: Date.now() });
        }
      });
      ws.on('close', () => term.viewers.delete(ws));
    });
  });

  reset(fixture);
  await new Promise((resolve) => server.listen(port, host, resolve));
  const actual = server.address().port;
  const url = `http://${host}:${actual}`;
  if (!quiet) console.log(`[mock] cockpit: ${url}/?t=${token}`);

  return {
    url, port: actual, token, state: st, reset,
    close: () => new Promise((resolve) => {
      for (const t of timers) clearTimeout(t);
      for (const term of st.terms.values()) clearInterval(term.stream);
      for (const res of sse) { try { res.end(); } catch { /* ignore */ } }
      for (const ws of wss.clients) { try { ws.terminate(); } catch { /* ignore */ } }
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
  };
  const srv = await startMockServer({ port: Number(arg('port', 4848)), fixture: arg('fixture', 'default'), token: arg('token', 'mock-token-0123456789abcdef'), quiet: false });
  const stop = () => srv.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

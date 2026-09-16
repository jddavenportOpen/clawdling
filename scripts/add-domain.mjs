#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// add-domain.mjs — create a domain agent.
//
// A "domain" is a scoped pane: its own agent prompt, its own cwd, its own
// place in the picker. This writes the profile row and the agent prompt
// template, so you never hand-edit YAML to add one.
//
//   npm run domain:add -- --id health --label Health --blurb "Training and food"
//   npm run domain:add -- --id health --color "#22C55E" --agent agents/custom.md
//
// The picker hydrates from GET /api/domains at open time, so a new domain
// shows up on the next open. No rebuild.
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const args = process.argv.slice(2);
const arg = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
};

const id = arg('id');
if (!id) {
  console.error('usage: npm run domain:add -- --id <slug> [--label L] [--color #RRGGBB] [--blurb B] [--agent agents/x.md]');
  process.exit(2);
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
  console.error(`invalid --id "${id}": use a lowercase slug, e.g. "health" or "side-project"`);
  process.exit(2);
}

const PALETTE = ['#6366F1', '#F5A623', '#22C55E', '#EC4899', '#06B6D4', '#EF4444', '#A855F7'];
const profile = process.env.ADJUTANT_PROFILE || 'starter';
const root = path.join(process.cwd(), 'profiles', profile);
const yamlPath = path.join(root, 'domains.yaml');

if (!fs.existsSync(yamlPath)) {
  console.error(`no domains.yaml for profile "${profile}" at ${yamlPath}`);
  process.exit(1);
}

const raw = fs.readFileSync(yamlPath, 'utf8');
const doc = YAML.parse(raw) ?? {};
const rows = Array.isArray(doc.domains) ? doc.domains : [];

if (rows.some((r) => r?.id === id)) {
  console.error(`domain "${id}" already exists in ${path.relative(process.cwd(), yamlPath)}`);
  process.exit(1);
}

const label = arg('label') || id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const color = arg('color') || PALETTE[rows.length % PALETTE.length];
const blurb = arg('blurb') || `${label} work`;
const agentRel = arg('agent') || `agents/${id}.md`;

if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
  console.error(`invalid --color "${color}": expected #RRGGBB`);
  process.exit(2);
}

// Agent prompt template — only written if absent, so re-running never clobbers
// a prompt you have edited.
const agentAbs = path.join(root, agentRel);
let wroteAgent = false;
if (!fs.existsSync(agentAbs)) {
  fs.mkdirSync(path.dirname(agentAbs), { recursive: true });
  fs.writeFileSync(
    agentAbs,
    `# ${label} agent

You are the ${label.toLowerCase()} agent inside a self-hosted AI OS. You own one
scope and you stay in it: ${blurb.toLowerCase()}.

## How you work

- Get to the point. Short, plain answers. No filler, no flattery.
- When the user wants to remember to do something, call \`create_task\` rather
  than only replying.
- When the user shares a durable fact or preference, call \`remember\` so it
  survives across conversations.
- Before answering anything about their list, call \`list_tasks\` and answer
  from the real data.
- Say when you do not know. Do not invent specifics.

## Scope

Replace this with what this domain actually owns, the files or projects it
should read first, and anything it must never do.
`,
    'utf8'
  );
  wroteAgent = true;
}

// Append the row while preserving the file's comments: YAML.stringify on the
// whole doc would strip the header block that explains the format.
const row =
  `  - id: ${id}\n` +
  `    label: ${label}\n` +
  `    color: "${color}"\n` +
  `    blurb: ${blurb}\n` +
  `    agent: ${agentRel}\n`;

const out = raw.endsWith('\n') ? raw + row : raw + '\n' + row;
fs.writeFileSync(yamlPath, out, 'utf8');

console.log(`added domain "${id}" (${label}) to profiles/${profile}/domains.yaml`);
if (wroteAgent) console.log(`wrote prompt template profiles/${profile}/${agentRel} — edit it to give the agent its real scope`);
else console.log(`kept existing prompt profiles/${profile}/${agentRel}`);
console.log('open the session picker and it will be there. No rebuild needed.');

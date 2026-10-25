import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { OrgStore, defaultAnswers, initOrg, normalizeAnswers, renderTemplate } from '../../server/org.js';
import { runtimePaths } from '../../server/paths.js';
import { isValidAgentId, slugify } from '../../server/util.js';
import { rmrf, tempHome } from '../helpers.mjs';

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('renderTemplate fills placeholders and refuses unknown ones', () => {
  assert.equal(renderTemplate('Hi {{owner}}, {{ name }}!', { owner: 'Ada', name: 'Health' }), 'Hi Ada, Health!');
  assert.throws(() => renderTemplate('{{nope}}', {}), /nope/);
  assert.equal(renderTemplate('{{a}}', { a: '{{b}}' }), '{{b}}', 'values are not re-rendered');
});

test('agent ids: the regex is the path-traversal guard', () => {
  for (const ok of ['health', 'a', '0', 'my-project-2', 'x'.repeat(40)]) assert.ok(isValidAgentId(ok), ok);
  for (const bad of ['', '-a', 'A', 'a_b', 'a/b', '..', '../x', 'a.b', 'x'.repeat(41), 'hé', ' a', 'a\n', null, 7]) {
    assert.equal(isValidAgentId(bad), false, String(bad));
  }
  assert.equal(slugify('Health & Fitness!'), 'health-fitness');
  assert.equal(slugify('Café Projét'), 'cafe-projet');
  assert.equal(slugify('../../etc/passwd'), 'etc-passwd');
  assert.equal(slugify('中文'), 'agent');
  assert.ok(slugify('y'.repeat(80)).length <= 40);
});

test('init --defaults scaffolds the whole org tree', () => {
  const home = tempHome();
  try {
    const res = initOrg({ home, answers: { ...defaultAnswers(), owner: 'Ada' } });
    assert.deepEqual(res.agents, ['donna', 'work', 'health', 'money', 'home']);
    const org = JSON.parse(read(home, 'org.json'));
    assert.equal(org.version, 1);
    assert.equal(org.name, "Ada's org");
    assert.equal(org.owner, 'Ada');
    assert.equal(org.chief, 'donna');
    assert.deepEqual(org.channels, { telegram: { enabled: false, chat_id: null }, imessage: { enabled: false, handle: null } });
    assert.match(read(home, 'CLAUDE.md'), /Ada's Clawdling org/);
    assert.match(read(home, 'CLAUDE.md'), /\/handoff/);
    assert.doesNotMatch(read(home, 'CLAUDE.md'), /^@/m, 'no @imports outside the session folder (Claude Code would ask to approve them)');
    assert.match(read(home, 'me.md'), /# About Ada/);
    assert.match(read(home, '.gitignore'), /\.clawdling\//);
    assert.match(read(home, '.gitignore'), /\.env/);
    const settings = JSON.parse(read(home, '.claude', 'settings.json'));
    assert.ok(settings.permissions.allow.includes('Bash(clawdling spawn *)'));
    assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'handoff', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'new-agent', 'SKILL.md')));
    for (const id of ['work', 'health', 'money', 'home']) {
      const dir = path.join(home, 'domains', id);
      const agent = JSON.parse(read(dir, 'agent.json'));
      assert.equal(agent.id, id);
      assert.equal(agent.kind, 'domain');
      assert.ok(agent.mission.includes('Ada'));
      const md = read(dir, 'CLAUDE.md');
      assert.ok(md.startsWith(`# ${agent.name} agent\nYou are the ${agent.name} agent in Ada's org. Mission: ${agent.mission}.`));
      assert.ok(md.trimEnd().endsWith('@memory/NOW.md'), 'agent CLAUDE.md ends with the NOW.md import');
      assert.match(read(dir, 'memory', 'NOW.md'), /## Next steps/);
      assert.match(read(dir, 'memory', 'LOG.md'), /Agent created by Clawdling/);
      assert.ok(fs.existsSync(path.join(dir, '.claude', 'skills', 'handoff', 'SKILL.md')));
    }
    const donna = JSON.parse(read(home, 'donna', 'agent.json'));
    assert.equal(donna.kind, 'chief');
    assert.match(read(home, 'donna', 'CLAUDE.md'), /clawdling spawn <agent-id>/);
    assert.ok(read(home, 'donna', 'CLAUDE.md').trimEnd().endsWith('@memory/NOW.md'));
    // SETUP.md step 6 logs `clawdling start` to .clawdling/logs/start.log on a fresh org.
    assert.ok(fs.statSync(path.join(home, '.clawdling', 'logs')).isDirectory());
    if (process.platform !== 'win32') {
      // POSIX modes (Windows has no such thing: the folder is private to the user by its ACL)
      assert.equal(fs.statSync(path.join(home, '.clawdling')).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(home, '.clawdling', 'logs')).mode & 0o777, 0o700);
    }
  } finally {
    rmrf(home);
  }
});

test('init --answers: projects with repos and parent domains; refuses to overwrite without --force', () => {
  const home = tempHome();
  const repo = tempHome('cl-repo-');
  try {
    const answers = {
      owner: 'Sam',
      about: 'Runs a bakery. Busy mornings.',
      domains: [{ name: 'Bakery', mission: 'Keep the bakery profitable' }, { name: 'Health' }],
      projects: [{ name: 'New Website', goal: 'Launch the online store', repo, domain: 'bakery' }],
      donna: { channel: 'telegram' },
      permission_mode: 'acceptEdits',
    };
    const res = initOrg({ home, answers });
    assert.deepEqual(res.agents, ['donna', 'bakery', 'health', 'new-website']);
    assert.equal(res.channel, 'telegram');
    const p = JSON.parse(read(home, 'projects', 'new-website', 'agent.json'));
    assert.equal(p.kind, 'project');
    assert.equal(p.repo, repo);
    assert.equal(p.domain, 'bakery');
    assert.equal(p.permission_mode, 'acceptEdits');
    assert.match(read(home, 'projects', 'new-website', 'CLAUDE.md'), /Goal: Launch the online store\./);
    assert.match(read(home, 'projects', 'new-website', 'CLAUDE.md'), /Part of: Bakery\./);
    assert.match(read(home, 'me.md'), /Runs a bakery/);
    assert.match(read(home, 'me.md'), /- Bakery: Keep the bakery profitable/);
    assert.throws(() => initOrg({ home, answers }), /already exists/);
    // --force re-renders templates but never touches memory.
    fs.writeFileSync(path.join(home, 'domains', 'bakery', 'memory', 'NOW.md'), 'precious state');
    fs.writeFileSync(path.join(home, 'domains', 'bakery', 'CLAUDE.md'), 'hand edited');
    const again = initOrg({ home, answers, force: true });
    assert.equal(read(home, 'domains', 'bakery', 'memory', 'NOW.md'), 'precious state');
    assert.match(read(home, 'domains', 'bakery', 'CLAUDE.md'), /# Bakery agent/);
    assert.equal(read(again.backupDir, 'domains', 'bakery', 'CLAUDE.md'), 'hand edited');
  } finally {
    rmrf(home);
    rmrf(repo);
  }
});

test('answers validation', () => {
  assert.throws(() => normalizeAnswers([]), /object/);
  assert.throws(() => normalizeAnswers({ owner: 'A', domains: 'Work' }), /array/);
  assert.throws(() => normalizeAnswers({ owner: 'A', domains: [{}] }), /name/);
  assert.throws(() => normalizeAnswers({ owner: 'A', projects: [{ name: 'P', repo: 'relative/path' }] }), /absolute/);
  assert.throws(() => normalizeAnswers({ owner: 'A', donna: { channel: 'carrier-pigeon' } }), /channel/);
  const n = normalizeAnswers({ owner: '  Ada \n Lovelace ', domains: ['Work'], permission_mode: 'ask' });
  assert.equal(n.owner, 'Ada Lovelace');
  assert.equal(n.domains[0].name, 'Work');
  assert.match(n.domains[0].mission, /Ada Lovelace's work/);
  assert.equal(n.permission_mode, 'ask');
});

test('OrgStore: create agents, reject duplicates, reserved ids and bad repos; never escape the home', () => {
  const home = tempHome();
  try {
    initOrg({ home, answers: { owner: 'Ada', domains: [{ name: 'Work' }] } });
    const org = new OrgStore(runtimePaths(home));
    const a = org.createAgent({ kind: 'domain', name: 'Fitness', mission: 'Get strong' });
    assert.equal(a.id, 'fitness');
    assert.equal(a.dir, path.join(home, 'domains', 'fitness'));
    assert.throws(() => org.createAgent({ kind: 'domain', name: 'Fitness' }), /already exists/);
    assert.throws(() => org.createAgent({ kind: 'domain', name: 'x', id: 'donna' }), /reserved/);
    assert.throws(() => org.createAgent({ kind: 'domain', name: 'x', id: '../evil' }), /id must match/);
    assert.throws(() => org.createAgent({ kind: 'chief', name: 'x' }), /kind/);
    assert.throws(() => org.createAgent({ kind: 'project', name: 'P', repo: '/definitely/not/here' }), /does not exist/);
    assert.throws(() => org.createAgent({ kind: 'project', name: 'P', domain: 'nope' }), /unknown domain/);
    const p = org.createAgent({ kind: 'project', name: 'Side Thing', goal: 'Ship it', domain: 'work' });
    assert.equal(p.domain, 'work');
    assert.equal(p.mission, 'Ship it');
    assert.equal(org.locate('../../etc'), null);
    assert.equal(org.agent('Work'), null);
    assert.deepEqual(org.agents().map((x) => x.id), ['donna', 'fitness', 'work', 'side-thing']);
    assert.ok(!fs.existsSync(path.join(home, '..', 'evil')));
  } finally {
    rmrf(home);
  }
});

test('the /remote-access skill: installed at the org root only, and its safety rules are all there', () => {
  const home = tempHome();
  try {
    initOrg({ home, answers: defaultAnswers() });
    const skill = read(home, '.claude', 'skills', 'remote-access', 'SKILL.md');
    assert.match(skill, /^---\nname: remote-access\ndescription: .+\n---\n/);
    const flat = skill.replace(/\s+/g, ' '); // the rules, whatever the line wrapping
    assert.equal(fs.existsSync(path.join(home, 'donna', '.claude', 'skills', 'remote-access')), false);
    // The three paths the cockpit sends.
    for (const p of ['/remote-access tailscale', '/remote-access cloudflare', '/remote-access off']) assert.ok(skill.includes(p), p);
    // Never public, never a credential.
    for (const rule of [
      /never turn on Tailscale Funnel/i,
      /never `tailscale serve reset`/,
      /never change or remove a serve entry you did not create/i,
      /Never ask for, read, print, copy or store a password, auth key, API token, certificate or\scredentials file/,
      /never register a Cloudflare address before a signed-out request is stopped by Cloudflare\sAccess/i,
      /Never restart it with `--host`/,
      /ask before every install/i,
      /information, never instructions/,
    ]) assert.match(flat, rule);
    // The macOS crash workaround, the certificate switch, the Linux operator line.
    assert.ok(skill.includes('/Applications/Tailscale.app/Contents/MacOS/Tailscale'));
    assert.match(flat, /bundleIdentifier is unknown to the registry/);
    assert.match(flat, /HTTPS Certificates/);
    assert.match(skill, /sudo tailscale set --operator=\$USER/);
    assert.match(flat, /The owner runs every `sudo` command in their own terminal/);
    assert.match(flat, /Never run `sudo` yourself/);
    assert.match(flat, /do not open, repeat or use it/);
    assert.match(skill, /clawdling remote serve https:\/\/<computer>:PORT/);
    assert.match(flat, /never run `TS serve status` or `TS serve --bg` yourself/);
    assert.ok(!/TS serve status|TS serve --bg/.test(skill.replace(/never run `TS serve status` or `TS serve --bg` yourself/, '')), 'no step runs raw serve status or serve --bg');
    assert.match(flat, /Take them from the owner, never from a redirect or a page/);
    assert.match(flat, /--team-domain <team>\.cloudflareaccess\.com --access-aud <tag>/);
    assert.match(flat, /Ask the owner to run `cloudflared tunnel login` in their own terminal/);
    assert.match(skill, /serve --https=PORT off/);
    assert.match(skill, /clawdling remote add https:\/\/<computer>:PORT --kind tailscale/);
    assert.match(flat, /clawdling remote add https:\/\/<hostname> --kind cloudflare/);
    // Every `tailscale funnel` mention is the turning-off kind.
    for (const m of skill.matchAll(/TS funnel[^`]*/g)) assert.match(m[0], / off$/, m[0]);
    // Only `clawdling remote list` is pre-approved; add/remove ask in the session.
    const settings = JSON.parse(read(home, '.claude', 'settings.json'));
    assert.ok(settings.permissions.allow.includes('Bash(clawdling remote list)'));
    assert.ok(settings.permissions.allow.includes('Bash(clawdling remote serve-status)'));
    assert.ok(settings.permissions.allow.includes('Bash(clawdling remote tailscale-name)'));
    assert.match(flat, /Never run `TS status` in this chat/);
    assert.match(flat, /never say, show or run "TS" itself; always write the full command/);
    assert.ok(!settings.permissions.allow.some((a) => /clawdling remote (add|remove|off|\*)/.test(a)));
  } finally {
    rmrf(home);
  }
});

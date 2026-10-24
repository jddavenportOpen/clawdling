#!/usr/bin/env node
// A stand-in for the GitHub CLI in the discover tests. It answers the calls discovery makes
// (`gh api user --jq .login`, `gh api user/orgs --jq .[].login`, `gh repo list [owner] --json ...
// --limit N`) from the JSON file named by FAKE_GH_DATA:
//   {"user": "ada", "orgs": ["acme-co"], "repos": {"ada": [...], "acme-co": [...]}}
// The import tests also use `gh auth status`, `gh repo view <nwo> --json ...`, `gh issue list -R
// <nwo> ...`, `gh pr list -R <nwo> ...` (from "issues"/"prs": {"<nwo>": [{number, title}]}) and
// `gh repo clone <nwo> <dest>`, which runs a real `git clone` of "clone": {"<nwo>": "<local repo>"}.
// and fails the way the real gh does when asked:
//   FAKE_GH_MODE=unauth  not signed in: "To get started with GitHub CLI, please run: gh auth login" (exit 4)
//   FAKE_GH_MODE=old     an old gh that does not know isArchived/isFork: "Unknown JSON field" (exit 1)
//   FAKE_GH_SLOW=<owner> `gh repo list <owner>` hangs for 30 s (a slow call must never be fatal)
// FAKE_GH_LOG names a file that gets one JSON line per call: the argv and the gh env flags seen.
// Output is written and the exit code set without process.exit(), so a pipe is never cut short.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const env = process.env;

if (env.FAKE_GH_LOG) {
  const tokenVars = Object.keys(env).filter((k) => /^(GH|GITHUB)_(ENTERPRISE_)?TOKEN$/.test(k));
  fs.appendFileSync(env.FAKE_GH_LOG, JSON.stringify({ args, prompt: env.GH_PROMPT_DISABLED || null, notifier: env.GH_NO_UPDATE_NOTIFIER || null, tokenVars }) + '\n');
}

const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};

/** [exit code, stdout, stderr, delay ms] for this call. */
function answer() {
  if (env.FAKE_GH_MODE === 'unauth') {
    return [4, '', 'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n'];
  }
  const data = env.FAKE_GH_DATA ? JSON.parse(fs.readFileSync(env.FAKE_GH_DATA, 'utf8')) : { user: 'ada', orgs: [], repos: {} };
  if (args[0] === 'api' && args[1] === 'user' && flag('--jq') === '.login') return [0, `${data.user}\n`, ''];
  if (args[0] === 'api' && args[1] === 'user/orgs' && flag('--jq') === '.[].login') return [0, (data.orgs || []).map((o) => `${o}\n`).join(''), ''];
  if (args[0] === 'auth' && args[1] === 'status') return [0, '', 'github.com\n  ✓ Logged in to github.com account ' + data.user + '\n'];
  if ((args[0] === 'issue' || args[0] === 'pr') && args[1] === 'list') {
    const nwo = flag('-R');
    const all = (args[0] === 'issue' ? data.issues : data.prs) || {};
    return [0, JSON.stringify((all[nwo] || []).slice(0, Number(flag('--limit') || 30))) + '\n', ''];
  }
  if (args[0] === 'repo' && args[1] === 'view') {
    const nwo = args[2];
    const all = Object.values(data.repos || {}).flat();
    const r = all.find((x) => x.nameWithOwner && x.nameWithOwner.toLowerCase() === String(nwo).toLowerCase());
    if (!r) return [1, '', `GraphQL: Could not resolve to a Repository with the name '${nwo}'.\n`];
    return [0, JSON.stringify({ nameWithOwner: r.nameWithOwner, description: r.description ?? '', isPrivate: !!r.isPrivate, url: r.url }) + '\n', ''];
  }
  if (args[0] === 'repo' && args[1] === 'clone') {
    const src = (data.clone || {})[args[2]];
    if (!src) return [1, '', `GraphQL: Could not resolve to a Repository with the name '${args[2]}'.\n`];
    const r = spawnSync('git', ['clone', '-q', src, args[3]], { encoding: 'utf8' });
    return [r.status ?? 1, '', r.stderr || ''];
  }
  if (args[0] === 'repo' && args[1] === 'list') {
    const owner = args[2] && !args[2].startsWith('-') ? args[2] : data.user;
    const fields = String(flag('--json') || '').split(',').filter(Boolean);
    const limit = Number(flag('--limit') || 30);
    if (!fields.length) return [1, '', '--json requires fields\n'];
    if (env.FAKE_GH_MODE === 'old') {
      const unknown = fields.find((f) => f === 'isArchived' || f === 'isFork');
      if (unknown) return [1, '', `Unknown JSON field: "${unknown}"\nAvailable fields:\n  description\n  isPrivate\n  name\n  nameWithOwner\n  primaryLanguage\n  pushedAt\n  url\n`];
    }
    const out = (data.repos?.[owner] || []).slice(0, limit).map((r) => Object.fromEntries(fields.map((f) => [f, r[f] ?? null])));
    return [0, JSON.stringify(out, null, 2) + '\n', '', env.FAKE_GH_SLOW && env.FAKE_GH_SLOW === owner ? 30000 : 0];
  }
  return [1, '', `unknown command "${args.join(' ')}" for "gh"\n`];
}

const [code, stdout, stderr, delay = 0] = answer();
setTimeout(() => {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}, delay);

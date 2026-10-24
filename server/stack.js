// What a folder is built with and how to run it, read from its own manifest files (package.json,
// pyproject.toml, Makefile, Cargo.toml, go.mod, ...). Read-only and local: nothing is executed.
// Every read is confined to the folder: a file whose realpath is outside it (a cloned repo can
// commit `README.md -> ../../.netrc`) reads as missing. Symlinks that stay inside are fine.
import fs from 'node:fs';
import path from 'node:path';

const MAX_READ = 256 * 1024;
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);

function readText(file, max = MAX_READ) {
  let fd;
  try {
    fd = fs.openSync(file, OPEN_FLAGS);
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function realOf(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** Is `p` the folder `dir` or inside it? Both realpaths. */
function inside(p, dir) {
  const key = (x) => (process.platform === 'win32' ? x.toLowerCase() : x);
  const a = key(p);
  const b = key(dir);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/**
 * Paths inside `dir` that really are inside it: `file(rel)` / `dir(rel)` give the realpath of a
 * regular file / folder whose realpath is within realpath(dir), else null.
 */
function confined(dir) {
  const root = typeof dir === 'string' && dir && !dir.includes('\0') ? realOf(dir) : null;
  const resolve = (rel) => {
    if (!root) return null;
    const rp = realOf(path.join(root, rel));
    return rp && inside(rp, root) ? rp : null;
  };
  return {
    root,
    file: (rel) => {
      const rp = resolve(rel);
      return rp && isFile(rp) ? rp : null;
    },
    dir: (rel) => {
      const rp = resolve(rel);
      return rp && isDir(rp) ? rp : null;
    },
  };
}

function listDir(dir, max = 2000) {
  if (!dir) return [];
  try {
    const out = [];
    const d = fs.opendirSync(dir);
    try {
      for (let e = d.readSync(); e && out.length < max; e = d.readSync()) out.push(e);
    } finally {
      d.closeSync();
    }
    return out;
  } catch {
    return [];
  }
}

/** The `[section]` blocks of a TOML file as {name: body}. Enough for the keys we read; not a TOML parser. */
export function tomlSections(text) {
  const out = { '': '' };
  let cur = '';
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/);
    if (m) {
      cur = m[1];
      out[cur] = out[cur] || '';
      continue;
    }
    out[cur] += line + '\n';
  }
  return out;
}

function tomlString(body, key) {
  const m = String(body || '').match(new RegExp(`^\\s*${key}\\s*=\\s*(["'])(.*?)\\1`, 'm'));
  return m ? m[2] : null;
}

function tomlArray(body, key) {
  const m = String(body || '').match(new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm'));
  if (!m) return [];
  return [...m[1].matchAll(/(["'])(.*?)\1/g)].map((x) => x[2]);
}

/** Make targets a person would run (skips pattern rules, variables and dot-targets). */
export function makeTargets(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    // `name:` or a double-colon rule `name::`, but not an assignment (`:=`, `::=`, `:::=`).
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9_.\-/]*)\s*::?(?![=:])/);
    if (!m) continue;
    const t = m[1];
    if (t.includes('%') || t.includes('/') || t.startsWith('.') || /\.(o|c|h|a|so)$/.test(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** justfile recipe names. */
export function justRecipes(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    // `name params:` (params may have defaults, `target="x"`), but not an assignment `name := value`.
    const m = line.match(/^@?([A-Za-z0-9][A-Za-z0-9_-]*)(\s+[^:]*)?:(?!=)/);
    if (m && !/^(set|export|alias|import|mod)$/.test(m[1]) && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

const JS_FRAMEWORKS = [
  ['next', 'Next.js'], ['nuxt', 'Nuxt'], ['@sveltejs/kit', 'SvelteKit'], ['svelte', 'Svelte'], ['astro', 'Astro'],
  ['@remix-run/react', 'Remix'], ['react-native', 'React Native'], ['expo', 'Expo'], ['electron', 'Electron'],
  ['vue', 'Vue'], ['react', 'React'], ['@angular/core', 'Angular'], ['solid-js', 'Solid'], ['preact', 'Preact'],
  ['@nestjs/core', 'NestJS'], ['express', 'Express'], ['fastify', 'Fastify'], ['hono', 'Hono'], ['koa', 'Koa'],
  ['vite', 'Vite'], ['tailwindcss', 'Tailwind CSS'], ['prisma', 'Prisma'], ['drizzle-orm', 'Drizzle'],
];
const JS_TESTERS = [['vitest', 'Vitest'], ['jest', 'Jest'], ['mocha', 'Mocha'], ['@playwright/test', 'Playwright'], ['cypress', 'Cypress'], ['ava', 'AVA']];
const PY_FRAMEWORKS = [['django', 'Django'], ['fastapi', 'FastAPI'], ['flask', 'Flask'], ['streamlit', 'Streamlit'], ['pytest', 'pytest'], ['torch', 'PyTorch'], ['pandas', 'pandas']];
// Scripts worth naming, in the order a newcomer needs them.
const SCRIPT_KINDS = [
  ['dev', 'dev'], ['start', 'start'], ['test', 'test'], ['test:unit', 'test'], ['build', 'build'], ['lint', 'lint'],
  ['typecheck', 'typecheck'], ['type-check', 'typecheck'], ['check', 'check'], ['format', 'format'], ['e2e', 'test'],
];
const MAKE_KINDS = { test: 'test', check: 'test', build: 'build', run: 'run', dev: 'dev', serve: 'dev', start: 'start', lint: 'lint', install: 'install', setup: 'install', fmt: 'format', format: 'format', deploy: 'deploy' };
const EXT_LANG = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.py': 'Python',
  '.go': 'Go', '.rs': 'Rust', '.rb': 'Ruby', '.java': 'Java', '.kt': 'Kotlin', '.swift': 'Swift', '.c': 'C', '.h': 'C',
  '.cpp': 'C++', '.cc': 'C++', '.cs': 'C#', '.php': 'PHP', '.ex': 'Elixir', '.exs': 'Elixir', '.dart': 'Dart', '.lua': 'Lua',
  '.sh': 'Shell', '.html': 'HTML', '.css': 'CSS', '.ipynb': 'Jupyter Notebook', '.r': 'R', '.scala': 'Scala', '.zig': 'Zig',
};

function placeholderTest(cmd) {
  return /no test specified/i.test(cmd || '');
}

function expandWorkspaceGlobs(box, globs) {
  const out = [];
  for (const g of globs.slice(0, 20)) {
    const clean = String(g).replace(/^\.\//, '').replace(/\/+$/, '');
    if (!clean || clean.startsWith('!') || clean.includes('..') || path.isAbsolute(clean)) continue;
    const star = clean.indexOf('*');
    if (star === -1) {
      if (box.dir(clean)) out.push(clean);
      continue;
    }
    const base = clean.slice(0, star).replace(/\/+$/, '');
    for (const e of listDir(box.dir(base || '.'), 200)) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') out.push(base ? `${base}/${e.name}` : e.name);
    }
  }
  return [...new Set(out)].sort().slice(0, 20);
}

/**
 * Detect a folder's stack.
 * @returns {{language: string|null, languages: string[], frameworks: string[], manifests: string[],
 *   package_manager: string|null, commands: {kind: string, cmd: string, from: string}[],
 *   monorepo: {tool: string, packages: string[]}|null, description: string|null, ci: boolean, docker: boolean}}
 */
export function detectStack(dir) {
  const box = confined(dir);
  const has = (f) => !!box.file(f);
  const read = (f) => {
    const rp = box.file(f);
    return rp ? readText(rp) : null;
  };
  const hasDir = (d) => !!box.dir(d);
  const languages = [];
  const frameworks = [];
  const manifests = [];
  const commands = [];
  let pm = null;
  let monorepo = null;
  let description = null;
  const lang = (l) => {
    if (l && !languages.includes(l)) languages.push(l);
  };
  const fw = (f) => {
    if (f && !frameworks.includes(f)) frameworks.push(f);
  };
  const cmd = (kind, c, from) => {
    if (!commands.some((x) => x.cmd === c)) commands.push({ kind, cmd: c, from });
  };

  // JavaScript / TypeScript
  if (has('package.json')) {
    manifests.push('package.json');
    let pkg = {};
    try {
      pkg = JSON.parse(read('package.json') || '{}') || {};
    } catch {
      pkg = {};
    }
    if (has('pnpm-lock.yaml') || has('pnpm-workspace.yaml')) pm = 'pnpm';
    else if (has('yarn.lock')) pm = 'yarn';
    else if (has('bun.lockb') || has('bun.lock')) pm = 'bun';
    else if (typeof pkg.packageManager === 'string') pm = pkg.packageManager.split('@')[0] || 'npm';
    else pm = 'npm';
    if (!['npm', 'pnpm', 'yarn', 'bun'].includes(pm)) pm = 'npm';
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.peerDependencies || {}) };
    if (has('tsconfig.json') || deps.typescript) lang('TypeScript');
    lang('JavaScript');
    for (const [dep, name] of JS_FRAMEWORKS) if (deps[dep]) fw(name);
    for (const [dep, name] of JS_TESTERS) if (deps[dep]) fw(name);
    if (typeof pkg.description === 'string' && pkg.description.trim()) description = pkg.description.trim();
    cmd('install', pm === 'yarn' ? 'yarn' : `${pm} install`, 'package.json');
    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    for (const [name, kind] of SCRIPT_KINDS) {
      const body = scripts[name];
      if (typeof body !== 'string' || (name === 'test' && placeholderTest(body))) continue;
      const run = pm === 'npm' ? (name === 'test' || name === 'start' ? `npm ${name}` : `npm run ${name}`) : pm === 'bun' ? `bun run ${name}` : `${pm} ${name}`;
      cmd(kind, run, 'package.json');
    }
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : Array.isArray(pkg.workspaces?.packages) ? pkg.workspaces.packages : null;
    if (ws && ws.length) monorepo = { tool: `${pm} workspaces`, packages: expandWorkspaceGlobs(box, ws) };
  }
  if (has('pnpm-workspace.yaml')) {
    manifests.push('pnpm-workspace.yaml');
    const globs = [...String(read('pnpm-workspace.yaml') || '').matchAll(/^\s*-\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)].map((m) => m[1]);
    monorepo = { tool: 'pnpm workspaces', packages: expandWorkspaceGlobs(box, globs) };
  }
  for (const [f, tool] of [['turbo.json', 'Turborepo'], ['nx.json', 'Nx'], ['lerna.json', 'Lerna']]) {
    if (!has(f)) continue;
    manifests.push(f);
    monorepo = { tool: monorepo ? `${tool} + ${monorepo.tool}` : tool, packages: monorepo ? monorepo.packages : [] };
  }
  if (has('deno.json') || has('deno.jsonc')) {
    const f = has('deno.json') ? 'deno.json' : 'deno.jsonc';
    manifests.push(f);
    lang('TypeScript');
    fw('Deno');
    try {
      const d = JSON.parse(String(read(f) || '{}').replace(/^\s*\/\/.*$/gm, ''));
      for (const t of Object.keys(d.tasks || {}).slice(0, 6)) cmd(t === 'test' ? 'test' : t === 'dev' ? 'dev' : 'run', `deno task ${t}`, f);
    } catch {
      // unreadable deno.json
    }
    if (!commands.some((c) => c.kind === 'test')) cmd('test', 'deno test', f);
  }

  // Python
  if (has('pyproject.toml')) {
    manifests.push('pyproject.toml');
    lang('Python');
    const toml = read('pyproject.toml') || '';
    const s = tomlSections(toml);
    if (!description) description = tomlString(s.project, 'description') || tomlString(s['tool.poetry'], 'description');
    const poetry = has('poetry.lock') || 'tool.poetry' in s;
    const uv = has('uv.lock') || 'tool.uv' in s;
    pm = pm || (uv ? 'uv' : poetry ? 'poetry' : 'pip');
    cmd('install', uv ? 'uv sync' : poetry ? 'poetry install' : 'pip install -e .', 'pyproject.toml');
    const lower = toml.toLowerCase();
    for (const [dep, name] of PY_FRAMEWORKS) if (new RegExp(`["'\\s]${dep}\\b`).test(lower)) fw(name);
    if ('tool.pytest.ini_options' in s || /\bpytest\b/.test(lower) || hasDir('tests')) {
      cmd('test', uv ? 'uv run pytest' : poetry ? 'poetry run pytest' : 'pytest', 'pyproject.toml');
    }
  }
  if (has('requirements.txt')) {
    manifests.push('requirements.txt');
    lang('Python');
    pm = pm || 'pip';
    cmd('install', 'pip install -r requirements.txt', 'requirements.txt');
    const req = String(read('requirements.txt') || '').toLowerCase();
    for (const [dep, name] of PY_FRAMEWORKS) if (new RegExp(`^${dep}\\b`, 'm').test(req)) fw(name);
    if (/^pytest\b/m.test(req)) cmd('test', 'pytest', 'requirements.txt');
  }
  if (has('setup.py') && !manifests.includes('pyproject.toml')) {
    manifests.push('setup.py');
    lang('Python');
    pm = pm || 'pip';
    cmd('install', 'pip install -e .', 'setup.py');
  }
  if (has('manage.py')) {
    fw('Django');
    cmd('dev', 'python manage.py runserver', 'manage.py');
    cmd('test', 'python manage.py test', 'manage.py');
  }
  if (has('tox.ini')) {
    manifests.push('tox.ini');
    cmd('test', 'tox', 'tox.ini');
  }

  // Rust, Go and the rest
  if (has('Cargo.toml')) {
    manifests.push('Cargo.toml');
    lang('Rust');
    pm = pm || 'cargo';
    const s = tomlSections(read('Cargo.toml') || '');
    if (!description) description = tomlString(s.package, 'description');
    if ('workspace' in s) monorepo = { tool: 'Cargo workspace', packages: expandWorkspaceGlobs(box, tomlArray(s.workspace, 'members')) };
    cmd('build', 'cargo build', 'Cargo.toml');
    cmd('test', 'cargo test', 'Cargo.toml');
    if (has('src/main.rs')) cmd('run', 'cargo run', 'Cargo.toml');
  }
  if (has('go.mod')) {
    manifests.push('go.mod');
    lang('Go');
    pm = pm || 'go';
    cmd('build', 'go build ./...', 'go.mod');
    cmd('test', 'go test ./...', 'go.mod');
    if (has('main.go')) cmd('run', 'go run .', 'go.mod');
  }
  if (has('go.work')) {
    manifests.push('go.work');
    const uses = [...String(read('go.work') || '').matchAll(/^\s*(?:use\s+)?(\.\/[^\s)]+)\s*$/gm)].map((m) => m[1]);
    monorepo = { tool: 'Go workspace', packages: expandWorkspaceGlobs(box, uses) };
  }
  if (has('Gemfile')) {
    manifests.push('Gemfile');
    lang('Ruby');
    pm = pm || 'bundler';
    cmd('install', 'bundle install', 'Gemfile');
    if (/\brails\b/.test(read('Gemfile') || '')) fw('Rails');
    if (hasDir('spec')) cmd('test', 'bundle exec rspec', 'Gemfile');
    else if (has('Rakefile')) cmd('test', 'bundle exec rake test', 'Gemfile');
  }
  if (has('pom.xml')) {
    manifests.push('pom.xml');
    lang('Java');
    cmd('build', 'mvn package', 'pom.xml');
    cmd('test', 'mvn test', 'pom.xml');
  }
  for (const f of ['build.gradle.kts', 'build.gradle']) {
    if (!has(f)) continue;
    manifests.push(f);
    lang(f.endsWith('.kts') || /kotlin/.test(read(f) || '') ? 'Kotlin' : 'Java');
    const g = has('gradlew') ? './gradlew' : 'gradle';
    cmd('build', `${g} build`, f);
    cmd('test', `${g} test`, f);
    break;
  }
  if (has('Package.swift')) {
    manifests.push('Package.swift');
    lang('Swift');
    cmd('build', 'swift build', 'Package.swift');
    cmd('test', 'swift test', 'Package.swift');
  }
  if (has('composer.json')) {
    manifests.push('composer.json');
    lang('PHP');
    cmd('install', 'composer install', 'composer.json');
    try {
      const c = JSON.parse(read('composer.json') || '{}');
      if (!description && typeof c.description === 'string') description = c.description;
      if (c.scripts && c.scripts.test) cmd('test', 'composer test', 'composer.json');
    } catch {
      // unreadable composer.json
    }
  }
  if (has('mix.exs')) {
    manifests.push('mix.exs');
    lang('Elixir');
    cmd('install', 'mix deps.get', 'mix.exs');
    cmd('test', 'mix test', 'mix.exs');
  }
  if (has('pubspec.yaml')) {
    manifests.push('pubspec.yaml');
    lang('Dart');
    const flutter = /\bflutter\s*:/.test(read('pubspec.yaml') || '');
    if (flutter) fw('Flutter');
    cmd('install', flutter ? 'flutter pub get' : 'dart pub get', 'pubspec.yaml');
    cmd('test', flutter ? 'flutter test' : 'dart test', 'pubspec.yaml');
  }
  const dotnet = listDir(box.root, 400).find((e) => e.isFile() && /\.(sln|csproj|fsproj)$/i.test(e.name));
  if (dotnet) {
    manifests.push(dotnet.name);
    lang(/\.fsproj$/i.test(dotnet.name) ? 'F#' : 'C#');
    cmd('build', 'dotnet build', dotnet.name);
    cmd('test', 'dotnet test', dotnet.name);
  }

  // Task runners (they often hold the real commands, so they go first among equals)
  if (has('Makefile') || has('makefile') || has('GNUmakefile')) {
    const f = has('Makefile') ? 'Makefile' : has('makefile') ? 'makefile' : 'GNUmakefile';
    manifests.push(f);
    for (const t of makeTargets(read(f))) if (MAKE_KINDS[t]) cmd(MAKE_KINDS[t], `make ${t}`, f);
  }
  if (has('justfile') || has('Justfile')) {
    const f = has('justfile') ? 'justfile' : 'Justfile';
    manifests.push(f);
    for (const t of justRecipes(read(f)).slice(0, 8)) cmd(MAKE_KINDS[t] || 'run', `just ${t}`, f);
  }

  // No manifest: count file extensions near the top of the tree.
  if (!languages.length) {
    const counts = {};
    const visit = (d, depth) => {
      for (const e of listDir(d, 400)) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        if (e.isFile()) {
          const l = EXT_LANG[path.extname(e.name).toLowerCase()];
          if (l) counts[l] = (counts[l] || 0) + 1;
        } else if (e.isDirectory() && depth < 1) visit(path.join(d, e.name), depth + 1);
      }
    };
    if (box.root) visit(box.root, 0);
    for (const [l] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3)) lang(l);
  }

  return {
    language: languages[0] || null,
    languages,
    frameworks: frameworks.slice(0, 8),
    manifests,
    package_manager: pm,
    commands: commands.slice(0, 12),
    monorepo,
    description: description ? description.replace(/\s+/g, ' ').trim().slice(0, 300) : null,
    ci: hasDir(path.join('.github', 'workflows')) || has('.gitlab-ci.yml') || has(path.join('.circleci', 'config.yml')),
    docker: has('Dockerfile') || has('docker-compose.yml') || has('compose.yaml') || has('docker-compose.yaml'),
  };
}

const README_NAMES = ['README.md', 'readme.md', 'Readme.md', 'README.markdown', 'README.rst', 'README.txt', 'README'];

/**
 * The opening of a folder's README in plain text: the title and the first paragraphs (badges,
 * images, HTML and link syntax removed), at most `max` characters. null when there is no README.
 */
export function readmeExcerpt(dir, max = 800) {
  const box = confined(dir);
  let file = null;
  let rp = null;
  for (const n of README_NAMES) {
    rp = box.file(n);
    if (rp) {
      file = n;
      break;
    }
  }
  if (!file) return null;
  const raw = readText(rp, 64 * 1024) || '';
  const lines = raw.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  let title = null;
  const paras = [];
  let cur = [];
  let inCode = false;
  const flush = () => {
    const t = cur.join(' ').replace(/\s+/g, ' ').trim();
    if (t) paras.push(t);
    cur = [];
  };
  for (let line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inCode = !inCode;
      flush();
      continue;
    }
    if (inCode) continue;
    const h = line.match(/^\s{0,3}#{1,6}\s+(.*)$/) || line.match(/^\s*<h[1-6][^>]*>(.*?)<\/h[1-6]>\s*$/i);
    if (h) {
      flush();
      const text = clean(h[1]);
      if (!title && text) title = text;
      else if (paras.length) break; // the next section: the opening is over
      continue;
    }
    if (/^\s*(=+|-+)\s*$/.test(line) && cur.length) {
      // setext heading: the previous line was a title
      if (!title) title = clean(cur.join(' '));
      cur = [];
      continue;
    }
    line = clean(line);
    if (!line) {
      flush();
      continue;
    }
    cur.push(line);
  }
  flush();
  let text = '';
  for (const p of paras) {
    if (text.length >= max) break;
    text += (text ? '\n\n' : '') + p;
  }
  if (text.length > max) text = text.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  return { file, title: title ? title.slice(0, 120) : null, text: text || null };
}

function clean(s) {
  return String(s)
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '') // linked badges
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> their text
    .replace(/[*_`]{1,3}([^*_`]+)[*_`]{1,3}/g, '$1')
    .replace(/^\s*[-*+>]\s+/, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

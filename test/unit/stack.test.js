// Stack detection reads a folder's own manifests; nothing is executed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { detectStack, justRecipes, makeTargets, readmeExcerpt, tomlSections } from '../../server/stack.js';
import { rmrf, tempHome } from '../helpers.mjs';

/** A temp folder with these files ({rel: text}); returns its path. */
function tree(files) {
  const dir = tempHome('cl-stack-');
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (rel.endsWith('/')) fs.mkdirSync(f, { recursive: true });
    else fs.writeFileSync(f, text);
  }
  return dir;
}

function withTree(files, fn) {
  const dir = tree(files);
  try {
    return fn(dir);
  } finally {
    rmrf(dir);
  }
}

const cmds = (st) => st.commands.map((c) => `${c.kind}:${c.cmd}`);

test('package.json: scripts become commands; the npm placeholder test script is skipped', () => {
  withTree(
    {
      'package.json': JSON.stringify({
        description: '  A tiny   site ',
        scripts: { dev: 'vite', test: 'echo "Error: no test specified" && exit 1', build: 'vite build', lint: 'eslint .', start: 'node .' },
        dependencies: { react: '^19', next: '15' },
        devDependencies: { typescript: '5', vitest: '3' },
      }),
    },
    (dir) => {
      const st = detectStack(dir);
      assert.equal(st.language, 'TypeScript');
      assert.deepEqual(st.languages, ['TypeScript', 'JavaScript']);
      assert.equal(st.package_manager, 'npm');
      assert.ok(st.frameworks.includes('Next.js') && st.frameworks.includes('React') && st.frameworks.includes('Vitest'));
      assert.equal(st.description, 'A tiny site');
      assert.deepEqual(cmds(st), ['install:npm install', 'dev:npm run dev', 'start:npm start', 'build:npm run build', 'lint:npm run lint']);
      assert.ok(!cmds(st).some((c) => c.startsWith('test:')), 'the "no test specified" placeholder is not a test command');
      assert.equal(st.commands[0].from, 'package.json');
      assert.equal(st.monorepo, null);
    }
  );
  withTree({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) }, (dir) => {
    assert.deepEqual(cmds(detectStack(dir)), ['install:npm install', 'test:npm test']);
    assert.equal(detectStack(dir).language, 'JavaScript');
  });
});

test('lockfiles pick the package manager: pnpm, yarn, bun', () => {
  const pkg = JSON.stringify({ scripts: { test: 'vitest', dev: 'vite' } });
  withTree({ 'package.json': pkg, 'pnpm-lock.yaml': '' }, (dir) => {
    const st = detectStack(dir);
    assert.equal(st.package_manager, 'pnpm');
    assert.deepEqual(cmds(st), ['install:pnpm install', 'dev:pnpm dev', 'test:pnpm test']);
  });
  withTree({ 'package.json': pkg, 'yarn.lock': '' }, (dir) => {
    const st = detectStack(dir);
    assert.equal(st.package_manager, 'yarn');
    assert.deepEqual(cmds(st), ['install:yarn', 'dev:yarn dev', 'test:yarn test']);
  });
  withTree({ 'package.json': pkg, 'bun.lockb': '' }, (dir) => {
    const st = detectStack(dir);
    assert.equal(st.package_manager, 'bun');
    assert.deepEqual(cmds(st), ['install:bun install', 'dev:bun run dev', 'test:bun run test']);
  });
  withTree({ 'package.json': pkg, 'bun.lock': '' }, (dir) => assert.equal(detectStack(dir).package_manager, 'bun'));
  // packageManager field, and an unknown one falls back to npm
  withTree({ 'package.json': JSON.stringify({ packageManager: 'pnpm@9.1.0' }) }, (dir) => assert.equal(detectStack(dir).package_manager, 'pnpm'));
  withTree({ 'package.json': JSON.stringify({ packageManager: 'weird@1' }) }, (dir) => assert.equal(detectStack(dir).package_manager, 'npm'));
  withTree({ 'package.json': '{not json' }, (dir) => assert.equal(detectStack(dir).package_manager, 'npm', 'a broken package.json still reads as npm'));
});

test('pyproject: uv, poetry and plain pip; pytest detected', () => {
  withTree({ 'pyproject.toml': '[project]\nname = "x"\ndescription = "Crunch numbers"\ndependencies = ["fastapi", "pytest"]\n', 'uv.lock': '' }, (dir) => {
    const st = detectStack(dir);
    assert.equal(st.language, 'Python');
    assert.equal(st.package_manager, 'uv');
    assert.equal(st.description, 'Crunch numbers');
    assert.ok(st.frameworks.includes('FastAPI') && st.frameworks.includes('pytest'));
    assert.deepEqual(cmds(st), ['install:uv sync', 'test:uv run pytest']);
  });
  withTree({ 'pyproject.toml': '[tool.poetry]\nname = "x"\ndescription = "Poetic"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n' }, (dir) => {
    const st = detectStack(dir);
    assert.equal(st.package_manager, 'poetry');
    assert.equal(st.description, 'Poetic');
    assert.deepEqual(cmds(st), ['install:poetry install', 'test:poetry run pytest']);
  });
  withTree({ 'pyproject.toml': '[project]\nname = "x"\n', 'tests/': '' }, (dir) => {
    const st = detectStack(dir);
    assert.equal(st.package_manager, 'pip');
    assert.deepEqual(cmds(st), ['install:pip install -e .', 'test:pytest'], 'a tests/ folder means pytest');
  });
  withTree({ 'pyproject.toml': '[project]\nname = "x"\n' }, (dir) => assert.deepEqual(cmds(detectStack(dir)), ['install:pip install -e .'], 'no tests, no test command'));
  withTree({ 'requirements.txt': 'Django==5\npytest\n', 'manage.py': '' }, (dir) => {
    const st = detectStack(dir);
    assert.ok(st.frameworks.includes('Django'));
    assert.deepEqual(cmds(st), ['install:pip install -r requirements.txt', 'test:pytest', 'dev:python manage.py runserver', 'test:python manage.py test']);
  });
});

test('Makefile targets: the ones a person runs, mapped to kinds', () => {
  const mk = ['.PHONY: test', 'CC := gcc', 'VAR = 1', 'X ::= 2', 'Y :::= 3', 'all: build', 'build:', '\tgo build', 'test: build', 'lint:', 'fmt:', '%.o: %.c', 'src/foo.o: x', 'deploy::', 'install:', 'clean:'].join('\n');
  assert.deepEqual(makeTargets(mk), ['all', 'build', 'test', 'lint', 'fmt', 'deploy', 'install', 'clean']);
  withTree({ Makefile: mk }, (dir) => {
    const st = detectStack(dir);
    assert.deepEqual(st.manifests, ['Makefile']);
    assert.deepEqual(cmds(st), ['build:make build', 'test:make test', 'lint:make lint', 'format:make fmt', 'deploy:make deploy', 'install:make install']);
  });
  assert.deepEqual(justRecipes('set shell := ["bash"]\nalias t := test\ntest:\n  cargo test\n@build target="x":\n  echo\nx := "1"\n'), ['test', 'build']);
});

test('Cargo workspace and go.mod', () => {
  withTree({ 'Cargo.toml': '[workspace]\nmembers = ["crates/*", "cli"]\n', 'crates/a/Cargo.toml': '', 'crates/b/Cargo.toml': '', 'cli/Cargo.toml': '' }, (dir) => {
    const st = detectStack(dir);
    assert.equal(st.language, 'Rust');
    assert.equal(st.package_manager, 'cargo');
    assert.deepEqual(st.monorepo, { tool: 'Cargo workspace', packages: ['cli', 'crates/a', 'crates/b'] });
    assert.deepEqual(cmds(st), ['build:cargo build', 'test:cargo test']);
  });
  withTree({ 'Cargo.toml': '[package]\nname = "x"\ndescription = "A CLI"\n', 'src/main.rs': '' }, (dir) => {
    const st = detectStack(dir);
    assert.equal(st.description, 'A CLI');
    assert.deepEqual(cmds(st), ['build:cargo build', 'test:cargo test', 'run:cargo run']);
  });
  withTree({ 'go.mod': 'module example.com/x\n', 'main.go': 'package main' }, (dir) => {
    const st = detectStack(dir);
    assert.equal(st.language, 'Go');
    assert.deepEqual(cmds(st), ['build:go build ./...', 'test:go test ./...', 'run:go run .']);
  });
  assert.deepEqual(Object.keys(tomlSections('a = 1\n[x]\nb = 2\n[[bin]]\nname = "y"\n')), ['', 'x', 'bin']);
});

test('monorepo workspaces are expanded to their package folders', () => {
  withTree(
    {
      'package.json': JSON.stringify({ workspaces: ['packages/*', 'apps/web', '!packages/skip', '../escape'] }),
      'packages/ui/package.json': '{}',
      'packages/core/package.json': '{}',
      'packages/.hidden/x': '',
      'packages/node_modules/x': '',
      'apps/web/package.json': '{}',
    },
    (dir) => {
      const st = detectStack(dir);
      assert.deepEqual(st.monorepo, { tool: 'npm workspaces', packages: ['apps/web', 'packages/core', 'packages/ui'] });
    }
  );
  withTree({ 'package.json': '{}', 'pnpm-lock.yaml': '', 'pnpm-workspace.yaml': "packages:\n  - 'libs/*'\n", 'libs/a/package.json': '{}', 'turbo.json': '{}' }, (dir) => {
    const st = detectStack(dir);
    assert.deepEqual(st.monorepo, { tool: 'Turborepo + pnpm workspaces', packages: ['libs/a'] });
    assert.ok(st.manifests.includes('turbo.json'));
  });
  withTree({ 'package.json': JSON.stringify({ workspaces: { packages: ['pkgs/*'] } }), 'yarn.lock': '', 'pkgs/one/package.json': '{}' }, (dir) => {
    assert.deepEqual(detectStack(dir).monorepo, { tool: 'yarn workspaces', packages: ['pkgs/one'] });
  });
});

test('no manifest: the language comes from counting file extensions near the top', () => {
  withTree({ 'a.py': '', 'b.py': '', 'lib/c.py': '', 'run.sh': '', '.hidden/x.go': '', 'node_modules/y.js': '', 'deep/er/z.rb': '' }, (dir) => {
    const st = detectStack(dir);
    assert.equal(st.language, 'Python');
    assert.deepEqual(st.languages, ['Python', 'Shell']);
    assert.deepEqual(st.manifests, []);
    assert.deepEqual(st.commands, []);
    assert.equal(st.package_manager, null);
  });
  withTree({ 'notes.txt': '' }, (dir) => assert.equal(detectStack(dir).language, null));
});

test('CI and Docker flags', () => {
  withTree({ '.github/workflows/ci.yml': 'on: push', Dockerfile: 'FROM node' }, (dir) => {
    const st = detectStack(dir);
    assert.equal(st.ci, true);
    assert.equal(st.docker, true);
  });
  withTree({ 'x.js': '' }, (dir) => {
    const st = detectStack(dir);
    assert.equal(st.ci, false);
    assert.equal(st.docker, false);
  });
});

function canSymlink() {
  const d = tempHome('cl-stack-ln-');
  try {
    fs.writeFileSync(path.join(d, 't'), '');
    fs.symlinkSync(path.join(d, 't'), path.join(d, 'l'));
    return true;
  } catch {
    return false;
  } finally {
    rmrf(d);
  }
}
const NO_LINKS = canSymlink() ? false : 'this system does not let a test create symlinks';

test('detectStack and readmeExcerpt never read through a symlink that leaves the folder; one that stays inside is fine', { skip: NO_LINKS }, () => {
  const base = tempHome('cl-stack-ln-');
  try {
    const outside = path.join(base, 'private');
    fs.mkdirSync(path.join(outside, 'pkgs', 'leaked-pkg'), { recursive: true });
    fs.writeFileSync(path.join(outside, '.netrc'), 'machine github.com login ada password NETRCSECRET0001\n');
    fs.writeFileSync(path.join(outside, 'package.json'), JSON.stringify({ description: 'PKGSECRET0002', scripts: { test: 'steal' } }));
    fs.writeFileSync(path.join(outside, 'pyproject.toml'), '[project]\ndescription = "PYSECRET0003"\n');
    fs.writeFileSync(path.join(outside, 'Makefile'), 'deploy:\n');
    const repo = path.join(base, 'home', 'code', 'evil');
    fs.mkdirSync(repo, { recursive: true });
    fs.symlinkSync(path.relative(repo, path.join(outside, '.netrc')), path.join(repo, 'README.md'));
    fs.symlinkSync(path.join(outside, 'package.json'), path.join(repo, 'package.json'));
    fs.symlinkSync(path.join(outside, 'pyproject.toml'), path.join(repo, 'pyproject.toml'));
    fs.symlinkSync(path.join(outside, 'Makefile'), path.join(repo, 'Makefile'));
    fs.writeFileSync(path.join(repo, 'Cargo.toml'), '[workspace]\nmembers = ["pkgs/*"]\n');
    fs.symlinkSync(path.join(outside, 'pkgs'), path.join(repo, 'pkgs'));

    const st = detectStack(repo);
    const text = JSON.stringify({ st, readme: readmeExcerpt(repo) });
    for (const s of ['NETRCSECRET0001', 'PKGSECRET0002', 'PYSECRET0003', 'steal', 'leaked-pkg', 'make deploy']) assert.ok(!text.includes(s), `${s} came through a symlink out of the repo`);
    assert.deepEqual(st.manifests, ['Cargo.toml'], 'a manifest that is a symlink out of the repo reads as absent');
    assert.deepEqual(st.monorepo, { tool: 'Cargo workspace', packages: [] });
    assert.equal(readmeExcerpt(repo), null);

    // Inside the repo: a linked README, and the repo reached through a symlinked path, both work.
    const good = path.join(base, 'home', 'code', 'good');
    fs.mkdirSync(path.join(good, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(good, 'docs', 'README.md'), '# Good\n\nGood is fine.\n');
    fs.writeFileSync(path.join(good, 'package.json'), JSON.stringify({ description: 'Good app' }));
    fs.symlinkSync(path.join('docs', 'README.md'), path.join(good, 'README.md'));
    const via = path.join(base, 'via');
    fs.symlinkSync(good, via);
    for (const d of [good, via]) {
      assert.equal(readmeExcerpt(d).text, 'Good is fine.', d);
      assert.equal(detectStack(d).description, 'Good app', d);
    }
  } finally {
    rmrf(base);
  }
});

test('readmeExcerpt: title and opening paragraphs; badges, images, HTML and code blocks removed; stops at the next heading', () => {
  const md = [
    '<!-- a comment that should vanish -->',
    '<p align="center"><img src="logo.png" width="80"></p>',
    '# My **Tool**',
    '',
    '[![CI](https://x/badge.svg)](https://x/actions) ![cov](https://x/cov.svg)',
    '',
    'My Tool turns [CSV files](https://example.com) into `charts`.',
    'It runs locally.',
    '',
    '```bash',
    'npm install my-tool',
    '```',
    '',
    '- Fast',
    '',
    '## Install',
    '',
    'This paragraph is in the next section.',
  ].join('\n');
  withTree({ 'README.md': md }, (dir) => {
    const r = readmeExcerpt(dir);
    assert.equal(r.file, 'README.md');
    assert.equal(r.title, 'My Tool');
    assert.equal(r.text, 'My Tool turns CSV files into charts. It runs locally.\n\nFast');
    assert.doesNotMatch(r.text, /badge|svg|img|npm install|next section|comment/);
  });
  withTree({ 'readme.md': 'Setext Title\n============\n\nFirst para.\n' }, (dir) => {
    const r = readmeExcerpt(dir);
    assert.equal(r.title, 'Setext Title');
    assert.equal(r.text, 'First para.');
  });
  withTree({ 'README.md': `# T\n\n${'word '.repeat(400)}\n` }, (dir) => {
    const r = readmeExcerpt(dir, 100);
    assert.ok(r.text.length <= 100, `clamped (${r.text.length})`);
    assert.ok(r.text.endsWith('…'));
  });
  withTree({ 'README.md': '# Only a title\n' }, (dir) => assert.deepEqual(readmeExcerpt(dir), { file: 'README.md', title: 'Only a title', text: null }));
  withTree({ 'x.txt': '' }, (dir) => assert.equal(readmeExcerpt(dir), null));
});

test('other test scripts (test:smoke, e2e:ci) are named too, but not watch modes', () => {
  const dir = tempHome('cl-stack-scripts-');
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { 'test:smoke': 'playwright test', 'test:watch': 'vitest', 'e2e:ci': 'playwright test --ci', dev: 'vite' } }));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    const tests = detectStack(dir).commands.filter((c) => c.kind === 'test').map((c) => c.cmd);
    assert.deepEqual(tests, ['pnpm test:smoke', 'pnpm e2e:ci']);
  } finally {
    rmrf(dir);
  }
});

test('commitHooks: husky, lint-staged and pre-commit are seen from the repo\'s files', async () => {
  const { commitHooks } = await import('../../server/stack.js');
  const os = await import('node:os');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdling-hooks-'));
  assert.equal(commitHooks(d), false);
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ devDependencies: { husky: '9' } }));
  assert.equal(commitHooks(d), true);
  fs.rmSync(path.join(d, 'package.json'));
  fs.writeFileSync(path.join(d, '.pre-commit-config.yaml'), 'repos: []\n');
  assert.equal(commitHooks(d), true);
  fs.rmSync(d, { recursive: true, force: true });
});

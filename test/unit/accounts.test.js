// Extra Claude accounts are only folders passed as CLAUDE_CONFIG_DIR: names, listing, lookups.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Accounts, accountId, accountsDir } from '../../server/accounts.js';
import { isValidEffort } from '../../server/util.js';
import { rmrf, tempHome } from '../helpers.mjs';

test('account ids: a name becomes a short slug; "default" and empty are refused', () => {
  assert.equal(accountId('Work plan'), 'work-plan');
  assert.equal(accountId('  ../../etc  '), 'etc');
  assert.equal(accountId('x'.repeat(50)).length, 32);
  assert.equal(accountId('!!!'), '');
  assert.equal(accountsDir({ CLAWDLING_ACCOUNTS_DIR: '/tmp/a' }), '/tmp/a');
  assert.match(accountsDir({}), /\.clawdling-accounts$/);
});

test('accounts: the default login always comes first; added accounts are private folders', () => {
  const dir = tempHome('cl-acct-');
  try {
    const acc = new Accounts({ env: { CLAWDLING_ACCOUNTS_DIR: path.join(dir, 'accounts') } });
    assert.deepEqual(acc.list().map((a) => a.id), ['default'], 'no folder yet: only the default login');
    assert.equal(acc.list()[0].name, 'Your Claude login');
    assert.equal(acc.configDir('default'), null, 'the default login passes no CLAUDE_CONFIG_DIR');
    assert.equal(acc.configDir(null), null);

    const a = acc.create('Work');
    assert.equal(a.id, 'work');
    assert.equal(a.dir, path.join(dir, 'accounts', 'work'));
    assert.ok(fs.statSync(a.dir).isDirectory());
    if (process.platform !== 'win32') assert.equal(fs.statSync(a.dir).mode & 0o777, 0o700);
    assert.deepEqual(acc.list().map((x) => x.id), ['default', 'work']);
    assert.equal(acc.configDir('work'), a.dir);

    assert.throws(() => acc.create('work'), (e) => e.status === 409);
    assert.throws(() => acc.create('default'), (e) => e.status === 400);
    assert.throws(() => acc.create(''), (e) => e.status === 400);
    assert.throws(() => acc.configDir('nope'), (e) => e.status === 404);
    assert.throws(() => acc.configDir('../work'), (e) => e.status === 400, 'no path tricks');
    fs.writeFileSync(path.join(dir, 'accounts', 'stray-file'), 'x');
    assert.deepEqual(acc.list().map((x) => x.id), ['default', 'work'], 'only folders are accounts');
  } finally {
    rmrf(dir);
  }
});

test('effort levels are the CLI\'s own', () => {
  for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) assert.ok(isValidEffort(e));
  for (const e of ['', 'ultra', 'HIGH', null, 3]) assert.ok(!isValidEffort(e));
});

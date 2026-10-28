// A permanent regression test: the stand-in adversarial review (1.8, round 2) wrote it as a probe.
// Stand-in review r2, LOW-2: two common ways to put a password on a command line pass ruleText() as they
// are, so an allow rule holding one shows its password in GET /api/setup/safety and in
// `clawdling discover --setup --safety` (text and --json).
//
// ruleText() (discover.js) hides a value glued to `-p` only when it holds a digit or a ':' (to keep
// `find -print` and `-p22`), so MySQL's own `-p<password>` form with a letters-only password stays; and
// `redis-cli -a <password>` (Redis's documented form) has no rule at all. Both are words, under 20
// characters, after no key word, so neither redactSecrets() nor scrubTokens() catches them. These outputs
// are the owner's own (the report carries no rule text), hence Low.
//
// It FAILS while either password comes back, and passes once ruleText knows those command forms (a glued
// `-p` after mysql, mariadb, mysqldump, mysqladmin; `-a`/`--pass` after redis-cli).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ruleText } from '../../server/discover.js';

test('a letters-only password glued to mysql -p is hidden', () => {
  const out = ruleText('Bash(mysql -u admin -pbluemoon appdb)');
  assert.ok(out && out.startsWith('Bash(mysql'), `precondition: the rule is kept (${out})`);
  assert.ok(!out.includes('bluemoon'), `the password is shown: ${out}`);
});

test('redis-cli -a <password> is hidden', () => {
  const out = ruleText('Bash(redis-cli -a bluemoon ping)');
  assert.ok(out && out.startsWith('Bash(redis-cli'), `precondition: the rule is kept (${out})`);
  assert.ok(!out.includes('bluemoon'), `the password is shown: ${out}`);
});

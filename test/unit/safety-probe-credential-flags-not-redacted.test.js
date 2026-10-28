// A permanent regression test: the stand-in adversarial review (1.8, round 3) wrote it as a probe.
// Stand-in review r3, LOW-2 (word-list extension, the same class as round 2's LOW-2): more documented
// ways to put a password on a command line pass ruleText() as they are, so an allow rule holding one shows
// it in GET /api/setup/safety and in `clawdling discover --setup --safety` (text and --json).
//
// ruleText() (server/discover.js) knows `-p`/`-u`/`--password`/`--pass`/`--token`/... and, since round 2,
// mysql's glued -p and redis-cli's -a. Not:
//   gpg --passphrase <pw>             (CRED_FLAG_RE's `--pass` must be followed by a space or "=")
//   openssl ... -passout pass:<pw>    (OpenSSL's documented pass: form; "pass" is not a key word)
//   sqlcmd -U sa -P <pw>              (the flags are matched case-sensitively: -P is not -p)
//   ldapsearch -D <dn> -w <pw>        (-w is the bind password)
// Short words, so neither redactSecrets() nor scrubTokens() catches them. Low for the reason round 2 gave:
// these outputs are the owner's own (the report carries no rule text).
//
// FAILS on r18 HEAD 7017c92 while any of the four passwords comes back.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ruleText } from '../../server/discover.js';

const cases = [
  ['gpg --passphrase', 'Bash(gpg --batch --passphrase bluemoon -c notes.txt)', 'Bash(gpg'],
  ['openssl -passout pass:', 'Bash(openssl pkcs12 -export -in cert.pem -passout pass:bluemoon -out cert.p12)', 'Bash(openssl'],
  ['sqlcmd -P', 'Bash(sqlcmd -S localhost -U sa -P bluemoon -Q "select 1")', 'Bash(sqlcmd'],
  ['ldapsearch -w', 'Bash(ldapsearch -x -D cn=admin,dc=example,dc=com -w bluemoon -b dc=example,dc=com)', 'Bash(ldapsearch'],
];

for (const [label, rule, start] of cases) {
  test(`${label}: the password is hidden`, () => {
    const out = ruleText(rule);
    assert.ok(out && out.startsWith(start), `precondition: the rule is kept (${out})`);
    assert.ok(!out.includes('bluemoon'), `the password is shown: ${out}`);
  });
}

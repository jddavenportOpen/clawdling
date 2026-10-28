// A permanent regression test: the stand-in adversarial review (1.8, round 3) wrote it as a probe.
// Stand-in review r3, LOW-1: hiding a secret in a rule can also hide the rule's own wildcard, so a rule
// that lets the agent send anywhere is classified as one fixed command.
//
// ruleText() (server/discover.js) runs redactSecrets() first. Its `key = value` pass (KV_RE) takes a bare
// value as any run of characters but whitespace, quotes and brackets, and ':' and '*' are in that run.
// `Bash(curl https://api.example.com/v1/items?api_key=abc123:*)` comes back as
// `Bash(curl https://api.example.com/v1/items?api_key=[redacted])`: the `:*` went with the secret. The
// audit classifies that text, and a curl rule without a wildcard is "what it says" (no chip), while the
// rule as Claude Code holds it allows `curl <that URL> <any other URL> -d @<any file>`: sends and untrusted.
// The same happens for `--password=x:*`, `--token=x:*` and any secret-named key glued to the wildcard
// (CRED_FLAG_RE keeps the tail; KV_RE runs first and leaves nothing for it). Low: it needs an unquoted
// secret directly before the wildcard, though on an agent that already has private (the org folder) and
// untrusted (another agent's notes) it is the difference between red and green.
//
// FAILS on r18 HEAD 7017c92; passes once the redacted text keeps a trailing `:*` / `*` (or a rule that
// lost its wildcard in redaction is said as "unknown: review").
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ruleText } from '../../server/discover.js';
import { parseRule, shellRuleSends } from '../../server/safety.js';

const sendsAfterRedaction = (rule) => {
  const shown = ruleText(rule);
  const p = parseRule(shown);
  return { shown, parsed: !!p, sends: !!(p && shellRuleSends(p.content)) };
};

test('control: the same rule with no secret in it sends', () => {
  const r = sendsAfterRedaction('Bash(curl https://api.example.com/v1/items:*)');
  assert.ok(r.sends, JSON.stringify(r));
});

test('a secret in the query string does not cost the rule its wildcard', () => {
  const r = sendsAfterRedaction('Bash(curl https://api.example.com/v1/items?api_key=abc123:*)');
  assert.ok(!r.shown.includes('abc123'), `precondition: the key is hidden (${r.shown})`);
  assert.ok(r.parsed, `precondition: the rule still parses (${r.shown})`);
  assert.ok(r.sends, `shown as "${r.shown}": the wildcard went with the secret, so the audit sees one fixed curl command`);
});

test('a secret-named flag glued to the wildcard keeps it too', () => {
  const r = sendsAfterRedaction('Bash(wget --http-password=bluemoon7:*)');
  assert.ok(!r.shown.includes('bluemoon7'), `precondition: the password is hidden (${r.shown})`);
  assert.ok(r.sends, `shown as "${r.shown}": no wildcard left, so wget is not classified`);
});

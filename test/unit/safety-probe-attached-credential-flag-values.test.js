// A permanent regression test: the stand-in adversarial review (1.8, round 1) wrote it as a probe.
// Stand-in review r1, LOW-1: a credential written right after its flag, with no space or "=", is not
// redacted. redactFlagValues (discover.js CRED_FLAG_RE) needs `-u value` / `-u=value`; curl also takes
// `-uuser:pass` and mysql's own form is `-pPASSWORD`. Under 20 characters, scrubTokens does not catch
// it either. A classified rule (curl) carries it into a chip: GET /api/setup/safety and the CLI.
//
// Fails on r18 HEAD ca03e6d; passes once an attached value after -u / -p (and the long forms) is redacted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { ruleText } from '../../server/discover.js';
import { runSafetyAudit } from '../../server/safety-run.js';

const temps = [];
after(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text, null, 2));
  return file;
}

test('ruleText hides a password attached to its flag (curl -uuser:pass, mysql -pPASS)', () => {
  for (const [rule, secret] of [
    ['Bash(curl -uadmin:S3cretPw99 https://api.example.com/*)', 'S3cretPw99'],
    ['Bash(mysql -uroot -pS3cretPass99 -e:*)', 'S3cretPass99'],
  ]) {
    const t = ruleText(rule);
    assert.ok(!t.includes(secret), `${rule} is shown as ${t}`);
  }
});

test('the curl rule reaches the audit body (what GET /api/setup/safety and the CLI print) with its password', () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'probe-l1-')));
  temps.push(home);
  const cfg = path.join(home, '.claude');
  write(path.join(cfg, 'settings.json'), { disableClaudeAiConnectors: true, permissions: { allow: ['Bash(curl -uadmin:S3cretPw99 https://api.example.com/*)'] } });
  const audit = runSafetyAudit({ agents: [], home: path.join(home, 'clawdling'), userHome: home, configDir: cfg, claudeJsonPath: path.join(home, '.claude.json'), env: {}, managed: [], channels: {} });
  const body = JSON.stringify(audit);
  assert.ok(body.includes('curl'), 'precondition: the rule is classified and shown');
  assert.ok(!body.includes('S3cretPw99'), 'the password is in the audit body');
});

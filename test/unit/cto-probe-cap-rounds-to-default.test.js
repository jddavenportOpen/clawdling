// Probe: Cto.configure (server/cto.js) accepts any weekly cap above $0 and stores round2(cap). A cap
// under half a cent rounds to 0, and state() reads a cap that is not > 0 as the $2.00 default. So an
// owner who sets a tiny cap (the Settings box takes any decimal) gets a 400-times larger one, and the
// schedule's "skip a week that would go over the cap" check uses $2.00.
//
// Fails on 49723e2 (state().weekly_cap_usd is 2); passes once such a cap is refused, or stored and read
// back as at most what was asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Cto } from '../../server/cto.js';

test('a weekly cap of $0.004 is never read back as $2.00', () => {
  const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'cto-cap-probe-'));
  try {
    const cto = new Cto({ paths: { rt, home: rt }, org: { cto: () => ({ id: 'cto', dir: rt }) }, sessions: {}, reports: {} });
    let refused = false;
    try {
      cto.configure({ weekly_cap_usd: 0.004 }); // passes the "more than 0 and at most 100" check
    } catch {
      refused = true;
    }
    const cap = cto.state().weekly_cap_usd;
    assert.ok(refused || cap <= 0.004, `accepted 0.004, now reads ${cap}`);
  } finally {
    fs.rmSync(rt, { recursive: true, force: true });
  }
});

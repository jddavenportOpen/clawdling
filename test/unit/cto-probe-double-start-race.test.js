// Probe: Cto.startReview (server/cto.js) checks busyReview() once, then awaits sessions.end() for each
// earlier review that finished, then spawns. Two starts that overlap while an earlier review is being
// ended (a double click on "Run this week's review", or that click landing while the scheduled check()
// is mid-start) both pass the check and both spawn: two review sessions for one week, each spending the
// plan, both writing reviews/<week>.md. this.running guards only check(), not a manual start.
//
// Fails on 49723e2 (two spawns); passes once the busy check is repeated after the awaits (or starts are
// serialised), so the second start gets 409.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Cto } from '../../server/cto.js';

test('two overlapping starts make one review session, not two', async () => {
  const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'cto-race-probe-'));
  try {
    const records = new Map([['old-review', { sid: 'old-review', agent: 'cto', kind: 'cto', status: 'ready', review_week: '2026-W43', created_at: '2026-10-20T08:00:00.000Z' }]]);
    const spawned = [];
    const sessions = {
      records,
      view: (r) => ({ ...r }),
      get: (sid) => records.get(sid) || null,
      transcriptFile: () => null,
      // Ending a session takes a moment (tmux kill, then a strict liveness check).
      async end(sid) {
        await new Promise((r) => setTimeout(r, 30));
        records.get(sid).status = 'ended';
      },
      async spawn(o) {
        const sid = `review-${spawned.length + 1}`;
        spawned.push(o);
        records.set(sid, { sid, agent: 'cto', kind: 'cto', status: 'starting', review_week: o.reviewWeek, created_at: new Date().toISOString() });
        return { sid };
      },
    };
    const cto = new Cto({ paths: { rt, home: rt }, org: { cto: () => ({ id: 'cto', dir: rt }) }, sessions, reports: {}, now: () => Date.parse('2026-10-27T10:00:00') });
    const out = await Promise.allSettled([cto.startReview(), cto.startReview({ scheduled: true })]);
    assert.equal(spawned.length, 1, `spawned ${spawned.length} review sessions for one week`);
    assert.equal(out.filter((r) => r.status === 'rejected').length, 1);
  } finally {
    fs.rmSync(rt, { recursive: true, force: true });
  }
});

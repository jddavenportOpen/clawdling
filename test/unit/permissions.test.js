// 1.1.1: every permission choice passes the mode it names, by the name the installed claude uses.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { applyHookEvent } from '../../server/hooks.js';
import { initOrg, normalizeAnswers } from '../../server/org.js';
import { cliPermissionMode, parseModeChoices, permissionSetting } from '../../server/permissions.js';
import { rmrf, tempHome } from '../helpers.mjs';

// `claude --help` on 2.1.283 (and, word for word, 2.1.309): the option before and after included.
const HELP_283 = `  --output-format <format>              Output format (only works with --print):
                                        "text" (default), "json" (single
                                        result), or "stream-json" (realtime
                                        streaming) (choices: "text", "json",
                                        "stream-json")
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  --permission-prompts <target>         Who answers permission prompts with
                                        --print: "host" (the SDK host or
                                        --permission-prompt-tool) or "none"
                                        (choices: "host", "none", default:
                                        "host")`;
// An older Claude Code, whose ask-first mode was called "default".
const HELP_OLD = `  --permission-mode <mode>  Permission mode to use for the session (choices: "acceptEdits", "bypassPermissions", "default", "plan")`;

test('parseModeChoices reads the --permission-mode choices, not the options around it', () => {
  assert.deepEqual(parseModeChoices(HELP_283), ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);
  assert.deepEqual(parseModeChoices(HELP_OLD), ['acceptEdits', 'bypassPermissions', 'default', 'plan']);
  assert.equal(parseModeChoices(''), null);
  assert.equal(parseModeChoices(null), null);
  assert.equal(parseModeChoices('  --permission-mode <mode>   Permission mode'), null, 'no choices listed: unknown');
});

test('"Ask before editing files" is always an explicit mode: manual on 2.1.283+, default before, default when unknown', () => {
  const now = parseModeChoices(HELP_283);
  const old = parseModeChoices(HELP_OLD);
  for (const stored of [null, undefined, '', 'ask', 'manual', 'default']) {
    assert.equal(cliPermissionMode(stored, now), 'manual', `${stored} on 2.1.283`);
    assert.equal(cliPermissionMode(stored, old), 'default', `${stored} on an older claude`);
    assert.equal(cliPermissionMode(stored, null), 'default', `${stored} when the help could not be read`);
  }
  assert.equal(cliPermissionMode('acceptEdits', now), 'acceptEdits');
  assert.equal(cliPermissionMode('plan', old), 'plan');
  assert.equal(cliPermissionMode('inherit', now), null, 'inherit = the owner\'s own Claude Code setting: no flag');
  // Never a mode that skips permission checks, whatever an agent.json says.
  assert.equal(cliPermissionMode('bypassPermissions', now), 'manual');
  assert.equal(cliPermissionMode('auto', now), 'manual');
  assert.equal(permissionSetting('dontAsk'), 'ask');
});

test('answers: permission_mode ask / default / manual all mean ask; inherit is kept; init stores ask as null', () => {
  assert.equal(normalizeAnswers({ owner: 'A' }).permission_mode, 'ask');
  for (const v of ['ask', 'default', 'manual']) assert.equal(normalizeAnswers({ owner: 'A', permission_mode: v }).permission_mode, 'ask', v);
  assert.equal(normalizeAnswers({ owner: 'A', permission_mode: 'acceptEdits' }).permission_mode, 'acceptEdits');
  assert.equal(normalizeAnswers({ owner: 'A', permission_mode: 'inherit' }).permission_mode, 'inherit');
  assert.throws(() => normalizeAnswers({ owner: 'A', permission_mode: 'bypassPermissions' }), /permission_mode/);
  const home = tempHome();
  try {
    initOrg({ home, answers: { owner: 'A', domains: ['Work'], permission_mode: 'default' } });
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'domains', 'work', 'agent.json'), 'utf8')).permission_mode, null);
  } finally {
    rmrf(home);
  }
});

test('answers: donna.channel "later" (any case) is none, as the interview words it', () => {
  for (const v of ['later', 'Later', ' LATER ', 'none', undefined]) {
    assert.equal(normalizeAnswers({ owner: 'A', donna: { channel: v } }).donna.channel, 'none', String(v));
  }
  assert.equal(normalizeAnswers({ owner: 'A', donna: { channel: 'Telegram' } }).donna.channel, 'telegram');
  assert.throws(() => normalizeAnswers({ owner: 'A', donna: { channel: 'carrier-pigeon' } }), /later/);
  const home = tempHome();
  try {
    const res = initOrg({ home, answers: { owner: 'A', donna: { channel: 'later' } } });
    assert.equal(res.channel, 'none');
  } finally {
    rmrf(home);
  }
});

test('hooks: the mode Claude Code reports is kept as live_mode (it can change with Shift+Tab)', () => {
  const rec = { status: 'starting', sid: '11111111-1111-4111-8111-111111111111' };
  applyHookEvent(rec, 'SessionStart', { permission_mode: 'manual' });
  assert.equal(rec.live_mode, 'manual');
  applyHookEvent(rec, 'UserPromptSubmit', { permission_mode: 'acceptEdits', prompt: 'hi' });
  assert.equal(rec.live_mode, 'acceptEdits');
  applyHookEvent(rec, 'Stop', { permission_mode: 'not a mode; rm -rf' });
  assert.equal(rec.live_mode, 'acceptEdits', 'junk is ignored');
});

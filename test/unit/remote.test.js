// Use from anywhere (1.3): address rules, remote.json integrity, devices, pairing codes, the
// throttle, the Tailscale and Cloudflare checks, and Cloudflare Access token checks.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { deviceCookieHeader, originAllowed } from '../../server/auth.js';
import {
  AccessVerifier, DeviceStore, PAIRING_TTL_MS, Pairings, RemoteStore, Throttle, answerable, checkCloudflare, checkTailscale, deviceLabel,
  funnelOn, funnelState, hostKeys, loopbackPeer, parseRemoteUrl, remoteOriginAllowed, statusText, tailscaleBin, validateState,
} from '../../server/remote.js';
import { rmrf, tempHome } from '../helpers.mjs';
import { fakeAccess } from '../fixtures/fake-access.mjs';

test('remote addresses: https only, a DNS name, no path; the port is part of the address', () => {
  assert.deepEqual(parseRemoteUrl('https://Box.Example.ts.net', 'tailscale'), { url: 'https://box.example.ts.net', host: 'box.example.ts.net', port: 443, hostport: 'box.example.ts.net' });
  assert.equal(parseRemoteUrl('https://box.example.ts.net:443/', 'tailscale').url, 'https://box.example.ts.net');
  assert.equal(parseRemoteUrl('https://box.example.ts.net:8743', 'tailscale').hostport, 'box.example.ts.net:8743');
  assert.equal(parseRemoteUrl('https://cockpit.example.com', 'cloudflare').url, 'https://cockpit.example.com');
  for (const [bad, re] of [
    ['http://box.example.ts.net', /https:\/\//],
    ['ws://box.example.ts.net', /https:\/\//],
    ['https://user:pw@box.example.ts.net', /user name/],
    ['https://box.example.ts.net/cockpit', /no path/],
    ['https://box.example.ts.net/?x=1', /no path/],
    ['https://box.example.ts.net/#a', /no path/],
    ['https://100.64.0.1', /not an IP/],
    ['https://[fd7a::1]', /not an IP/],
    ['https://localhost', /not an IP address or a bare word/],
    ['not a url', /not a web address/],
  ]) assert.throws(() => parseRemoteUrl(bad, 'tailscale'), re, bad);
  assert.throws(() => parseRemoteUrl('https://cockpit.example.com', 'tailscale'), /ends in \.ts\.net/);
  assert.throws(() => parseRemoteUrl('https://box.example.ts.net', 'cloudflare'), /use --kind tailscale/);
  assert.throws(() => parseRemoteUrl('https://box.example.ts.net', 'ngrok'), /--kind/);
});

test('Host matching is exact: the port must match, and :443 is the same as no port', () => {
  const a = parseRemoteUrl('https://box.example.ts.net', 'tailscale');
  assert.deepEqual(hostKeys(a), ['box.example.ts.net', 'box.example.ts.net:443']);
  const b = parseRemoteUrl('https://box.example.ts.net:8743', 'tailscale');
  assert.deepEqual(hostKeys(b), ['box.example.ts.net:8743']);
  const req = (headers) => ({ headers });
  assert.equal(remoteOriginAllowed(req({}), b), true, 'no Origin (the app, curl)');
  assert.equal(remoteOriginAllowed(req({ origin: 'https://box.example.ts.net:8743' }), b), true);
  assert.equal(remoteOriginAllowed(req({ origin: 'http://box.example.ts.net:8743' }), b), false, 'an http origin is refused');
  assert.equal(remoteOriginAllowed(req({ origin: 'https://box.example.ts.net' }), b), false, 'another port is another origin');
  assert.equal(remoteOriginAllowed(req({ origin: 'https://evil.example' }), b), false);
  assert.equal(remoteOriginAllowed(req({ origin: 'null' }), b), false);
  assert.equal(remoteOriginAllowed(req({ origin: 'https://box.example.ts.net' }), a), true);
  assert.equal(originAllowed(req({ host: 'x.example:1', origin: 'http://x.example:1' }), { secure: true }), false);
});

test('which addresses are answered: never a public, unchecked or unprotected one', () => {
  const ts = (status, login = 'owner@example.com') => ({ kind: 'tailscale', status, login });
  const cf = (status, access = { team_domain: 'https://team.cloudflareaccess.com', aud: 'a'.repeat(64) }) => ({ kind: 'cloudflare', status, access });
  for (const s of ['private', 'unreachable']) assert.equal(answerable(ts(s)), true, s);
  for (const s of ['public', 'pending', 'unconfirmed']) assert.equal(answerable(ts(s)), false, s);
  assert.equal(answerable(ts('private', null)), false, 'no owner login to check requests against');
  assert.equal(answerable(cf('access')), true);
  assert.equal(answerable(cf('access', null)), false, 'Access with no team and AUD to check tokens against');
  for (const s of ['unprotected', 'unverified', 'unreachable', 'pending']) assert.equal(answerable(cf(s)), false, s);
  assert.equal(statusText(ts('private')), 'Private to your devices ✓');
  assert.equal(statusText(cf('access')), 'Behind Cloudflare Access ✓');
  assert.equal(statusText(ts('unreachable')), 'Not reachable');
});

test('remote.json: default off, strict on every field, and a bad file turns everything off', () => {
  assert.deepEqual(validateState(null), { enabled: false, hosts: [], invalid: null });
  const good = { version: 1, enabled: true, hosts: [{ url: 'https://box.example.ts.net:8743', kind: 'tailscale', status: 'private', added_at: '2026-10-25T10:00:00.000Z', checked_at: null, detail: null }] };
  const v = validateState(good);
  assert.equal(v.enabled, true);
  assert.equal(v.hosts[0].port, 8743);
  const bad = (patch, hostPatch) => validateState({ ...good, ...patch, hosts: hostPatch ? [{ ...good.hosts[0], ...hostPatch }] : good.hosts });
  for (const [why, st] of [
    ['version', bad({ version: 2 })],
    ['enabled', bad({ enabled: 'yes' })],
    ['http url', bad({}, { url: 'http://box.example.ts.net:8743' })],
    ['path', bad({}, { url: 'https://box.example.ts.net:8743/x' })],
    ['not normal', bad({}, { url: 'https://BOX.example.ts.net:8743' })],
    ['kind', bad({}, { kind: 'ngrok' })],
    ['status', bad({}, { status: 'fine' })],
    ['date', bad({}, { added_at: 'yesterday' })],
    ['access on tailscale', bad({}, { access: { team_domain: 'https://t.cloudflareaccess.com', aud: 'a'.repeat(64) } })],
    ['twice', validateState({ ...good, hosts: [good.hosts[0], good.hosts[0]] })],
    ['garbage', validateState('unreadable')],
    ['array', validateState([])],
  ]) {
    assert.equal(st.enabled, false, why);
    assert.deepEqual(st.hosts, [], why);
    assert.match(st.invalid, /remote\.json is not valid/, why);
  }
  const cfBad = validateState({ version: 1, enabled: true, hosts: [{ url: 'https://c.example.com', kind: 'cloudflare', status: 'access', access: { team_domain: 'https://evil.example.com', aud: 'a'.repeat(64) } }] });
  assert.match(cfBad.invalid, /bad Access settings/);
  assert.equal(validateState({ version: 1, enabled: true, hosts: [] }).enabled, false, 'on with no address is off');
});

test('RemoteStore re-reads on change, writes 0600, and matches Host headers', () => {
  const home = tempHome();
  try {
    const file = path.join(home, 'remote.json');
    const store = new RemoteStore(file);
    assert.equal(store.read().enabled, false);
    store.update((s) => {
      s.enabled = true;
      s.hosts.push({ url: 'https://box.example.ts.net:8743', kind: 'tailscale', status: 'private', added_at: new Date().toISOString(), checked_at: null, detail: null, access: null });
    });
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(store.match('box.example.ts.net:8743').url, 'https://box.example.ts.net:8743');
    assert.equal(store.match('BOX.example.ts.net:8743').url, 'https://box.example.ts.net:8743');
    assert.equal(store.match('box.example.ts.net'), null, 'port mismatch');
    assert.equal(store.match('box.example.ts.net:87430'), null);
    assert.equal(store.match(''), null);
    fs.writeFileSync(file, '{"version":1,"enabled":true,"hosts":[{"url":"https://evil.example.com","kind":"cloudflare","status":"access"}]}');
    const fresh = new RemoteStore(file);
    assert.equal(fresh.read().enabled, false, 'a Cloudflare address with no Access settings is refused');
    assert.match(fresh.read().invalid, /not valid/);
  } finally {
    rmrf(home);
  }
});

test('devices: a token works until revoked or expired; the file holds only a hash', () => {
  const home = tempHome();
  try {
    let now = Date.parse('2026-10-25T10:00:00Z');
    const file = path.join(home, 'remote-devices.json');
    const store = new DeviceStore(file, { now: () => now });
    const { token, device } = store.add({ label: 'iPhone · Safari', host: 'https://box.example.ts.net' });
    assert.match(token, /^cld_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    const disk = fs.readFileSync(file, 'utf8');
    assert.ok(!disk.includes(token.split('_')[2]), 'the secret is never written');
    assert.equal(store.verify(token).id, device.id);
    assert.equal(new DeviceStore(file, { now: () => now }).verify(token).id, device.id, 'survives a restart');
    const secretAt = token.lastIndexOf('_') + 1; // change the first secret character (the last one holds padding bits)
    assert.equal(store.verify(token.slice(0, secretAt) + (token[secretAt] === 'A' ? 'B' : 'A') + token.slice(secretAt + 1)), null);
    assert.equal(store.verify('cld_000000000000_' + 'A'.repeat(43)), null);
    assert.equal(store.verify(''), null);
    assert.equal(store.verify('a'.repeat(64)), null, 'the long-lived token is not a device token');
    now += 31 * 24 * 3600 * 1000;
    assert.equal(store.verify(token), null, 'expired after 30 days');
    now -= 31 * 24 * 3600 * 1000;
    assert.equal(store.revoke(device.id), true);
    assert.equal(store.verify(token), null);
    const b = store.add({ label: 'Mac', host: 'x' });
    assert.equal(store.revokeAll(), 1);
    assert.equal(store.verify(b.token), null);
    // Two processes, one file: a device signed out by one is signed out for the other, and a
    // later "last used" write by the other never brings it back.
    const c = store.add({ label: 'Phone', host: 'x' });
    const other = new DeviceStore(file, { now: () => now });
    const seen = other.verify(c.token);
    assert.equal(seen.id, c.device.id);
    assert.equal(store.revoke(c.device.id), true);
    now += 120000;
    other.touch(seen);
    assert.equal(other.verify(c.token), null);
    assert.equal(new DeviceStore(file, { now: () => now }).verify(c.token), null);
  } finally {
    rmrf(home);
  }
});

test('remote names are answered only from this computer (the tunnel), never from the Wi-Fi', () => {
  for (const a of ['127.0.0.1', '127.0.0.53', '::1', '::ffff:127.0.0.1']) assert.equal(loopbackPeer(a), true, a);
  for (const a of ['192.168.1.20', '100.64.0.9', '::ffff:192.168.1.20', 'fe80::1', '', undefined]) assert.equal(loopbackPeer(a), false, String(a));
});

test('pairing codes: single use, short expiry, at most a few outstanding', () => {
  let now = 0;
  const p = new Pairings({ now: () => now });
  const a = p.create();
  assert.match(a.code, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(Date.parse(a.expires_at), PAIRING_TTL_MS);
  assert.equal(p.consume(a.code), true);
  assert.equal(p.consume(a.code), false, 'used once');
  const b = p.create();
  now = PAIRING_TTL_MS + 1;
  assert.equal(p.consume(b.code), false, 'expired');
  now = 0;
  const codes = Array.from({ length: 7 }, () => p.create().code);
  assert.equal(p.consume(codes[0]), false, 'oldest dropped');
  assert.equal(p.consume(codes[6]), true);
  assert.equal(p.consume('../../etc'), false);
  assert.equal(p.consume(undefined), false);
  const c = p.create();
  p.clear();
  assert.equal(p.consume(c.code), false, 'turning off voids every link');
});

test('throttle: after 10 failures in 5 minutes an address refuses new attempts, then recovers', () => {
  let now = 0;
  const t = new Throttle({ now: () => now });
  for (let i = 0; i < 9; i++) t.fail('a');
  assert.equal(t.blocked('a'), false);
  t.fail('a');
  assert.equal(t.blocked('a'), true);
  assert.equal(t.blocked('b'), false, 'per address');
  assert.ok(t.retryAfter('a') > 0 && t.retryAfter('a') <= 300);
  now = 5 * 60 * 1000 + 1;
  assert.equal(t.blocked('a'), false);
});

test('cookies: the device cookie is Secure, HttpOnly, SameSite=Strict', () => {
  const c = deviceCookieHeader('cld_x');
  assert.match(c, /^cl_device=cld_x;/);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000']) assert.ok(c.includes(flag), flag);
  assert.match(deviceCookieHeader('', 0), /Max-Age=0/);
});

test('device labels come from the User-Agent', () => {
  assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'iPhone · Safari');
  assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1'), 'iPhone · Chrome');
  assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'), 'Android · Chrome');
  assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0'), 'Windows · Edge');
  assert.equal(deviceLabel(''), 'A device');
});

test('the Tailscale command: the macOS app binary, never the crashing Homebrew symlink', () => {
  assert.equal(tailscaleBin({ env: {}, platform: 'darwin', exists: () => true, which: () => '/opt/homebrew/bin/tailscale' }), '/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  assert.equal(tailscaleBin({ env: {}, platform: 'linux', exists: () => true, which: () => '/usr/bin/tailscale' }), '/usr/bin/tailscale');
  assert.equal(tailscaleBin({ env: {}, platform: 'darwin', exists: () => false, which: () => null }), null);
  assert.equal(tailscaleBin({ env: { CLAWDLING_TAILSCALE_BIN: '/x/ts' }, platform: 'darwin' }), '/x/ts');
});

test('Funnel detection reads serve status, foreground configs included', async () => {
  const cfg = { TCP: { 8743: { HTTPS: true } }, Web: { 'box.example.ts.net:8743': { Handlers: { '/': { Proxy: 'http://127.0.0.1:5000' } } } } };
  assert.equal(funnelOn(cfg, 'box.example.ts.net:8743'), false);
  assert.equal(funnelOn({ ...cfg, AllowFunnel: { 'box.example.ts.net:8743': true } }, 'box.example.ts.net:8743'), true);
  assert.equal(funnelOn({ ...cfg, AllowFunnel: { 'box.example.ts.net:443': true } }, 'box.example.ts.net:8743'), false, 'another port');
  assert.equal(funnelOn({ Foreground: { abc: { AllowFunnel: { 'box.example.ts.net:443': true } } } }, 'box.example.ts.net:443'), true);
  const entry = parseRemoteUrl('https://box.example.ts.net:8743', 'tailscale');
  const run = async (bin, args) => {
    assert.deepEqual(args, ['serve', 'status', '--json'], 'only ever serve status');
    return { stdout: JSON.stringify({ AllowFunnel: { 'box.example.ts.net:8743': true } }) };
  };
  assert.deepEqual(await funnelState(entry, { bin: 'ts', run }), { known: true, funnel: true });
  assert.deepEqual(await funnelState(entry, { bin: 'ts', run: async () => ({ stdout: '' }) }), { known: true, funnel: false }, 'no serve config');
  assert.equal((await funnelState(entry, { bin: null })).known, false);
  assert.equal((await funnelState(entry, { bin: 'ts', run: async () => { throw new Error('boom'); } })).known, false);
});

test('Tailscale check: public is refused; it must reach THIS Clawdling', async () => {
  const entry = parseRemoteUrl('https://box.example.ts.net:8743', 'tailscale');
  const off = async () => ({ stdout: '{}' });
  const on = async () => ({ stdout: JSON.stringify({ AllowFunnel: { 'box.example.ts.net:8743': true } }) });
  const hello = (nonce, login = 'owner@example.com') => async () => ({ status: 200, headers: {}, body: JSON.stringify({ clawdling: true, nonce, ...(login ? { login } : {}) }) });
  assert.equal((await checkTailscale(entry, { nonce: 'n1', bin: 'ts', run: on, probeImpl: hello('n1') })).status, 'public');
  const ok = await checkTailscale(entry, { nonce: 'n1', bin: 'ts', run: off, probeImpl: hello('n1') });
  assert.equal(ok.status, 'private');
  assert.equal(ok.login, 'owner@example.com');
  assert.equal((await checkTailscale(entry, { nonce: 'n1', bin: 'ts', run: off, probeImpl: hello('other') })).status, 'unreachable', 'another Clawdling answered');
  const unknown = await checkTailscale(entry, { nonce: 'n1', bin: null, probeImpl: hello('n1') });
  assert.equal(unknown.status, 'unconfirmed', 'Funnel not confirmed off: fails closed');
  assert.equal(answerable({ ...entry, ...unknown }), false);
  assert.equal((await checkTailscale(entry, { nonce: 'n1', bin: 'ts', run: off, probeImpl: hello('n1', null) })).status, 'unconfirmed', 'no Tailscale login (a tagged device)');
  assert.equal((await checkTailscale({ ...entry, login: 'a@example.com' }, { nonce: 'n1', bin: 'ts', run: off, probeImpl: hello('n1', 'b@example.com') })).status, 'unconfirmed', 'signed in as someone else now');
  const down = async () => { throw new Error('connect ECONNREFUSED'); };
  const r = await checkTailscale(entry, { nonce: 'n1', bin: 'ts', run: off, probeImpl: down });
  assert.equal(r.status, 'unreachable');
  assert.match(r.detail, /ECONNREFUSED/);
});

test('Cloudflare check: only a redirect to Cloudflare Access passes; a page that answers is refused', async () => {
  const entry = parseRemoteUrl('https://cockpit.example.com', 'cloudflare');
  const aud = 'f'.repeat(64);
  const answer = (status, headers = {}) => async () => ({ status, headers, body: '' });
  const ok = await checkCloudflare(entry, { probeImpl: answer(302, { location: `https://team.cloudflareaccess.com/cdn-cgi/access/login/cockpit.example.com?kid=${aud}&redirect_url=%2F` }) });
  assert.equal(ok.status, 'access');
  assert.deepEqual(ok.access, { team_domain: 'https://team.cloudflareaccess.com', aud });
  assert.equal((await checkCloudflare(entry, { probeImpl: answer(200) })).status, 'unprotected', 'a plain 200');
  assert.equal((await checkCloudflare(entry, { probeImpl: answer(403, { 'x-clawdling-refused': '1' }) })).status, 'unprotected', 'reached Clawdling itself');
  assert.equal((await checkCloudflare(entry, { probeImpl: answer(302, { location: 'https://evil.example/cdn-cgi/access/login?kid=' + aud }) })).status, 'unverified', 'a redirect somewhere else');
  assert.equal((await checkCloudflare(entry, { probeImpl: answer(302, { location: 'http://team.cloudflareaccess.com/x?kid=' + aud }) })).status, 'unverified', 'http');
  assert.equal((await checkCloudflare(entry, { probeImpl: answer(302, { location: 'https://team.cloudflareaccess.com.evil.example/x?kid=' + aud }) })).status, 'unverified');
  assert.equal((await checkCloudflare(entry, { probeImpl: answer(302, { location: 'https://team.cloudflareaccess.com/x' }) })).status, 'unverified', 'no AUD tag');
  assert.equal((await checkCloudflare({ ...entry, access: { team_domain: 'https://team.cloudflareaccess.com', aud } }, { probeImpl: answer(403, { 'cf-ray': 'x' }) })).status, 'access', 'blocked by Access, settings given');
  assert.equal((await checkCloudflare(entry, { probeImpl: answer(403, { 'cf-ray': 'x' }) })).status, 'unverified', 'blocked, but whose block?');
  assert.equal((await checkCloudflare(entry, { probeImpl: async () => { throw new Error('ENOTFOUND'); } })).status, 'unreachable');
});

test('Cloudflare Access tokens: signature, AUD, issuer and expiry are all checked; fails closed', async () => {
  const fa = fakeAccess();
  let fetches = 0;
  const fetchImpl = async (u) => {
    fetches++;
    assert.equal(u, `${fa.team}/cdn-cgi/access/certs`);
    return new Response(JSON.stringify(fa.certs), { status: 200 });
  };
  const v = new AccessVerifier({ fetchImpl });
  const cfg = { team_domain: fa.team, aud: fa.aud };
  assert.deepEqual(await v.verify(fa.sign({}), cfg), { ok: true, email: 'owner@example.com' });
  await v.verify(fa.sign({}), cfg);
  assert.equal(fetches, 1, 'keys are cached');
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  for (const [why, jwt] of [
    ['missing', undefined],
    ['garbage', 'a.b.c'],
    ['wrong key', fa.sign({}, { key: other })],
    ['unknown kid', fa.sign({}, { kid: 'k2' })],
    ['other app', fa.sign({ aud: ['0'.repeat(64)] })],
    ['other team', fa.sign({ iss: 'https://evil.cloudflareaccess.com' })],
    ['expired', fa.sign({ exp: Math.floor(Date.now() / 1000) - 3600 })],
    ['not yet', fa.sign({ nbf: Math.floor(Date.now() / 1000) + 3600 })],
    ['alg none', fa.sign({}, { alg: 'none' })],
    ['HS256', fa.sign({}, { alg: 'HS256' })],
  ]) assert.equal((await v.verify(jwt, cfg)).ok, false, why);
  const down = new AccessVerifier({ fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal((await down.verify(fa.sign({}), cfg)).ok, false, 'no keys: refused');
  const err = new AccessVerifier({ fetchImpl: async () => new Response('nope', { status: 500 }) });
  assert.equal((await err.verify(fa.sign({}), cfg)).ok, false);
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPairingLink, isLoopbackHost, makeTarget, networkKind, parsePairingLink, parseQuery, parseServerUrl } from '../../src/links';

const TOKEN = 'a3f9c2d17b8e4f60a3f9c2d17b8e4f60a3f9c2d17b8e4f60a3f9c2d17b8e4f60';

function ok(input: string) {
  const r = parsePairingLink(input);
  if (!r.ok) throw new Error(`expected ok for ${input}, got ${r.code}`);
  return r.target;
}

function code(input: string) {
  const r = parsePairingLink(input);
  assert.equal(r.ok, false, `expected failure for ${input}`);
  return r.ok ? null : r.code;
}

describe('parsePairingLink: clawdling:// links', () => {
  it('accepts the canonical link with an encoded url', () => {
    const t = ok(`clawdling://connect?url=${encodeURIComponent('http://192.168.1.20:4747')}&t=${TOKEN}`);
    assert.equal(t.url, 'http://192.168.1.20:4747');
    assert.equal(t.token, TOKEN);
    assert.equal(t.host, '192.168.1.20');
    assert.equal(t.port, 4747);
    assert.equal(t.hostPort, '192.168.1.20:4747');
    assert.equal(t.network, 'lan');
    assert.equal(t.atsBlocked, false);
  });

  it('accepts an unencoded url and strips a trailing slash', () => {
    const t = ok(`clawdling://connect?url=http://192.168.1.20:4747/&t=${TOKEN}`);
    assert.equal(t.url, 'http://192.168.1.20:4747');
  });

  it('round-trips buildPairingLink', () => {
    const link = buildPairingLink('https://mac.example.ts.net/clawdling', TOKEN);
    const t = ok(link);
    assert.equal(t.url, 'https://mac.example.ts.net/clawdling');
    assert.equal(t.scheme, 'https');
    assert.equal(t.network, 'tailscale');
  });

  it('is case-insensitive about the scheme and tolerates surrounding text', () => {
    const t = ok(`Here is the link: CLAWDLING://connect?url=http%3A%2F%2F10.0.0.5%3A4747&t=${TOKEN}.`);
    assert.equal(t.url, 'http://10.0.0.5:4747');
  });

  it('rejects a clawdling link that is not a connect link', () => {
    assert.equal(code(`clawdling://open?url=http://10.0.0.5:4747&t=${TOKEN}`), 'not_a_link');
  });

  it('rejects a missing url or token', () => {
    assert.equal(code(`clawdling://connect?t=${TOKEN}`), 'missing_url');
    assert.equal(code('clawdling://connect?url=http://10.0.0.5:4747'), 'missing_token');
    assert.equal(code('clawdling://connect?url=http://10.0.0.5:4747&t='), 'missing_token');
  });

  it('rejects javascript:, data: and file: server urls', () => {
    assert.equal(code(`clawdling://connect?url=${encodeURIComponent('javascript:alert(1)')}&t=${TOKEN}`), 'unsafe_url');
    assert.equal(code(`clawdling://connect?url=${encodeURIComponent('data:text/html,hi')}&t=${TOKEN}`), 'unsafe_url');
    assert.equal(code(`clawdling://connect?url=${encodeURIComponent('file:///etc/passwd')}&t=${TOKEN}`), 'unsafe_url');
    assert.equal(code(`clawdling://connect?url=${encodeURIComponent('ftp://10.0.0.5')}&t=${TOKEN}`), 'unsafe_url');
  });

  it('rejects server urls with credentials, a query, a fragment or a bad port', () => {
    assert.equal(code(`clawdling://connect?url=${encodeURIComponent('http://user:pw@10.0.0.5:4747')}&t=${TOKEN}`), 'bad_url');
    assert.equal(code(`clawdling://connect?url=${encodeURIComponent('http://10.0.0.5:4747/?x=1')}&t=${TOKEN}`), 'bad_url');
    assert.equal(code(`clawdling://connect?url=${encodeURIComponent('http://10.0.0.5:4747/#a')}&t=${TOKEN}`), 'bad_url');
    assert.equal(code(`clawdling://connect?url=${encodeURIComponent('http://10.0.0.5:99999')}&t=${TOKEN}`), 'bad_url');
    assert.equal(code(`clawdling://connect?url=${encodeURIComponent('http://10.0.0.5:0')}&t=${TOKEN}`), 'bad_url');
    assert.equal(code(`clawdling://connect?url=${encodeURIComponent('http:/10.0.0.5')}&t=${TOKEN}`), 'bad_url');
    assert.equal(code(`clawdling://connect?url=${encodeURIComponent('http://bad host:4747')}&t=${TOKEN}`), 'bad_url');
    assert.equal(code(`clawdling://connect?url=${encodeURIComponent('http://10.0.0.5:4747/../x')}&t=${TOKEN}`), 'bad_url');
    assert.equal(code(`clawdling://connect?url=${encodeURIComponent('http://999.1.1.1:4747')}&t=${TOKEN}`), 'bad_url');
  });

  it('rejects tokens with characters a header cannot carry', () => {
    assert.equal(code(`clawdling://connect?url=http://10.0.0.5:4747&t=${encodeURIComponent('abc def ghij')}`), 'bad_token');
    assert.equal(code(`clawdling://connect?url=http://10.0.0.5:4747&t=${encodeURIComponent('abcdefgh\r\nX-Evil: 1')}`), 'bad_token');
    assert.equal(code('clawdling://connect?url=http://10.0.0.5:4747&t=short'), 'bad_token');
  });
});

describe('parsePairingLink: cockpit links', () => {
  it('accepts http(s)://host:port/?t=token', () => {
    const t = ok(`http://192.168.1.20:4747/?t=${TOKEN}`);
    assert.equal(t.url, 'http://192.168.1.20:4747');
    assert.equal(t.token, TOKEN);
  });

  it('ignores a fragment copied from the address bar', () => {
    const t = ok(`http://192.168.1.20:4747/?t=${TOKEN}#/settings`);
    assert.equal(t.url, 'http://192.168.1.20:4747');
  });

  it('keeps a path prefix', () => {
    assert.equal(ok(`https://box.example.com/clawdling/?t=${TOKEN}`).url, 'https://box.example.com/clawdling');
  });

  it('needs the token', () => {
    assert.equal(code('http://192.168.1.20:4747/'), 'missing_token');
  });
});

describe('parsePairingLink: everything else', () => {
  it('rejects empty input and plain words', () => {
    assert.equal(code(''), 'empty');
    assert.equal(code('   '), 'empty');
    assert.equal(code('hello there'), 'not_a_link');
    assert.equal(code('192.168.1.20:4747'), 'not_a_link');
  });

  it('rejects javascript:, data: and other schemes outright', () => {
    assert.equal(code('javascript:alert(document.cookie)'), 'bad_scheme');
    assert.equal(code('data:text/html;base64,PHNjcmlwdD4='), 'bad_scheme');
    assert.equal(code('file:///Users/x'), 'bad_scheme');
    assert.equal(code('mailto:a@b.c'), 'bad_scheme');
  });

  it('has a human message for every failure', () => {
    const r = parsePairingLink('javascript:alert(1)');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.message, /clawdling:\/\//);
  });
});

describe('server addresses', () => {
  it('classifies networks', () => {
    assert.equal(networkKind('127.0.0.1'), 'loopback');
    assert.equal(networkKind('localhost'), 'loopback');
    assert.equal(networkKind('[::1]'), 'loopback');
    assert.equal(networkKind('192.168.0.9'), 'lan');
    assert.equal(networkKind('10.1.2.3'), 'lan');
    assert.equal(networkKind('172.20.1.1'), 'lan');
    assert.equal(networkKind('172.40.1.1'), 'public');
    assert.equal(networkKind('100.101.102.103'), 'tailscale');
    assert.equal(networkKind('mac.tail1234.ts.net'), 'tailscale');
    assert.equal(networkKind('studio.local'), 'lan');
    assert.equal(networkKind('studio'), 'lan');
    assert.equal(networkKind('example.com'), 'public');
    assert.equal(isLoopbackHost('127.8.9.1'), true);
  });

  it('flags plain http to internet names (iOS ATS would block them)', () => {
    const blocked = (u: string) => {
      const r = parseServerUrl(u);
      assert.ok(r.ok);
      return r.ok && r.address.atsBlocked;
    };
    assert.equal(blocked('http://mac.tail1234.ts.net:4747'), true);
    assert.equal(blocked('http://example.com'), true);
    assert.equal(blocked('https://example.com'), false);
    assert.equal(blocked('http://192.168.1.20:4747'), false);
    assert.equal(blocked('http://100.64.1.2:4747'), false);
    assert.equal(blocked('http://studio.local:4747'), false);
    assert.equal(blocked('http://studio:4747'), false);
    assert.equal(blocked('http://[fd7a:115c:a1e0::1]:4747'), false);
  });

  it('parses IPv6 literals', () => {
    const r = parseServerUrl('http://[fd7a:115c:a1e0::1]:4747');
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.address.host, '[fd7a:115c:a1e0::1]');
      assert.equal(r.address.port, 4747);
      assert.equal(r.address.network, 'tailscale');
    }
  });

  it('makeTarget validates deep-link params', () => {
    assert.equal(makeTarget(undefined, TOKEN).ok, false);
    assert.equal(makeTarget('http://10.0.0.5:4747', undefined).ok, false);
    const r = makeTarget('http://10.0.0.5:4747', TOKEN);
    assert.ok(r.ok);
  });

  it('parseQuery decodes values and keeps the first of a repeated key', () => {
    assert.deepEqual(parseQuery('?a=1&b=two+words&a=2&c=%E2%9C%93'), { a: '1', b: 'two words', c: '✓' });
    assert.deepEqual(parseQuery('bad=%E0%A4%A'), { bad: '%E0%A4%A' });
  });
});

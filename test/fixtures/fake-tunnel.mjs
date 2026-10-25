#!/usr/bin/env node
// A stand-in for Tailscale Serve and the Cloudflare edge in the Use from anywhere tests, in its
// own process (the tests call the CLI synchronously, which would freeze an in-process server).
// Prints its port on the first line of stdout. Each request reads FAKE_TUNNEL_DIR/mode:
//   forward   pass the request to Clawdling (port in FAKE_TUNNEL_DIR/target) keeping the Host
//             header and adding proxy headers, the way `tailscale serve` and cloudflared do;
//             like Tailscale Serve, it drops any Tailscale-* header the client sent and sets
//             Tailscale-User-Login to FAKE_TUNNEL_DIR/login (none if that file is empty)
//   access    a Cloudflare Access redirect to <team>.cloudflareaccess.com with the AUD as kid
//   plain200  a page that answers without any sign-in
//   down      drop the connection
// GET /certs serves the fake Access team's keys from FAKE_TUNNEL_DIR/certs.json.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const dir = process.env.FAKE_TUNNEL_DIR;
const read = (f, d = '') => {
  try {
    return fs.readFileSync(path.join(dir, f), 'utf8').trim();
  } catch {
    return d;
  }
};

const server = http.createServer((req, res) => {
  if (req.url === '/certs') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(read('certs.json', '{"keys":[]}'));
  }
  const mode = read('mode', 'forward');
  if (mode === 'down') return req.socket.destroy();
  if (mode === 'plain200') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<h1>hello</h1>');
  }
  if (mode === 'access') {
    const host = String(req.headers.host || '').split(':')[0];
    res.writeHead(302, { location: `https://team.cloudflareaccess.com/cdn-cgi/access/login/${host}?kid=${read('aud')}&redirect_url=%2F` });
    return res.end();
  }
  const headers = { ...req.headers, 'x-forwarded-for': '100.64.0.9', 'x-forwarded-proto': 'https' };
  for (const k of Object.keys(headers)) if (k.startsWith('tailscale-')) delete headers[k];
  const login = read('login', 'owner@example.com');
  if (login) headers['tailscale-user-login'] = login;
  const up = http.request({ host: '127.0.0.1', port: Number(read('target')), path: req.url, method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', () => res.destroy());
  req.pipe(up);
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`${server.address().port}\n`));
process.on('SIGTERM', () => process.exit(0));

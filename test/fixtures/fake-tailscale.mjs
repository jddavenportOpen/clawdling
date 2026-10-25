#!/usr/bin/env node
// A stand-in for the Tailscale CLI in the Use from anywhere tests, keeping its serve config in a
// JSON file the way tailscaled does. It answers the calls Clawdling makes:
//   status --json                       this node and its peers (`clawdling remote tailscale-name`)
//   serve status --json                 the config (the server's checks)
//   serve status                        the config as text (`clawdling remote serve-status`)
//   serve --bg --https=N <target>       add an entry (`clawdling remote serve`)
//   serve --https=N off                 remove one
// Anything else fails loudly (exit 2), so a test catches it.
//   FAKE_TS_SERVE  the JSON file ({} or missing: no serve config)
//   FAKE_TS_HOST   this node's name (default box.example.ts.net)
//   FAKE_TS_LOG    one JSON line per call: the argv
import fs from 'node:fs';

const args = process.argv.slice(2);
const file = process.env.FAKE_TS_SERVE || '';
const host = process.env.FAKE_TS_HOST || 'box.example.ts.net';
if (process.env.FAKE_TS_LOG) fs.appendFileSync(process.env.FAKE_TS_LOG, JSON.stringify({ args }) + '\n');
const read = () => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
  } catch {
    return {};
  }
};
const line = args.join(' ');
let m;
if (line === 'status --json') {
  // Like the real one: this node, and the other people's devices on the tailnet.
  process.stdout.write(JSON.stringify({ BackendState: process.env.FAKE_TS_STATE || 'Running', AuthURL: process.env.FAKE_TS_STATE === 'NeedsLogin' ? 'https://login.tailscale.com/a/secret-sign-in' : '', Self: { DNSName: `${host}.`, UserID: 1 }, Peer: { a: { DNSName: 'someone-elses-laptop.example.ts.net.', UserID: 2 } }, User: { 1: { LoginName: 'owner@example.com' }, 2: { LoginName: 'someone@example.org' } } }));
} else if (line === 'serve status --json') {
  let text = '{}';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // no serve config
  }
  process.stdout.write(text);
} else if (line === 'serve status') {
  const web = read().Web || {};
  const keys = Object.keys(web);
  if (!keys.length) process.stdout.write('No serve config\n');
  for (const k of keys) {
    process.stdout.write(`https://${k.endsWith(':443') ? k.slice(0, -4) : k} (tailnet only)\n`);
    for (const [mount, h] of Object.entries(web[k].Handlers || {})) process.stdout.write(`|-- ${mount} proxy ${h.Proxy}\n\n`);
  }
} else if ((m = /^serve --bg --https=(\d+) (http:\/\/\S+)$/.exec(line))) {
  const cfg = read();
  cfg.TCP = { ...(cfg.TCP || {}), [m[1]]: { HTTPS: true } };
  cfg.Web = { ...(cfg.Web || {}), [`${host}:${m[1]}`]: { Handlers: { '/': { Proxy: m[2] } } } };
  fs.writeFileSync(file, JSON.stringify(cfg));
  process.stdout.write(`Available within your tailnet:\n\nhttps://${host}:${m[1]}/\n|-- proxy ${m[2]}\n\nServe started and running in the background.\n`);
} else if ((m = /^serve --https=(\d+) off$/.exec(line))) {
  const cfg = read();
  if (cfg.TCP) delete cfg.TCP[m[1]];
  if (cfg.Web) delete cfg.Web[`${host}:${m[1]}`];
  fs.writeFileSync(file, JSON.stringify(cfg));
} else {
  process.stderr.write(`fake tailscale: refusing "${line}"\n`);
  process.exitCode = 2;
}

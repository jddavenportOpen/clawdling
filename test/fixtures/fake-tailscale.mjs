#!/usr/bin/env node
// A stand-in for the Tailscale CLI in the Use from anywhere tests. Clawdling itself may only ever
// run `tailscale serve status --json`; anything else fails loudly (exit 2), so a test catches it.
//   FAKE_TS_SERVE  a JSON file printed as the serve config ({} or missing: no serve config)
//   FAKE_TS_LOG    one JSON line per call: the argv
import fs from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_TS_LOG) fs.appendFileSync(process.env.FAKE_TS_LOG, JSON.stringify({ args }) + '\n');
if (args.join(' ') === 'serve status --json') {
  let text = '{}';
  try {
    text = fs.readFileSync(process.env.FAKE_TS_SERVE || '', 'utf8');
  } catch {
    // no serve config
  }
  process.stdout.write(text);
} else {
  process.stderr.write(`fake tailscale: refusing "${args.join(' ')}"\n`);
  process.exitCode = 2;
}

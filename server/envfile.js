// Minimal .env reader/writer for the org's secrets file (mode 0600). Values are never logged.
import fs from 'node:fs';
import { writeFileAtomic } from './util.js';

export function readEnvFile(file) {
  const out = {};
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Set (or with value null, remove) one variable, keeping every other line as it was. */
export function writeEnvVar(file, key, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('invalid env key');
  if (value !== null && /[\r\n]/.test(String(value))) throw new Error('env values cannot contain newlines');
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    // new file
  }
  const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  lines = lines.filter((l) => !re.test(l));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (value !== null) lines.push(`${key}=${value}`);
  writeFileAtomic(file, lines.join('\n') + '\n', 0o600);
}

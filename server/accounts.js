// Extra Claude logins ("accounts"). Each one is only a folder, ~/.clawdling-accounts/<id>, that is
// passed to the sessions started with it as CLAUDE_CONFIG_DIR. The user signs in inside Claude
// Code itself (/login); Clawdling never opens, reads or copies anything in these folders.
// No account = the login `claude` already uses on this computer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { badRequest, conflict, notFound } from './util.js';

export const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const DEFAULT_ACCOUNT = { id: 'default', name: 'Your Claude login', default: true, dir: null };

export function accountsDir(env = process.env) {
  return env.CLAWDLING_ACCOUNTS_DIR || path.join(os.homedir(), '.clawdling-accounts');
}

/** "Work plan" -> "work-plan". */
export function accountId(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

export class Accounts {
  constructor({ env = process.env } = {}) {
    this.dir = accountsDir(env);
  }

  list() {
    let names = [];
    try {
      names = fs
        .readdirSync(this.dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && ACCOUNT_ID_RE.test(d.name) && d.name !== 'default')
        .map((d) => d.name)
        .sort();
    } catch {
      // no folder yet: only the default login
    }
    return [DEFAULT_ACCOUNT, ...names.map((id) => ({ id, name: id, default: false, dir: path.join(this.dir, id) }))];
  }

  /** The CLAUDE_CONFIG_DIR for an account id, or null for the default login. Throws if unknown. */
  configDir(id) {
    if (id === undefined || id === null || id === '' || id === 'default') return null;
    if (typeof id !== 'string' || !ACCOUNT_ID_RE.test(id)) throw badRequest('invalid account');
    const dir = path.join(this.dir, id);
    if (!fs.existsSync(dir)) throw notFound(`no account called "${id}"`);
    return dir;
  }

  create(name) {
    const id = accountId(name);
    if (!id || id === 'default') throw badRequest('give the account a name, like "work"');
    const dir = path.join(this.dir, id);
    if (fs.existsSync(dir)) throw conflict(`there is already an account called "${id}"`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return { id, name: id, default: false, dir };
  }
}

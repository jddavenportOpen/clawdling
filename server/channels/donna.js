// Donna routing: every inbound text from the paired owner becomes one headless Donna turn,
// `claude -p --output-format json`, run serially. Donna routes by running the clawdling CLI.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { which } from '../paths.js';
import { isUuid, oneLine } from '../util.js';

export const DONNA_TIMEOUT_MS = 180000;

/**
 * Tools Donna may use without asking. Headless turns run with --permission-mode dontAsk, so
 * anything not listed is denied: no arbitrary shell, no writes outside her memory folder.
 */
export function donnaAllowedTools(home) {
  const tools = [
    'Bash(clawdling spawn *)',
    'Bash(clawdling send *)',
    'Bash(clawdling ls)',
    'Bash(clawdling ls *)',
    'Bash(clawdling new *)',
    'Bash(clawdling end *)',
    'Edit(memory/**)',
  ];
  // `//abs/path/**` is Claude Code's absolute-path rule form. Only for paths without rule syntax.
  if (/^\/[A-Za-z0-9._/ -]+$/.test(home)) tools.push(`Read(/${home}/**)`);
  return tools;
}

export function buildDonnaArgs({ sessionId, resume, home, ctxFile, model }) {
  const a = ['-p', '--output-format', 'json'];
  if (resume) a.push('--resume', sessionId);
  else a.push('--session-id', sessionId);
  if (model) a.push(`--model=${model}`);
  a.push('--add-dir', home);
  if (ctxFile) a.push('--append-system-prompt-file', ctxFile);
  a.push('--permission-mode', 'dontAsk');
  a.push('--allowedTools', ...donnaAllowedTools(home)); // variadic: must stay last
  return a;
}

export function buildDonnaPrompt({ owner, channel, text, agents = [], sessions = [] }) {
  const roster = agents.map((a) => `- ${a.id} (${a.kind}): ${a.name}: ${oneLine(a.mission, 160)}`).join('\n') || '- (no agents)';
  const live =
    sessions
      .filter((s) => s.status !== 'ended')
      .slice(0, 15)
      .map((s) => `- ${s.sid} ${s.agent} [${s.status}] ${oneLine(s.title || 'new session', 60)}`)
      .join('\n') || '- none';
  return [
    `${owner} sent you a ${channel} message:`,
    '<message>',
    text,
    '</message>',
    '',
    'Agents in the org:',
    roster,
    '',
    'Live sessions:',
    live,
    '',
    `Route it (clawdling spawn / clawdling send) or answer it yourself if it is about the org, then reply to ${owner} in 1-3 short plain-text lines. Your final message is sent back as a text message.`,
  ].join('\n');
}

/** Parse `claude -p --output-format json` stdout. */
export function parseResult(stdout) {
  const lines = String(stdout).trim().split('\n').reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const j = JSON.parse(t);
      if (j && (j.type === 'result' || 'result' in j)) return j;
    } catch {
      // keep looking
    }
  }
  try {
    const j = JSON.parse(String(stdout));
    if (Array.isArray(j)) return j.reverse().find((x) => x?.type === 'result') || null;
    return j;
  } catch {
    return null;
  }
}

export class DonnaRouter {
  constructor({ paths, org, sessions, events, claudeBin, env, getPort, shimDir, logger, timeoutMs = DONNA_TIMEOUT_MS }) {
    Object.assign(this, { paths, org, sessions, events, claudeBin, env, getPort, shimDir, logger, timeoutMs });
    this.queue = Promise.resolve();
    this.inFlight = 0;
  }

  get busy() {
    return this.inFlight > 0;
  }

  /** Queue one inbound message; resolves with Donna's reply text (rejects with a short reason). */
  handle({ channel, text }) {
    this.inFlight++;
    const run = this.queue.then(() => this.runTurn({ channel, text }));
    this.queue = run.catch(() => {}).finally(() => {
      this.inFlight--;
    });
    return run;
  }

  async runTurn({ channel, text }) {
    const org = this.org.read();
    const donna = this.org.agent('donna');
    if (!donna) throw new Error('Donna is missing from this org (donna/agent.json)');
    const claude = which(this.claudeBin, this.env.PATH || '');
    if (!claude) throw new Error('the claude CLI was not found');
    const ctxFile = this.sessions.writeContextFile({ ...donna, cwd: donna.dir });
    const prompt = buildDonnaPrompt({
      owner: org.owner || 'The owner',
      channel,
      text,
      agents: this.org.agents(),
      sessions: this.sessions.list(),
    });
    let sessionId = isUuid(org.donna_session) ? org.donna_session : null;
    let resume = !!sessionId;
    if (!sessionId) sessionId = crypto.randomUUID();
    let r = await this.exec(claude, buildDonnaArgs({ sessionId, resume, home: this.paths.home, ctxFile, model: donna.model }), prompt, donna.dir);
    if (!r.ok && resume && r.noConversation) {
      sessionId = crypto.randomUUID();
      resume = false;
      r = await this.exec(claude, buildDonnaArgs({ sessionId, resume, home: this.paths.home, ctxFile, model: donna.model }), prompt, donna.dir);
    }
    if (!r.ok) throw new Error(r.error);
    const newId = isUuid(r.sessionId) ? r.sessionId : sessionId;
    if (newId !== org.donna_session) {
      this.org.update((o) => {
        o.donna_session = newId;
      });
    }
    return r.text;
  }

  exec(claude, args, prompt, cwd) {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let done = false;
      const child = spawn(claude, args, {
        cwd,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...this.env,
          CLAWDLING_HOME: this.paths.home,
          CLAWDLING_PORT: String(this.getPort()),
          CLAWDLING_DONNA: '1',
          PATH: `${this.shimDir}:${this.env.PATH || '/usr/bin:/bin'}`,
        },
      });
      const finish = (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(res);
      };
      const killGroup = (sig) => {
        try {
          process.kill(-child.pid, sig);
        } catch {
          try {
            child.kill(sig);
          } catch {
            // gone
          }
        }
      };
      const timer = setTimeout(() => {
        killGroup('SIGTERM');
        setTimeout(() => killGroup('SIGKILL'), 3000).unref?.();
        finish({ ok: false, error: `timed out after ${Math.round(this.timeoutMs / 1000)}s` });
      }, this.timeoutMs);
      child.stdout.on('data', (d) => {
        if (stdout.length < 4 * 1024 * 1024) stdout += d;
      });
      child.stderr.on('data', (d) => {
        if (stderr.length < 64 * 1024) stderr += d;
      });
      child.on('error', (err) => finish({ ok: false, error: oneLine(err.message, 200) }));
      child.on('close', (code) => {
        const j = parseResult(stdout);
        const errText = `${stderr}\n${j?.result || ''}`;
        const noConversation = /no conversation found|session.*not found/i.test(errText);
        if (code === 0 && j && !j.is_error && typeof j.result === 'string') {
          finish({ ok: true, text: j.result.trim(), sessionId: j.session_id });
          return;
        }
        const reason = (j?.is_error && (j.result || j.subtype)) || stderr.split('\n').map((l) => l.trim()).find(Boolean) || `claude exited with code ${code}`;
        finish({ ok: false, error: oneLine(reason, 200), noConversation });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
  }
}

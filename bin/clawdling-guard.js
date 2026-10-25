#!/usr/bin/env node
// PreToolUse guard for a Use from anywhere setup chat (a session started with /remote-access).
// The skill's "never" list, enforced in code: whatever else the session was told (an edited
// CLAUDE.md, a rule file, a web page), these tool calls are refused before they run, and Claude
// is told why. Registered only in that session's --settings file (hooks-settings-remote.json).
//
// Contract: read the tool call on stdin; exit 2 with the reason on stderr to refuse it; exit 0
// (printing nothing) to let Claude Code's normal permission flow decide. Any error lets it through
// to that flow: the owner still approves every command, and the server's own checks still hold.

// A credential, or Clawdling's runtime folder: cert.pem, anything in ~/.cloudflared except its
// config.yml, anything in .clawdling (relative or absolute).
const SECRET = /(^|[\s"'/=:])cert\.pem\b|\.cloudflared(?![\\/]config\.ya?ml\b)([\\/]|\s|$|["'])|(^|[\s"'=:\\/])\.clawdling([\\/]|\s|$|["'])/i;

/** One command part (no ; && || |): the reason to refuse it, or null. */
function part(cmd) {
  const rules = [
    [/\bsudo\b/i, 'the owner runs every sudo command in their own terminal'],
    [/\b(eval|exec)\b|\b(sh|bash|zsh|dash|fish|ksh|pwsh|powershell|cmd|python3?|node|perl|ruby|osascript)(\.exe)?\b|(^|\s)(source|\.)\s+\S|(^|\s)\.\/\S/i, 'no scripts or interpreters in this chat: run each command directly'],
    [/\bclawdling\s+(spawn|send|new|end|resume|attach|import)\b/i, 'this setup chat does only its own steps: no other sessions or agents'],
    [/tailscale\s+status\b/i, 'use `clawdling remote tailscale-name`: it shows only this computer\'s address, not everyone on the tailnet (or a sign-in link)'],
    [/\b(tailscale|cloudflared)\b[^]*["'`\\$]/i, 'write Tailscale and cloudflared commands plainly, with no quotes, escapes or variables'],
    [/\bserve\b\s.*\breset\b|\bserve\s+reset\b/i, 'never `tailscale serve reset`: it would wipe the owner\'s other serve entries'],
    [/\bserve\b.*--(tcp|tls-terminated-tcp)\b/i, 'never a TCP forward: whoever uses one can write their own headers'],
    [/--auth-?key\b/i, 'never an auth key: the owner signs in to Tailscale themselves'],
    [/tailscale\s+(up|down|logout|login|set|switch|cert)\b/i, 'never `tailscale up/down/logout/login/set/switch/cert`: the owner does that in the Tailscale app or their own terminal'],
    [/cloudflared\s+(tunnel\s+)?login\b/i, 'the owner runs `cloudflared tunnel login` in their own terminal'],
    [SECRET, 'never read a credential file (cert.pem, anything in ~/.cloudflared but config.yml, anything in .clawdling)'],
  ];
  for (const [re, why] of rules) if (re.test(cmd)) return why;
  if (/(^|\s)(--funnel|funnel)\b/i.test(cmd)) {
    // Only `tailscale funnel --https=PORT off` (or `funnel PORT off`).
    if (!/tailscale\s+funnel\s+(--https[= ]\d+|\d+)\s+off\s*$/i.test(cmd)) return 'never turn on Tailscale Funnel (it makes the address public); the only allowed Funnel command turns it off';
  }
  if (/tailscale\s+serve\b/i.test(cmd)) {
    // The serve entry carries the cockpit's private path: only Clawdling's CLI sets it up and shows
    // its status, with the path hidden. Turning one entry off is the one raw serve command.
    if (!/tailscale\s+serve\s+--https[= ]\d+\s+off\s*$/i.test(cmd)) return 'use `clawdling remote serve <url>` and `clawdling remote serve-status` instead of `tailscale serve`: they keep the cockpit\'s private path out of this chat (turning an entry off with `tailscale serve --https=PORT off` is fine)';
  }
  return null;
}

/** The reason to refuse this tool call, or null. Exported for the tests. */
export function verdict(input) {
  const tool = String(input?.tool_name || '');
  const ti = input?.tool_input || {};
  if (/^(Bash|PowerShell)$/.test(tool)) {
    const cmd = String(ti.command || '');
    if (/[\n\r`]|\$\(/.test(cmd)) return 'one plain command at a time in this chat (no newlines, backticks or $(...))';
    const segs = cmd.split(/;|&&|\|\||\||&/);
    if (segs.length > 1) return 'one command at a time in this chat, exactly as the setup steps write it (no chains or pipes)';
    for (const seg of segs) {
      const why = part(seg.replace(/\s+/g, ' ').trim());
      if (why) return why;
    }
    return null;
  }
  if (/^(Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob)$/.test(tool)) {
    const target = [ti.file_path, ti.notebook_path, ti.path, ti.pattern, ti.glob].filter((v) => typeof v === 'string').join(' ');
    if (SECRET.test(` ${target}`)) return 'never read or change a credential file (cert.pem, anything in ~/.cloudflared but config.yml, anything in .clawdling)';
    // A file written here must not become a script that runs what this guard refuses.
    if (/^(Write|Edit|MultiEdit)$/.test(tool) && /\.(sh|bash|zsh|command|ps1|bat|cmd|py|js|mjs)$/i.test(String(ti.file_path || ''))) return 'no script files in this chat: run each command directly';
  }
  return null;
}

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  let input = null;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    process.exit(0);
  }
  const why = verdict(input);
  if (why) {
    process.stderr.write(`Clawdling refused this in a Use from anywhere setup chat: ${why}.\n`);
    process.exit(2);
  }
  process.exit(0);
}

const direct = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href || /clawdling-guard\.js$/.test(process.argv[1] || '');
  } catch {
    return false;
  }
})();
if (direct) main().catch(() => process.exit(0));

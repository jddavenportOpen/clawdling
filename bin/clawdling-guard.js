#!/usr/bin/env node
// PreToolUse guard for a Use from anywhere setup chat (a session started with /remote-access).
// The skill's "never" list, enforced in code: whatever else the session was told (an edited
// CLAUDE.md, a rule file, a web page), these tool calls are refused before they run, and Claude
// is told why. Registered only in that session's --settings file (hooks-settings-remote.json).
//
// Contract: read the tool call on stdin; exit 2 with the reason on stderr to refuse it; exit 0
// (printing nothing) to let Claude Code's normal permission flow decide. Any error lets it through
// to that flow: the owner still approves every command, and the server's own checks still hold.

/** The reason to refuse this tool call, or null. Exported for the tests. */
export function verdict(input) {
  const tool = String(input?.tool_name || '');
  const ti = input?.tool_input || {};
  const SECRET = /(^|[\s"'/=:])(cert\.pem)\b|\.cloudflared[\\/][^\s"']*\.json\b|[\\/]\.clawdling([\\/]|$|\s)/i;
  if (/^(Bash|PowerShell)$/.test(tool)) {
    const cmd = String(ti.command || '').replace(/\s+/g, ' ');
    const rules = [
      [/\bsudo\b/i, 'the owner runs every sudo command in their own terminal'],
      [/(^|[\s;&|(])(--funnel|funnel)\b/i, null], // checked below: only turning Funnel off is allowed
      [/\bserve\b[^;&|]*\breset\b/i, 'never `tailscale serve reset`: it would wipe the owner\'s other serve entries'],
      [/\bserve\b[^;&|]*--(tcp|tls-terminated-tcp)\b/i, 'never a TCP forward: whoever uses one can write their own headers'],
      [/--auth-?key\b/i, 'never an auth key: the owner signs in to Tailscale themselves'],
      [/tailscale\s+(up|down|logout|login|set|switch)\b/i, 'never `tailscale up/down/logout/login/set/switch`: the owner does that in the Tailscale app or their own terminal'],
      [/cloudflared\s+(tunnel\s+)?login\b/i, 'the owner runs `cloudflared tunnel login` in their own terminal'],
      [SECRET, 'never read a credential file (cert.pem, a tunnel credentials file, anything in .clawdling)'],
    ];
    for (const [re, why] of rules) {
      if (!re.test(cmd)) continue;
      if (why) return why;
      // Funnel: allowed only as `... funnel --https=PORT off` (or `funnel reset` is still refused).
      const off = /\bfunnel\b(\s+--https[= ]\d+|\s+--bg|\s+\d+)*\s+off\b/i.test(cmd) && !/--funnel\b/i.test(cmd) && !/\bfunnel\b[^;&|]*\b(on|reset)\b/i.test(cmd);
      if (!off) return 'never turn on Tailscale Funnel (it makes the address public); the only allowed Funnel command turns it off';
    }
    return null;
  }
  if (/^(Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob)$/.test(tool)) {
    const target = [ti.file_path, ti.notebook_path, ti.path, ti.pattern].filter((v) => typeof v === 'string').join(' ');
    if (SECRET.test(target)) return 'never read or change a credential file (cert.pem, a tunnel credentials file, anything in .clawdling)';
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

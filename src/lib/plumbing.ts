// ── Shared plumbing-marker handling ──────────────────────────────────────────
// Claude Code / the bridge emit internal system bookkeeping inline with real
// conversation: <task-notification> blocks, <local-command-caveat> preambles,
// the /compact command + its <local-command-stdout> dump, and "No response
// requested." sentinels. These are NOT conversation — JD must never see them.
//
// Two consumers, two shapes:
//   1. The polled transcript (CleanTranscript) drops a WHOLE turn whose text is
//      ONLY a plumbing marker — uses PLUMBING_PATTERNS / isPlumbingText.
//   2. The live + persisted assistant bubble (MarkdownBubble) STRIPS plumbing
//      blocks that are interleaved inside an otherwise-real message — uses
//      stripPlumbing. The streamed SSE path never filtered these, which is the
//      root cause of "weird messages" (raw <task-notification> in bubbles).
//
// This module is the single source of truth so the two paths can't drift.

/** The plumbing wrapper tags whose contents are pure bookkeeping. */
export const PLUMBING_TAG_NAMES = [
  'task-notification',
  'local-command-caveat',
  'command-name',
  'command-message',
  'local-command-stdout',
] as const;

/** Whole-string matchers: a turn whose (trimmed) text IS exactly one of these
 *  markers is plumbing. Deliberately conservative — anchored with ^…$ so a real
 *  message that merely MENTIONS a tag is never matched. Used for whole-turn
 *  filtering in the polled transcript. */
export const PLUMBING_PATTERNS: RegExp[] = [
  /^<task-notification>[\s\S]*<\/task-notification>$/i,
  /^<local-command-caveat>[\s\S]*<\/local-command-caveat>$/i,
  /^<command-name>[\s\S]*<\/command-name>$/i,
  /^<command-message>[\s\S]*<\/command-message>$/i,
  /^<local-command-stdout>[\s\S]*<\/local-command-stdout>$/i,
  // Sentinel the TUI injects when a turn expects no reply.
  /^no response requested\.?$/i,
];

/** True if `text` (trimmed) is ENTIRELY one plumbing marker. Pure; unit-tested. */
export function isPlumbingText(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  return PLUMBING_PATTERNS.some((re) => re.test(t));
}

const _CLOSED_BLOCK = new RegExp(
  `<(${PLUMBING_TAG_NAMES.join('|')})>[\\s\\S]*?<\\/\\1>`,
  'gi'
);
// A plumbing block whose opening tag has arrived but whose closing tag has not
// yet streamed in. Everything from the open tag to end-of-text is still the
// (incomplete) plumbing payload, so drop it; once the close arrives the closed-
// block matcher takes over and any real trailing content reappears.
const _OPEN_BLOCK_TO_END = new RegExp(
  `<(${PLUMBING_TAG_NAMES.join('|')})>[\\s\\S]*$`,
  'i'
);
const _NO_RESPONSE_LINE = /^[ \t]*no response requested\.?[ \t]*$/gim;

/**
 * Remove plumbing-marker blocks from arbitrary (possibly streaming) assistant
 * text, leaving the real prose intact. Handles both fully-closed blocks and an
 * unclosed trailing block mid-stream. Collapses the blank gap a removed block
 * leaves behind. Pure — safe to call on every render.
 */
export function stripPlumbing(text: string | null | undefined): string {
  if (!text) return '';
  let out = text.replace(_CLOSED_BLOCK, '');
  out = out.replace(_OPEN_BLOCK_TO_END, '');
  out = out.replace(_NO_RESPONSE_LINE, '');
  // Collapse 3+ newlines (left by a removed block) down to a paragraph break.
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

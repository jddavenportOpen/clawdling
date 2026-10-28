import { cleanInput } from './receipts.js';
// Session titles, derived locally from the first prompt. Clawdling never calls a model for this.
export const TITLE_MAX = 48;

/**
 * First sentence of the text, without markdown or URLs, at most `max` characters, sentence case.
 * Returns null when nothing title-worthy is left (empty text, a slash command, only a URL).
 */
export function deriveTitle(text, max = TITLE_MAX) {
  if (typeof text !== 'string') return null;
  let s = text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/```[\s\S]*?(?:```|$)/g, '\n')
    .replace(/<\/?[A-Za-z][^>\n]{0,80}>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\b(?:https?|ftp|file):\/\/[^\s)>\]]+/gi, ' ')
    .replace(/\bwww\.[^\s)>\]]+/gi, ' ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
  s = s.trim();
  if (!s || s.startsWith('/')) return null;

  let line = '';
  for (const raw of s.split('\n')) {
    const l = raw.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d{1,3}[.)]\s+|\[[ xX]\]\s+)+/, '').trim();
    if (l) {
      line = l;
      break;
    }
  }
  line = line
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?:;]|$)/g, '$1$2');

  const m = line.match(/^(.+?[.!?])(?:\s|$)/);
  let title = (m ? m[1] : line).replace(/\s+/g, ' ').trim();
  title = title.replace(/[\s.,;:]+$/u, '').trim();
  if (!title || !/[\p{L}\p{N}]/u.test(title)) return null;

  if (title.length > max) {
    const cut = title.slice(0, max - 1);
    const sp = cut.lastIndexOf(' ');
    title = (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s.,;:!?-]+$/u, '') + '…';
  }
  // Sentence case: capitalise the first letter when the title starts with a word.
  return title.replace(/^([^\p{L}\p{N}]*)(\p{L})/u, (_, pre, c) => pre + c.toUpperCase());
}

/** Normalise a user-supplied title (rename, spawn). Empty → null. */
export function cleanTitle(t, max = 120) {
  if (t === null || t === undefined) return null;
  const s = cleanInput(String(t).replace(/[\u0000-\u001f\u007f]/g, ' ')) // nothing a person cannot see (tags, bidi)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  return s || null;
}

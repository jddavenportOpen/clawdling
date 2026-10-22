// In-memory hand-offs between screens that must not travel in a URL: a code the in-app scanner
// just read (deep links always ask before connecting; our own scanner does not need to), and the
// first message of a session that was just created from the draft screen.

import type { PendingMessage } from './chat';

let scanned: string | null = null;

export function setScannedLink(link: string) {
  scanned = link;
}

export function takeScannedLink(): string | null {
  const s = scanned;
  scanned = null;
  return s;
}

const firstMessages = new Map<string, PendingMessage[]>();

export function stashPending(sid: string, pending: PendingMessage[]) {
  firstMessages.set(sid, pending);
}

export function takePending(sid: string): PendingMessage[] {
  const p = firstMessages.get(sid) ?? [];
  firstMessages.delete(sid);
  return p;
}

'use client';

// ═══════════════════════════════════════════════════════════════════════════
// usePins — shared, localStorage-backed pin store for the Agent Rail.
//
// A module-level Set of pinned thread ids + a useSyncExternalStore subscription,
// so ThreadRow (the pin toggle on each row) and ThreadSidebar (the PINNED
// section at the top) share one source of truth WITHOUT prop-drilling through
// every section's ThreadRow call site. Pin the 2-3 chats you're actively
// driving; they float to the top of the rail. Devin's "pin to top" pattern.
// ═══════════════════════════════════════════════════════════════════════════

import { useSyncExternalStore } from 'react';

const KEY = 'rail.pinned';

let pins = new Set<string>();
const listeners = new Set<() => void>();

function load(): void {
  try {
    const raw = localStorage.getItem(KEY);
    pins = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    pins = new Set<string>();
  }
}
function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...pins]));
  } catch {
    /* quota / disabled — pinning just won't persist */
  }
}
function emit(): void {
  for (const l of listeners) l();
}

if (typeof window !== 'undefined') load();

export function togglePin(id: string): void {
  const next = new Set(pins);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  pins = next; // new ref so useSyncExternalStore detects the change
  save();
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
function getSnapshot(): Set<string> {
  return pins;
}
const EMPTY = new Set<string>(); // stable server snapshot

/** All pinned ids (re-renders on change). */
export function usePinnedIds(): Set<string> {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}

/** Whether a single id is pinned (re-renders on change). */
export function useIsPinned(id: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => pins.has(id),
    () => false
  );
}

// Where the pairing lives: the iOS Keychain (via expo-secure-store), readable only after the
// first unlock and never synced or restored to another device. Web builds (used for tests and
// screenshots) fall back to localStorage.

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

export type StoredConnection = { mode: 'live'; url: string; token: string } | { mode: 'demo' };

const KEY = 'clawdling.connection.v1';

function parse(raw: string | null): StoredConnection | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v && v.mode === 'demo') return { mode: 'demo' };
    if (v && v.mode === 'live' && typeof v.url === 'string' && typeof v.token === 'string' && v.url && v.token) {
      return { mode: 'live', url: v.url, token: v.token };
    }
  } catch {
    // corrupt: treat as not connected
  }
  return null;
}

const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export async function loadConnection(): Promise<StoredConnection | null> {
  if (Platform.OS === 'web') {
    try {
      return parse(globalThis.localStorage?.getItem(KEY) ?? null);
    } catch {
      return null;
    }
  }
  try {
    return parse(await SecureStore.getItemAsync(KEY, secureOptions));
  } catch {
    return null;
  }
}

export async function saveConnection(c: StoredConnection): Promise<void> {
  const raw = JSON.stringify(c);
  if (Platform.OS === 'web') {
    try {
      globalThis.localStorage?.setItem(KEY, raw);
    } catch {
      // private mode: the connection lasts for this page only
    }
    return;
  }
  await SecureStore.setItemAsync(KEY, raw, secureOptions);
}

export async function clearConnection(): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      globalThis.localStorage?.removeItem(KEY);
    } catch {
      // ignore
    }
    return;
  }
  try {
    await SecureStore.deleteItemAsync(KEY, secureOptions);
  } catch {
    // already gone
  }
}

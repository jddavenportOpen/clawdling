// ═══════════════════════════════════════════════════════════════════════════
// crypto-key.ts — AES-256-GCM at-rest encryption for per-user API keys (BYOK).
// SERVER ONLY. Never import from a client component. The plaintext key is
// decrypted only at request time to call Anthropic and is never returned to any
// client. Keyed by ADJUTANT_ENCRYPTION_KEY (base64 32 bytes, server secret).
// ═══════════════════════════════════════════════════════════════════════════

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

function encKey(): Buffer {
  const raw = process.env.ADJUTANT_ENCRYPTION_KEY || '';
  if (!raw) throw new Error('ADJUTANT_ENCRYPTION_KEY is not set');
  const b = Buffer.from(raw, 'base64');
  // Accept a raw base64 32-byte key, else derive 32 bytes deterministically.
  return b.length === 32 ? b : createHash('sha256').update(raw).digest();
}

/** Returns `iv:authTag:ciphertext`, all base64. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

export function decryptSecret(stored: string): string {
  const [ivB, tagB, ctB] = stored.split(':');
  const d = createDecipheriv('aes-256-gcm', encKey(), Buffer.from(ivB, 'base64'));
  d.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ctB, 'base64')), d.final()]).toString('utf8');
}

/** Display-only masked form. Never expose the real key to a client. */
export function maskKey(k: string): string {
  return k && k.length > 8 ? `sk-ant-...${k.slice(-4)}` : 'sk-ant-...';
}

// ═══════════════════════════════════════════════════════════════════════════
// chat-interface-v2 — Bridge JWT (server-only)
//
// Mints and verifies HS256 JWTs shared with the Mac Mini bridge
// (FastAPI at BRIDGE_URL). The bridge gates every endpoint on this token
// using the same BRIDGE_SECRET — keep the secret identical on both sides.
//
// Claims:
//   sub       — user's email (human-readable)
//   user_id   — NextAuth user id (stable UUID)
//   iat / exp — 15-minute TTL (short — tokens are re-minted per connection)
//
// DO NOT import this from client components — it will leak BRIDGE_SECRET.
// ═══════════════════════════════════════════════════════════════════════════
import 'server-only';

import { SignJWT, jwtVerify } from 'jose';

const TTL_SECONDS = 15 * 60; // 15 minutes

function getSecretBytes(): Uint8Array {
  const secret = process.env.BRIDGE_SECRET;
  if (!secret) {
    throw new Error(
      '[bridge-jwt] BRIDGE_SECRET is not set. This must match the secret used by the FastAPI bridge.'
    );
  }
  return new TextEncoder().encode(secret);
}

export interface BridgeJWTClaims {
  email: string;
  user_id: string;
}

/**
 * Sign a short-lived HS256 JWT for the bridge.
 * Returns a compact JWS string.
 */
export async function signBridgeJWT(
  userId: string,
  email: string,
  extra?: Record<string, unknown>
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    ...(extra || {}),
    user_id: userId,
  };

  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(email)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + TTL_SECONDS)
    .sign(getSecretBytes());
}

/**
 * Verify a bridge JWT. Returns claims on success, null on any failure.
 */
export async function verifyBridgeJWT(
  token: string
): Promise<BridgeJWTClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretBytes(), {
      algorithms: ['HS256'],
    });
    const email = typeof payload.sub === 'string' ? payload.sub : '';
    const userId = typeof payload.user_id === 'string' ? payload.user_id : '';
    if (!email || !userId) return null;
    return { email, user_id: userId };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// google.ts — per-user Google (Gmail + Calendar) connection for the agent.
// SERVER ONLY.
//
// Each user connects their OWN Google account via OAuth; we store their tokens
// encrypted (AES-GCM, crypto-key.ts) in public.user_integrations, one row per
// (user_id, 'google'). The agent's Gmail/Calendar tools (tools.ts) call
// getAccessToken(userId), which transparently refreshes an expired access token
// with the stored refresh token. This is what lets the assistant read/draft/send
// mail and read/create calendar events on the user's behalf.
//
// Config (env): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and the redirect URI is
// derived from NEXTAUTH_URL (/api/google/callback). The OAuth client + its
// redirect URI + test users are configured once in the Google Cloud console.
// ═══════════════════════════════════════════════════════════════════════════

import { getServerClient } from '@/lib/supabase';
import { encryptSecret, decryptSecret } from '@/lib/crypto-key';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'openid',
  'email',
];

export function googleConfigured(): boolean {
  return !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
}

function appUrl(): string {
  return (process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
}
export function redirectUri(): string {
  return `${appUrl()}/api/google/callback`;
}

/** The consent-screen URL to start the connect flow. `state` round-trips a returnTo. */
export function authUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Exchange an auth code for tokens and store them for the user. */
export async function connectFromCode(userId: string, code: string): Promise<void> {
  const t = await tokenRequest({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
  });
  const expiry = new Date(Date.now() + (t.expires_in - 60) * 1000).toISOString();
  await getServerClient().from('user_integrations').upsert(
    {
      user_id: userId,
      provider: 'google',
      access_token: encryptSecret(t.access_token),
      refresh_token: t.refresh_token ? encryptSecret(t.refresh_token) : undefined,
      expiry,
      scope: t.scope || GOOGLE_SCOPES.join(' '),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,provider' },
  );
}

interface IntegrationRow {
  access_token: string | null;
  refresh_token: string | null;
  expiry: string | null;
  scope: string | null;
}

async function getRow(userId: string): Promise<IntegrationRow | null> {
  const { data } = await getServerClient()
    .from('user_integrations')
    .select('access_token,refresh_token,expiry,scope')
    .eq('user_id', userId).eq('provider', 'google').maybeSingle();
  return (data as IntegrationRow) ?? null;
}

export async function googleConnected(userId: string): Promise<boolean> {
  const row = await getRow(userId);
  return !!row?.refresh_token;
}

/** A valid access token for the user, refreshing if expired. null if not connected. */
export async function getAccessToken(userId: string): Promise<string | null> {
  const row = await getRow(userId);
  if (!row) return null;
  const notExpired = row.expiry && new Date(row.expiry).getTime() > Date.now();
  if (notExpired && row.access_token) {
    try { return decryptSecret(row.access_token); } catch { /* fall through to refresh */ }
  }
  if (!row.refresh_token) return null;
  const refresh = decryptSecret(row.refresh_token);
  const t = await tokenRequest({
    refresh_token: refresh,
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
    grant_type: 'refresh_token',
  });
  const expiry = new Date(Date.now() + (t.expires_in - 60) * 1000).toISOString();
  await getServerClient().from('user_integrations').update({
    access_token: encryptSecret(t.access_token), expiry, updated_at: new Date().toISOString(),
  }).eq('user_id', userId).eq('provider', 'google');
  return t.access_token;
}

export async function disconnectGoogle(userId: string): Promise<void> {
  await getServerClient().from('user_integrations').delete().eq('user_id', userId).eq('provider', 'google');
}

// ── Thin Gmail + Calendar REST helpers (used by the agent tools) ─────────────
async function gapi(token: string, url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google API ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

export async function calendarList(token: string, timeMin: string, timeMax: string, q?: string) {
  const p = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '25' });
  if (q) p.set('q', q);
  return gapi(token, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${p.toString()}`) as Promise<{
    items?: Array<{ summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; location?: string; id?: string }>;
  }>;
}

export async function calendarInsert(token: string, ev: { summary: string; start: string; end: string; attendees?: string[]; description?: string }) {
  const body = {
    summary: ev.summary,
    description: ev.description,
    start: { dateTime: ev.start },
    end: { dateTime: ev.end },
    ...(ev.attendees?.length ? { attendees: ev.attendees.map((e) => ({ email: e })) } : {}),
  };
  return gapi(token, 'https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST', body: JSON.stringify(body),
  }) as Promise<{ htmlLink?: string; id?: string }>;
}

export async function gmailListMessages(token: string, q: string, max: number) {
  const p = new URLSearchParams({ q, maxResults: String(Math.min(max, 15)) });
  const list = (await gapi(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages?${p.toString()}`)) as {
    messages?: Array<{ id: string }>;
  };
  const ids = (list.messages || []).slice(0, Math.min(max, 15));
  const out: Array<{ id: string; from: string; subject: string; snippet: string; date: string }> = [];
  for (const m of ids) {
    const full = (await gapi(
      token,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
    )) as { snippet?: string; payload?: { headers?: Array<{ name: string; value: string }> } };
    const h = (n: string) => full.payload?.headers?.find((x) => x.name === n)?.value || '';
    out.push({ id: m.id, from: h('From'), subject: h('Subject'), date: h('Date'), snippet: full.snippet || '' });
  }
  return out;
}

export async function gmailGet(token: string, id: string): Promise<{ subject: string; from: string; body: string }> {
  const full = (await gapi(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`)) as {
    payload?: { headers?: Array<{ name: string; value: string }>; parts?: Array<{ mimeType: string; body?: { data?: string } }>; body?: { data?: string } };
    snippet?: string;
  };
  const h = (n: string) => full.payload?.headers?.find((x) => x.name === n)?.value || '';
  const decode = (d?: string) => (d ? Buffer.from(d.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') : '');
  let body = decode(full.payload?.body?.data);
  if (!body && full.payload?.parts) {
    const text = full.payload.parts.find((p) => p.mimeType === 'text/plain');
    body = decode(text?.body?.data) || full.snippet || '';
  }
  return { subject: h('Subject'), from: h('From'), body: body.slice(0, 4000) };
}

function rawMessage(to: string, subject: string, body: string): string {
  const mime = [`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=UTF-8', '', body].join('\n');
  return Buffer.from(mime).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function gmailSend(token: string, to: string, subject: string, body: string) {
  return gapi(token, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', body: JSON.stringify({ raw: rawMessage(to, subject, body) }),
  }) as Promise<{ id?: string }>;
}

export async function gmailDraft(token: string, to: string, subject: string, body: string) {
  return gapi(token, 'https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST', body: JSON.stringify({ message: { raw: rawMessage(to, subject, body) } }),
  }) as Promise<{ id?: string }>;
}

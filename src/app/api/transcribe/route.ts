// ═══════════════════════════════════════════════════════════════════════════
// POST /api/transcribe — speech-to-text for the hold-to-record mic.
//
// WHY THIS ROUTE NEEDS A SECOND PROVIDER (stated honestly):
//   Anthropic ships NO speech-to-text API. Claude accepts text, images and
//   documents; it cannot take an audio file. So the rest of this app being
//   BYOK-Anthropic does not get voice for free — transcription is a genuinely
//   separate capability and needs its own provider. Rather than hard-wire one
//   vendor into a self-host app, this route is provider-pluggable via env, and
//   the `local` provider means a self-hoster can run voice with NO second
//   account and NO second bill at all.
//
// THE WIRE CONTRACT — read off src/components/chat/VoiceRecorder.tsx, which
// already ships and is wired into both composers (CleanComposer + the
// SessionTerminal M2 row). Built to what the component ACTUALLY does:
//   - POST, multipart/form-data, ONE part named `audio` (the component's
//     `fieldName` prop, default 'audio'), filename `voice-<epochMs>.<ext>`.
//   - The part's Content-Type is the MediaRecorder mimeType, one of
//     audio/webm;codecs=opus | audio/webm | audio/mp4 | audio/ogg;codecs=opus
//     (or a browser default when none of those are supported).
//   - On res.ok the component parses JSON and reads `{ text }`; a `{ error }`
//     key throws, and an empty/whitespace `text` throws "Transcription
//     returned empty text".
//   - On !res.ok the component does NOT parse JSON — it reads res.text() and
//     shows `Transcribe failed (<status>): <first 200 chars>`. That 200-char
//     budget is why every error body here is a bare `{ error }` with a short,
//     actionable message and no extra keys: anything else eats the part of the
//     message the user actually needs to read.
//
// SAFETY: the audio is never written to disk. The uploaded File is streamed
// straight into the outbound FormData, so it lives only in request memory for
// the life of the call (Vercel's FS is read-only outside /tmp anyway, and a
// voice note is the last thing that should linger on disk).
// ═══════════════════════════════════════════════════════════════════════════

import 'server-only';

import { authWithTimeout as auth } from '@/lib/auth-timeout';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** The form field VoiceRecorder posts (its `fieldName` prop default). */
const FIELD = 'audio';

/** 25MB — OpenAI's own documented per-file limit for the audio endpoints, and
 *  the same cap /api/uploads already enforces. Opus at ~24kbps means this is
 *  roughly two hours of speech; a hold-to-record note is kilobytes. */
const MAX_BYTES = 25 * 1024 * 1024;

/** How long to wait on the provider before giving up. A wedged local whisper
 *  server must not hold the route open until the platform kills it. */
const PROVIDER_TIMEOUT_MS = 55_000;

/**
 * Accepted audio container types (base type only — any `;codecs=` parameter is
 * stripped before matching). Everything MediaRecorder can hand us, plus the
 * common files a future non-browser caller would send. Deliberately audio-only:
 * an allowlist that also waves through video or wildcard types is not an
 * allowlist.
 */
const ALLOWED_MIME = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/oga',
  'audio/opus',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/flac',
  'audio/x-flac',
]);

/** Extension fallback for the case where a client sends a part with no
 *  Content-Type at all. We still resolve to a type from the ALLOWED set — we
 *  never wave an unknown blob through. */
const EXT_MIME: Record<string, string> = {
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  mp4: 'audio/mp4',
  m4a: 'audio/m4a',
  mp3: 'audio/mpeg',
  mpga: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
};

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

/** The OpenAI-compatible path appended when TRANSCRIBE_URL is a bare origin. */
const COMPAT_PATH = '/v1/audio/transcriptions';

// ── Provider resolution ────────────────────────────────────────────────────

type Provider =
  | { ok: true; label: 'openai'; url: string; model: string; apiKey: string }
  | { ok: true; label: 'local'; url: string; model: string; apiKey: null }
  | { ok: false; error: string };

/**
 * Resolve TRANSCRIBE_PROVIDER into a concrete call target, or an actionable
 * reason why we cannot make one. Unset and unsupported are DIFFERENT messages:
 * "you haven't turned this on" and "you turned it on wrong" need different
 * fixes, and collapsing them is how a config typo reads as a missing feature.
 */
export function resolveProvider(env: NodeJS.ProcessEnv = process.env): Provider {
  const raw = (env.TRANSCRIBE_PROVIDER || '').trim().toLowerCase();
  const model = (env.TRANSCRIBE_MODEL || '').trim();

  if (!raw) {
    return {
      ok: false,
      error:
        'Voice transcription is not configured. Set TRANSCRIBE_PROVIDER=openai ' +
        '(with OPENAI_API_KEY) or TRANSCRIBE_PROVIDER=local (with TRANSCRIBE_URL).',
    };
  }

  if (raw === 'openai') {
    const apiKey = (env.OPENAI_API_KEY || '').trim();
    if (!apiKey) {
      return {
        ok: false,
        error:
          'TRANSCRIBE_PROVIDER=openai but OPENAI_API_KEY is not set. Add your ' +
          'OpenAI key, or switch to TRANSCRIBE_PROVIDER=local with TRANSCRIBE_URL.',
      };
    }
    return {
      ok: true,
      label: 'openai',
      url: (env.TRANSCRIBE_URL || '').trim() || OPENAI_ENDPOINT,
      model: model || 'whisper-1',
      apiKey,
    };
  }

  if (raw === 'local') {
    const base = (env.TRANSCRIBE_URL || '').trim();
    if (!base) {
      return {
        ok: false,
        error:
          'TRANSCRIBE_PROVIDER=local but TRANSCRIBE_URL is not set. Point it at ' +
          'your OpenAI-compatible server, e.g. http://127.0.0.1:8080.',
      };
    }
    const url = normalizeLocalUrl(base);
    if (!url) {
      return {
        ok: false,
        error: `TRANSCRIBE_URL is not a valid URL: ${base.slice(0, 80)}`,
      };
    }
    // whisper.cpp / faster-whisper / LM Studio all ignore an unknown model name
    // on this endpoint; it is required by the OpenAI schema, so we always send
    // one and let the local server pick whatever it has loaded.
    return { ok: true, label: 'local', url, model: model || 'whisper-1', apiKey: null };
  }

  return {
    ok: false,
    error:
      `Unsupported TRANSCRIBE_PROVIDER "${raw.slice(0, 32)}". ` +
      'Supported values: openai, local.',
  };
}

/**
 * A bare origin ("http://127.0.0.1:8080") gets the OpenAI-compatible path
 * appended; anything with a real path is used verbatim, so a server that
 * exposes the endpoint somewhere else (whisper.cpp's /inference) still works.
 * Returns null when the value is not a URL at all.
 */
function normalizeLocalUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.pathname === '' || u.pathname === '/') {
    u.pathname = COMPAT_PATH;
  }
  return u.toString();
}

// ── Upload validation ──────────────────────────────────────────────────────

/** Strip any `;codecs=opus` parameter and normalize case/whitespace. */
export function baseMime(value: string | null | undefined): string {
  return (value || '').split(';')[0].trim().toLowerCase();
}

/**
 * Decide the effective content type for an uploaded part: the declared type
 * when it is on the allowlist, else the filename extension's type when THAT is
 * on the allowlist, else null (caller 415s). Never guesses a default.
 */
export function resolveAudioMime(declared: string | null | undefined, filename: string): string | null {
  const base = baseMime(declared);
  if (base && ALLOWED_MIME.has(base)) return base;
  if (base) return null; // declared something, and it is not audio we accept

  const ext = (filename.split('.').pop() || '').toLowerCase();
  const fromExt = EXT_MIME[ext];
  return fromExt && ALLOWED_MIME.has(fromExt) ? fromExt : null;
}

// ── Route ──────────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  const session = await auth({ label: 'POST /api/transcribe' });
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Resolve the provider BEFORE reading the body: an unconfigured install
  // should answer instantly instead of buffering a 25MB upload it will refuse.
  const provider = resolveProvider();
  if (!provider.ok) {
    return Response.json({ error: provider.error }, { status: 501 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { error: `Expected multipart/form-data with an "${FIELD}" part.` },
      { status: 400 }
    );
  }

  const part = form.get(FIELD);
  if (!(part instanceof File)) {
    return Response.json(
      { error: `No audio uploaded. Send the recording as the "${FIELD}" form field.` },
      { status: 400 }
    );
  }

  if (part.size === 0) {
    return Response.json({ error: 'The audio upload was empty.' }, { status: 400 });
  }
  if (part.size > MAX_BYTES) {
    return Response.json(
      {
        error: `Audio is ${Math.round(part.size / 1024 / 1024)}MB; the limit is ${
          MAX_BYTES / 1024 / 1024
        }MB. Record a shorter clip.`,
      },
      { status: 413 }
    );
  }

  const filename = part.name || `voice-${Date.now()}.webm`;
  const mime = resolveAudioMime(part.type, filename);
  if (!mime) {
    return Response.json(
      {
        error: `Unsupported audio type "${
          baseMime(part.type) || 'unknown'
        }". Accepted: webm, ogg, mp4/m4a, mp3, wav, flac.`,
      },
      { status: 415 }
    );
  }

  // Re-pack for the provider. The File is passed through by reference — the
  // bytes are never copied to disk, only streamed onward.
  const outbound = new FormData();
  outbound.append('file', part, filename);
  outbound.append('model', provider.model);
  // Pin the response shape. OpenAI defaults to json, but several local servers
  // default to text/srt; asking explicitly keeps the parse below deterministic.
  outbound.append('response_format', 'json');

  let res: Response;
  try {
    res = await fetch(provider.url, {
      method: 'POST',
      headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : undefined,
      body: outbound,
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (err) {
    const aborted = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return Response.json(
      {
        error: aborted
          ? `Transcription timed out after ${PROVIDER_TIMEOUT_MS / 1000}s (${provider.label}).`
          : `Could not reach the ${provider.label} transcription endpoint: ${describe(err)}`,
      },
      { status: 502 }
    );
  }

  const body = await res.text().catch(() => '');

  if (!res.ok) {
    return Response.json(
      {
        error: `Transcription provider failed (${res.status}): ${summarize(body)}`,
      },
      // Relay auth/quota/payload failures at their own status so a bad key
      // reads as a bad key, not as a generic gateway fault.
      { status: res.status === 401 || res.status === 403 || res.status === 429 ? res.status : 502 }
    );
  }

  const text = extractText(body, res.headers.get('content-type'));
  if (text === null) {
    return Response.json(
      { error: `Transcription provider returned an unreadable body: ${summarize(body)}` },
      { status: 502 }
    );
  }

  // An empty transcript is a real outcome (silence, a stray tap). Return it
  // honestly — VoiceRecorder already surfaces "Transcription returned empty
  // text" rather than pasting nothing into the composer. Never invent words.
  return Response.json({ text });
}

/**
 * Pull the transcript out of a successful provider response. JSON `{ text }`
 * is the OpenAI shape. A text/plain body is accepted as the transcript itself
 * (some local servers ignore response_format) — but ONLY when the server said
 * text/plain, so an HTML error page served with a 200 can never be mistaken
 * for a transcription. Returns null when neither applies.
 */
export function extractText(body: string, contentType: string | null): string | null {
  const ct = baseMime(contentType);
  if (ct === 'application/json' || body.trimStart().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === 'object') {
        const t = (parsed as { text?: unknown }).text;
        if (typeof t === 'string') return t.trim();
      }
    } catch {
      /* fall through */
    }
    return null;
  }
  if (ct === 'text/plain') return body.trim();
  return null;
}

function describe(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, 120);
}

/** Keep relayed provider errors short — VoiceRecorder only shows 200 chars. */
function summarize(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 120) || '(empty body)';
}

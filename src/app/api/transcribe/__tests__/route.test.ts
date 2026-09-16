// ═══════════════════════════════════════════════════════════════════════════
// transcribe route — against a MOCKED provider. No test here ever touches a
// real transcription API: every outbound call goes through a vi.spyOn'd
// globalThis.fetch, and the only credential that appears is the obviously-fake
// low-entropy literal `test-key` (a real-looking key would trip the repo's
// gitleaks CI gate, and a public repo should never carry one anyway).
//
// Pins the contract VoiceRecorder.tsx actually speaks:
//   POST multipart, ONE part named `audio`, MediaRecorder mime types, and a
//   `{ text }` JSON reply. Plus the three refusals that must never become
//   silent: unconfigured, oversized, wrong type.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockAuth = vi.fn();
vi.mock('@/lib/auth-timeout', () => ({
  authWithTimeout: () => mockAuth(),
}));

import { POST, resolveProvider, resolveAudioMime, baseMime, extractText } from '../route';

const AUTHED = { user: { id: 'user-1', email: 'user@example.com' } };

/** The env keys this route reads — cleared before every test so one case can
 *  never leak configuration into the next. */
const ENV_KEYS = [
  'TRANSCRIBE_PROVIDER',
  'TRANSCRIBE_URL',
  'TRANSCRIBE_MODEL',
  'OPENAI_API_KEY',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.restoreAllMocks();
  mockAuth.mockReset();
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

/**
 * A Request whose formData() yields exactly what VoiceRecorder builds:
 * `fd.append('audio', blob, 'voice-<ts>.webm')`. We stub formData() rather
 * than round-tripping multipart bytes so the oversize case does not have to
 * serialize 26MB, while the route still walks its real code path.
 */
function audioRequest(
  file: File | null,
  field = 'audio'
): Request {
  const fd = new FormData();
  if (file) fd.append(field, file, file.name);
  return {
    formData: async () => fd,
  } as unknown as Request;
}

function voiceFile(
  bytes = 2048,
  type = 'audio/webm;codecs=opus',
  name = 'voice-1750000000000.webm'
): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function providerJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Auth ───────────────────────────────────────────────────────────────────

describe('POST /api/transcribe — auth', () => {
  it('401s without calling any provider when unauthenticated', async () => {
    mockAuth.mockResolvedValue(null);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    process.env.TRANSCRIBE_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'test-key';

    const res = await POST(audioRequest(voiceFile()));

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── Unconfigured: clear, actionable, never silent, never faked ─────────────

describe('POST /api/transcribe — unconfigured', () => {
  beforeEach(() => mockAuth.mockResolvedValue(AUTHED));

  it('501s naming BOTH provider paths when TRANSCRIBE_PROVIDER is unset', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const res = await POST(audioRequest(voiceFile()));

    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error).toContain('TRANSCRIBE_PROVIDER=openai');
    expect(body.error).toContain('OPENAI_API_KEY');
    expect(body.error).toContain('TRANSCRIBE_PROVIDER=local');
    expect(body.error).toContain('TRANSCRIBE_URL');
    // Not a fake transcript, and not a silent success.
    expect(body.text).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the error inside the 200-char window VoiceRecorder renders', async () => {
    // VoiceRecorder does res.text().slice(0, 200) on a non-ok response, so an
    // error longer than that gets its actionable half cut off.
    const res = await POST(audioRequest(voiceFile()));
    const raw = await res.text();
    expect(raw.length).toBeLessThanOrEqual(200);
  });

  it('501s naming OPENAI_API_KEY when provider=openai but the key is missing', async () => {
    process.env.TRANSCRIBE_PROVIDER = 'openai';
    const res = await POST(audioRequest(voiceFile()));
    expect(res.status).toBe(501);
    expect((await res.json()).error).toContain('OPENAI_API_KEY');
  });

  it('501s naming TRANSCRIBE_URL when provider=local but the URL is missing', async () => {
    process.env.TRANSCRIBE_PROVIDER = 'local';
    const res = await POST(audioRequest(voiceFile()));
    expect(res.status).toBe(501);
    expect((await res.json()).error).toContain('TRANSCRIBE_URL');
  });

  it('501s on an unsupported provider value and lists the supported ones', async () => {
    process.env.TRANSCRIBE_PROVIDER = 'whisper-cloud';
    const res = await POST(audioRequest(voiceFile()));
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error).toContain('whisper-cloud');
    expect(body.error).toContain('openai, local');
  });
});

// ── Upload validation ──────────────────────────────────────────────────────

describe('POST /api/transcribe — upload validation', () => {
  beforeEach(() => {
    mockAuth.mockResolvedValue(AUTHED);
    process.env.TRANSCRIBE_PROVIDER = 'local';
    process.env.TRANSCRIBE_URL = 'http://127.0.0.1:8080';
  });

  it('413s an oversized upload and never forwards it', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const big = voiceFile(26 * 1024 * 1024);

    const res = await POST(audioRequest(big));

    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/limit is 25MB/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('415s an upload whose type is not on the audio allowlist', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const notAudio = new File([new Uint8Array(64)], 'payload.pdf', {
      type: 'application/pdf',
    });

    const res = await POST(audioRequest(notAudio));

    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.error).toContain('application/pdf');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('415s a video container even though MediaRecorder can produce one', async () => {
    const res = await POST(
      audioRequest(new File([new Uint8Array(64)], 'clip.webm', { type: 'video/webm' }))
    );
    expect(res.status).toBe(415);
  });

  it('400s when the audio part is missing, naming the expected field', async () => {
    const res = await POST(audioRequest(null));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('"audio"');
  });

  it('400s when the part is posted under the wrong field name', async () => {
    const res = await POST(audioRequest(voiceFile(), 'file'));
    expect(res.status).toBe(400);
  });

  it('400s an empty recording', async () => {
    const res = await POST(audioRequest(voiceFile(0)));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/empty/i);
  });

  it('400s a body that is not multipart at all', async () => {
    const bad = {
      formData: async () => {
        throw new TypeError('Could not parse content as FormData.');
      },
    } as unknown as Request;
    const res = await POST(bad);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/multipart/i);
  });
});

// ── openai provider ────────────────────────────────────────────────────────

describe('POST /api/transcribe — provider=openai', () => {
  beforeEach(() => {
    mockAuth.mockResolvedValue(AUTHED);
    process.env.TRANSCRIBE_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'test-key';
  });

  it('posts multipart to the OpenAI audio endpoint with a bearer key and returns { text }', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(providerJson({ text: '  hello from the mic  ' }));

    const res = await POST(audioRequest(voiceFile()));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'hello from the mic' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');

    const sent = init.body as FormData;
    expect(sent).toBeInstanceOf(FormData);
    const file = sent.get('file');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('voice-1750000000000.webm');
    expect(sent.get('model')).toBe('whisper-1');
    expect(sent.get('response_format')).toBe('json');
  });

  it('honors TRANSCRIBE_MODEL', async () => {
    process.env.TRANSCRIBE_MODEL = 'gpt-4o-transcribe';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(providerJson({ text: 'ok' }));

    await POST(audioRequest(voiceFile()));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.body as FormData).get('model')).toBe('gpt-4o-transcribe');
  });

  it('relays a provider 401 as 401 so a bad key reads as a bad key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      providerJson({ error: { message: 'Incorrect API key provided' } }, 401)
    );
    const res = await POST(audioRequest(voiceFile()));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toContain('Incorrect API key');
  });

  it('relays a provider 500 as a 502 with the upstream detail', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('upstream exploded', { status: 500 })
    );
    const res = await POST(audioRequest(voiceFile()));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('upstream exploded');
  });

  it('502s when the network never produced a response', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      })
    );
    const res = await POST(audioRequest(voiceFile()));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/could not reach/i);
  });
});

// ── local provider ─────────────────────────────────────────────────────────

describe('POST /api/transcribe — provider=local', () => {
  beforeEach(() => {
    mockAuth.mockResolvedValue(AUTHED);
    process.env.TRANSCRIBE_PROVIDER = 'local';
  });

  it('appends the OpenAI-compatible path to a bare origin and sends NO auth header', async () => {
    process.env.TRANSCRIBE_URL = 'http://127.0.0.1:8080';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(providerJson({ text: 'local transcript' }));

    const res = await POST(audioRequest(voiceFile()));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'local transcript' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8080/v1/audio/transcriptions');
    expect(init.headers).toBeUndefined();
  });

  it('uses a URL that already carries a path verbatim (whisper.cpp /inference)', async () => {
    process.env.TRANSCRIBE_URL = 'http://127.0.0.1:8080/inference';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(providerJson({ text: 'x' }));

    await POST(audioRequest(voiceFile()));

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://127.0.0.1:8080/inference');
  });

  it('accepts a text/plain transcript from a server that ignores response_format', async () => {
    process.env.TRANSCRIBE_URL = 'http://127.0.0.1:8080';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('  plain text transcript\n', {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    );

    const res = await POST(audioRequest(voiceFile()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'plain text transcript' });
  });

  it('refuses to treat an HTML 200 as a transcript', async () => {
    process.env.TRANSCRIBE_URL = 'http://127.0.0.1:8080';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html><body>Gateway</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    );

    const res = await POST(audioRequest(voiceFile()));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/unreadable/i);
    expect(body.text).toBeUndefined();
  });

  it('passes an empty transcript through honestly instead of inventing words', async () => {
    process.env.TRANSCRIBE_URL = 'http://127.0.0.1:8080';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerJson({ text: '   ' }));

    const res = await POST(audioRequest(voiceFile()));
    expect(res.status).toBe(200);
    // VoiceRecorder turns this into "Transcription returned empty text".
    expect(await res.json()).toEqual({ text: '' });
  });
});

// ── Every MediaRecorder mime VoiceRecorder can produce is accepted ──────────

describe('mime handling', () => {
  const MEDIARECORDER_MIMES = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];

  it.each(MEDIARECORDER_MIMES)('accepts %s', async (mime) => {
    mockAuth.mockResolvedValue(AUTHED);
    process.env.TRANSCRIBE_PROVIDER = 'local';
    process.env.TRANSCRIBE_URL = 'http://127.0.0.1:8080';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerJson({ text: 'ok' }));

    const res = await POST(audioRequest(voiceFile(512, mime, 'voice-1.webm')));
    expect(res.status).toBe(200);
  });

  it('strips the codecs parameter before matching', () => {
    expect(baseMime('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(baseMime('AUDIO/WEBM; codecs=opus')).toBe('audio/webm');
    expect(baseMime(null)).toBe('');
  });

  it('falls back to the filename extension only when no type was declared', () => {
    expect(resolveAudioMime('', 'voice-1.webm')).toBe('audio/webm');
    expect(resolveAudioMime(null, 'voice-1.m4a')).toBe('audio/m4a');
    // A declared non-audio type is a refusal, never an extension guess.
    expect(resolveAudioMime('application/pdf', 'voice-1.webm')).toBeNull();
    expect(resolveAudioMime('', 'voice-1.exe')).toBeNull();
  });
});

// ── Pure helpers ───────────────────────────────────────────────────────────

describe('resolveProvider', () => {
  it('reports unconfigured rather than defaulting to a vendor', () => {
    const p = resolveProvider({} as NodeJS.ProcessEnv);
    expect(p.ok).toBe(false);
  });

  it('rejects a TRANSCRIBE_URL that is not a URL', () => {
    const p = resolveProvider({
      TRANSCRIBE_PROVIDER: 'local',
      TRANSCRIBE_URL: 'not a url',
    } as NodeJS.ProcessEnv);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error).toContain('not a valid URL');
  });
});

describe('extractText', () => {
  it('reads { text } out of a JSON body', () => {
    expect(extractText('{"text":" hi "}', 'application/json')).toBe('hi');
  });
  it('returns null for JSON with no text key', () => {
    expect(extractText('{"error":"nope"}', 'application/json')).toBeNull();
  });
  it('returns null for an unparseable body', () => {
    expect(extractText('<html>', 'text/html')).toBeNull();
  });
});

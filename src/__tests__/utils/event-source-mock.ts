// ═══════════════════════════════════════════════════════════════════════════
// event-source-mock.ts — pushable EventSource for unit tests.
//
// The real cockpit uses two SSE transports:
//   - POST transport (default, `connectViaPost` in SessionTerminal) — uses
//     `fetch()` with a ReadableStream body so we can send a JWT in the body.
//   - GET transport (legacy / `NEXT_PUBLIC_BRIDGE_STREAM_METHOD=get`) — uses
//     a native `new EventSource(url)`.
//
// This mock backs the GET transport when tests opt into it. The POST
// transport gets its own fetch-stream mock (see `post-stream-mock.ts`).
//
// Usage:
//
//   import { installMockEventSource, getLastMockEventSource } from
//     '@/__tests__/utils/event-source-mock';
//   installMockEventSource();
//   render(<Component />);
//   const es = getLastMockEventSource()!;
//   es.emit({ type: 'message', data: 'hello' });
//   es.emitOpen();
//   es.emitError();
// ═══════════════════════════════════════════════════════════════════════════

export interface MockSseEvent {
  type?: string;
  data?: string;
  lastEventId?: string;
}

export class MockEventSource {
  url: string;
  readyState: number = 0; // CONNECTING
  withCredentials: boolean = false;
  onopen: ((this: MockEventSource, ev: Event) => unknown) | null = null;
  onmessage: ((this: MockEventSource, ev: MessageEvent) => unknown) | null = null;
  onerror: ((this: MockEventSource, ev: Event) => unknown) | null = null;
  private listeners = new Map<
    string,
    Array<(ev: MessageEvent) => void>
  >();

  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  CONNECTING = 0;
  OPEN = 1;
  CLOSED = 2;

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = !!init?.withCredentials;
  }

  addEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    const arr = this.listeners.get(type) || [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }

  removeEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    const arr = this.listeners.get(type);
    if (!arr) return;
    const idx = arr.indexOf(listener);
    if (idx >= 0) arr.splice(idx, 1);
  }

  close(): void {
    this.readyState = MockEventSource.CLOSED;
  }

  // ── Test helpers ─────────────────────────────────────────────────────────

  emitOpen(): void {
    this.readyState = MockEventSource.OPEN;
    if (this.onopen) this.onopen.call(this, new Event('open'));
  }

  emitError(): void {
    if (this.onerror) this.onerror.call(this, new Event('error'));
  }

  /**
   * Push an SSE event into the stream. `type` defaults to 'message' which
   * fires onmessage; named events (e.g. 'exit', 'crashed') fire via
   * addEventListener handlers ONLY (matching the browser EventSource spec).
   */
  emit(ev: MockSseEvent): void {
    const evt = new MessageEvent(ev.type || 'message', {
      data: ev.data ?? '',
      lastEventId: ev.lastEventId,
    });
    if (!ev.type || ev.type === 'message') {
      if (this.onmessage) this.onmessage.call(this, evt);
    }
    const named = this.listeners.get(ev.type || 'message');
    if (named) {
      for (const fn of named) fn(evt);
    }
  }
}

let lastInstance: MockEventSource | null = null;
let allInstances: MockEventSource[] = [];

export function installMockEventSource(): void {
  lastInstance = null;
  allInstances = [];
  // @ts-expect-error: replacing global
  globalThis.EventSource = function (
    url: string,
    init?: { withCredentials?: boolean }
  ) {
    const m = new MockEventSource(url, init);
    lastInstance = m;
    allInstances.push(m);
    return m;
  } as unknown as typeof EventSource;
  // @ts-expect-error: align with the EventSource static interface
  globalThis.EventSource.CONNECTING = 0;
  // @ts-expect-error
  globalThis.EventSource.OPEN = 1;
  // @ts-expect-error
  globalThis.EventSource.CLOSED = 2;
}

export function getLastMockEventSource(): MockEventSource | null {
  return lastInstance;
}

export function getAllMockEventSources(): MockEventSource[] {
  return allInstances;
}

export function resetMockEventSource(): void {
  lastInstance = null;
  allInstances = [];
}

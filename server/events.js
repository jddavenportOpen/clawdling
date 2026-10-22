// Server-Sent Events fan-out plus the append-only events.jsonl log.
import fs from 'node:fs';
import { readTail } from './util.js';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export class EventBus {
  /** @param {{file: string, logger?: any}} opts */
  constructor({ file, logger }) {
    this.file = file;
    this.logger = logger;
    this.clients = new Set();
    this.listeners = new Set();
  }

  /** Push `{type, data}` to every SSE client and in-process listener. */
  publish(type, data) {
    const frame = `data: ${JSON.stringify({ type, data })}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(frame);
      } catch {
        this.clients.delete(res);
      }
    }
    for (const fn of this.listeners) {
      try {
        fn(type, data);
      } catch (err) {
        this.logger?.warn?.(`event listener failed: ${err.message}`);
      }
    }
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Append one entry to events.jsonl. Never throws. */
  record(entry) {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
      try {
        if (fs.statSync(this.file).size > MAX_LOG_BYTES) fs.renameSync(this.file, this.file + '.1');
      } catch {
        // file does not exist yet
      }
      fs.appendFileSync(this.file, line, { mode: 0o600 });
    } catch (err) {
      this.logger?.warn?.(`could not write events log: ${err.message}`);
    }
  }

  /** Most recent entries (newest last), optionally filtered by type. */
  recent({ type, limit = 30 } = {}) {
    const text = readTail(this.file, 512 * 1024);
    const out = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (!type || e.type === type) out.push(e);
      } catch {
        // skip torn line
      }
    }
    return out.slice(-limit);
  }

  attachSse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n: connected\n\n');
    this.clients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        // closed
      }
    }, 20000);
    ping.unref?.();
    const done = () => {
      clearInterval(ping);
      this.clients.delete(res);
    };
    req.on('close', done);
    res.on('error', done);
  }

  closeAll() {
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
  }
}

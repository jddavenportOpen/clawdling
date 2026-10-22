// A local stand-in for the Telegram Bot API. Tests point TELEGRAM_API_BASE at it.
import http from 'node:http';

export async function startTelegramStub({ token, username = 'clawdling_test_bot' } = {}) {
  const updates = [];
  const calls = [];
  const waiters = [];
  let nextId = 1;

  const flushWaiters = () => {
    while (waiters.length && updates.length) {
      const w = waiters.shift();
      clearTimeout(w.timer);
      w.resolve();
    }
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
      const send = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (!m) return send(404, { ok: false, description: 'Not Found' });
      if (m[1] !== token) return send(401, { ok: false, error_code: 401, description: 'Unauthorized' });
      let params = {};
      try {
        params = body ? JSON.parse(body) : {};
      } catch {
        // ignore
      }
      const method = m[2];
      calls.push({ method, params });
      if (method === 'getMe') return send(200, { ok: true, result: { id: 42, is_bot: true, username } });
      if (method === 'getUpdates') {
        const offset = params.offset || 0;
        const ready = () => updates.filter((u) => u.update_id >= offset);
        if (!ready().length) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, Math.min((params.timeout || 0) * 1000, 2000));
            waiters.push({ resolve, timer });
          });
        }
        return send(200, { ok: true, result: ready() });
      }
      if (method === 'sendMessage' || method === 'sendChatAction') return send(200, { ok: true, result: { message_id: nextId++ } });
      return send(400, { ok: false, description: `unknown method ${method}` });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  let updateId = 1000;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    /** Queue an incoming message as Telegram would deliver it. */
    message(chatId, text, { type = 'private' } = {}) {
      updates.push({ update_id: updateId++, message: { message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type }, from: { id: chatId, is_bot: false, first_name: 'Test' }, text } });
      flushWaiters();
    },
    sent(chatId) {
      return calls.filter((c) => c.method === 'sendMessage' && (chatId === undefined || String(c.params.chat_id) === String(chatId)));
    },
    async close() {
      for (const w of waiters.splice(0)) {
        clearTimeout(w.timer);
        w.resolve();
      }
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

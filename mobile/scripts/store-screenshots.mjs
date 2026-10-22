// App Store screenshots from the web build, against the mock server (real-looking data, no DEMO
// badge). Each scene is captured at the device's exact point size and scale, then framed with a
// caption at the store's required pixel size:
//   iPhone 6.9"  1320 x 2868   (440 x 956 pt @3x)
//   iPhone 6.5"  1284 x 2778   (428 x 926 pt @3x)
//   iPad 13"     2064 x 2752   (1032 x 1376 pt @2x)  (required because the app supports iPad)
// Usage: npm run export:web && npm run store-shots   -> test/screenshots/store/<device>/NN-scene.png
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startMockServer } from '../test/mock-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist-web');
const outRoot = path.join(root, 'test', 'screenshots', 'store');

const DEVICES = [
  { id: 'iphone-6.9', width: 440, height: 956, scale: 3 },
  { id: 'iphone-6.5', width: 428, height: 926, scale: 3 },
  { id: 'ipad-13', width: 1032, height: 1376, scale: 2 },
];

const SCENES = [
  { id: 'home', title: 'Every agent, one tap away', sub: 'See what needs you and what is running.' },
  { id: 'chat', title: 'Chat with any session', sub: 'Replies, code and every step your agents took.' },
  { id: 'donna', title: 'Just ask Donna', sub: 'Your chief of staff routes it to the right agent.' },
  { id: 'needs', title: "Know when you're needed", sub: 'Questions and approvals come first.' },
  { id: 'agents', title: 'An agent for every part of life', sub: 'Domains and projects, each with its own memory.' },
  { id: 'connect', title: 'Your computer, your agents', sub: 'Pair with a QR code. No accounts, no cloud.' },
];

// The phone pretends to reach a computer on the home Wi-Fi; Playwright forwards that address to
// the mock server, so the screenshots show a realistic address instead of 127.0.0.1.
const LAN = 'http://192.168.1.20:4747';

const only = process.argv.slice(2);

async function control(mock, what, body = {}) {
  await fetch(`${mock.url}/__mock/${what}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function connect(page, mock) {
  await page.goto(`${mock.url}/`);
  await page.getByTestId('connect-screen').waitFor();
  await page.evaluate(
    ([url, token]) => localStorage.setItem('clawdling.connection.v1', JSON.stringify({ mode: 'live', url, token })),
    [LAN, mock.token],
  );
  await page.goto(`${mock.url}/home`);
  await page.getByTestId('home-screen').waitFor();
  await page.getByText('Categorize September spending').first().waitFor();
}

async function settle(page) {
  await page.waitForTimeout(700);
}

/** Bring the app to a scene and return a PNG of the bare UI. */
async function capture(page, mock, scene) {
  await control(mock, 'reset');
  await page.evaluate(() => localStorage.clear()).catch(() => {});
  if (scene === 'connect') {
    await page.goto(`${mock.url}/`);
    await page.getByTestId('connect-screen').waitFor();
    await settle(page);
    return page.screenshot();
  }
  await connect(page, mock);
  if (scene === 'home') {
    await settle(page);
    return page.screenshot();
  }
  if (scene === 'chat') {
    await page.getByText('Fix the broken pricing page links').first().click();
    await page.getByTestId('chat-screen').getByTestId('typing-row').waitFor();
    await settle(page);
    return page.screenshot();
  }
  if (scene === 'needs') {
    await page.getByText('Categorize September spending').first().click();
    await page.getByTestId('needs-card').waitFor();
    await settle(page);
    return page.screenshot();
  }
  if (scene === 'donna') {
    await page.getByTestId('ask-donna').click();
    const donna = page.getByTestId('donna-screen');
    await donna.getByText('What\'s waiting on me?').waitFor();
    await page.getByTestId('composer-input').fill('Have Health move Thursday to Friday morning');
    await page.getByTestId('composer-send').click();
    await donna.getByText(/^Health is on it/).waitFor({ timeout: 15_000 });
    await settle(page);
    return page.screenshot();
  }
  if (scene === 'agents') {
    await page.getByTestId('section-agents').scrollIntoViewIfNeeded();
    await page.getByTestId('agent-row-kitchen-remodel').scrollIntoViewIfNeeded();
    await settle(page);
    return page.screenshot();
  }
  throw new Error(`unknown scene ${scene}`);
}

function frameHtml({ width, height, ipad }, shot, title, sub) {
  const pad = Math.round(width * (ipad ? 0.07 : 0.075));
  const titleSize = Math.round(width * (ipad ? 0.046 : 0.064));
  const subSize = Math.round(width * (ipad ? 0.024 : 0.036));
  const uiScale = ipad ? 0.8 : 0.79;
  const uiW = Math.round(width * uiScale);
  const uiH = Math.round(height * uiScale);
  const radius = Math.round(width * (ipad ? 0.035 : 0.075));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}
    body{background:radial-gradient(120% 60% at 50% 0%, rgba(155,140,255,0.22), rgba(155,140,255,0) 60%), linear-gradient(180deg,#171a21 0%,#0c0e11 100%);
      font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",system-ui,sans-serif;color:#eef0f3;-webkit-font-smoothing:antialiased}
    .cap{position:absolute;left:${pad}px;right:${pad}px;top:${Math.round(height * 0.055)}px;text-align:center}
    h1{margin:0;font-size:${titleSize}px;line-height:1.12;font-weight:700;letter-spacing:-0.01em}
    p{margin:${Math.round(subSize * 0.6)}px 0 0;font-size:${subSize}px;line-height:1.3;color:#a9b0bb;font-weight:500}
    .ui{position:absolute;left:${Math.round((width - uiW) / 2)}px;bottom:${Math.round(height * 0.03)}px;width:${uiW}px;height:${uiH}px;
      border-radius:${radius}px;overflow:hidden;box-shadow:0 ${Math.round(width * 0.02)}px ${Math.round(width * 0.06)}px rgba(0,0,0,0.55),0 0 0 ${Math.max(2, Math.round(width * 0.003))}px rgba(214,222,235,0.16)}
    .ui img{width:100%;height:100%;display:block}
  </style></head><body>
    <div class="cap"><h1>${title}</h1><p>${sub}</p></div>
    <div class="ui"><img src="data:image/png;base64,${shot.toString('base64')}"></div>
  </body></html>`;
}

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('No web build: run `npm run export:web` first.');
  process.exit(1);
}

const mock = await startMockServer({ staticDir: dist, replyMs: 600, donnaMs: 900, cors: true });
const browser = await chromium.launch();
try {
  for (const d of DEVICES) {
    if (only.length && !only.includes(d.id)) continue;
    const outDir = path.join(outRoot, d.id);
    fs.mkdirSync(outDir, { recursive: true });
    const ctx = await browser.newContext({ viewport: { width: d.width, height: d.height }, deviceScaleFactor: d.scale, colorScheme: 'dark' });
    await ctx.route(`${LAN}/**`, (route) => route.continue({ url: route.request().url().replace(LAN, mock.url) }));
    const page = await ctx.newPage();
    const framer = await browser.newPage({ viewport: { width: d.width * d.scale, height: d.height * d.scale }, deviceScaleFactor: 1 });
    for (const [i, s] of SCENES.entries()) {
      const shot = await capture(page, mock, s.id);
      fs.writeFileSync(path.join(outDir, `raw-${String(i + 1).padStart(2, '0')}-${s.id}.png`), shot);
      const size = { width: d.width * d.scale, height: d.height * d.scale, ipad: d.id.startsWith('ipad') };
      await framer.setContent(frameHtml(size, shot, s.title, s.sub), { waitUntil: 'load' });
      const file = path.join(outDir, `${String(i + 1).padStart(2, '0')}-${s.id}.png`);
      await framer.screenshot({ path: file, clip: { x: 0, y: 0, width: size.width, height: size.height } });
      console.log('wrote', path.relative(root, file));
    }
    await framer.close();
    await ctx.close();
  }
} finally {
  await browser.close();
  await mock.close();
}

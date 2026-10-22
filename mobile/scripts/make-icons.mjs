// Render the app icon, splash mark, in-app mark and favicon from assets/brand/mark.svg.
// Uses Playwright's Chromium (already a dev dependency) so it runs the same on macOS and Linux.
//   node scripts/make-icons.mjs [--preview out.png]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mark = fs.readFileSync(path.join(root, 'assets/brand/mark.svg'), 'utf8');
const markInner = mark.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<!--[\s\S]*?-->/g, '');

// The full-bleed icon: graphite with a faint violet glow; iOS applies its own corner mask.
function iconSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1d2129"/>
      <stop offset="1" stop-color="#0c0e11"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.46" cy="0.5" r="0.46">
      <stop offset="0" stop-color="#9b8cff" stop-opacity="0.26"/>
      <stop offset="0.55" stop-color="#9b8cff" stop-opacity="0.07"/>
      <stop offset="1" stop-color="#9b8cff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#bg)"/>
  <rect width="1024" height="1024" fill="url(#glow)"/>
  <g transform="translate(44 24) scale(30)">${markInner}</g>
</svg>`;
}

function markOnly(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="5.2 5.6 21.2 21.2">${markInner}</svg>`;
}

async function render(page, svg, size, out, { transparent = false } = {}) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;padding:0;background:${transparent ? 'transparent' : '#0d0f12'}}svg{display:block}</style></head><body>${svg}</body></html>`);
  await page.screenshot({ path: out, omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
  console.log('wrote', path.relative(root, out));
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const a = (f) => path.join(root, 'assets', f);
  const preview = process.argv.indexOf('--preview');
  if (preview > 0) {
    await render(page, iconSvg(1024), 1024, process.argv[preview + 1]);
  } else {
    await render(page, iconSvg(1024), 1024, a('icon.png'));
    await render(page, iconSvg(48), 48, a('favicon.png'));
    await render(page, markOnly(512), 512, a('splash-icon.png'), { transparent: true });
    await render(page, markOnly(192), 192, a('mark.png'), { transparent: true });
  }
} finally {
  await browser.close();
}

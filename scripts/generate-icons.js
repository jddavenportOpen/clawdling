#!/usr/bin/env node
/**
 * Generate Clawd PWA icons.
 *
 * Renders an SVG ("C" glyph on dark background) and rasterises to PNG
 * using ImageMagick (`magick`) if available, otherwise `convert`.
 *
 * Outputs:
 *   public/icons/icon-192.png              (192x192, maskable-any)
 *   public/icons/icon-512.png              (512x512, maskable-any)
 *   public/icons/apple-touch-icon.png      (180x180)
 *
 * Usage: node scripts/generate-icons.js
 *
 * No npm deps. Requires ImageMagick (homebrew: `brew install imagemagick`).
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'icons');

// Dark palette per PWA spec (#0a0a0a) with cyan "C" matching app theme.
const BG = '#0a0a0a';
const FG = '#00FFE0';

/** Return an SVG string for a square icon of `size` px. */
function svg(size) {
  // Maskable-safe: glyph stays inside the central 80% (safe zone).
  // Draw "C" as an SVG stroked arc so we don't depend on ImageMagick's Freetype.
  const r = Math.round(size * 0.18);
  const cx = size / 2;
  const cy = size / 2;
  // Ring radius sized to fit inside safe zone.
  const ringR = size * 0.32;
  const strokeW = Math.max(4, Math.round(size * 0.09));
  // Open arc from 30deg to 330deg (leaves a gap on the right, forming a "C").
  const startA = (30 * Math.PI) / 180;
  const endA = (330 * Math.PI) / 180;
  const x1 = (cx + ringR * Math.cos(startA)).toFixed(2);
  const y1 = (cy - ringR * Math.sin(startA)).toFixed(2);
  const x2 = (cx + ringR * Math.cos(endA)).toFixed(2);
  const y2 = (cy - ringR * Math.sin(endA)).toFixed(2);
  // largeArcFlag=1 because the arc spans > 180 degrees; sweepFlag=0 (counter-clockwise in SVG coords).
  const arcPath = `M ${x1} ${y1} A ${ringR} ${ringR} 0 1 0 ${x2} ${y2}`;
  const borderW = Math.max(2, Math.round(size * 0.015));
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect x="0" y="0" width="${size}" height="${size}" rx="${r}" ry="${r}" fill="${BG}"/>
  <rect x="${borderW / 2}" y="${borderW / 2}" width="${size - borderW}" height="${size - borderW}" rx="${r}" ry="${r}" fill="none" stroke="${FG}" stroke-opacity="0.35" stroke-width="${borderW}"/>
  <path d="${arcPath}" fill="none" stroke="${FG}" stroke-width="${strokeW}" stroke-linecap="round"/>
</svg>`;
}

function findMagickCommand() {
  for (const bin of ['magick', 'convert']) {
    try {
      execSync(`command -v ${bin}`, { stdio: 'ignore' });
      return bin;
    } catch {
      /* not found */
    }
  }
  throw new Error(
    'Neither `magick` nor `convert` (ImageMagick) is on PATH. Install via `brew install imagemagick`.'
  );
}

function renderPng(size, outPath, magickBin) {
  const tmp = path.join(os.tmpdir(), `clawd-icon-${size}-${Date.now()}.svg`);
  fs.writeFileSync(tmp, svg(size), 'utf8');
  try {
    // `magick` unified CLI: `magick input.svg -resize ... output.png`
    // Legacy `convert`: same args (minus the `magick` prefix).
    const cmd =
      magickBin === 'magick'
        ? `magick -background none -size ${size}x${size} ${tmp} ${outPath}`
        : `convert -background none -size ${size}x${size} ${tmp} ${outPath}`;
    execSync(cmd, { stdio: 'inherit' });
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const bin = findMagickCommand();
  const targets = [
    { size: 192, file: 'icon-192.png' },
    { size: 512, file: 'icon-512.png' },
    { size: 180, file: 'apple-touch-icon.png' },
  ];
  for (const t of targets) {
    const outPath = path.join(OUT_DIR, t.file);
    renderPng(t.size, outPath, bin);
    console.log(`wrote ${path.relative(ROOT, outPath)}`);
  }
}

main();

// ═══════════════════════════════════════════════════════════════════════════
// viewport-fit.test.ts — CAT-07 keystone regression (mobile safe-area, batch B).
//
// WITHOUT `viewportFit: 'cover'` on the root `viewport` export, iOS Safari
// resolves EVERY `env(safe-area-inset-*)` to 0px, silently nullifying all the
// mobile safe-area handling (MobileTabBar pb-[env(safe-area-inset-bottom)], the
// composer's `.composer-safe-bottom`, `.safe-*`). The result: the composer send
// row + the bottom tab bar sit UNDER the iPhone home indicator, untappable.
//
// We assert via source-string because `src/app/layout.tsx` imports the geist
// font package (a directory-style ESM import) which cannot be evaluated under
// vitest's node resolver — so the `viewport` object can't be imported directly.
// A single-line config keystone is exactly the kind of thing that silently
// regresses on a refactor; this guard makes its removal fail CI.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const layoutSrc = readFileSync(path.join(here, '..', 'layout.tsx'), 'utf8');

describe('layout viewport export — CAT-07 (safe-area keystone)', () => {
  it('declares viewportFit: "cover" so iOS resolves non-zero safe-area insets', () => {
    // The whole mobile safe-area stack is dead without this single property.
    expect(layoutSrc).toMatch(/viewportFit:\s*['"]cover['"]/);
  });

  it('keeps the property inside the `viewport` export (not stray text)', () => {
    const viewportBlock = layoutSrc.match(
      /export const viewport:\s*Viewport\s*=\s*\{[\s\S]*?\};/
    );
    expect(viewportBlock, 'viewport export block must exist').toBeTruthy();
    expect(viewportBlock![0]).toMatch(/viewportFit:\s*['"]cover['"]/);
  });
});

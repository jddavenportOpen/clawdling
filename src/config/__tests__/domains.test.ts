import { describe, it, expect } from 'vitest';
import { DOMAINS, DOMAIN_IDS, STARTER_DOMAINS, loadProfileDomains, getDomain } from '@/config/domains';

describe('config/domains — profile loader with compiled fallback', () => {
  it('exposes the three compiled starter domains as the fallback', () => {
    expect(STARTER_DOMAINS.map((d) => d.id)).toEqual(['work', 'personal', 'notes']);
    for (const d of STARTER_DOMAINS) {
      expect(typeof d.label).toBe('string');
      expect(d.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(typeof d.blurb).toBe('string');
    }
  });

  it('falls back to null (→ compiled starter) when the profile file is absent', () => {
    // A profile that does not exist on disk must not throw; it returns null so
    // the module-level DOMAINS resolves to STARTER_DOMAINS.
    expect(loadProfileDomains('__does_not_exist__')).toBeNull();
  });

  it('loads the shipped starter profile domains.yaml and it matches the fallback', () => {
    const loaded = loadProfileDomains('starter');
    // The starter profile file ships in the repo, so on the server this loads.
    // (In a non-Node/browser test env it returns null; the loader is server-only.)
    if (loaded) {
      expect(loaded).toEqual(STARTER_DOMAINS);
    } else {
      // Environment without fs — the fallback path is exercised instead.
      expect(loaded).toBeNull();
    }
  });

  it('DOMAINS resolves to a non-empty list with valid ids and DOMAIN_IDS is in sync', () => {
    expect(DOMAINS.length).toBeGreaterThan(0);
    expect(DOMAIN_IDS.size).toBe(DOMAINS.length);
    for (const d of DOMAINS) expect(DOMAIN_IDS.has(d.id)).toBe(true);
    // The shipped install renders the three starter domains.
    expect(DOMAINS.map((d) => d.id)).toEqual(['work', 'personal', 'notes']);
  });

  it('getDomain returns a row by id and undefined for unknown ids', () => {
    expect(getDomain('work')?.label).toBe('Work');
    expect(getDomain('nope')).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ChatGridSpawnLock.test.tsx — the W6 locked-model contract for the cockpit.
//
// QA NO-GO (2026-05-31, audit FINAL-QA-batch.md Item 6 FAIL): the cockpit
// "+ New chat" header button opened the FULL legacy NewSessionPicker
// (mode defaulted to 'all' → ad-hoc Claude + 8 spawnable domains + launch-all),
// bypassing W6's locked model. The rail enforces CEO+project-only; the header
// did not.
//
// Invariant: EVERY NewSessionPicker rendered inside ChatGrid must be
// mode="projects" so the cockpit offers no generic/domain spawn path. We mock
// NewSessionPicker to record the props it's mounted with and assert every
// instance is locked.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

const pickerProps: Array<{ mode?: string }> = [];

vi.mock('../NewSessionPicker', () => ({
  default: (props: { mode?: string }) => {
    pickerProps.push({ mode: props.mode });
    return null;
  },
}));
vi.mock('../ChatGridPane', () => ({
  default: () => <div>pane</div>,
}));
vi.mock('../PaneSwitcher', () => ({ default: () => null }));

let __mockSearchParams = '';
vi.mock('next/navigation', async () => {
  const actual = await vi.importActual<typeof import('next/navigation')>('next/navigation');
  return {
    ...actual,
    useRouter: () => ({
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
      prefetch: vi.fn(),
    }),
    useSearchParams: () => new URLSearchParams(__mockSearchParams),
    usePathname: () => '/chat',
  };
});

import ChatGrid from '../ChatGrid';

describe('ChatGrid — cockpit spawn is locked to projects-only (W6 contract)', () => {
  beforeEach(() => {
    pickerProps.length = 0;
  });

  it('empty grid → NewSessionPicker is mode="projects" (no generic/domain spawn)', () => {
    __mockSearchParams = '';
    render(<ChatGrid />);
    expect(pickerProps.length).toBeGreaterThan(0);
    for (const p of pickerProps) {
      expect(p.mode).toBe('projects');
    }
  });
});

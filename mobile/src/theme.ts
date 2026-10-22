// Calm graphite, one accent (the cockpit's signal violet), status colour only where it means
// something. Same tokens as the web cockpit so the phone and the Mac feel like one product.

import { Platform, StyleSheet, type TextStyle } from 'react-native';
import type { StatusTone } from './format';

export const colors = {
  bg: '#0d0f12',
  bgRaised: '#111317',
  surface: '#16191e',
  surface2: '#1c2026',
  surface3: '#252a31',
  line: 'rgba(214, 222, 235, 0.085)',
  line2: 'rgba(214, 222, 235, 0.14)',
  line3: 'rgba(214, 222, 235, 0.22)',
  text: '#e5e8ec',
  text2: '#a5acb6',
  text3: '#7d848f',
  accent: '#9b8cff',
  accentStrong: '#b2a7ff',
  accentInk: '#15112c',
  accentSoft: 'rgba(155, 140, 255, 0.14)',
  accentLine: 'rgba(155, 140, 255, 0.55)',
  danger: '#f06a73',
  dangerSoft: 'rgba(240, 106, 115, 0.12)',
  scrim: 'rgba(4, 5, 7, 0.6)',
  userBubble: '#2a2550',
  userBubbleLine: 'rgba(155, 140, 255, 0.32)',
  codeBg: '#0f1115',
} as const;

export const tones: Record<StatusTone, { fg: string; text: string; soft: string }> = {
  working: { fg: '#5aa7f2', text: '#6fb3f5', soft: 'rgba(90, 167, 242, 0.14)' },
  needs: { fg: '#f0b33c', text: '#f2bd55', soft: 'rgba(240, 179, 60, 0.13)' },
  ready: { fg: '#4cc48a', text: '#5fcd97', soft: 'rgba(76, 196, 138, 0.13)' },
  ended: { fg: '#6c737d', text: '#9aa1ab', soft: 'rgba(108, 115, 125, 0.18)' },
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 } as const;

export const radius = { sm: 8, md: 12, lg: 16, xl: 20, pill: 999 } as const;

export const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, SFMono-Regular, Menlo, monospace' });

/** System type scale (San Francisco on iOS). */
export const type = {
  largeTitle: { fontSize: 32, lineHeight: 38, fontWeight: '700', letterSpacing: 0.2, color: colors.text },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700', color: colors.text },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '600', color: colors.text },
  body: { fontSize: 16, lineHeight: 22, fontWeight: '400', color: colors.text },
  callout: { fontSize: 15, lineHeight: 20, fontWeight: '400', color: colors.text2 },
  subhead: { fontSize: 14, lineHeight: 19, fontWeight: '400', color: colors.text2 },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: '400', color: colors.text3 },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500', color: colors.text3 },
  section: { fontSize: 13, lineHeight: 18, fontWeight: '600', color: colors.text2, letterSpacing: 0.3 },
} satisfies Record<string, TextStyle>;

export const hairline = StyleSheet.hairlineWidth;

/** Max content width on iPad and wide windows, so lines stay readable. */
export const CONTENT_MAX = 720;

/** Agent icon names (from agent.json) mapped to Ionicons. Unknown names fall back to a sparkle. */
const AGENT_ICONS: Record<string, string> = {
  chat: 'chatbubbles-outline',
  heart: 'heart-outline',
  briefcase: 'briefcase-outline',
  coins: 'wallet-outline',
  money: 'wallet-outline',
  home: 'home-outline',
  users: 'people-outline',
  book: 'book-outline',
  plane: 'airplane-outline',
  pen: 'create-outline',
  star: 'star-outline',
  code: 'code-slash-outline',
  folder: 'folder-outline',
  terminal: 'terminal-outline',
};

export function agentIcon(icon: string | null | undefined, kind?: string): string {
  if (icon && AGENT_ICONS[icon]) return AGENT_ICONS[icon];
  if (kind === 'chief') return 'chatbubbles-outline';
  if (kind === 'project') return 'folder-outline';
  return 'sparkles-outline';
}

/** A safe agent colour: the agent's own if it is a hex colour, else the accent. */
export function agentColor(color: string | null | undefined): string {
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color : colors.accent;
}

/** `#rrggbb` + alpha → rgba(), for tinted avatar backgrounds. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}

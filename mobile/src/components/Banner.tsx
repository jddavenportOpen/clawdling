import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ApiError } from '../api';
import { colors, radius, tones } from '../theme';
import { Icon } from './Icon';

type Tone = 'warn' | 'error' | 'info';

export function Banner({ tone = 'warn', title, message, action, onAction, testID }: { tone?: Tone; title: string; message?: string | null; action?: string; onAction?: () => void; testID?: string }) {
  const t = TONES[tone];
  return (
    <View style={[styles.box, { backgroundColor: t.bg, borderColor: t.border }]} accessibilityRole="alert" testID={testID}>
      <Icon name={t.icon} size={18} color={t.fg} style={styles.icon} />
      <View style={styles.body}>
        <Text style={[styles.title, { color: t.fg }]}>{title}</Text>
        {message ? <Text style={styles.message}>{message}</Text> : null}
      </View>
      {action && onAction ? (
        <Pressable onPress={onAction} hitSlop={10} accessibilityRole="button" accessibilityLabel={action} style={({ pressed }) => [styles.action, pressed && { opacity: 0.6 }]}>
          <Text style={[styles.actionText, { color: t.fg }]}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function useCountdown(at: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!at) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [at]);
  return at ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
}

/** The "can't reach your computer" banner with a countdown and Retry now. Hidden when healthy. */
export function ConnectionBanner({ error, retryAt, onRetry, host }: { error: ApiError | null; retryAt: number | null; onRetry: () => void; host?: string }) {
  const secs = useCountdown(error && error.retryable ? retryAt : null);
  if (!error || error.kind === 'auth') return null;
  if (error.retryable) {
    const where = host ? ` at ${host}` : '';
    const title = error.kind === 'timeout' ? `Your computer${where} is slow to answer` : `Can't reach your computer${where}`;
    const message =
      error.kind === 'server'
        ? error.message
        : secs !== null && secs > 0
          ? `Retrying in ${secs}s. Check that Clawdling is running and your phone is on the same network or Tailscale.`
          : 'Retrying now…';
    return <Banner tone="warn" title={title} message={message} action="Retry now" onAction={onRetry} testID="retry-banner" />;
  }
  return <Banner tone="error" title="Something went wrong" message={error.message} action="Retry" onAction={onRetry} testID="error-banner" />;
}

const TONES: Record<Tone, { bg: string; fg: string; border: string; icon: string }> = {
  warn: { bg: tones.needs.soft, fg: tones.needs.text, border: 'rgba(240, 179, 60, 0.28)', icon: 'cloud-offline-outline' },
  error: { bg: colors.dangerSoft, fg: colors.danger, border: 'rgba(240, 106, 115, 0.3)', icon: 'alert-circle-outline' },
  info: { bg: colors.accentSoft, fg: colors.accentStrong, border: 'rgba(155, 140, 255, 0.3)', icon: 'information-circle-outline' },
};

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  icon: { marginTop: 1 },
  body: { flex: 1, gap: 2 },
  title: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  message: { fontSize: 13, lineHeight: 18, color: colors.text2 },
  action: { paddingVertical: 2, paddingLeft: 6 },
  actionText: { fontSize: 14, lineHeight: 19, fontWeight: '600' },
});

import { StyleSheet, Text, View } from 'react-native';
import { statusMeta } from '../format';
import { radius, tones } from '../theme';
import type { SessionStatus } from '../types';

export function StatusDot({ status, size = 8 }: { status: SessionStatus; size?: number }) {
  const tone = tones[statusMeta(status).tone];
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: tone.fg }} />;
}

export function StatusPill({ status, compact = false }: { status: SessionStatus; compact?: boolean }) {
  const meta = statusMeta(status);
  const tone = tones[meta.tone];
  return (
    <View
      style={[styles.pill, compact && styles.compact, { backgroundColor: tone.soft }]}
      accessibilityRole="text"
      accessibilityLabel={`Status: ${meta.a11y}`}
      testID={`status-${status}`}
    >
      <View style={[styles.dot, { backgroundColor: tone.fg }]} />
      <Text style={[styles.label, { color: tone.text }]} numberOfLines={1}>
        {meta.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  compact: { paddingHorizontal: 7, paddingVertical: 3 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  label: { fontSize: 12, lineHeight: 15, fontWeight: '600', letterSpacing: 0.1 },
});

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { activityTime, previewText, relativeTime, sessionTitle, statusMeta } from '../format';
import { colors, tones } from '../theme';
import type { Agent, Session } from '../types';
import { AgentAvatar } from './AgentAvatar';
import { StatusPill } from './StatusPill';

export function SessionRow({ session, agent, now, onPress }: { session: Session; agent?: Agent; now: number; onPress: () => void }) {
  const title = sessionTitle(session);
  const meta = statusMeta(session.status);
  const when = relativeTime(activityTime(session), now);
  const detail =
    session.status === 'needs_you' && session.notification
      ? session.notification
      : session.last_message
        ? previewText(session.last_message, 120)
        : null;
  const detailColor = session.status === 'needs_you' ? tones.needs.text : colors.text3;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${session.agent_name}. ${meta.a11y}. ${when}`}
      accessibilityHint="Opens the chat"
      testID={`session-row-${session.sid}`}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <AgentAvatar icon={agent?.icon} color={agent?.color} kind={agent?.kind ?? session.kind} size={38} />
      <View style={styles.body}>
        <View style={styles.top}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
        </View>
        <Text style={styles.sub} numberOfLines={1}>
          {session.agent_name}
          {when ? ` · ${when}` : ''}
        </Text>
        {detail ? (
          <Text style={[styles.detail, { color: detailColor }]} numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
      </View>
      <StatusPill status={session.status} compact />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 13, paddingHorizontal: 14 },
  pressed: { backgroundColor: colors.surface2 },
  body: { flex: 1, minWidth: 0, gap: 2 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, fontSize: 16, lineHeight: 21, fontWeight: '600', color: colors.text },
  sub: { fontSize: 13, lineHeight: 17, color: colors.text2 },
  detail: { fontSize: 13, lineHeight: 18, marginTop: 3 },
});

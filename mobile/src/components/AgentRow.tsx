import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, tones } from '../theme';
import type { Agent } from '../types';
import { AgentAvatar } from './AgentAvatar';
import { Icon } from './Icon';

const KIND_LABEL: Record<string, string> = { chief: 'Chief of staff', domain: 'Domain', project: 'Project', scratch: 'Scratch' };

export function AgentRow({ agent, onPress }: { agent: Agent; onPress: () => void }) {
  const chief = agent.kind === 'chief';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${agent.name}, ${KIND_LABEL[agent.kind] ?? agent.kind}${agent.live ? `, ${agent.live} live` : ''}`}
      accessibilityHint={chief ? 'Opens your chat with Donna' : `Starts a new session with ${agent.name}`}
      testID={`agent-row-${agent.id}`}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <AgentAvatar icon={agent.icon} color={agent.color} kind={agent.kind} size={38} />
      <View style={styles.body}>
        <View style={styles.top}>
          <Text style={styles.name} numberOfLines={1}>
            {agent.name}
          </Text>
          {chief ? <Text style={styles.kind}>Chief of staff</Text> : agent.kind === 'project' ? <Text style={styles.kind}>Project</Text> : null}
        </View>
        {agent.mission ? (
          <Text style={styles.mission} numberOfLines={1}>
            {agent.mission}
          </Text>
        ) : null}
      </View>
      {agent.live > 0 ? (
        <View style={styles.live}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>{agent.live} live</Text>
        </View>
      ) : null}
      <Icon name={chief ? 'chatbubble-ellipses-outline' : 'add'} size={chief ? 19 : 22} color={colors.text3} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14 },
  pressed: { backgroundColor: colors.surface2 },
  body: { flex: 1, minWidth: 0, gap: 2 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { fontSize: 16, lineHeight: 21, fontWeight: '600', color: colors.text, flexShrink: 1 },
  kind: { fontSize: 12, lineHeight: 16, fontWeight: '500', color: colors.text3 },
  mission: { fontSize: 13, lineHeight: 18, color: colors.text2 },
  live: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: tones.working.soft },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: tones.working.fg },
  liveText: { fontSize: 12, lineHeight: 15, fontWeight: '600', color: tones.working.text },
});

import { StyleSheet, View } from 'react-native';
import { agentColor, agentIcon, colors, withAlpha } from '../theme';
import { Icon } from './Icon';

export function AgentAvatar({ icon, color, kind, size = 40 }: { icon?: string | null; color?: string | null; kind?: string; size?: number }) {
  const c = agentColor(color);
  return (
    <View
      style={[
        styles.box,
        { width: size, height: size, borderRadius: size * 0.3, backgroundColor: withAlpha(c, 0.16), borderColor: withAlpha(c, 0.28) },
      ]}
    >
      <Icon name={agentIcon(icon, kind)} size={Math.round(size * 0.5)} color={c} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, backgroundColor: colors.surface2 },
});

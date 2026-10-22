import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, radius } from '../theme';
import { Icon } from './Icon';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  title,
  onPress,
  variant = 'primary',
  icon,
  busy = false,
  disabled = false,
  style,
  testID,
  accessibilityHint,
}: {
  title: string;
  onPress: () => void;
  variant?: Variant;
  icon?: string;
  busy?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityHint?: string;
}) {
  const v = VARIANTS[variant];
  const off = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: off, busy }}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: v.bg, borderColor: v.border },
        variant === 'ghost' && styles.ghost,
        pressed && !off && { opacity: 0.82, transform: [{ scale: 0.985 }] },
        off && !busy && { opacity: 0.45 },
        style,
      ]}
    >
      <View style={styles.row}>
        {busy ? <ActivityIndicator size="small" color={v.fg} /> : icon ? <Icon name={icon} size={19} color={v.fg} /> : null}
        <Text style={[styles.title, { color: v.fg }]} numberOfLines={1}>
          {title}
        </Text>
      </View>
    </Pressable>
  );
}

const VARIANTS: Record<Variant, { bg: string; fg: string; border: string }> = {
  primary: { bg: colors.accent, fg: colors.accentInk, border: colors.accent },
  secondary: { bg: colors.surface2, fg: colors.text, border: colors.line2 },
  ghost: { bg: 'transparent', fg: colors.accentStrong, border: 'transparent' },
  danger: { bg: colors.dangerSoft, fg: colors.danger, border: 'rgba(240, 106, 115, 0.3)' },
};

const styles = StyleSheet.create({
  base: {
    minHeight: 50,
    borderRadius: radius.md + 2,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  ghost: { minHeight: 44 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  title: { fontSize: 16, lineHeight: 21, fontWeight: '600' },
});

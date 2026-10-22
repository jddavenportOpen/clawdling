import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, CONTENT_MAX } from '../theme';
import { Icon } from './Icon';

/** One header for every screen (identical on iOS and in the web build used for screenshots). */
export function ScreenHeader({
  title,
  subtitle,
  onBack,
  backLabel = 'Back',
  left,
  right,
  bordered = true,
  testID,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  left?: ReactNode;
  right?: ReactNode;
  bordered?: boolean;
  testID?: string;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.wrap, { paddingTop: Math.max(insets.top, 10) }, bordered && styles.bordered]} testID={testID}>
      <View style={styles.row}>
        {onBack ? (
          <Pressable
            onPress={onBack}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={backLabel}
            testID="header-back"
            style={({ pressed }) => [styles.back, pressed && { opacity: 0.55 }]}
          >
            <Icon name="chevron-back" size={27} color={colors.accentStrong} />
          </Pressable>
        ) : null}
        {left ? <View style={styles.left}>{left}</View> : null}
        <View style={styles.titles}>
          {typeof title === 'string' ? (
            <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
              {title}
            </Text>
          ) : (
            title
          )}
          {subtitle ? (typeof subtitle === 'string' ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : subtitle) : null}
        </View>
        {right ? <View style={styles.right}>{right}</View> : null}
      </View>
    </View>
  );
}

export function HeaderIconButton({ icon, label, onPress, testID }: { icon: string; label: string; onPress: () => void; testID?: string }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      style={({ pressed }) => [styles.iconBtn, pressed && { backgroundColor: colors.surface3 }]}
    >
      <Icon name={icon} size={21} color={colors.text2} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { backgroundColor: colors.bg, paddingHorizontal: 8, paddingBottom: 8 },
  bordered: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line2 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 48, width: '100%', maxWidth: CONTENT_MAX + 16, alignSelf: 'center' },
  back: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center', marginLeft: -2 },
  left: { marginRight: 10 },
  titles: { flex: 1, minWidth: 0, paddingHorizontal: 4 },
  title: { fontSize: 17, lineHeight: 22, fontWeight: '600', color: colors.text },
  subtitle: { fontSize: 13, lineHeight: 17, color: colors.text2, marginTop: 1 },
  right: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 8 },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
});

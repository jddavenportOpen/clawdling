import { Children, Fragment, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, radius } from '../theme';

/** An inset grouped card (iOS Settings style); children are separated by hairlines. */
export function Card({ children, inset = 66, style, testID }: { children: ReactNode; inset?: number; style?: StyleProp<ViewStyle>; testID?: string }) {
  const items = Children.toArray(children).filter(Boolean);
  return (
    <View style={[styles.card, style]} testID={testID}>
      {items.map((child, i) => (
        <Fragment key={i}>
          {i > 0 ? <View style={[styles.sep, { marginLeft: inset }]} /> : null}
          {child}
        </Fragment>
      ))}
    </View>
  );
}

export function SectionHeader({ title, count, tone, action, onAction }: { title: string; count?: number; tone?: string; action?: string; onAction?: () => void }) {
  return (
    <View style={styles.header} accessibilityRole="header">
      <Text style={[styles.headerText, tone ? { color: tone } : null]}>{title}</Text>
      {typeof count === 'number' && count > 0 ? (
        <View style={[styles.count, tone ? { backgroundColor: `${tone}22` } : null]}>
          <Text style={[styles.countText, tone ? { color: tone } : null]}>{count}</Text>
        </View>
      ) : null}
      <View style={{ flex: 1 }} />
      {action && onAction ? (
        <Pressable onPress={onAction} hitSlop={8} accessibilityRole="button" accessibilityLabel={action}>
          <Text style={styles.action}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line2,
    overflow: 'hidden',
  },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line2 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, marginBottom: 8, marginTop: 22 },
  headerText: { fontSize: 13, lineHeight: 18, fontWeight: '600', color: colors.text2, letterSpacing: 0.4, textTransform: 'uppercase' },
  count: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface3 },
  countText: { fontSize: 12, lineHeight: 15, fontWeight: '700', color: colors.text2 },
  action: { fontSize: 14, fontWeight: '600', color: colors.accentStrong },
});

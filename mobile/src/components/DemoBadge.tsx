import { StyleSheet, Text, View } from 'react-native';
import { tones } from '../theme';

/** Shown on every screen in demo mode so sample data is never mistaken for real work. */
export function DemoBadge() {
  return (
    <View style={styles.badge} accessibilityLabel="Demo mode: sample data on this phone" testID="demo-badge">
      <Text style={styles.text}>DEMO</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: tones.needs.soft, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(240, 179, 60, 0.4)' },
  text: { fontSize: 11, lineHeight: 14, fontWeight: '800', letterSpacing: 0.8, color: tones.needs.text },
});

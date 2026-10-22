import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { colors } from '../theme';

/** Three softly pulsing dots: "the agent is working". */
export function TypingDots({ color = colors.text2 }: { color?: string }) {
  const v = useRef([0, 1, 2].map(() => new Animated.Value(0.3))).current;
  useEffect(() => {
    const loops = v.map((val, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 160),
          Animated.timing(val, { toValue: 1, duration: 420, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(val, { toValue: 0.3, duration: 420, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.delay((2 - i) * 160),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [v]);
  return (
    <View style={styles.row} accessibilityLabel="Working">
      {v.map((val, i) => (
        <Animated.View key={i} style={[styles.dot, { backgroundColor: color, opacity: val, transform: [{ scale: val.interpolate({ inputRange: [0.3, 1], outputRange: [0.85, 1.1] }) }] }]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 5, alignItems: 'center', height: 16 },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
});

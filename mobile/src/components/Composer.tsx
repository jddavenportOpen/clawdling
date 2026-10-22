import { forwardRef } from 'react';
import { Platform, Pressable, StyleSheet, TextInput, View, type NativeSyntheticEvent, type TextInputKeyPressEventData } from 'react-native';
import { colors, CONTENT_MAX } from '../theme';
import { Icon } from './Icon';

export const Composer = forwardRef<
  TextInput,
  {
    value: string;
    onChangeText: (t: string) => void;
    onSend: () => void;
    placeholder: string;
    disabled?: boolean;
    sending?: boolean;
    bottomInset: number;
    autoFocus?: boolean;
  }
>(function Composer({ value, onChangeText, onSend, placeholder, disabled, sending, bottomInset, autoFocus }, ref) {
  const canSend = !!value.trim() && !disabled && !sending;
  const onKeyPress = (e: NativeSyntheticEvent<TextInputKeyPressEventData & { shiftKey?: boolean }>) => {
    // On a hardware keyboard (web, iPad keyboard), Enter sends and Shift+Enter adds a line.
    if (Platform.OS === 'web' && e.nativeEvent.key === 'Enter' && !e.nativeEvent.shiftKey) {
      e.preventDefault?.();
      if (canSend) onSend();
    }
  };
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(bottomInset, 10) }]}>
      <View style={styles.inner}>
        <View style={[styles.field, disabled && styles.fieldOff]}>
          <TextInput
            ref={ref}
            value={value}
            onChangeText={onChangeText}
            placeholder={placeholder}
            placeholderTextColor={colors.text3}
            multiline
            editable={!disabled}
            autoFocus={autoFocus}
            style={styles.input}
            selectionColor={colors.accent}
            keyboardAppearance="dark"
            onKeyPress={onKeyPress}
            accessibilityLabel={placeholder}
            testID="composer-input"
          />
        </View>
        <Pressable
          onPress={onSend}
          disabled={!canSend}
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityState={{ disabled: !canSend, busy: !!sending }}
          hitSlop={6}
          testID="composer-send"
          style={({ pressed }) => [styles.send, canSend ? styles.sendOn : styles.sendOff, pressed && canSend && { transform: [{ scale: 0.92 }] }]}
        >
          <Icon name="arrow-up" size={20} color={canSend ? colors.accentInk : colors.text3} />
        </Pressable>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  bar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line2,
    backgroundColor: colors.bg,
    paddingTop: 8,
    paddingHorizontal: 10,
  },
  inner: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, width: '100%', maxWidth: CONTENT_MAX, alignSelf: 'center' },
  field: {
    flex: 1,
    minHeight: 40,
    maxHeight: 148,
    borderRadius: 20,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line2,
    justifyContent: 'center',
  },
  fieldOff: { opacity: 0.55 },
  input: {
    fontSize: 16,
    lineHeight: 21,
    color: colors.text,
    paddingHorizontal: 15,
    paddingTop: Platform.OS === 'ios' ? 10 : 9,
    paddingBottom: Platform.OS === 'ios' ? 10 : 9,
    maxHeight: 146,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null),
  },
  send: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', marginBottom: 1 },
  sendOn: { backgroundColor: colors.accent },
  sendOff: { backgroundColor: colors.surface3 },
});

// A yes/no question that works on iOS (native alert) and in the web build (window.confirm).

import { Alert, Platform } from 'react-native';

export function confirmAsync(title: string, message: string, confirmLabel: string, destructive = false): Promise<boolean> {
  if (Platform.OS === 'web') {
    const ok = typeof globalThis.confirm === 'function' ? globalThis.confirm(`${title}\n\n${message}`) : true;
    return Promise.resolve(ok);
  }
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

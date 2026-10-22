import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '../src/components/Button';
import { Icon } from '../src/components/Icon';
import { setScannedLink } from '../src/handoff';
import { parsePairingLink } from '../src/links';
import { colors, radius, type } from '../src/theme';

const FRAME = 248;

export default function ScanScreen() {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  const lastBad = useRef<{ data: string; at: number } | null>(null);

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/connect');
  };

  const onScan = ({ data }: BarcodeScanningResult) => {
    if (done.current) return;
    const r = parsePairingLink(data);
    if (r.ok) {
      done.current = true;
      setScannedLink(data);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      close();
      return;
    }
    // The same wrong code is reported once, not on every frame.
    const now = Date.now();
    if (lastBad.current && lastBad.current.data === data && now - lastBad.current.at < 4000) return;
    lastBad.current = { data, at: now };
    setError(r.code === 'not_a_link' || r.code === 'bad_scheme' ? "That QR code isn't a Clawdling pairing code." : r.message);
  };

  const body = (() => {
    if (Platform.OS === 'web') {
      return <Message title="Scanning needs the iPhone camera" text="In this build, paste the pairing link instead." action="Paste a link instead" onAction={close} />;
    }
    if (!permission) return null;
    if (!permission.granted) {
      return permission.canAskAgain ? (
        <Message
          title="Allow the camera to scan"
          text="Clawdling uses the camera only to read the pairing code on your computer's screen. Nothing is recorded."
          action="Allow camera"
          onAction={() => void requestPermission()}
        />
      ) : (
        <Message
          title="Camera access is off"
          text="Turn on Camera for Clawdling in iOS Settings, or paste the pairing link instead."
          action="Open Settings"
          onAction={() => void Linking.openSettings()}
        />
      );
    }
    return (
      <>
        <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onScan} />
        <View style={styles.overlay} pointerEvents="none">
          <View style={styles.frame}>
            <Corner style={{ top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 18 }} />
            <Corner style={{ top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 18 }} />
            <Corner style={{ bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 18 }} />
            <Corner style={{ bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 18 }} />
          </View>
          <Text style={styles.hint}>Point at the code in the cockpit: Settings, then Connect your phone.</Text>
          {error ? (
            <View style={styles.errorPill}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}
        </View>
      </>
    );
  })();

  return (
    <View style={styles.screen} testID="scan-screen">
      {body}
      <Pressable
        onPress={close}
        accessibilityRole="button"
        accessibilityLabel="Close scanner"
        hitSlop={10}
        style={[styles.close, { top: insets.top + 10 }]}
      >
        <Icon name="close" size={24} color="#fff" />
      </Pressable>
    </View>
  );
}

function Corner({ style }: { style: object }) {
  return <View style={[styles.corner, style]} />;
}

function Message({ title, text, action, onAction }: { title: string; text: string; action: string; onAction: () => void }) {
  return (
    <View style={styles.message}>
      <Icon name="camera-outline" size={40} color={colors.accent} />
      <Text style={styles.messageTitle}>{title}</Text>
      <Text style={styles.messageText}>{text}</Text>
      <Button title={action} onPress={onAction} style={{ alignSelf: 'stretch', marginTop: 8 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.25)' },
  frame: { width: FRAME, height: FRAME },
  corner: { position: 'absolute', width: 46, height: 46, borderColor: colors.accent },
  hint: { marginTop: 28, color: '#fff', fontSize: 15, lineHeight: 21, textAlign: 'center', maxWidth: 280, fontWeight: '500' },
  errorPill: { marginTop: 16, paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, backgroundColor: 'rgba(240, 106, 115, 0.92)' },
  errorText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  close: {
    position: 'absolute',
    left: 16,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  message: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 10, backgroundColor: colors.bg },
  messageTitle: { ...type.title, textAlign: 'center', marginTop: 8 },
  messageText: { ...type.callout, textAlign: 'center', lineHeight: 21 },
});

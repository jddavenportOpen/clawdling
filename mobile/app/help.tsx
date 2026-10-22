import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '../src/components/Icon';
import { Markdown } from '../src/components/Markdown';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { PRIVACY_NOTE } from '../src/constants';
import { colors, CONTENT_MAX, radius, type } from '../src/theme';

const STEPS: { icon: string; title: string; body: string }[] = [
  {
    icon: 'laptop-outline',
    title: 'Run Clawdling on your computer',
    body: "Clawdling is free and runs on your Mac or Linux computer. If you don't have it yet, see github.com/jddavenportOpen/clawdling. So your phone can reach it, start it like this:\n\n```sh\nclawdling start --host 0.0.0.0\n```",
  },
  {
    icon: 'qr-code-outline',
    title: 'Scan the code',
    body: 'In the cockpit on your computer, open **Settings**, then **Connect your phone**. Tap **Scan the code on your Mac** in this app and point the camera at it. You can also copy the link there and paste it here.',
  },
  {
    icon: 'wifi-outline',
    title: 'Same Wi-Fi',
    body: 'At home, keep your phone on the same Wi-Fi as your computer. If iOS asks whether Clawdling may find devices on your local network, allow it. You can change that later in iOS Settings, under Privacy & Security, Local Network.',
  },
  {
    icon: 'globe-outline',
    title: 'Away from home: Tailscale',
    body: "Install Tailscale on your computer and your phone and sign in to the same account. Then pair using your computer's Tailscale address (it starts with 100.). Your agents stay on your own computer; nothing goes through a cloud service of ours.",
  },
];

const SAFETY =
  '`--host 0.0.0.0` lets other devices on your network reach the cockpit. Every request still needs the pairing code, so only use it on networks you trust, and never share the link or QR code.';

export default function HelpScreen() {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.screen} testID="help-screen">
      <ScreenHeader onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} backLabel="Close" title="How to connect" />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <View style={styles.column}>
          <Text style={styles.lead}>
            This app is a chat window into Clawdling, which runs your agents on your own computer. Pair it once and your agents are one tap away.
          </Text>
          {STEPS.map((s, i) => (
            <View key={s.title} style={styles.step}>
              <View style={styles.stepHead}>
                <View style={styles.num}>
                  <Text style={styles.numText}>{i + 1}</Text>
                </View>
                <Text style={styles.stepTitle}>{s.title}</Text>
                <Icon name={s.icon} size={20} color={colors.text3} />
              </View>
              <Markdown text={s.body} />
            </View>
          ))}
          <View style={styles.safety}>
            <Icon name="shield-checkmark-outline" size={20} color={colors.accentStrong} />
            <View style={{ flex: 1 }}>
              <Markdown text={SAFETY} />
            </View>
          </View>
          <Text style={styles.privacy}>{PRIVACY_NOTE}</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 16, paddingTop: 14 },
  column: { width: '100%', maxWidth: CONTENT_MAX, alignSelf: 'center', gap: 14 },
  lead: { ...type.callout, fontSize: 16, lineHeight: 22, color: colors.text2, marginBottom: 4 },
  step: {
    padding: 16,
    gap: 10,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line2,
  },
  stepHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  num: { width: 26, height: 26, borderRadius: 13, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  numText: { fontSize: 14, fontWeight: '700', color: colors.accentStrong },
  stepTitle: { ...type.headline, flex: 1 },
  safety: { flexDirection: 'row', gap: 12, padding: 16, borderRadius: radius.lg, backgroundColor: colors.accentSoft },
  privacy: { ...type.footnote, textAlign: 'center', marginTop: 6, paddingHorizontal: 12 },
});

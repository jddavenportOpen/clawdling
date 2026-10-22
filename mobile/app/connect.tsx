import * as Clipboard from 'expo-clipboard';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { checkConnection } from '../src/api';
import { Banner } from '../src/components/Banner';
import { Button } from '../src/components/Button';
import { Icon } from '../src/components/Icon';
import { Markdown } from '../src/components/Markdown';
import { atsProblem, connectProblem, type ConnectProblem } from '../src/connect-errors';
import { useConnection } from '../src/connection';
import { hostLabel } from '../src/format';
import { takeScannedLink } from '../src/handoff';
import { makeTarget, parsePairingLink, type PairingTarget } from '../src/links';
import { colors, radius, type } from '../src/theme';


const markImage = require('../assets/mark.png');

export default function ConnectScreen() {
  const insets = useSafeAreaInsets();
  const { connection, connect, startDemo, notice, clearNotice } = useConnection();
  const params = useLocalSearchParams<{ url?: string; t?: string }>();
  const [pasteOpen, setPasteOpen] = useState(false);
  const [link, setLink] = useState('');
  const [confirmTarget, setConfirmTarget] = useState<PairingTarget | null>(null);
  const [problem, setProblem] = useState<ConnectProblem | null>(null);
  const [busy, setBusy] = useState<'link' | 'confirm' | 'demo' | null>(null);
  const handled = useRef<string | null>(null);
  const input = useRef<TextInput>(null);

  const attempt = useCallback(
    async (target: PairingTarget) => {
      clearNotice();
      setProblem(null);
      if (Platform.OS === 'ios') {
        const ats = atsProblem(target);
        if (ats) {
          setProblem(ats);
          return;
        }
      }
      let check = await checkConnection(target.url, target.token);
      // The first request to a local address is what makes iOS ask for Local Network access, and
      // it fails while that question is on screen. Give the person a moment, then try once more.
      if (!check.ok && check.step === 'health' && check.error?.kind === 'network' && target.network === 'lan') {
        await new Promise((r) => setTimeout(r, 2500));
        check = await checkConnection(target.url, target.token);
      }
      const p = connectProblem(target, check);
      if (p) {
        setProblem(p);
        return;
      }
      await connect(target.url, target.token);
    },
    [clearNotice, connect],
  );

  const connectLink = useCallback(
    async (text: string) => {
      const r = parsePairingLink(text);
      if (!r.ok) {
        clearNotice();
        setProblem({ title: "That link can't connect", message: r.message });
        return;
      }
      setBusy('link');
      try {
        await attempt(r.target);
      } finally {
        setBusy(null);
      }
    },
    [attempt, clearNotice],
  );

  // A deep link (clawdling://connect?url=...&t=...) always asks before connecting.
  useEffect(() => {
    if (!params.url && !params.t) return;
    const key = `${params.url ?? ''}\u0000${params.t ?? ''}`;
    if (handled.current === key) return;
    handled.current = key;
    const r = makeTarget(params.url, params.t);
    if (r.ok) {
      setConfirmTarget(r.target);
      setProblem(null);
    } else setProblem({ title: "That link can't connect", message: r.message });
  }, [params.url, params.t]);

  // The in-app scanner hands its code over in memory, and scanning is consent enough.
  useFocusEffect(
    useCallback(() => {
      const scanned = takeScannedLink();
      if (scanned) void connectLink(scanned);
    }, [connectLink]),
  );

  const pasteFromClipboard = async () => {
    try {
      const text = await Clipboard.getStringAsync();
      if (text) setLink(text.trim());
    } catch {
      input.current?.focus();
    }
  };

  const confirm = async () => {
    if (!confirmTarget) return;
    setBusy('confirm');
    try {
      await attempt(confirmTarget);
    } finally {
      setBusy(null);
    }
  };

  const cancelConfirm = () => {
    setConfirmTarget(null);
    setProblem(null);
    if (!connection) return;
    if (router.canGoBack()) router.back();
    else router.replace('/home');
  };

  const demo = async () => {
    setBusy('demo');
    try {
      await startDemo();
    } finally {
      setBusy(null);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 28, paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
        testID="connect-screen"
      >
        <View style={styles.column}>
          {notice ? (
            <View style={styles.block}>
              <Banner tone="warn" icon="key-outline" title="Connect again" message={notice} testID="connect-notice" />
            </View>
          ) : null}

          <View style={styles.hero}>
            <Image source={markImage} style={styles.mark} accessibilityIgnoresInvertColors accessible={false} />
            <Text style={styles.title} accessibilityRole="header">
              Clawdling
            </Text>
            <Text style={styles.lead}>Chat with your AI agents from your phone. They keep running on your own computer.</Text>
          </View>

          {confirmTarget ? (
            <View style={styles.confirm} testID="confirm-card">
              <Text style={styles.confirmTitle}>Connect to {confirmTarget.hostPort}?</Text>
              <Text style={styles.confirmText}>
                This link pairs the app with the Clawdling server at {confirmTarget.url}. Continue only if it came from your own cockpit.
              </Text>
              {connection?.mode === 'live' && hostLabel(connection.url) !== confirmTarget.hostPort ? (
                <Text style={styles.confirmNote}>You are connected to {hostLabel(connection.url)} now. This replaces it.</Text>
              ) : null}
              <View style={styles.confirmRow}>
                <Button title="Cancel" variant="secondary" onPress={cancelConfirm} style={styles.grow} testID="confirm-cancel" />
                <Button title="Connect" onPress={confirm} busy={busy === 'confirm'} style={styles.grow} testID="confirm-connect" />
              </View>
            </View>
          ) : (
            <View style={styles.actions}>
              <Button
                title="Scan the code on your Mac"
                icon="qr-code-outline"
                onPress={() => {
                  clearNotice();
                  setProblem(null);
                  router.push('/scan');
                }}
                testID="scan-button"
              />
              {pasteOpen ? (
                <View style={styles.paste} testID="paste-panel">
                  <Text style={styles.label}>Pairing link</Text>
                  <TextInput
                    ref={input}
                    value={link}
                    onChangeText={(t) => {
                      setLink(t);
                      if (problem) setProblem(null);
                    }}
                    placeholder="clawdling://connect?url=…"
                    placeholderTextColor={colors.text3}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="off"
                    keyboardType={Platform.OS === 'ios' ? 'url' : 'default'}
                    keyboardAppearance="dark"
                    returnKeyType="go"
                    onSubmitEditing={() => void connectLink(link)}
                    style={styles.input}
                    autoFocus
                    accessibilityLabel="Pairing link"
                    testID="link-input"
                  />
                  <View style={styles.pasteRow}>
                    {Platform.OS !== 'web' ? (
                      <Button title="Paste" variant="secondary" icon="clipboard-outline" onPress={pasteFromClipboard} style={styles.grow} />
                    ) : null}
                    <Button
                      title="Connect"
                      onPress={() => void connectLink(link)}
                      busy={busy === 'link'}
                      disabled={!link.trim()}
                      style={styles.grow}
                      testID="link-connect"
                    />
                  </View>
                </View>
              ) : (
                <Button
                  title="Paste a link"
                  icon="link-outline"
                  variant="secondary"
                  onPress={() => {
                    setPasteOpen(true);
                    clearNotice();
                  }}
                  testID="paste-button"
                />
              )}
              <Button title="Try the demo" icon="sparkles-outline" variant="ghost" onPress={demo} busy={busy === 'demo'} testID="demo-button" />
            </View>
          )}

          {problem ? (
            <View style={styles.problem} accessibilityRole="alert" testID="connect-problem">
              <View style={styles.problemHead}>
                <Icon name="alert-circle-outline" size={18} color={colors.danger} />
                <Text style={styles.problemTitle}>{problem.title}</Text>
              </View>
              <Markdown text={problem.message} />
            </View>
          ) : null}

          <View style={styles.footer}>
            <Pressable onPress={() => router.push('/help')} accessibilityRole="button" hitSlop={8} testID="help-link" style={({ pressed }) => [styles.helpLink, pressed && { opacity: 0.6 }]}>
              <Icon name="help-circle-outline" size={17} color={colors.accentStrong} />
              <Text style={styles.helpText}>How do I connect?</Text>
            </Pressable>
            <Text style={styles.privacy}>No accounts and no analytics. This app talks only to the server you connect it to.</Text>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  grow: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 22 },
  column: { width: '100%', maxWidth: 440, alignSelf: 'center' },
  block: { marginBottom: 20 },
  hero: { alignItems: 'center', marginBottom: 34 },
  mark: { width: 84, height: 84, marginBottom: 18 },
  title: { ...type.largeTitle, textAlign: 'center' },
  lead: { ...type.callout, textAlign: 'center', marginTop: 10, maxWidth: 340, fontSize: 16, lineHeight: 22 },
  actions: { gap: 12 },
  paste: {
    gap: 10,
    padding: 14,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line2,
  },
  label: { ...type.caption, color: colors.text2, textTransform: 'uppercase', letterSpacing: 0.4 },
  input: {
    minHeight: 48,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line2,
    paddingHorizontal: 14,
    fontSize: 15,
    color: colors.text,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null),
  },
  pasteRow: { flexDirection: 'row', gap: 10 },
  confirm: {
    gap: 10,
    padding: 18,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accentLine,
  },
  confirmTitle: { ...type.headline, fontSize: 18 },
  confirmText: { ...type.subhead, lineHeight: 20 },
  confirmNote: { ...type.footnote, color: colors.text2 },
  confirmRow: { flexDirection: 'row', gap: 10, marginTop: 6 },
  problem: {
    marginTop: 18,
    padding: 14,
    gap: 6,
    borderRadius: radius.md,
    backgroundColor: colors.dangerSoft,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(240, 106, 115, 0.3)',
  },
  problemHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  problemTitle: { ...type.headline, fontSize: 16, color: colors.danger, flex: 1 },
  footer: { marginTop: 30, alignItems: 'center', gap: 14 },
  helpLink: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 },
  helpText: { fontSize: 15, fontWeight: '600', color: colors.accentStrong },
  privacy: { ...type.footnote, textAlign: 'center', maxWidth: 320 },
});

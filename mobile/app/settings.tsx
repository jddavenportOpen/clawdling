import Constants from 'expo-constants';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toApiError } from '../src/api';
import { Button } from '../src/components/Button';
import { Card, SectionHeader } from '../src/components/Card';
import { DemoBadge } from '../src/components/DemoBadge';
import { Icon } from '../src/components/Icon';
import { openLink } from '../src/components/Markdown';
import { RequireConnection } from '../src/components/RequireConnection';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { confirmAsync } from '../src/confirm';
import { useConnection } from '../src/connection';
import { PRIVACY_NOTE, SOURCE_URL } from '../src/constants';
import { hostLabel, maskToken } from '../src/format';
import { colors, CONTENT_MAX, tones, type } from '../src/theme';


export default function SettingsRoute() {
  return (
    <RequireConnection>
      <Settings />
    </RequireConnection>
  );
}

function Row({ icon, label, value, onPress, testID, valueTone }: { icon: string; label: string; value?: string; onPress?: () => void; testID?: string; valueTone?: string }) {
  const content = (
    <View style={styles.row}>
      <Icon name={icon} size={20} color={colors.text2} />
      <Text style={styles.rowLabel}>{label}</Text>
      {value ? (
        <Text style={[styles.rowValue, valueTone ? { color: valueTone } : null]} numberOfLines={1} testID={testID ? `${testID}-value` : undefined}>
          {value}
        </Text>
      ) : (
        <View style={{ flex: 1 }} />
      )}
      {onPress ? <Icon name="chevron-forward" size={18} color={colors.text3} /> : null}
    </View>
  );
  if (!onPress) return <View testID={testID}>{content}</View>;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={value ? `${label}, ${value}` : label} testID={testID} style={({ pressed }) => pressed && { backgroundColor: colors.surface2 }}>
      {content}
    </Pressable>
  );
}

function Settings() {
  const insets = useSafeAreaInsets();
  const { connection, client, disconnect } = useConnection();
  const [server, setServer] = useState<{ ok: boolean; text: string } | null>(null);
  const demo = connection?.mode === 'demo';
  const host = connection?.mode === 'live' ? hostLabel(connection.url) : null;
  const version = Constants.expoConfig?.version ?? '1.0.0';

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      if (!client || demo) return;
      setServer(null);
      client
        .me()
        .then((me) => alive && setServer({ ok: true, text: me.version ? `Connected · Clawdling ${me.version}` : 'Connected' }))
        .catch((e) => alive && setServer({ ok: false, text: toApiError(e).kind === 'network' ? "Can't reach it right now" : toApiError(e).message }));
      return () => {
        alive = false;
      };
    }, [client, demo]),
  );

  const leave = async () => {
    const ok = demo
      ? true
      : await confirmAsync(
          `Disconnect from ${host}?`,
          'The pairing code is removed from this phone. Your agents keep running on your computer, and you can pair again any time.',
          'Disconnect',
          true,
        );
    if (ok) await disconnect(null);
  };

  return (
    <View style={styles.screen} testID="settings-screen">
      <ScreenHeader onBack={() => (router.canGoBack() ? router.back() : router.replace('/home'))} backLabel="Back to Home" title="Settings" />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <View style={styles.column}>
          <SectionHeader title="Connection" />
          {demo ? (
            <Card inset={48}>
              <View style={styles.demoRow}>
                <DemoBadge />
                <Text style={styles.demoText}>You are trying the demo. The agents, sessions and replies are samples stored on this phone; nothing is sent anywhere.</Text>
              </View>
            </Card>
          ) : (
            <Card inset={48} testID="connection-card">
              <Row icon="server-outline" label="Server" value={host ?? ''} testID="server-row" />
              <Row icon="key-outline" label="Pairing code" value={connection?.mode === 'live' ? maskToken(connection.token) : ''} testID="token-row" />
              <Row
                icon="pulse-outline"
                label="Status"
                value={server ? server.text : 'Checking…'}
                valueTone={server ? (server.ok ? tones.ready.text : tones.needs.text) : undefined}
                testID="status-row"
              />
            </Card>
          )}
          <Button
            title={demo ? 'Leave the demo' : 'Disconnect'}
            icon={demo ? 'log-out-outline' : 'unlink-outline'}
            variant={demo ? 'secondary' : 'danger'}
            onPress={leave}
            style={styles.disconnect}
            testID="disconnect-button"
          />

          <SectionHeader title="Help" />
          <Card inset={48}>
            <Row icon="help-circle-outline" label="How to connect" onPress={() => router.push('/help')} testID="help-row" />
          </Card>

          <SectionHeader title="Privacy" />
          <Card>
            <View style={styles.note}>
              <Icon name="shield-checkmark-outline" size={20} color={tones.ready.text} />
              <Text style={styles.noteText} testID="privacy-note">
                {PRIVACY_NOTE}
              </Text>
            </View>
          </Card>

          <SectionHeader title="About" />
          <Card inset={48}>
            <Row icon="information-circle-outline" label="Version" value={version} />
            <Row icon="document-text-outline" label="License" value="AGPL-3.0" />
            <Row icon="logo-github" label="Source code" value="github.com/jddavenportOpen/clawdling" onPress={() => void openLink(SOURCE_URL)} testID="source-row" />
          </Card>
          <Text style={styles.footer}>Clawdling is free and open source. The app is a chat client for your own Clawdling server; it runs no agents itself.</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 16, paddingTop: 2 },
  column: { width: '100%', maxWidth: CONTENT_MAX, alignSelf: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 14, minHeight: 50, paddingVertical: 12 },
  rowLabel: { fontSize: 16, lineHeight: 21, color: colors.text },
  rowValue: { flex: 1, textAlign: 'right', fontSize: 15, lineHeight: 20, color: colors.text2 },
  disconnect: { marginTop: 14 },
  demoRow: { padding: 14, gap: 10, alignItems: 'flex-start' },
  demoText: { ...type.subhead, lineHeight: 20 },
  note: { flexDirection: 'row', gap: 12, padding: 14, alignItems: 'flex-start' },
  noteText: { flex: 1, fontSize: 15, lineHeight: 21, color: colors.text },
  footer: { ...type.footnote, marginTop: 14, paddingHorizontal: 4, lineHeight: 18 },
});

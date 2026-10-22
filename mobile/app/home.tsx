import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AgentAvatar } from '../src/components/AgentAvatar';
import { AgentRow } from '../src/components/AgentRow';
import { ConnectionBanner } from '../src/components/Banner';
import { Card, SectionHeader } from '../src/components/Card';
import { DemoBadge } from '../src/components/DemoBadge';
import { Icon } from '../src/components/Icon';
import { RequireConnection } from '../src/components/RequireConnection';
import { HeaderIconButton, ScreenHeader } from '../src/components/ScreenHeader';
import { SessionRow } from '../src/components/SessionRow';
import { useConnection } from '../src/connection';
import { groupHome, hostLabel } from '../src/format';
import { colors, CONTENT_MAX, radius, tones, type } from '../src/theme';
import type { Agent, ClawdlingClient, OrgView, Session } from '../src/types';
import { usePolling } from '../src/usePolling';

const markImage = require('../assets/mark.png');
const RECENT_PREVIEW = 5;

export default function HomeScreen() {
  return (
    <RequireConnection>
      <Home />
    </RequireConnection>
  );
}

function Home() {
  const { client, connection } = useConnection();
  return client ? <HomeBody client={client} demo={connection?.mode === 'demo'} host={connection?.mode === 'live' ? hostLabel(connection.url) : null} /> : null;
}

function HomeBody({ client, demo, host }: { client: ClawdlingClient; demo: boolean; host: string | null }) {
  const insets = useSafeAreaInsets();
  const [orgView, setOrgView] = useState<OrgView | null>(null);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [allRecent, setAllRecent] = useState(false);

  const poll = usePolling(async () => {
    const [o, s] = await Promise.all([client.org(), client.sessions()]);
    setOrgView(o);
    setSessions(s);
    setNow(Date.now());
  }, 5000);

  const sections = useMemo(() => groupHome(sessions ?? [], orgView?.agents ?? [], now), [sessions, orgView, now]);
  const agentsById = useMemo(() => new Map((orgView?.agents ?? []).map((a) => [a.id, a])), [orgView]);
  const donna = orgView?.agents.find((a) => a.kind === 'chief');
  const loaded = !!orgView && !!sessions;
  const nothingYet = loaded && !sections.needsYou.length && !sections.live.length && !sections.recent.length;
  const recent = allRecent ? sections.recent : sections.recent.slice(0, RECENT_PREVIEW);

  const openSession = (s: Session) => router.push({ pathname: '/session/[sid]', params: { sid: s.sid } });
  const openAgent = (a: Agent) => {
    if (a.kind === 'chief') router.push('/donna');
    else router.push({ pathname: '/new/[agent]', params: { agent: a.id } });
  };

  const rows = (list: Session[]) =>
    list.map((s) => <SessionRow key={s.sid} session={s} agent={agentsById.get(s.agent)} now={now} onPress={() => openSession(s)} />);

  return (
    <View style={styles.screen} testID="home-screen">
      <ScreenHeader
        bordered={false}
        left={<Image source={markImage} style={styles.mark} accessible={false} />}
        title={
          <View style={styles.brandRow}>
            <Text style={styles.brand} accessibilityRole="header">
              Clawdling
            </Text>
            {demo ? <DemoBadge /> : null}
          </View>
        }
        right={<HeaderIconButton icon="settings-outline" label="Settings" onPress={() => router.push('/settings')} testID="settings-button" />}
      />
      <ScrollView
        style={styles.screen}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        refreshControl={<RefreshControl refreshing={poll.refreshing} onRefresh={poll.refresh} tintColor={colors.text2} />}
      >
        <View style={styles.column}>
          <Text style={styles.org} numberOfLines={1} testID="org-name">
            {orgView?.org.name ?? ' '}
          </Text>
          <View style={styles.statusLine}>
            <View style={[styles.statusDot, { backgroundColor: poll.error ? tones.needs.fg : loaded ? tones.ready.fg : colors.text3 }]} />
            <Text style={styles.statusText} numberOfLines={1}>
              {demo ? 'Demo: sample agents on this phone, nothing is sent anywhere' : poll.error ? `Reconnecting to ${host}` : loaded ? `Connected to ${host}` : `Connecting to ${host}…`}
            </Text>
          </View>

          {poll.error ? (
            <View style={styles.banner}>
              <ConnectionBanner error={poll.error} retryAt={poll.retryAt} onRetry={poll.kick} host={host ?? undefined} />
            </View>
          ) : null}

          <Pressable
            onPress={() => router.push('/donna')}
            accessibilityRole="button"
            accessibilityLabel="Ask Donna"
            accessibilityHint="Opens your chat with Donna, your chief of staff"
            testID="ask-donna"
            style={({ pressed }) => [styles.ask, pressed && { backgroundColor: colors.surface2 }]}
          >
            <AgentAvatar icon={donna?.icon ?? 'chat'} color={donna?.color ?? '#FFB224'} kind="chief" size={34} />
            <View style={styles.askBody}>
              <Text style={styles.askTitle}>Ask {donna?.name ?? 'Donna'}</Text>
              <Text style={styles.askHint} numberOfLines={1}>
                She hands it to the right agent and reports back
              </Text>
            </View>
            <Icon name="paper-plane" size={18} color={colors.accent} />
          </Pressable>

          {!loaded && !poll.error ? <Skeleton /> : null}

          {sections.needsYou.length ? (
            <>
              <SectionHeader title="Needs you" count={sections.needsYou.length} tone={tones.needs.text} />
              <Card testID="section-needs">{rows(sections.needsYou)}</Card>
            </>
          ) : null}

          {sections.live.length ? (
            <>
              <SectionHeader title="Live" count={sections.live.length} tone={tones.working.text} />
              <Card testID="section-live">{rows(sections.live)}</Card>
            </>
          ) : null}

          {nothingYet ? (
            <View style={styles.empty} testID="home-empty">
              <Text style={styles.emptyTitle}>No sessions yet</Text>
              <Text style={styles.emptyText}>Pick an agent below to start one, or ask Donna and she will.</Text>
            </View>
          ) : null}

          {sections.recent.length ? (
            <>
              <SectionHeader
                title="Recent"
                count={sections.recent.length}
                action={sections.recent.length > RECENT_PREVIEW ? (allRecent ? 'Show less' : 'Show all') : undefined}
                onAction={() => setAllRecent(!allRecent)}
              />
              <Card testID="section-recent">{rows(recent)}</Card>
            </>
          ) : null}

          {orgView?.agents.length ? (
            <>
              <SectionHeader title="Agents" />
              <Card testID="section-agents">
                {sections.agents.map((a) => (
                  <AgentRow key={a.id} agent={a} onPress={() => openAgent(a)} />
                ))}
              </Card>
              <Text style={styles.footnote}>Tap an agent to start a new session. It runs on your computer; this phone only chats with it.</Text>
            </>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function Skeleton() {
  return (
    <View style={{ marginTop: 22, gap: 10 }} accessibilityLabel="Loading">
      {[0, 1, 2].map((i) => (
        <View key={i} style={styles.skelRow}>
          <View style={styles.skelAvatar} />
          <View style={{ flex: 1, gap: 8 }}>
            <View style={[styles.skelLine, { width: '72%' }]} />
            <View style={[styles.skelLine, { width: '40%', height: 10 }]} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 16, paddingTop: 4 },
  column: { width: '100%', maxWidth: CONTENT_MAX, alignSelf: 'center' },
  mark: { width: 28, height: 28, marginLeft: 6 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  brand: { fontSize: 17, lineHeight: 22, fontWeight: '700', color: colors.text },
  org: { ...type.largeTitle, marginTop: 6 },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 4 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { ...type.footnote, color: colors.text2, flex: 1 },
  banner: { marginTop: 14 },
  ask: {
    marginTop: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line2,
  },
  askBody: { flex: 1, minWidth: 0 },
  askTitle: { fontSize: 16, lineHeight: 21, fontWeight: '600', color: colors.text },
  askHint: { fontSize: 13, lineHeight: 18, color: colors.text2 },
  empty: { marginTop: 26, padding: 18, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line2, borderStyle: 'dashed', alignItems: 'center', gap: 4 },
  emptyTitle: { ...type.headline },
  emptyText: { ...type.subhead, textAlign: 'center' },
  footnote: { ...type.footnote, marginTop: 10, paddingHorizontal: 4 },
  skelRow: { flexDirection: 'row', gap: 12, alignItems: 'center', padding: 14, borderRadius: radius.lg, backgroundColor: colors.surface },
  skelAvatar: { width: 38, height: 38, borderRadius: 11, backgroundColor: colors.surface3 },
  skelLine: { height: 12, borderRadius: 6, backgroundColor: colors.surface3 },
});

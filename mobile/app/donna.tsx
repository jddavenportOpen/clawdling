import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isApiError, toApiError } from '../src/api';
import { channelLabel, mergeDonna, newLocalItem, pruneLocal, type LocalDonnaItem } from '../src/chat';
import { AgentAvatar } from '../src/components/AgentAvatar';
import { Banner, ConnectionBanner } from '../src/components/Banner';
import { Composer } from '../src/components/Composer';
import { DemoBadge } from '../src/components/DemoBadge';
import { MessageList, type ChatRow } from '../src/components/Message';
import { RequireConnection } from '../src/components/RequireConnection';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { useConnection } from '../src/connection';
import { colors, radius, type } from '../src/theme';
import type { Agent, ClawdlingClient, DonnaMessage } from '../src/types';
import { useKeyboardVisible } from '../src/useKeyboard';
import { usePolling } from '../src/usePolling';

const SUGGESTIONS = ["What's waiting on me?", 'Ask Health to plan this week’s workouts', 'Have Work draft my priorities for tomorrow'];

export default function DonnaRoute() {
  return (
    <RequireConnection>
      <DonnaScreen />
    </RequireConnection>
  );
}

function DonnaScreen() {
  const { client, connection } = useConnection();
  return client ? <DonnaChat client={client} demo={connection?.mode === 'demo'} /> : null;
}

function goBack() {
  if (router.canGoBack()) router.back();
  else router.replace('/home');
}

function failure(e: unknown): string {
  const err = toApiError(e);
  if (err.kind === 'timeout') return 'Donna took too long. She may still be on it; her answer will show here when it arrives';
  if (err.kind === 'network') return "couldn't reach your computer";
  return err.message.replace(/\.$/, '');
}

function DonnaChat({ client, demo }: { client: ClawdlingClient; demo: boolean }) {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardVisible();
  const [server, setServer] = useState<DonnaMessage[]>([]);
  const [local, setLocal] = useState<LocalDonnaItem[]>([]);
  const [chief, setChief] = useState<Agent | null>(null);
  const [draft, setDraft] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [inFlight, setInFlight] = useState(0);
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const serverRef = useRef(server);
  serverRef.current = server;
  const localRef = useRef(local);
  localRef.current = local;
  const chiefRef = useRef(chief);
  chiefRef.current = chief;
  const inFlightRef = useRef(inFlight);
  inFlightRef.current = inFlight;

  const poll = usePolling(
    async () => {
      if (!chiefRef.current) {
        try {
          const o = await client.org();
          setChief(o.agents.find((a) => a.kind === 'chief') ?? null);
        } catch (e) {
          if (isApiError(e) && !e.retryable) {
            // the header falls back to "Donna"
          } else throw e;
        }
      }
      try {
        const list = await client.donnaMessages(50);
        setServer(list);
        setLocal((l) => pruneLocal(list, l));
      } catch (e) {
        if (isApiError(e) && e.kind === 'unsupported') setUnsupported(true);
        else throw e;
      }
      setLoaded(true);
    },
    () => (inFlightRef.current > 0 ? 3000 : 5000),
    !unsupported,
  );

  // Elapsed time on the "Donna is on it" row.
  useEffect(() => {
    if (!since) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);

  const name = chief?.name ?? 'Donna';

  const send = useCallback(
    async (textArg?: string) => {
      const text = (textArg ?? draft).trim();
      if (!text) return;
      if (textArg === undefined) setDraft('');
      // Count against the history as it was before this send: the reply can reach the history
      // (through a poll) before the POST returns, and must not be counted as an older copy.
      const snapshot = serverRef.current;
      const mine = newLocalItem(snapshot, pruneLocal(snapshot, localRef.current), 'user', text, 'sending');
      localRef.current = [...localRef.current, mine];
      setLocal((l) => [...pruneLocal(serverRef.current, l), mine]);
      setInFlight((n) => n + 1);
      setSince((s) => s ?? Date.now());
      setNow(Date.now());
      try {
        const { reply } = await client.donnaChat(text);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        setLocal((l) => {
          const next = l.map((x) => (x.id === mine.id ? { ...x, state: 'sent' as const } : x));
          if (!reply.trim()) return next;
          return [...next, newLocalItem(snapshot, next, 'donna', reply, 'sent')];
        });
        poll.kick();
      } catch (e) {
        setLocal((l) => l.map((x) => (x.id === mine.id ? { ...x, state: 'failed' as const, error: failure(e) } : x)));
      } finally {
        setInFlight((n) => {
          const left = Math.max(0, n - 1);
          if (!left) setSince(null);
          return left;
        });
      }
    },
    [client, draft, poll],
  );

  const retry = useCallback(
    (id: string, text: string) => {
      setLocal((l) => l.filter((x) => x.id !== id));
      void send(text);
    },
    [send],
  );

  const rows = useMemo<ChatRow[]>(() => {
    const merged = mergeDonna(server, local).rows;
    const out: ChatRow[] = merged.map((r, i) => {
      const next = merged[i + 1];
      return {
        kind: 'msg',
        key: r.key,
        side: r.role === 'user' ? 'me' : 'them',
        text: r.text,
        tools: [],
        ts: r.ts,
        channel: channelLabel(r.channel),
        state: r.state === 'sent' ? undefined : r.state,
        error: r.error,
        showMeta: r.state !== 'sent' && (!next || next.role !== r.role || channelLabel(next.channel) !== channelLabel(r.channel)),
        onRetry: r.state === 'failed' && r.localId ? () => retry(r.localId as string, r.text) : undefined,
      };
    });
    if (inFlight > 0) {
      const secs = since ? Math.max(0, Math.round((now - since) / 1000)) : 0;
      out.push({ kind: 'typing', key: 'typing', label: secs >= 3 ? `${name} is on it · ${secs}s` : `${name} is on it` });
    }
    return out;
  }, [server, local, inFlight, since, now, name, retry]);

  const empty = loaded ? (
    <View style={styles.empty} testID="donna-empty">
      <AgentAvatar icon={chief?.icon ?? 'chat'} color={chief?.color ?? '#FFB224'} kind="chief" size={56} />
      <Text style={styles.emptyTitle}>Tell {name} what you need</Text>
      <Text style={styles.emptyText}>She knows every agent in your org. She hands your request to the right one, starts or continues its session, and tells you who is on it.</Text>
      <View style={styles.chips}>
        {SUGGESTIONS.map((s) => (
          <Pressable key={s} onPress={() => setDraft(s)} accessibilityRole="button" accessibilityLabel={`Use suggestion: ${s}`} style={({ pressed }) => [styles.chip, pressed && { backgroundColor: colors.surface3 }]}>
            <Text style={styles.chipText}>{s}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  ) : null;

  return (
    <View style={styles.screen} testID="donna-screen">
      <ScreenHeader
        onBack={goBack}
        backLabel="Back to Home"
        left={<AgentAvatar icon={chief?.icon ?? 'chat'} color={chief?.color ?? '#FFB224'} kind="chief" size={34} />}
        title={name}
        subtitle={
          <View style={styles.subRow}>
            <Text style={styles.sub}>Chief of staff</Text>
            {demo ? <DemoBadge /> : null}
          </View>
        }
      />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.flex}>
          {poll.error ? (
            <View style={styles.bannerWrap}>
              <ConnectionBanner error={poll.error} retryAt={poll.retryAt} onRetry={poll.kick} />
            </View>
          ) : null}
          {unsupported ? (
            <View style={styles.bannerWrap}>
              <Banner tone="info" title="Update Clawdling on your computer" message={`This server doesn't support chatting with ${name} from the app yet. You can still reach her on Telegram or iMessage.`} />
            </View>
          ) : null}
          <MessageList rows={rows} empty={empty} />
        </View>
        <Composer
          value={draft}
          onChangeText={setDraft}
          onSend={() => void send()}
          placeholder={`Message ${name}`}
          disabled={unsupported}
          bottomInset={keyboard ? 8 : insets.bottom}
        />
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 1 },
  sub: { fontSize: 13, lineHeight: 17, color: colors.text2 },
  bannerWrap: { paddingHorizontal: 12, paddingTop: 10 },
  empty: { alignItems: 'center', paddingHorizontal: 22, gap: 8 },
  emptyTitle: { ...type.headline, fontSize: 19, marginTop: 8 },
  emptyText: { ...type.callout, textAlign: 'center', lineHeight: 21, maxWidth: 340 },
  chips: { marginTop: 14, gap: 8, alignSelf: 'stretch', alignItems: 'center' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: radius.pill,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line2,
  },
  chipText: { fontSize: 14, lineHeight: 19, color: colors.text },
});

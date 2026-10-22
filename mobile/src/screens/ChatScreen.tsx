// The session chat. With a `sid` it shows a live session: messages polled every 2 s (faster right
// after you send), the status in the header, Resume when it has ended. With only an `agentId` it
// is a draft: nothing is started until you send the first message, which becomes the session's
// task (POST /api/sessions {agent, prompt}), so a stray tap never leaves an empty session behind.

import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isApiError, toApiError } from '../api';
import { groupForDisplay, localId, maxN, mergeMessages, nextCursor, reconcilePending, type PendingMessage } from '../chat';
import { AgentAvatar } from '../components/AgentAvatar';
import { Banner, ConnectionBanner } from '../components/Banner';
import { Button } from '../components/Button';
import { Composer } from '../components/Composer';
import { DemoBadge } from '../components/DemoBadge';
import { Icon } from '../components/Icon';
import { MessageList, type ChatRow } from '../components/Message';
import { ScreenHeader } from '../components/ScreenHeader';
import { StatusPill } from '../components/StatusPill';
import { confirmAsync } from '../confirm';
import { useConnection } from '../connection';
import { activityTime, previewText, relativeTimeLong, sessionTitle, terminalQuestion, type TerminalQuestion } from '../format';
import { stashPending, takePending } from '../handoff';
import { colors, radius, tones, type } from '../theme';
import type { Agent, ChatMessage, ClawdlingClient, Session, SessionStatus } from '../types';
import { useKeyboardVisible } from '../useKeyboard';
import { usePolling } from '../usePolling';

const PAGE = 200;

function questionTitle(q: TerminalQuestion | null): string {
  if (!q) return 'Waiting on you';
  if (q.kind === 'permission') return 'Waiting for your permission';
  if (q.kind === 'choice') return 'Waiting for your choice';
  return 'Waiting for an answer before it starts';
}

export function ChatScreen({ sid, agentId }: { sid?: string; agentId?: string }) {
  const { client, connection } = useConnection();
  if (!client) return null;
  return <Chat client={client} sid={sid ?? null} agentId={agentId ?? null} demo={connection?.mode === 'demo'} />;
}

function goBack() {
  if (router.canGoBack()) router.back();
  else router.replace('/home');
}

function shortError(e: unknown): string {
  const err = toApiError(e);
  if (err.kind === 'network' || err.kind === 'timeout') return "couldn't reach your computer";
  return err.message.replace(/\.$/, '');
}

function Chat({ client, sid, agentId, demo }: { client: ClawdlingClient; sid: string | null; agentId: string | null; demo: boolean }) {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardVisible();
  const [session, setSession] = useState<Session | null>(null);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [pending, setPending] = useState<PendingMessage[]>(() => (sid ? takePending(sid) : []));
  const [draft, setDraft] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [gone, setGone] = useState(false);
  const [creating, setCreating] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const cursor = useRef<number | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const statusRef = useRef(status);
  statusRef.current = status;
  const unsupportedRef = useRef(unsupported);
  unsupportedRef.current = unsupported;
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const ticks = useRef(0);
  const boostUntil = useRef(0);

  const loadAgent = useCallback(
    async (id: string) => {
      if (agentRef.current) return;
      try {
        const o = await client.org();
        const a = o.agents.find((x) => x.id === id) ?? null;
        if (a) setAgent(a);
      } catch {
        // the header falls back to the session's own names
      }
    },
    [client],
  );

  const task = useCallback(async () => {
    if (!sid) {
      if (agentId) await loadAgent(agentId);
      setLoaded(true);
      return;
    }
    ticks.current += 1;
    let refreshSession = !session || ticks.current % 4 === 1;
    if (!unsupportedRef.current) {
      try {
        let page = await client.messages(sid, { after: cursor.current, limit: PAGE });
        let merged = mergeMessages(messagesRef.current, page.messages);
        cursor.current = nextCursor(page.next, merged, cursor.current);
        // The server pages from the start; a long session takes a few pages to catch up.
        for (let i = 0; i < 20 && (page.more ?? page.messages.length >= PAGE) && page.messages.length > 0; i++) {
          page = await client.messages(sid, { after: cursor.current, limit: PAGE });
          merged = mergeMessages(merged, page.messages);
          cursor.current = nextCursor(page.next, merged, cursor.current);
        }
        if (merged !== messagesRef.current) {
          setMessages(merged);
          setPending((p) => reconcilePending(p, merged));
        }
        if (page.status && page.status !== statusRef.current) {
          refreshSession = true;
          setStatus(page.status);
        }
      } catch (e) {
        if (isApiError(e) && e.kind === 'unsupported') {
          setUnsupported(true);
          refreshSession = true;
        } else if (isApiError(e) && e.kind === 'not_found') {
          setGone(true);
          return;
        } else throw e;
      }
    }
    if (refreshSession || unsupportedRef.current) {
      try {
        const s = await client.session(sid);
        setSession(s);
        setStatus(s.status);
        void loadAgent(s.agent);
      } catch (e) {
        if (isApiError(e) && e.kind === 'not_found') {
          setGone(true);
          return;
        }
        throw e;
      }
    }
    setLoaded(true);
  }, [client, sid, agentId, session, loadAgent]);

  const poll = usePolling(task, () => (Date.now() < boostUntil.current ? 700 : statusRef.current === 'working' ? 1500 : 2000), !gone);

  const notification = session?.notification ?? null;
  const question: TerminalQuestion | null = session ? terminalQuestion({ ...session, status: status ?? session.status }) : null;
  // A question only the terminal can answer: the server refuses to type into it, so don't offer to.
  const blocked = !!question?.certain;
  const ended = status === 'ended';

  const send = async (textArg?: string) => {
    const text = (textArg ?? draft).trim();
    if (!text) return;
    if (blocked) return;
    if (question && !question.certain) {
      // An older server types into whatever is on screen, and Return would answer the prompt.
      const ok = await confirmAsync(
        'A permission prompt is open',
        `${notification}\n\nSending types your message and presses Return in the terminal, which can approve the prompt. To answer it safely, use the cockpit on your computer.`,
        'Send anyway',
      );
      if (!ok) return;
    }
    setNotice(null);
    if (textArg === undefined) setDraft('');
    const p: PendingMessage = { id: localId(), text, state: 'sending', afterN: maxN(messagesRef.current) ?? cursor.current, createdAt: Date.now() };

    if (!sid) {
      if (!agentId) return;
      setPending([p]);
      setCreating(true);
      try {
        const s = await client.createSession({ agent: agentId, prompt: text });
        stashPending(s.sid, [{ ...p, state: 'sent', afterN: null }]);
        Haptics.selectionAsync().catch(() => {});
        router.replace({ pathname: '/session/[sid]', params: { sid: s.sid } });
      } catch (e) {
        setPending([{ ...p, state: 'failed', error: shortError(e) }]);
        const err = toApiError(e);
        if (err.kind === 'conflict' || err.kind === 'server' || err.kind === 'bad_request') setNotice(err.message);
      } finally {
        setCreating(false);
      }
      return;
    }

    setPending((list) => [...list, p]);
    try {
      await client.send(sid, text);
      setPending((list) => list.map((x) => (x.id === p.id ? { ...x, state: 'sent' } : x)));
      boostUntil.current = Date.now() + 15_000;
      Haptics.selectionAsync().catch(() => {});
      poll.kick();
    } catch (e) {
      const err = toApiError(e);
      setPending((list) => list.map((x) => (x.id === p.id ? { ...x, state: 'failed', error: shortError(err) } : x)));
      if (err.kind === 'conflict') {
        setNotice(err.message);
        poll.kick();
      }
    }
  };

  const sendRef = useRef(send);
  sendRef.current = send;
  const retry = useCallback((p: PendingMessage) => {
    setPending((list) => list.filter((x) => x.id !== p.id));
    void sendRef.current(p.text);
  }, []);

  const resume = async () => {
    if (!sid) return;
    setResuming(true);
    setNotice(null);
    try {
      const s = await client.resume(sid);
      setSession(s);
      setStatus(s.status);
      boostUntil.current = Date.now() + 10_000;
      poll.kick();
    } catch (e) {
      setNotice(toApiError(e).message);
    } finally {
      setResuming(false);
    }
  };

  const rows = useMemo<ChatRow[]>(() => {
    const shown = groupForDisplay(messages);
    const out: ChatRow[] = shown.map((m, i) => ({
      kind: 'msg',
      key: m.key,
      side: m.role === 'user' ? 'me' : 'them',
      text: m.text,
      tools: m.tools,
      ts: m.ts,
      showMeta: i === shown.length - 1 || shown[i + 1].role !== m.role,
    }));
    if (unsupported && session?.last_message) {
      out.push({ kind: 'msg', key: 'last', side: 'them', text: session.last_message, tools: [], ts: session.last_activity_at, showMeta: true });
    }
    for (const p of pending) {
      out.push({
        kind: 'msg',
        key: p.id,
        side: 'me',
        text: p.text,
        tools: [],
        ts: new Date(p.createdAt).toISOString(),
        state: p.state === 'sent' ? undefined : p.state,
        error: p.error,
        showMeta: p.state !== 'sent',
        onRetry: p.state === 'failed' ? () => retry(p) : undefined,
      });
    }
    if (status === 'working' || status === 'starting' || creating) {
      out.push({ kind: 'typing', key: 'typing', label: status === 'starting' || creating ? 'Starting the session…' : `${session?.agent_name ?? agent?.name ?? 'The agent'} is working…` });
    }
    return out;
  }, [messages, pending, status, creating, unsupported, session, agent, retry]);

  const agentName = session?.agent_name ?? agent?.name ?? (agentId ? agentId : 'Agent');
  const title = session ? sessionTitle(session) : `${agentName}: new session`;
  const when = session ? relativeTimeLong(activityTime(session)) : '';

  const header = (
    <ScreenHeader
      onBack={goBack}
      backLabel="Back to Home"
      left={<AgentAvatar icon={agent?.icon} color={agent?.color} kind={agent?.kind ?? session?.kind} size={34} />}
      title={
        <Text style={styles.title} numberOfLines={1} accessibilityRole="header" testID="chat-title">
          {title}
        </Text>
      }
      subtitle={
        <View style={styles.subRow}>
          {status ? <StatusPill status={status} compact /> : null}
          <Text style={styles.sub} numberOfLines={1}>
            {sid ? agentName : 'New session · starts when you send'}
            {when ? ` · ${when}` : ''}
          </Text>
          {demo ? <DemoBadge /> : null}
        </View>
      }
      testID="chat-header"
    />
  );

  if (gone) {
    return (
      <View style={styles.screen}>
        {header}
        <View style={styles.center}>
          <Icon name="file-tray-outline" size={36} color={colors.text3} />
          <Text style={styles.goneTitle}>This session is gone</Text>
          <Text style={styles.goneText}>It is no longer on your computer. Sessions that ended more than 14 days ago are cleared.</Text>
          <Button title="Back to Home" variant="secondary" onPress={() => router.replace('/home')} style={{ marginTop: 10 }} />
        </View>
      </View>
    );
  }

  const empty = !sid ? (
    <View style={styles.draft} testID="draft-empty">
      <AgentAvatar icon={agent?.icon} color={agent?.color} kind={agent?.kind} size={56} />
      <Text style={styles.draftTitle}>New session with {agentName}</Text>
      {agent?.mission ? <Text style={styles.draftMission}>{agent.mission}</Text> : null}
      <Text style={styles.draftHint}>Your first message becomes the session's task. It runs on your computer, and you can follow it here.</Text>
    </View>
  ) : loaded && !unsupported ? (
    <View style={styles.draft}>
      <Text style={styles.draftHint}>No messages yet. Say what you want {agentName} to do.</Text>
    </View>
  ) : null;

  return (
    <View style={styles.screen} testID="chat-screen">
      {header}
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.flex}>
          {poll.error && poll.error.kind !== 'not_found' ? (
            <View style={styles.bannerWrap}>
              <ConnectionBanner error={poll.error} retryAt={poll.retryAt} onRetry={poll.kick} />
            </View>
          ) : null}
          {unsupported ? (
            <View style={styles.bannerWrap}>
              <Banner
                tone="info"
                title="Update Clawdling on your computer"
                message="This server can't show the conversation on a phone yet. You can still send messages, and the latest reply shows below."
              />
            </View>
          ) : null}
          <MessageList rows={rows} empty={empty} />
        </View>

        {status === 'needs_you' ? (
          <View style={styles.needs} testID="needs-card">
            <Icon name={question ? 'hand-left-outline' : 'chatbubble-ellipses-outline'} size={18} color={tones.needs.text} style={{ marginTop: 1 }} />
            <View style={styles.flexShrink}>
              <Text style={styles.needsTitle}>{questionTitle(question)}</Text>
              <Text style={styles.needsText}>{notification ?? `${agentName} is waiting for your reply.`}</Text>
              {question ? (
                <Text style={styles.needsHint}>
                  {question.certain
                    ? 'Answer it in the cockpit on your computer. To keep you in control, the app never answers these for you.'
                    : 'Answer it in the cockpit on your computer.'}
                </Text>
              ) : null}
            </View>
          </View>
        ) : null}

        {notice ? (
          <View style={styles.noticeWrap}>
            <Banner tone="error" title="That didn't go through" message={notice} />
          </View>
        ) : null}

        {ended ? (
          <View style={[styles.endedBar, { paddingBottom: Math.max(insets.bottom, 12) }]} testID="ended-bar">
            <View style={styles.flexShrink}>
              <Text style={styles.endedTitle}>This session has ended</Text>
              <Text style={styles.endedText} numberOfLines={2}>
                {session?.last_message ? `Last reply: ${previewText(session.last_message, 90)}` : 'Resume it to pick up where it left off.'}
              </Text>
            </View>
            <Button title="Resume" icon="play" onPress={resume} busy={resuming} testID="resume-button" style={styles.resume} />
          </View>
        ) : (
          <Composer
            value={draft}
            onChangeText={setDraft}
            onSend={() => void send()}
            placeholder={blocked ? 'Answer this in the cockpit on your computer' : sid ? `Message ${agentName}` : `What should ${agentName} do?`}
            sending={creating}
            disabled={(!loaded && !!sid) || blocked}
            bottomInset={keyboard ? 8 : insets.bottom}
            autoFocus={!sid}
          />
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  flexShrink: { flex: 1, minWidth: 0 },
  title: { fontSize: 16, lineHeight: 21, fontWeight: '600', color: colors.text },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3 },
  sub: { fontSize: 13, lineHeight: 17, color: colors.text2, flexShrink: 1 },
  bannerWrap: { paddingHorizontal: 12, paddingTop: 10 },
  noticeWrap: { paddingHorizontal: 12, paddingBottom: 8 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  goneTitle: { ...type.title, fontSize: 20, marginTop: 6 },
  goneText: { ...type.callout, textAlign: 'center' },
  draft: { alignItems: 'center', paddingHorizontal: 24, gap: 8 },
  draftTitle: { ...type.headline, fontSize: 19, marginTop: 8, textAlign: 'center' },
  draftMission: { ...type.callout, textAlign: 'center' },
  draftHint: { ...type.footnote, textAlign: 'center', marginTop: 6, maxWidth: 320 },
  needs: {
    flexDirection: 'row',
    gap: 10,
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 12,
    borderRadius: radius.md,
    backgroundColor: tones.needs.soft,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(240, 179, 60, 0.3)',
  },
  needsTitle: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: tones.needs.text },
  needsText: { fontSize: 14, lineHeight: 19, color: colors.text },
  needsHint: { fontSize: 12.5, lineHeight: 17, color: colors.text2, marginTop: 3 },
  endedBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingTop: 12,
    paddingHorizontal: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line2,
    backgroundColor: colors.bg,
  },
  endedTitle: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: colors.text },
  endedText: { fontSize: 13, lineHeight: 18, color: colors.text2 },
  resume: { minHeight: 44, paddingHorizontal: 16 },
});

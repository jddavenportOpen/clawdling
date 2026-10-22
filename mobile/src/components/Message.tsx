import { memo, useState, type ReactNode } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { toolDisplay, type PendingState } from '../chat';
import { clockTime } from '../format';
import { colors, CONTENT_MAX, mono, radius } from '../theme';
import type { ToolCall } from '../types';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { TypingDots } from './TypingDots';

export type ChatRow =
  | {
      kind: 'msg';
      key: string;
      side: 'me' | 'them';
      text: string;
      tools: ToolCall[];
      ts: string | null;
      state?: PendingState;
      error?: string;
      /** Time (and channel) under the last bubble of a run. */
      showMeta: boolean;
      channel?: string | null;
      onRetry?: () => void;
    }
  | { kind: 'typing'; key: string; label: string };

function ToolLines({ tools }: { tools: ToolCall[] }) {
  const [expanded, setExpanded] = useState(false);
  const d = toolDisplay(tools, expanded);
  if (!d.lines.length) return null;
  return (
    <View style={styles.tools} testID="tool-lines">
      {d.lines.map((line, i) => (
        <View key={i} style={styles.toolRow}>
          <Icon name="terminal-outline" size={13} color={colors.text3} style={styles.toolIcon} />
          <Text style={styles.toolText} numberOfLines={expanded ? 3 : 1}>
            <Text style={styles.toolRan}>Ran: </Text>
            <Text style={styles.toolWhat}>{line.replace(/^Ran: /, '')}</Text>
          </Text>
        </View>
      ))}
      {d.toggle ? (
        <Pressable
          onPress={() => setExpanded(!expanded)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={expanded ? 'Show fewer steps' : `Show ${d.toggle}`}
          style={styles.toolToggle}
          testID="tool-toggle"
        >
          <Text style={styles.toolToggleText}>{d.toggle}</Text>
          <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={13} color={colors.accentStrong} />
        </Pressable>
      ) : null}
    </View>
  );
}

export const MessageBubble = memo(function MessageBubble({ row }: { row: Extract<ChatRow, { kind: 'msg' }> }) {
  const me = row.side === 'me';
  const failed = row.state === 'failed';
  const meta: string[] = [];
  if (row.state === 'sending') meta.push('Sending…');
  else if (failed) meta.push(row.error ? `Not sent: ${row.error}` : 'Not sent');
  else if (row.showMeta) {
    const t = clockTime(row.ts);
    if (t) meta.push(t);
    if (row.channel) meta.push(row.channel);
  }
  const bubble = row.text.trim() ? (
    <View style={[styles.bubble, me ? styles.me : styles.them, row.state === 'sending' && styles.sending, failed && styles.failed]}>
      <Markdown text={row.text} tone={me ? 'user' : 'assistant'} />
    </View>
  ) : null;
  return (
    <View style={[styles.wrap, me ? styles.wrapMe : styles.wrapThem]} testID={me ? 'msg-me' : 'msg-them'}>
      {!me && row.tools.length ? <ToolLines tools={row.tools} /> : null}
      {failed && row.onRetry ? (
        <Pressable onPress={row.onRetry} accessibilityRole="button" accessibilityLabel="Not sent. Tap to retry" style={styles.maxMe}>
          {bubble}
        </Pressable>
      ) : (
        bubble
      )}
      {meta.length ? (
        <View style={[styles.metaRow, me && styles.metaMe]}>
          {failed ? <Icon name="alert-circle-outline" size={13} color={colors.danger} /> : null}
          <Text style={[styles.meta, failed && styles.metaFailed]}>
            {meta.join(' · ')}
            {failed && row.onRetry ? ' · Tap to retry' : ''}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

function TypingRow({ label }: { label: string }) {
  return (
    <View style={[styles.wrap, styles.wrapThem]} testID="typing-row">
      <View style={[styles.bubble, styles.them, styles.typing]}>
        <TypingDots />
        <Text style={styles.typingText}>{label}</Text>
      </View>
    </View>
  );
}

/** Newest at the bottom (an inverted list), keyboard-friendly, centred on wide screens. */
export function MessageList({ rows, empty, header }: { rows: ChatRow[]; empty?: ReactNode; header?: ReactNode }) {
  const data = [...rows].reverse();
  return (
    <FlatList
      data={data}
      inverted
      keyExtractor={(r) => r.key}
      renderItem={({ item }) => (item.kind === 'typing' ? <TypingRow label={item.label} /> : <MessageBubble row={item} />)}
      contentContainerStyle={[styles.listContent, !rows.length && styles.listEmpty]}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      ListEmptyComponent={empty ? <View style={styles.emptyWrap}>{empty}</View> : null}
      ListFooterComponent={header ? <View style={styles.listHeader}>{header}</View> : null}
      testID="message-list"
    />
  );
}

const styles = StyleSheet.create({
  listContent: { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 18, width: '100%', maxWidth: CONTENT_MAX, alignSelf: 'center' },
  listEmpty: { flexGrow: 1, justifyContent: 'center' },
  emptyWrap: { transform: [{ scaleY: -1 }], paddingVertical: 24 },
  listHeader: { paddingBottom: 8 },
  wrap: { marginVertical: 3 },
  wrapMe: { alignItems: 'flex-end' },
  wrapThem: { alignItems: 'flex-start' },
  maxMe: { maxWidth: '86%' },
  bubble: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: radius.xl - 2 },
  me: { backgroundColor: colors.userBubble, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.userBubbleLine, borderBottomRightRadius: 6, maxWidth: '86%' },
  them: { backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line2, borderBottomLeftRadius: 6, maxWidth: '94%' },
  sending: { opacity: 0.72 },
  failed: { borderColor: 'rgba(240, 106, 115, 0.55)' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4, marginHorizontal: 6 },
  metaMe: { justifyContent: 'flex-end' },
  meta: { fontSize: 11.5, lineHeight: 15, color: colors.text3 },
  metaFailed: { color: colors.danger },
  tools: { gap: 3, marginBottom: 6, marginLeft: 4, maxWidth: '94%' },
  toolRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  toolIcon: { marginTop: 1 },
  toolText: { fontSize: 13, lineHeight: 18, color: colors.text3, flexShrink: 1 },
  toolRan: { color: colors.text3 },
  toolWhat: { fontFamily: mono, fontSize: 12.5, color: colors.text2 },
  toolToggle: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingVertical: 2, marginLeft: 19 },
  toolToggleText: { fontSize: 12.5, lineHeight: 17, fontWeight: '600', color: colors.accentStrong },
  typing: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12 },
  typingText: { fontSize: 14, lineHeight: 18, color: colors.text2 },
});

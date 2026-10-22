import * as Clipboard from 'expo-clipboard';
import { memo, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View, type TextStyle } from 'react-native';
import { inlineText, parseMarkdown, safeHref, type Block, type Inline } from '../markdown';
import { colors, mono, radius } from '../theme';

export type MarkdownTone = 'assistant' | 'user';

/** Opens http(s) and mailto links in the system browser / mail app. The app embeds no browser. */
export async function openLink(href: string) {
  const safe = safeHref(href);
  if (!safe) return;
  try {
    await Linking.openURL(safe);
  } catch {
    // nothing can open it
  }
}

function Spans({ nodes, tone, base }: { nodes: Inline[]; tone: MarkdownTone; base?: TextStyle }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case 'text':
            return n.v;
          case 'code':
            return (
              <Text key={i} style={[styles.inlineCode, tone === 'user' && styles.inlineCodeUser]}>
                {n.v}
              </Text>
            );
          case 'bold':
            return (
              <Text key={i} style={styles.bold}>
                <Spans nodes={n.c} tone={tone} base={base} />
              </Text>
            );
          case 'italic':
            return (
              <Text key={i} style={styles.italic}>
                <Spans nodes={n.c} tone={tone} base={base} />
              </Text>
            );
          case 'strike':
            return (
              <Text key={i} style={styles.strike}>
                <Spans nodes={n.c} tone={tone} base={base} />
              </Text>
            );
          case 'link':
            return (
              <Text
                key={i}
                style={[styles.link, tone === 'user' && styles.linkUser]}
                onPress={() => void openLink(n.href)}
                accessibilityRole="link"
                accessibilityHint={`Opens ${n.href}`}
              >
                <Spans nodes={n.c} tone={tone} base={base} />
              </Text>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await Clipboard.setStringAsync(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable
    }
  };
  return (
    <View style={styles.codeBox}>
      <View style={styles.codeBar}>
        <Text style={styles.codeLang}>{lang || 'code'}</Text>
        <Pressable onPress={copy} hitSlop={8} accessibilityRole="button" accessibilityLabel="Copy code">
          <Text style={styles.codeCopy}>{copied ? 'Copied' : 'Copy'}</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.codeScroll}>
        <Text style={styles.codeText} selectable>
          {code}
        </Text>
      </ScrollView>
    </View>
  );
}

function colWidth(header: Inline[], rows: Inline[][][], c: number): number {
  const lens = [inlineText(header).length, ...rows.map((r) => inlineText(r[c] ?? []).length)];
  const longest = Math.max(...lens);
  return Math.max(64, Math.min(220, longest * 8 + 24));
}

function Table({ header, rows, tone }: { header: Inline[][]; rows: Inline[][][]; tone: MarkdownTone }) {
  const widths = header.map((_, c) => colWidth(header[c], rows, c));
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tableScroll}>
      <View style={styles.table}>
        <View style={[styles.tr, styles.thRow]}>
          {header.map((cell, c) => (
            <View key={c} style={[styles.td, { width: widths[c] }]}>
              <Text style={[styles.th, tone === 'user' && styles.userText]}>
                <Spans nodes={cell} tone={tone} />
              </Text>
            </View>
          ))}
        </View>
        {rows.map((row, r) => (
          <View key={r} style={[styles.tr, r === rows.length - 1 && styles.trLast]}>
            {row.map((cell, c) => (
              <View key={c} style={[styles.td, { width: widths[c] }]}>
                <Text style={[styles.tdText, tone === 'user' && styles.userText]}>
                  <Spans nodes={cell} tone={tone} />
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function BlockView({ block, tone, first }: { block: Block; tone: MarkdownTone; first: boolean }) {
  const text = [styles.p, tone === 'user' && styles.userText];
  const gap = first ? null : styles.gap;
  switch (block.t) {
    case 'p':
      return (
        <Text style={[text, gap]} selectable>
          <Spans nodes={block.c} tone={tone} />
        </Text>
      );
    case 'h':
      return (
        <Text style={[text, styles.h, block.level === 1 ? styles.h1 : block.level === 2 ? styles.h2 : styles.h3, gap]} accessibilityRole="header" selectable>
          <Spans nodes={block.c} tone={tone} />
        </Text>
      );
    case 'code':
      return (
        <View style={gap}>
          <CodeBlock lang={block.lang} code={block.v} />
        </View>
      );
    case 'ul':
    case 'ol':
      return (
        <View style={[styles.list, gap]}>
          {block.items.map((item, i) => (
            <View key={i} style={[styles.li, { paddingLeft: item.depth * 16 }]}>
              <Text style={[text, styles.marker]}>{block.t === 'ol' ? `${block.start + i}.` : item.depth > 0 ? '◦' : '•'}</Text>
              <Text style={[text, styles.liText]} selectable>
                <Spans nodes={item.c} tone={tone} />
              </Text>
            </View>
          ))}
        </View>
      );
    case 'quote':
      return (
        <View style={[styles.quote, gap]}>
          <Text style={[text, styles.quoteText]} selectable>
            <Spans nodes={block.c} tone={tone} />
          </Text>
        </View>
      );
    case 'table':
      return (
        <View style={gap}>
          <Table header={block.header} rows={block.rows} tone={tone} />
        </View>
      );
    case 'hr':
      return <View style={[styles.hr, gap]} />;
    default:
      return null;
  }
}

export const Markdown = memo(function Markdown({ text, tone = 'assistant' }: { text: string; tone?: MarkdownTone }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <View>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} tone={tone} first={i === 0} />
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  p: { fontSize: 16, lineHeight: 23, color: colors.text },
  userText: { color: '#f3f1ff' },
  gap: { marginTop: 10 },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
  link: { color: colors.accentStrong, textDecorationLine: 'underline' },
  linkUser: { color: '#ffffff' },
  inlineCode: { fontFamily: mono, fontSize: 14, color: '#e9e4ff', backgroundColor: 'rgba(155, 140, 255, 0.13)' },
  inlineCodeUser: { backgroundColor: 'rgba(255, 255, 255, 0.12)', color: '#ffffff' },
  h: { fontWeight: '700' },
  h1: { fontSize: 20, lineHeight: 26 },
  h2: { fontSize: 18, lineHeight: 24 },
  h3: { fontSize: 16, lineHeight: 22 },
  list: { gap: 4 },
  li: { flexDirection: 'row', gap: 8 },
  marker: { minWidth: 14, color: colors.text2 },
  liText: { flex: 1 },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.accentLine, paddingLeft: 10 },
  quoteText: { color: colors.text2 },
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line3, marginVertical: 4 },
  codeBox: { backgroundColor: colors.codeBg, borderRadius: radius.sm + 2, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line2, overflow: 'hidden' },
  codeBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 12, paddingTop: 7, paddingBottom: 2 },
  codeLang: { fontSize: 11, lineHeight: 14, fontWeight: '600', color: colors.text3, letterSpacing: 0.4, textTransform: 'uppercase' },
  codeCopy: { fontSize: 12, lineHeight: 15, fontWeight: '600', color: colors.accentStrong },
  codeScroll: { paddingHorizontal: 12, paddingBottom: 11, paddingTop: 4 },
  codeText: { fontFamily: mono, fontSize: 13, lineHeight: 19, color: '#d8dce3' },
  tableScroll: { marginHorizontal: -2 },
  table: { borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line2, overflow: 'hidden' },
  tr: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line2 },
  trLast: { borderBottomWidth: 0 },
  thRow: { backgroundColor: colors.surface3 },
  td: { paddingHorizontal: 10, paddingVertical: 7 },
  th: { fontSize: 14, lineHeight: 19, fontWeight: '700', color: colors.text },
  tdText: { fontSize: 14, lineHeight: 19, color: colors.text },
});

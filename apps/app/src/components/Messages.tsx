import { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { readSealed, type B64, type Event, type HiddenReason, type ScopeView } from '@mun/core';
import { timeOf, useSession } from '../hooks';
import { useTheme } from '../theme';
import { Badge, Btn, Empty, Field, Row } from '../ui';

const HIDDEN_LABEL: Record<HiddenReason, string> = {
  muted: 'sent while muted',
  locked: 'sent while locked',
  slowMode: 'too soon (slow mode)',
  revoked: 'removed device',
  forked: 'tampered',
  notAllowed: 'not allowed',
};

type Item =
  | { kind: 'post'; event: Event<'post' | 'announce'>; hidden?: HiddenReason }
  | { kind: 'sealed'; event: Event<'dm' | 'ebpost'> };

/** Display name of an author, as of when they wrote. */
export function useAuthorName() {
  const session = useSession();
  return (e: Event) => session.node.replica.auth.memberAt(e.a, e.h)?.name ?? 'Unknown device';
}

function Bubble(props: { item: Item; mine: boolean; pinned: boolean; onPin?: () => void }) {
  const { colors, styles } = useTheme();
  const session = useSession();
  const author = useAuthorName();
  const { item } = props;
  const e = item.event;
  const member = session.node.replica.auth.memberAt(e.a, e.h);
  const announcement = e.k === 'announce';
  const text =
    item.kind === 'post' ? item.event.b.text : (readSealed(session.node, item.event)?.text ?? '🔒 Sealed for someone else');
  return (
    <View
      style={{
        padding: 10,
        borderRadius: 12,
        gap: 4,
        backgroundColor: announcement ? colors.highlight : props.mine ? colors.surfaceHi : colors.surface,
        borderWidth: announcement ? 1 : 0,
        borderColor: colors.accent,
        opacity: item.kind === 'post' && item.hidden ? 0.45 : 1,
      }}
    >
      <Row style={{ justifyContent: 'space-between' }}>
        <Row style={{ gap: 6 }}>
          <Text style={styles.h2}>{author(e)}</Text>
          {member?.role === 'eb' ? <Badge label="EB" tone="accent" /> : null}
          {member?.role === 'secretariat' ? <Badge label="Secretariat" tone="accent" /> : null}
          {announcement ? <Badge label="Announcement" tone="accent" /> : null}
          {props.pinned ? <Badge label="Pinned" /> : null}
          {item.kind === 'post' && item.hidden ? <Badge label={`Hidden: ${HIDDEN_LABEL[item.hidden]}`} tone="muted" /> : null}
        </Row>
        <Row style={{ gap: 6 }}>
          {props.onPin ? (
            <Pressable accessibilityRole="button" onPress={props.onPin}>
              <Text style={styles.muted}>{props.pinned ? 'Unpin' : 'Pin'}</Text>
            </Pressable>
          ) : null}
          <Text style={styles.muted}>{timeOf(e.h.t)}</Text>
        </Row>
      </Row>
      <Text style={styles.text} selectable>
        {text}
      </Text>
    </View>
  );
}

/**
 * A committee or global channel. Pinned posts first; hidden posts only for
 * moderators (greyed, with the reason), so they can see what the rules stopped.
 */
export function Channel(props: { view: ScopeView; showHidden?: boolean; onPin?: (id: B64, on: boolean) => void; empty: string }) {
  const session = useSession();
  const { view } = props;
  const items: Item[] = [
    ...view.posts.map((event) => ({ kind: 'post' as const, event })),
    ...(props.showHidden ? view.hidden.map((h) => ({ kind: 'post' as const, event: h.event, hidden: h.why })) : []),
  ].sort((a, b) => a.event.h.t - b.event.h.t || a.event.h.c - b.event.h.c);
  const pinned = new Set(view.pinned);
  const pinnedItems = items.filter((i) => pinned.has(i.event.id));
  return (
    <View style={{ flex: 1, gap: 8 }}>
      {pinnedItems.length ? (
        <View style={{ gap: 6 }}>
          {pinnedItems.map((i) => (
            <Bubble key={`pin-${i.event.id}`} item={i} mine={i.event.a === session.node.key} pinned onPin={props.onPin && (() => props.onPin!(i.event.id, false))} />
          ))}
        </View>
      ) : null}
      <List items={items} pinned={pinned} onPin={props.onPin} empty={props.empty} />
    </View>
  );
}

/** EB-to-EB channel or a delegate↔EB thread: sealed messages, opened with this device's key. */
export function SealedList(props: { events: Event<'dm' | 'ebpost'>[]; empty: string }) {
  const items: Item[] = props.events.map((event) => ({ kind: 'sealed', event }));
  return <List items={items} pinned={new Set()} empty={props.empty} />;
}

function List(props: { items: Item[]; pinned: Set<B64>; onPin?: (id: B64, on: boolean) => void; empty: string }) {
  const session = useSession();
  const ref = useRef<FlatList<Item>>(null);
  const count = props.items.length;
  // Keep the newest message in view as messages arrive.
  useEffect(() => {
    if (count) setTimeout(() => ref.current?.scrollToEnd({ animated: false }), 0);
  }, [count]);
  if (!count) return <Empty text={props.empty} />;
  return (
    <FlatList
      ref={ref}
      style={{ flex: 1 }}
      data={props.items}
      keyExtractor={(i) => i.event.id}
      contentContainerStyle={{ gap: 6, paddingBottom: 8 }}
      renderItem={({ item }) => (
        <Bubble
          item={item}
          mine={item.event.a === session.node.key}
          pinned={props.pinned.has(item.event.id)}
          onPin={props.onPin && item.kind === 'post' && !(item as { hidden?: HiddenReason }).hidden ? () => props.onPin!(item.event.id, !props.pinned.has(item.event.id)) : undefined}
        />
      )}
    />
  );
}

/** Text box and send button; `blocked` explains why posting isn't possible right now. */
export function Composer(props: {
  onSend: (text: string) => void;
  placeholder: string;
  blocked?: string | null;
  sendLabel?: string;
  extra?: React.ReactNode;
}) {
  const { styles } = useTheme();
  const [text, setText] = useState('');
  const send = () => {
    const t = text.trim();
    if (!t || props.blocked) return;
    props.onSend(t);
    setText('');
  };
  return (
    <View style={{ gap: 6 }}>
      {props.blocked ? <Text style={styles.muted}>{props.blocked}</Text> : null}
      <Row style={{ flexWrap: 'nowrap', alignItems: 'flex-end' }}>
        <View style={{ flex: 1 }}>
          <Field
            value={text}
            onChangeText={setText}
            placeholder={props.placeholder}
            editable={!props.blocked}
            multiline
            maxLength={4000}
            style={{ maxHeight: 120 }}
            onKeyPress={(e) => {
              // Enter sends on a laptop; Shift+Enter makes a new line.
              const ne = e.nativeEvent as { key: string; shiftKey?: boolean };
              if (ne.key === 'Enter' && !ne.shiftKey) {
                (e as unknown as { preventDefault?: () => void }).preventDefault?.();
                send();
              }
            }}
          />
        </View>
        {props.extra}
        <Btn title={props.sendLabel ?? 'Send'} variant="primary" onPress={send} disabled={!!props.blocked || !text.trim()} />
      </Row>
    </View>
  );
}

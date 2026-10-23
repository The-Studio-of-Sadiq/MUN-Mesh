import { Pressable, Text, View } from 'react-native';
import { readSealed, sendDm, type B64, type ScopeView } from '@mun/core';
import { timeOf, useSession } from '../hooks';
import { useTheme } from '../theme';
import { Btn, Empty, Row } from '../ui';
import { Composer, SealedList } from './Messages';

/** Private delegate↔EB threads. The EB can read and answer every thread in their committee. */
export function Threads(props: { com: string; view: ScopeView; open: B64 | null; onOpen: (key: B64 | null) => void }) {
  const { colors, styles } = useTheme();
  const session = useSession();
  const auth = session.node.replica.auth;
  const threads = [...props.view.dms.entries()].sort((a, b) => b[1][b[1].length - 1]!.h.t - a[1][a[1].length - 1]!.h.t);

  if (props.open) {
    const events = props.view.dms.get(props.open) ?? [];
    return (
      <View style={{ flex: 1, gap: 8 }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.h2}>{auth.member(props.open)?.name ?? 'Delegate'}</Text>
          <Btn title="All threads" variant="outline" onPress={() => props.onOpen(null)} />
        </Row>
        <SealedList events={events} empty="No messages yet." />
        <Composer placeholder="Reply privately…" onSend={(t) => void sendDm(session.node, props.com, props.open!, t)} />
      </View>
    );
  }

  if (!threads.length) return <Empty text="Delegates’ private messages to the EB appear here." />;
  return (
    <View style={{ gap: 4 }}>
      {threads.map(([key, events]) => {
        const last = events[events.length - 1]!;
        const waiting = last.a === key;
        return (
          <Pressable
            key={key}
            accessibilityRole="button"
            onPress={() => props.onOpen(key)}
            style={{ padding: 10, borderRadius: 10, backgroundColor: colors.surface, gap: 2 }}
          >
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={[styles.h2, waiting && { color: colors.accent }]}>
                {auth.member(key)?.name ?? 'Delegate'}
                {waiting ? ' · waiting' : ''}
              </Text>
              <Text style={styles.muted}>{timeOf(last.h.t)}</Text>
            </Row>
            <Text style={styles.muted} numberOfLines={1}>
              {readSealed(session.node, last)?.text ?? '🔒'}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

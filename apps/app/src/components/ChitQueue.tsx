import { useEffect } from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';
import { approveChit, readChit, rejectChit, type ChitState, type ScopeView } from '@mun/core';
import { timeOf, useSession } from '../hooks';
import { useTheme } from '../theme';
import { Badge, Btn, Card, Empty, Row } from '../ui';

/**
 * Chits waiting for the EB, oldest first. On a laptop, A approves and R
 * rejects the top one, so a chair can clear the queue without the mouse.
 */
export function ChitQueue({ view }: { view: ScopeView }) {
  const { styles } = useTheme();
  const session = useSession();
  const auth = session.node.replica.auth;
  const pending = view.chits.filter((c) => c.status === 'pending').sort((a, b) => a.chit.h.t - b.chit.h.t);
  const decided = view.chits.filter((c) => c.status !== 'pending').slice(-15).reverse();
  const top = pending[0];

  const approve = (c: ChitState) => {
    const result = approveChit(session.node, c.chit);
    if (typeof result === 'string') alertOnce(result === 'unknownRecipient' ? 'The recipient isn’t a member yet.' : 'This laptop can’t open that chit.');
  };
  const reject = (c: ChitState) => void rejectChit(session.node, c.chit);

  useEffect(() => {
    if (Platform.OS !== 'web' || !top) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'a' || e.key === 'A') approve(top);
      else if (e.key === 'r' || e.key === 'R') reject(top);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const line = (c: ChitState) => {
    const content = readChit(session.node, c);
    const from = auth.memberAt(c.chit.a, c.chit.h)?.name ?? '?';
    const to = content ? (auth.member(content.to)?.name ?? 'unknown') : '?';
    return { from, to, text: content?.text ?? '🔒 Can’t open (sealed before this laptop joined the EB)' };
  };

  return (
    <ScrollView contentContainerStyle={{ gap: 8 }}>
      <Text style={styles.muted}>
        {pending.length ? `${pending.length} waiting · A approves, R rejects the top one` : 'No chits waiting.'}
      </Text>
      <Text style={styles.muted}>An approval is final; a rejection can be changed to an approval.</Text>
      {pending.map((c, i) => {
        const l = line(c);
        return (
          <Card key={c.chit.id} style={i === 0 ? { borderWidth: 2 } : undefined}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.h2}>
                {l.from} → {l.to}
              </Text>
              <Text style={styles.muted}>{timeOf(c.chit.h.t)}</Text>
            </Row>
            <Text style={styles.text} selectable>
              {l.text}
            </Text>
            <Row>
              <Btn title={i === 0 ? 'Approve (A)' : 'Approve'} variant="accent" onPress={() => approve(c)} />
              <Btn title={i === 0 ? 'Reject (R)' : 'Reject'} variant="outline" onPress={() => reject(c)} />
            </Row>
          </Card>
        );
      })}
      {decided.length ? <Text style={styles.eyebrow}>Recently decided</Text> : null}
      {decided.map((c) => {
        const l = line(c);
        return (
          <View key={c.chit.id} style={{ gap: 2 }}>
            <Row>
              <Badge label={c.status} tone={c.status === 'approved' ? 'accent' : 'muted'} />
              <Text style={styles.small}>
                {l.from} → {l.to}
              </Text>
              {c.status === 'rejected' ? <Btn title="Approve instead" variant="outline" onPress={() => approve(c)} /> : null}
            </Row>
            <Text style={styles.muted} numberOfLines={1}>
              {l.text}
            </Text>
          </View>
        );
      })}
      {!pending.length && !decided.length ? <Empty text="Chits between delegates will appear here for approval." /> : null}
    </ScrollView>
  );
}

function alertOnce(text: string) {
  if (Platform.OS === 'web') globalThis.alert?.(text);
}

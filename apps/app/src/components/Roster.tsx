import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { GLOBAL, kick, mute, unmute, type B64, type Member, type ScopeView } from '@mun/core';
import { useSession } from '../hooks';
import { useTheme } from '../theme';
import { Badge, Btn, Empty, Row } from '../ui';

/** The committee's members; the EB mutes, kicks or messages them from here. */
export function Roster(props: { com: string; view: ScopeView; onMessage: (key: B64) => void }) {
  const { colors, styles } = useTheme();
  const session = useSession();
  const auth = session.node.replica.auth;
  const [open, setOpen] = useState<B64 | null>(null);
  const [confirmKick, setConfirmKick] = useState<B64 | null>(null);
  const linked = new Set(session.node.neighbours().map((n) => n.node));
  const members = auth
    .all()
    .filter((m) => m.com === props.com && (m.role === 'delegate' || m.role === 'observer' || m.role === 'eb'))
    .filter((m) => !auth.isRemoved(m.key))
    .sort((a, b) => (a.role === 'eb' ? -1 : 0) - (b.role === 'eb' ? -1 : 0) || a.name.localeCompare(b.name));
  const muted = new Set(props.view.muted);
  // EBs remove delegates and observers; only the Secretariat removes an EB laptop.
  const secretariat = session.me()?.role === 'secretariat';
  const removable = (m: Member) => m.role !== 'eb' || secretariat;

  const actions = (m: Member) => (
    <Row style={{ paddingLeft: 8, paddingBottom: 6 }}>
      {m.role !== 'eb' ? (
        muted.has(m.key) ? (
          <Btn title="Unmute" onPress={() => void unmute(session.node, props.com, m.key)} />
        ) : (
          <Btn title="Mute" onPress={() => void mute(session.node, props.com, m.key)} />
        )
      ) : null}
      {m.role === 'delegate' ? <Btn title="Message" onPress={() => props.onMessage(m.key)} /> : null}
      {removable(m) ? (
        confirmKick === m.key ? (
          <Btn
            title="Confirm: remove device"
            variant="outline"
            onPress={() => {
              kick(session.node, m.role === 'eb' ? GLOBAL : props.com, m.key);
              setConfirmKick(null);
              setOpen(null);
            }}
          />
        ) : (
          <Btn title="Remove…" variant="outline" onPress={() => setConfirmKick(m.key)} />
        )
      ) : null}
    </Row>
  );

  return (
    <ScrollView contentContainerStyle={{ gap: 2 }}>
      <Text style={styles.eyebrow}>Members ({members.length})</Text>
      {members.length === 0 ? <Empty text="No delegates yet. Share the invite QR." /> : null}
      {members.map((m) => (
        <View key={m.key}>
          <Pressable
            accessibilityRole="button"
            onPress={() => setOpen(open === m.key ? null : m.key)}
            style={{ paddingVertical: 6, paddingHorizontal: 8, borderRadius: 8, backgroundColor: open === m.key ? colors.surfaceHi : 'transparent' }}
          >
            <Row style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
              <Row style={{ gap: 6, flexShrink: 1 }}>
                <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: linked.has(m.key) ? colors.accent : 'transparent', borderWidth: 1, borderColor: colors.muted }} />
                <Text style={styles.small} numberOfLines={1}>
                  {m.name}
                </Text>
              </Row>
              <Row style={{ gap: 4 }}>
                {m.role === 'eb' ? <Badge label="EB" tone="accent" /> : null}
                {m.role === 'observer' ? <Badge label="Obs" tone="muted" /> : null}
                {muted.has(m.key) ? <Badge label="Muted" /> : null}
              </Row>
            </Row>
          </Pressable>
          {open === m.key ? actions(m) : null}
        </View>
      ))}
      <Text style={[styles.muted, { marginTop: 8 }]}>● filled: linked directly to this laptop</Text>
    </ScrollView>
  );
}

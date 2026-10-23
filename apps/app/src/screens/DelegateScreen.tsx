import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { GLOBAL, post, readChit, sendChit, sendDm, type B64, type ChitState, type ScopeView } from '@mun/core';
import { Channel, Composer, SealedList } from '../components/Messages';
import { timeOf, useNow, useScope, useSession } from '../hooks';
import { useTheme } from '../theme';
import { Badge, Btn, Card, Chip, Empty, Field, Row, Status } from '../ui';

type Tab = 'committee' | 'chits' | 'chair' | 'global';

/** A delegate's (or observer's) app: the committee channel, chits, a private line to the EB, and conference news. */
export function DelegateScreen(props: { onLeave: () => void }) {
  const { colors, styles } = useTheme();
  const session = useSession();
  const me = session.me()!;
  const com = me.com!;
  const view = useScope(com);
  const globalView = useScope(GLOBAL);
  const [tab, setTab] = useState<Tab>('committee');
  const [confirmLeave, setConfirmLeave] = useState(false);
  const links = session.node.neighbours().length;
  if (!view) return null;

  const chitsForMe = view.chits.filter((c) => c.status === 'approved' && readChit(session.node, c)?.to === me.key).length;
  const tabs: [Tab, string][] = [
    ['committee', 'Committee'],
    ['chits', `Chits${chitsForMe ? ` (${chitsForMe})` : ''}`],
    ['chair', 'Chair'],
    ['global', 'Conference'],
  ];

  return (
    <View style={styles.screen}>
      <View style={{ width: '100%', maxWidth: 820, alignSelf: 'center', flex: 1, padding: 12, gap: 10 }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <View style={{ flexShrink: 1 }}>
            <Text style={styles.eyebrow}>{session.committeeName(com)}</Text>
            <Text style={styles.title}>{me.name}</Text>
          </View>
          <Status ok={links > 0} label={links ? 'Connected' : 'Offline — messages send when back'} />
        </Row>
        <Row>
          {tabs.map(([id, label]) => (
            <Chip key={id} label={label} active={tab === id} onPress={() => setTab(id)} />
          ))}
        </Row>
        <View style={{ flex: 1, gap: 8 }}>
          {tab === 'committee' ? <CommitteeTab com={com} view={view} /> : null}
          {tab === 'chits' ? <ChitsTab com={com} view={view} /> : null}
          {tab === 'chair' ? (
            <>
              <Text style={styles.muted}>A private line to your committee’s EB.</Text>
              <SealedList events={view.dms.get(me.key) ?? []} empty="Ask the chair anything; only the EB sees this." />
              {me.role === 'delegate' ? (
                <Composer
                  files
                  placeholder="Message the chair…"
                  onSend={async (t, f) => void sendDm(session.node, com, me.key, t, f ? await session.prepareFile(f, com) : undefined)}
                />
              ) : null}
            </>
          ) : null}
          {tab === 'global' && globalView ? <Channel view={globalView} empty="Announcements from the Secretariat appear here." /> : null}
        </View>
        <View style={{ borderTopWidth: 1, borderColor: colors.border, paddingTop: 6 }}>
          {confirmLeave ? (
            <Row>
              <Text style={styles.muted}>Leave and forget this conference on this device?</Text>
              <Btn title="Leave" variant="outline" onPress={props.onLeave} />
              <Btn title="Cancel" onPress={() => setConfirmLeave(false)} />
            </Row>
          ) : (
            <Pressable accessibilityRole="button" onPress={() => setConfirmLeave(true)}>
              <Text style={styles.muted}>Leave conference…</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

function CommitteeTab({ com, view }: { com: string; view: ScopeView }) {
  const session = useSession();
  const me = session.me()!;
  const now = useNow();
  const mine = view.posts.filter((p) => p.a === me.key);
  const last = mine[mine.length - 1];
  const wait = view.slowSec && last ? Math.ceil(view.slowSec - (now - last.h.t) / 1000) : 0;
  const blocked =
    me.role === 'observer'
      ? 'Observers can read the committee but not post.'
      : view.muted.includes(me.key)
        ? 'The chair has muted you. You can still message the chair privately.'
        : view.locked
          ? 'The chair has locked the channel.'
          : wait > 0
            ? `Slow mode: you can post again in ${wait}s.`
            : null;
  return (
    <>
      <Channel view={view} empty="No messages yet." />
      <Composer
        files
        placeholder="Message the committee…"
        blocked={blocked}
        onSend={async (t, f) => void post(session.node, com, t, { file: f ? await session.prepareFile(f, com) : undefined })}
      />
    </>
  );
}

function ChitsTab({ com, view }: { com: string; view: ScopeView }) {
  const { styles } = useTheme();
  const session = useSession();
  const me = session.me()!;
  const auth = session.node.replica.auth;
  const [to, setTo] = useState<B64 | null>(null);
  const [filter, setFilter] = useState('');
  const delegates = auth
    .all()
    .filter((m) => m.com === com && m.role === 'delegate' && m.key !== me.key)
    .sort((a, b) => a.name.localeCompare(b.name));
  const shown = delegates.filter((d) => d.name.toLowerCase().includes(filter.toLowerCase())).slice(0, 30);

  const mineOrToMe = view.chits
    .map((c) => ({ c, content: readChit(session.node, c) }))
    .filter(({ c, content }) => c.chit.a === me.key || (content && content.to === me.key))
    .sort((a, b) => b.c.chit.h.t - a.c.chit.h.t);

  const label = (c: ChitState) => (c.status === 'pending' ? 'With the EB' : c.status === 'approved' ? 'Delivered' : 'Not passed on');

  return (
    <ScrollView contentContainerStyle={{ gap: 10 }}>
      {me.role === 'delegate' ? (
        <Card>
          <Text style={styles.h2}>Pass a chit</Text>
          <Text style={styles.muted}>Chits go through the EB, who approves them before the other delegate can read them.</Text>
          {to ? (
            <Row>
              <Text style={styles.text}>To {auth.member(to)?.name}</Text>
              <Btn title="Change" variant="outline" onPress={() => setTo(null)} />
            </Row>
          ) : (
            <>
              <Field value={filter} onChangeText={setFilter} placeholder="Find a delegate…" />
              <Row>
                {shown.map((d) => (
                  <Chip key={d.key} label={d.name} onPress={() => setTo(d.key)} />
                ))}
              </Row>
              {!delegates.length ? <Text style={styles.muted}>No other delegates have joined yet.</Text> : null}
            </>
          )}
          {to ? (
            <Composer
              placeholder="Your chit…"
              sendLabel="Send to EB"
              onSend={(t) => {
                sendChit(session.node, com, to, t);
                setTo(null);
              }}
            />
          ) : null}
        </Card>
      ) : null}
      {mineOrToMe.length === 0 ? <Empty text="No chits yet." /> : null}
      {mineOrToMe.map(({ c, content }) => {
        const sent = c.chit.a === me.key;
        const other = sent ? (content ? auth.member(content.to)?.name : '?') : auth.memberAt(c.chit.a, c.chit.h)?.name;
        return (
          <Card key={c.chit.id}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.h2}>{sent ? `To ${other}` : `From ${other}`}</Text>
              <Row>
                {sent ? <Badge label={label(c)} tone={c.status === 'approved' ? 'accent' : 'muted'} /> : null}
                <Text style={styles.muted}>{timeOf(c.chit.h.t)}</Text>
              </Row>
            </Row>
            <Text style={styles.text} selectable>
              {content?.text}
            </Text>
          </Card>
        );
      })}
    </ScrollView>
  );
}

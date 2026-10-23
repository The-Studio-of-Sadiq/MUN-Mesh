import { useState } from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { announce, ebPost, EB_SCOPE, GLOBAL, lock, pin, post, slowMode, type B64, type Event } from '@mun/core';
import { ChitQueue } from '../components/ChitQueue';
import { Channel, Composer, SealedList } from '../components/Messages';
import { NetworkPanel } from '../components/NetworkPanel';
import { Requests } from '../components/Requests';
import { Roster } from '../components/Roster';
import { Threads } from '../components/Threads';
import { useScope, useSession } from '../hooks';
import { useTheme } from '../theme';
import { Badge, Btn, Chip, Row, Status } from '../ui';

type Panel = 'chits' | 'requests' | 'threads' | 'network';

/**
 * The EB's laptop: channels and members on the left, the chat in the middle,
 * the work queue (chits, join requests, private threads) on the right. The
 * Secretariat gets the same console with every committee.
 */
export function ConsoleScreen(props: { onLeave: () => void }) {
  const { colors, styles } = useTheme();
  const session = useSession();
  const me = session.me()!;
  const { width } = useWindowDimensions();
  const sec = me.role === 'secretariat';
  const committees = sec ? session.profile.conf.committees.map((c) => c.id) : [me.com!];
  const [channel, setChannel] = useState<string>(committees[0] ?? GLOBAL);
  const com = session.node.replica.auth.isCommittee(channel) ? channel : (committees[0] ?? undefined);
  const view = useScope(com);
  const globalView = useScope(GLOBAL);
  const [panel, setPanel] = useState<Panel>('chits');
  const [thread, setThread] = useState<B64 | null>(null);
  const [asAnnouncement, setAsAnnouncement] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const wide = width >= 1100;

  const pendingChits = view?.chits.filter((c) => c.status === 'pending').length ?? 0;
  const requests = session.approvable().length;
  const waitingThreads = view ? [...view.dms.entries()].filter(([k, list]) => list[list.length - 1]!.a === k).length : 0;
  const links = session.node.neighbours().length;

  const channelButton = (id: string, label: string, badge?: number) => (
    <Pressable
      key={id}
      accessibilityRole="button"
      onPress={() => setChannel(id)}
      style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8, backgroundColor: channel === id ? colors.surfaceHi : 'transparent' }}
    >
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={[styles.h2, { fontSize: 14 }]} numberOfLines={1}>
          {label}
        </Text>
        {badge ? <Badge label={String(badge)} tone="accent" /> : null}
      </Row>
    </Pressable>
  );

  const center = () => {
    if (channel === EB_SCOPE) {
      const events = (session.node.replica.store.events(EB_SCOPE) as Event<'ebpost'>[]).filter((e) => e.k === 'ebpost').sort((a, b) => a.h.t - b.h.t);
      return (
        <>
          <SealedList events={events} empty="Messages between EBs and the Secretariat. Delegates never see these." />
          <Composer placeholder="Message all EBs and the Secretariat…" onSend={(t) => void ebPost(session.node, t)} />
        </>
      );
    }
    if (channel === GLOBAL) {
      return (
        <>
          {globalView ? <Channel view={globalView} showHidden onPin={sec ? (id, on) => void pin(session.node, GLOBAL, id, on) : undefined} empty="Conference-wide announcements from the Secretariat." /> : null}
          {sec ? <Composer placeholder="Announce to the whole conference…" sendLabel="Announce" onSend={(t) => void announce(session.node, GLOBAL, t)} /> : null}
        </>
      );
    }
    if (!view || !com) return null;
    return (
      <>
        <Row style={{ justifyContent: 'space-between' }}>
          <Row>
            <Chip label={view.locked ? 'Locked — unlock' : 'Lock channel'} active={view.locked} onPress={() => void lock(session.node, com, !view.locked)} />
            <Chip
              label={view.slowSec ? `Slow mode ${view.slowSec}s — off` : 'Slow mode 30s'}
              active={view.slowSec > 0}
              onPress={() => void slowMode(session.node, com, view.slowSec ? 0 : 30)}
            />
          </Row>
          <Text style={styles.muted}>{view.posts.length} messages · {view.hidden.length} hidden</Text>
        </Row>
        <Channel view={view} showHidden onPin={(id, on) => void pin(session.node, com, id, on)} empty="No messages yet. Share the invite QR to bring delegates in." />
        <Composer
          placeholder={asAnnouncement ? 'Announcement to the committee…' : 'Message the committee…'}
          sendLabel={asAnnouncement ? 'Announce' : 'Send'}
          onSend={(t) => void (asAnnouncement ? announce(session.node, com, t) : post(session.node, com, t))}
          extra={<Chip label="Announce" active={asAnnouncement} onPress={() => setAsAnnouncement(!asAnnouncement)} />}
        />
      </>
    );
  };

  const right = () => (
    <View style={{ flex: 1, gap: 10 }}>
      <Row>
        <Chip label={`Chits${pendingChits ? ` (${pendingChits})` : ''}`} active={panel === 'chits'} onPress={() => setPanel('chits')} />
        <Chip label={`Join${requests ? ` (${requests})` : ''}`} active={panel === 'requests'} onPress={() => setPanel('requests')} />
        <Chip label={`Threads${waitingThreads ? ` (${waitingThreads})` : ''}`} active={panel === 'threads'} onPress={() => setPanel('threads')} />
        <Chip label="Network" active={panel === 'network'} onPress={() => setPanel('network')} />
      </Row>
      {panel === 'chits' && view ? <ChitQueue view={view} /> : null}
      {panel === 'requests' ? <Requests com={sec ? (channel === com ? com : undefined) : me.com} /> : null}
      {panel === 'threads' && view && com ? <Threads com={com} view={view} open={thread} onOpen={setThread} /> : null}
      {panel === 'network' ? <NetworkPanel /> : null}
    </View>
  );

  return (
    <View style={[styles.screen, { flexDirection: wide ? 'row' : 'column' }]}>
      <View style={{ width: wide ? 250 : '100%', padding: 12, gap: 6, borderRightWidth: wide ? 1 : 0, borderColor: colors.border, maxHeight: wide ? undefined : 260 }}>
        <Text style={styles.eyebrow}>{session.profile.conf.name}</Text>
        <Text style={styles.title} numberOfLines={1}>
          {me.name}
        </Text>
        <Row>
          <Badge label={sec ? 'Secretariat' : `EB · ${session.committeeName(me.com).split(/\s+[—–-]\s+/)[0]}`} tone="accent" />
        </Row>
        <Status ok={links > 0} label={links ? `${links} link${links > 1 ? 's' : ''}` : 'No links yet'} />
        <Text style={[styles.eyebrow, { marginTop: 8 }]}>Channels</Text>
        {committees.map((c) => channelButton(c, session.committeeName(c)))}
        {channelButton(EB_SCOPE, 'EB channel')}
        {channelButton(GLOBAL, 'Conference announcements')}
        {com && view && wide ? (
          <View style={{ flex: 1, marginTop: 8 }}>
            <Roster
              com={com}
              view={view}
              onMessage={(key) => {
                setThread(key);
                setPanel('threads');
              }}
            />
          </View>
        ) : null}
        {session.node.key === session.profile.conf.root ? (
          <Text style={styles.muted}>This laptop holds the conference’s master key.</Text>
        ) : confirmLeave ? (
          <Row>
            <Btn title="Yes, leave and forget" variant="outline" onPress={props.onLeave} />
            <Btn title="Cancel" onPress={() => setConfirmLeave(false)} />
          </Row>
        ) : (
          <Btn title="Leave conference…" variant="outline" onPress={() => setConfirmLeave(true)} />
        )}
      </View>
      <View style={{ flex: 1, padding: 12, gap: 8, minWidth: 0 }}>{center()}</View>
      <View style={{ width: wide ? 400 : '100%', padding: 12, borderLeftWidth: wide ? 1 : 0, borderColor: colors.border, flex: wide ? undefined : 1 }}>
        {right()}
      </View>
    </View>
  );
}

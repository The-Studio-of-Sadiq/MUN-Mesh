import { ScrollView, Text } from 'react-native';
import { keyFingerprint } from '@mun/core';
import { useSession } from '../hooks';
import { useTheme } from '../theme';
import { Btn, Card, Row, Status } from '../ui';

/** After the EB (or Secretariat) removed this device: every device now refuses its links and messages. */
export function RemovedScreen(props: { onLeave: () => void }) {
  const { styles } = useTheme();
  const session = useSession();
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.eyebrow}>{session.profile.conf.name}</Text>
      <Text style={styles.h1}>You’ve been removed</Text>
      <Card>
        <Text style={styles.text}>
          This device was removed from the conference. It can no longer send or receive messages. If you think this is a mistake, speak to{' '}
          {session.me()?.role === 'eb' ? 'the Secretariat' : 'your EB'}.
        </Text>
        <Row>
          <Btn title="Leave and start over" variant="outline" onPress={props.onLeave} />
        </Row>
      </Card>
    </ScrollView>
  );
}

/** Until a cert for this device arrives. */
export function WaitingScreen(props: { onLeave: () => void }) {
  const { styles } = useTheme();
  const session = useSession();
  const { profile } = session;
  const links = session.node.neighbours().length;
  const approver = profile.role === 'eb' || profile.role === 'secretariat' ? 'the Secretariat' : 'your EB';
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.eyebrow}>{profile.conf.name}</Text>
      <Text style={styles.h1}>Waiting for approval</Text>
      <Card>
        <Text style={styles.text}>
          {profile.name}
          {profile.com ? ` · ${session.committeeName(profile.com)}` : ''}
        </Text>
        <Text style={styles.muted}>Your device code — read it out if {approver} asks:</Text>
        <Text style={styles.code}>{keyFingerprint(session.node.key)}</Text>
        <Status ok={links > 0} label={links > 0 ? `Connected to ${links} device${links > 1 ? 's' : ''}` : 'Looking for the network…'} />
        {links === 0 ? (
          <Text style={styles.muted}>Make sure you’re on the committee room’s Wi-Fi. The request is sent as soon as a hub is in reach.</Text>
        ) : null}
        <Row>
          <Btn title="Ask again" onPress={() => session.node.requestJoin(session.joinFields())} />
          <Btn title="Start over" variant="outline" onPress={props.onLeave} />
        </Row>
      </Card>
    </ScrollView>
  );
}

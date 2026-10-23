import { ScrollView, Text } from 'react-native';
import { keyFingerprint } from '@mun/core';
import { useSession } from '../hooks';
import { useTheme } from '../theme';
import { Btn, Card, Row, Status } from '../ui';

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

import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { isHostPort } from '@mun/core';
import { useSession } from '../hooks';
import { useTheme } from '../theme';
import { Badge, Btn, Card, Field, Row, Status } from '../ui';

/** Links, addresses and stored events: for working out why a room is cut off. */
export function NetworkPanel() {
  const { styles } = useTheme();
  const session = useSession();
  const status = session.device.status();
  const auth = session.node.replica.auth;
  const [addr, setAddr] = useState('');
  const links = status.links.filter((l) => l.node);

  return (
    <ScrollView contentContainerStyle={{ gap: 12 }}>
      <Card>
        <Status ok={links.length > 0} label={`${links.length} link${links.length === 1 ? '' : 's'} · ${session.node.replica.store.size} events stored`} />
        <Text style={styles.muted}>
          {status.port !== null
            ? status.addresses.length
              ? `Accepting connections at ${status.addresses.join(', ')}`
              : `Listening on port ${status.port}, but no network address yet`
            : 'Connects out to hubs only'}
        </Text>
      </Card>
      <Text style={styles.eyebrow}>Linked devices</Text>
      {links.map((l) => {
        const m = l.node ? auth.member(l.node) : null;
        return (
          <Row key={l.id} style={{ justifyContent: 'space-between' }}>
            <Text style={styles.small}>{m ? `${m.name}${m.com ? ` (${session.committeeName(m.com)})` : ''}` : 'Device waiting for approval'}</Text>
            <Row style={{ gap: 4 }}>
              {m?.role === 'eb' || m?.role === 'secretariat' ? <Badge label="Hub" tone="accent" /> : null}
              <Badge label={l.inbound ? 'In' : 'Out'} tone="muted" />
            </Row>
          </Row>
        );
      })}
      <Text style={styles.eyebrow}>Known hub addresses</Text>
      {status.known.map((k) => (
        <Row key={k.addr} style={{ justifyContent: 'space-between' }}>
          <Text style={styles.small}>{k.addr}</Text>
          <Text style={styles.muted}>
            {k.source}
            {k.failures ? ` · ${k.failures} failed` : ''}
          </Text>
        </Row>
      ))}
      <View style={{ gap: 6 }}>
        <Field label="Connect to an address" value={addr} onChangeText={setAddr} placeholder="192.168.1.20:47900" autoCapitalize="none" />
        <Row>
          <Btn
            title="Connect"
            disabled={!isHostPort(addr.trim())}
            onPress={() => {
              session.device.addAddress(addr.trim(), 'manual');
              setAddr('');
            }}
          />
          <Btn title="Refresh my addresses" variant="outline" onPress={() => void session.device.refreshAddresses()} />
        </Row>
      </View>
    </ScrollView>
  );
}

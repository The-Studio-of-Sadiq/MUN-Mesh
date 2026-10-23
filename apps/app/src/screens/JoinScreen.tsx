import { useState } from 'react';
import { ScrollView, Text } from 'react-native';
import type { Invite, Role } from '@mun/core';
import { canHost } from '../platform/transport';
import { AppSession } from '../session';
import { useTheme } from '../theme';
import { Btn, Card, Chip, Field, Row } from '../ui';

const ROLE_LABELS: Record<Role, string> = {
  delegate: 'Delegate',
  observer: 'Observer / press',
  eb: 'Executive Board',
  secretariat: 'Secretariat',
};

export function JoinScreen(props: { invite: Invite; onJoined: (s: AppSession) => void; onBack: () => void }) {
  const { styles } = useTheme();
  const { conf } = props.invite;
  // EB and Secretariat run hubs, which need a laptop.
  const roles: Role[] = canHost ? ['delegate', 'eb', 'secretariat', 'observer'] : ['delegate', 'observer'];
  const [role, setRole] = useState<Role>('delegate');
  const [com, setCom] = useState(props.invite.com ?? conf.committees[0]?.id);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [bridge, setBridge] = useState(false);
  const [busy, setBusy] = useState(false);
  const staff = role === 'eb' || role === 'secretariat';
  const needsCommittee = role !== 'secretariat';

  const join = async () => {
    setBusy(true);
    const session = await AppSession.begin({
      conf,
      role,
      ...(needsCommittee ? { com } : {}),
      name: name.trim(),
      ...(code.trim() && role === 'delegate' ? { code: code.trim() } : {}),
      hubs: props.invite.hubs,
      hub: staff || bridge,
    });
    props.onJoined(session);
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.eyebrow}>{conf.name}</Text>
      <Text style={styles.h1}>Join</Text>
      <Card>
        <Text style={styles.muted}>I am</Text>
        <Row>
          {roles.map((r) => (
            <Chip key={r} label={ROLE_LABELS[r]} active={role === r} onPress={() => setRole(r)} />
          ))}
        </Row>
        {needsCommittee ? (
          <>
            <Text style={styles.muted}>Committee</Text>
            <Row>
              {conf.committees.map((c) => (
                <Chip key={c.id} label={c.name.split(/\s+[—–-]\s+/)[0]!} active={com === c.id} onPress={() => setCom(c.id)} />
              ))}
            </Row>
          </>
        ) : null}
        <Field
          label={role === 'delegate' ? 'Country you represent' : 'Your name'}
          value={name}
          onChangeText={setName}
          placeholder={role === 'delegate' ? 'e.g. France' : 'e.g. Ayesha Rahman'}
          maxLength={80}
        />
        {role === 'delegate' ? (
          <Field
            label="Roster code (if the Secretariat gave you one)"
            value={code}
            onChangeText={setCode}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={40}
          />
        ) : null}
        {canHost && !staff ? (
          <Row>
            <Chip label="This laptop bridges two networks" active={bridge} onPress={() => setBridge(!bridge)} />
          </Row>
        ) : null}
        <Text style={styles.muted}>
          {staff
            ? role === 'eb'
              ? 'The Secretariat approves EB laptops.'
              : 'The Secretariat’s main laptop approves other Secretariat devices.'
            : 'Your EB approves you; with a valid roster code it happens automatically.'}
        </Text>
        <Row>
          <Btn title="Ask to join" variant="primary" onPress={() => void join()} disabled={busy || !name.trim() || (needsCommittee && !com)} />
          <Btn title="Back" variant="outline" onPress={props.onBack} />
        </Row>
      </Card>
    </ScrollView>
  );
}

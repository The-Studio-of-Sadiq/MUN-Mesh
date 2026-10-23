import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { keyFingerprint } from '@mun/core';
import { QrCode } from '../QrCode';
import { useSession } from '../hooks';
import { parseRoster } from '../session';
import { useTheme } from '../theme';
import { Badge, Btn, Card, Chip, Empty, Field, Row } from '../ui';

const ROLE: Record<string, string> = { delegate: 'Delegate', observer: 'Observer', eb: 'EB', secretariat: 'Secretariat' };

/** Invite QR, devices asking to join, and the roster that lets delegates in automatically. */
export function Requests({ com }: { com?: string }) {
  const { styles } = useTheme();
  const session = useSession();
  const me = session.me();
  const requests = session.approvable().filter((r) => me?.role !== 'secretariat' || !com || r.com === com || r.role === 'eb' || r.role === 'secretariat');
  const invite = session.invite(com);
  const [copied, setCopied] = useState(false);
  const [rosterText, setRosterText] = useState('');
  const isEb = me?.role === 'eb';

  return (
    <ScrollView contentContainerStyle={{ gap: 12 }}>
      <Card>
        <Text style={styles.h2}>{com ? `Invite to ${session.committeeName(com)}` : 'Invite EB and Secretariat laptops'}</Text>
        <View style={{ alignItems: 'center' }}>
          <QrCode value={invite} size={220} />
        </View>
        <Row>
          <Btn
            title={copied ? 'Copied' : 'Copy join code'}
            onPress={() => {
              void Clipboard.setStringAsync(invite);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          />
        </Row>
        <Text style={styles.muted}>
          {session.device.status().addresses.length
            ? `This laptop: ${session.device.status().addresses.join(', ')}`
            : 'This laptop has no network address yet. Connect it to the room’s Wi-Fi.'}
        </Text>
      </Card>

      <Text style={styles.eyebrow}>Asking to join ({requests.length})</Text>
      {requests.length === 0 ? <Empty text="Nobody is waiting." /> : null}
      {requests.map((r) => (
        <Card key={r.sign}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={styles.h2}>{r.name}</Text>
            <Badge label={ROLE[r.role] ?? r.role} />
          </Row>
          <Text style={styles.muted}>
            Device {keyFingerprint(r.sign)}
            {r.com ? ` · ${session.committeeName(r.com)}` : ''}
            {r.code ? ` · code ${r.code}${session.roster.some((e) => e.code.toLowerCase() === r.code!.toLowerCase()) ? '' : ' (not on roster)'}` : ''}
          </Text>
          <Row>
            <Btn title="Approve" variant="accent" onPress={() => session.approve(r)} />
            <Btn title="Dismiss" variant="outline" onPress={() => session.dismiss(r)} />
          </Row>
        </Card>
      ))}

      {isEb ? (
        <Card>
          <Text style={styles.h2}>Roster</Text>
          <Text style={styles.muted}>
            {session.roster.length
              ? `${session.roster.length} delegates on the roster. A delegate who enters their code is let in under the roster’s name.`
              : 'Paste the roster from the Secretariat: one “code, country” per line.'}
          </Text>
          <Field
            value={rosterText}
            onChangeText={setRosterText}
            multiline
            style={{ minHeight: 80, textAlignVertical: 'top' }}
            placeholder={'FR-7Q2, France\nUS-K91, United States'}
          />
          <Row>
            <Btn
              title="Import roster"
              disabled={!parseRoster(rosterText).length}
              onPress={() => {
                void session.setRoster(parseRoster(rosterText));
                setRosterText('');
              }}
            />
            <Chip label="Let roster codes in automatically" active={session.autoApprove} onPress={() => void session.setAutoApprove(!session.autoApprove)} />
          </Row>
        </Card>
      ) : null}
    </ScrollView>
  );
}

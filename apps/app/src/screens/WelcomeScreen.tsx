import { useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { parseInvite, type Invite } from '@mun/core';
import { Scanner, scanWithSystemScanner, useSystemScanner } from '../components/Scanner';
import { canHost, socketsAvailable } from '../platform/transport';
import { useTheme } from '../theme';
import { Btn, Card, Field, Row } from '../ui';

export function WelcomeScreen(props: { onInvite: (invite: Invite) => void; onCreate: () => void }) {
  const { styles } = useTheme();
  const [code, setCode] = useState('');
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tryCode = (text: string) => {
    const invite = parseInvite(text);
    if (invite) props.onInvite(invite);
    else setError('⚠ That isn’t a join code for this app. Scan the QR code on the EB’s screen, or paste the code exactly.');
  };

  const scan = async () => {
    if (!useSystemScanner) return setScanning(true);
    const text = await scanWithSystemScanner();
    if (text) tryCode(text);
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.eyebrow}>Model United Nations</Text>
      <Text style={styles.h1}>MUN Toolkit</Text>
      <Text style={styles.text}>Committee chat that works without internet. Messages hop from device to device across the venue.</Text>
      {!socketsAvailable ? (
        <Text style={styles.alert}>⚠ This is a browser preview: it can’t connect to anyone. Use the Windows app or the phone app.</Text>
      ) : null}

      <Card>
        <Text style={styles.h2}>Join a committee</Text>
        <Text style={styles.muted}>Scan the QR code on your EB’s screen, or paste the join code they shared.</Text>
        {scanning ? (
          <Scanner
            onCode={(t) => {
              setScanning(false);
              tryCode(t);
            }}
            onClose={() => setScanning(false)}
          />
        ) : (
          <Row>
            <Btn title="Scan QR code" variant="primary" onPress={() => void scan()} />
          </Row>
        )}
        <Field
          label="Or paste a join code"
          value={code}
          onChangeText={(t) => {
            setCode(t);
            setError(null);
          }}
          placeholder="mun://join?i=…"
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={() => tryCode(code)}
        />
        <Row>
          <Btn title="Continue" onPress={() => tryCode(code)} disabled={!code.trim()} />
        </Row>
        {error ? <Text style={styles.alert}>{error}</Text> : null}
      </Card>

      {canHost ? (
        <Card>
          <Text style={styles.h2}>Running the conference?</Text>
          <Text style={styles.muted}>
            The Secretariat creates the conference once, on one laptop. That laptop holds the conference’s master key.
          </Text>
          <Row>
            <Btn title="Create a conference" variant="outline" onPress={props.onCreate} />
          </Row>
        </Card>
      ) : null}
    </ScrollView>
  );
}

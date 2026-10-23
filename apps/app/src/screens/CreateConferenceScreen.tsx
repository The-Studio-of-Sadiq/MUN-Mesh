import { useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { newConference, type Committee } from '@mun/core';
import { AppSession } from '../session';
import { useTheme } from '../theme';
import { Btn, Card, Field, Row } from '../ui';

/** "DISEC — Disarmament and International Security" → { id: "disec", name: … }. */
export function parseCommittees(text: string): Committee[] {
  const out: Committee[] = [];
  const taken = new Set(['global', 'eb']);
  for (const line of text.split(/\r?\n/)) {
    const name = line.trim();
    if (!name) continue;
    const short = name.split(/\s+[—–-]\s+|:/)[0]!;
    let id = short.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'committee';
    for (let n = 2; taken.has(id); n++) id = `${id.replace(/-\d+$/, '')}-${n}`;
    taken.add(id);
    out.push({ id, name });
  }
  return out;
}

export function CreateConferenceScreen(props: { onCreated: (s: AppSession) => void; onBack: () => void }) {
  const { styles } = useTheme();
  const [name, setName] = useState('');
  const [committeesText, setCommitteesText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const committees = parseCommittees(committeesText);

  const create = async () => {
    setBusy(true);
    try {
      const { conf, root } = newConference(name.trim(), committees, Date.now());
      props.onCreated(await AppSession.begin({ conf, role: 'secretariat', name: 'Secretariat', hubs: [], hub: true }, root));
    } catch (e) {
      setError(`⚠ ${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.eyebrow}>Secretariat</Text>
      <Text style={styles.h1}>New conference</Text>
      <Card>
        <Field label="Conference name" value={name} onChangeText={setName} placeholder="e.g. Dhaka MUN 2026" />
        <Field
          label="Committees, one per line"
          value={committeesText}
          onChangeText={setCommitteesText}
          multiline
          style={{ minHeight: 140, textAlignVertical: 'top' }}
          placeholder={'DISEC — Disarmament and International Security\nUNSC — Security Council\nUNHRC — Human Rights Council'}
        />
        {committees.length ? <Text style={styles.muted}>Short ids: {committees.map((c) => c.id).join(', ')}</Text> : null}
        <Text style={styles.muted}>
          The committee list is fixed once created: every device checks it. This laptop becomes the conference’s root of trust; keep it safe
          and don’t copy its keys to another device.
        </Text>
        <Row>
          <Btn title="Create" variant="primary" onPress={() => void create()} disabled={busy || !name.trim() || !committees.length} />
          <Btn title="Back" variant="outline" onPress={props.onBack} />
        </Row>
        {error ? <Text style={styles.alert}>{error}</Text> : null}
      </Card>
    </ScrollView>
  );
}

import { useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { GLOBAL, fieldTests, summarizeFieldTest, type GroupResult } from '@mun/core';
import { timeOf, useSession } from '../hooks';
import { saveFile } from '../platform/files';
import { useTheme } from '../theme';
import { Badge, Btn, Card, Empty, Row } from '../ui';

const ms = (n: number) => (n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} s`);
const percent = (x: number) => `${Math.round(x * 1000) / 10}%`;

/**
 * Secretariat: run a field test and watch it live. A ping goes out every 10 s;
 * each device reports what it heard once a minute.
 */
export function FieldTestPanel() {
  const { colors, styles } = useTheme();
  const session = useSession();
  const runner = session.fieldTest;
  const tests = fieldTests(session.node.replica);
  const [picked, setPicked] = useState<string | null>(null);
  const test = picked ?? runner.test ?? tests[0] ?? null;
  const version = session.version;
  const summary = useMemo(() => (test ? summarizeFieldTest(session.node.replica, test) : null), [session, test, version]);

  const group = (label: string, g: GroupResult) => (
    <Row key={label} style={{ justifyContent: 'space-between' }}>
      <Text style={styles.small}>{label}</Text>
      <Text style={styles.small}>
        {g.devices} device{g.devices === 1 ? '' : 's'} · {percent(g.delivery)} · p50 {ms(g.p50)} · p95 {ms(g.p95)}
      </Text>
    </Row>
  );

  return (
    <ScrollView contentContainerStyle={{ gap: 10 }}>
      <Card>
        <Text style={styles.h2}>Field test</Text>
        <Text style={styles.muted}>
          Sends a ping every 10 s to every device. Each reports what it heard once a minute, so results fill in with a minute’s delay.
          Latency uses each device’s own clock.
        </Text>
        <Row>
          {runner.running ? (
            <Btn title="Stop test" variant="outline" onPress={() => { runner.stop(); setPicked(runner.test); }} />
          ) : (
            <Btn title="Start a test" variant="primary" onPress={() => setPicked(runner.start())} />
          )}
          {summary ? (
            <Btn
              title="Export results"
              onPress={() => void saveFile(`field-test-${summary.test}.json`, 'application/json', new TextEncoder().encode(JSON.stringify(summary, null, 2)))}
            />
          ) : null}
        </Row>
        {runner.running ? <Badge label={`Running · ${runner.test}`} tone="accent" /> : null}
      </Card>
      {tests.length > 1 ? (
        <Row>
          {tests.slice(0, 5).map((t) => (
            <Btn key={t} title={t} variant={t === test ? 'primary' : 'default'} onPress={() => setPicked(t)} />
          ))}
        </Row>
      ) : null}
      {!summary ? <Empty text="No field tests yet." /> : null}
      {summary ? (
        <>
          <Text style={styles.muted}>
            {summary.pings} pings · {timeOf(summary.startedAt)}–{timeOf(summary.lastPingAt)}
          </Text>
          <Card>
            {group('Overall', summary.overall)}
            {summary.committees.map((c) => group(c.com === GLOBAL ? 'Secretariat' : session.committeeName(c.com), c))}
          </Card>
          <Text style={styles.eyebrow}>Devices ({summary.devices.length})</Text>
          {summary.devices.map((d) => (
            <View key={d.key} style={{ paddingVertical: 4, borderBottomWidth: 1, borderColor: colors.border }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={styles.small}>
                  {d.name} · {d.platform}
                  {d.relay ? ' · relay' : ''}
                </Text>
                <Text style={[styles.small, d.received < d.expected && { color: colors.accent }]}>
                  {d.received}/{d.expected}
                </Text>
              </Row>
              <Text style={styles.muted}>
                p50 {ms(d.p50)} · max {ms(d.max)} · {d.tcp} Wi-Fi + {d.nearby} Nearby links · last report {timeOf(d.lastReport)}
              </Text>
            </View>
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}

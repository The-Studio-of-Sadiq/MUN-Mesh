import { useState } from 'react';
import { Text, View } from 'react-native';
import { checkFile, fileOf, fileRules, type Event } from '@mun/core';
import { useSession } from '../hooks';
import { saveFile } from '../platform/files';
import { useTheme } from '../theme';
import { Btn, Row } from '../ui';

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** A file in a message: its name and size, download progress, and a button to save it. */
export function AttachmentCard({ event }: { event: Event }) {
  const { colors, styles } = useTheme();
  const session = useSession();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const file = fileOf(session.node, event);
  if (!(event.b as { att?: unknown }).att) return null;
  if (!file) {
    return <Text style={styles.muted}>📎 A file sealed for someone else</Text>;
  }
  const { att, meta } = file;
  const status = session.files.status(att.id);
  const refusal = checkFile(fileRules(session.node.replica, event.s), att.size, meta.name);
  const pct = status ? Math.floor((status.have / status.total) * 100) : 0;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const data = await session.files.read(att, meta);
      if (!data) setError('The file is incomplete or damaged; it will be fetched again.');
      else await saveFile(meta.name, meta.mime, data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, gap: 6, backgroundColor: colors.bg }}>
      <Row style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
        <Text style={[styles.h2, { flexShrink: 1 }]} numberOfLines={1}>
          📎 {meta.name}
        </Text>
        <Text style={styles.muted}>{formatSize(att.size)}</Text>
      </Row>
      {refusal ? (
        <Text style={styles.muted}>{refusal === 'tooLarge' ? 'Over this committee’s size limit; not shared.' : 'A blocked file type; not shared.'}</Text>
      ) : status?.done ? (
        <Row>
          <Btn title={saving ? 'Opening…' : 'Save'} variant="primary" disabled={saving} onPress={() => void save()} />
        </Row>
      ) : status?.wanted ? (
        <View style={{ gap: 4 }}>
          <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.surfaceHi, overflow: 'hidden' }}>
            <View style={{ width: `${pct}%`, height: 6, backgroundColor: colors.accent }} />
          </View>
          <Text style={styles.muted}>
            {pct}% · {status.have > 0 ? 'downloading' : 'looking for a device that has it…'}
          </Text>
        </View>
      ) : (
        <Row>
          <Btn title="Download" onPress={() => session.files.want(att.id)} />
        </Row>
      )}
      {error ? <Text style={styles.alert}>⚠ {error}</Text> : null}
    </View>
  );
}

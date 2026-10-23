import { useState } from 'react';
import { Text, View } from 'react-native';
import { useSession } from '../hooks';
import { nearby, requestNearbyPermissions } from '../platform/nearby';
import type { AppSession } from '../session';
import { useTheme } from '../theme';
import { Chip, Row } from '../ui';

/**
 * "Relay for nearby phones" (Android): links this phone to phones around it
 * over Bluetooth and Wi-Fi Direct, so someone out of the router's range can
 * still reach the room. Also how a phone out of range gets in.
 */
export function RelayToggle({ onReplace }: { onReplace: (s: AppSession) => void }) {
  const { styles } = useTheme();
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!nearby) return null;
  const on = !!session.profile.relay;
  const status = session.nearby?.status();

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!on && !(await requestNearbyPermissions())) {
        setError('Relaying needs Bluetooth and nearby-devices permission.');
        return;
      }
      onReplace(await session.setRelay(!on));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 4 }}>
      <Row>
        <Chip label={busy ? 'Switching…' : on ? 'Relay for nearby phones: on' : 'Relay for nearby phones'} active={on} onPress={() => void toggle()} />
        {on && status ? (
          <Text style={styles.muted}>
            {status.links ? `${status.links} phone${status.links > 1 ? 's' : ''} linked` : status.seen ? `${status.seen} in range` : 'Looking for phones…'}
          </Text>
        ) : null}
      </Row>
      {on ? <Text style={styles.muted}>Keep the app open: Android pauses relaying when it’s in the background.</Text> : null}
      {error ? <Text style={styles.alert}>⚠ {error}</Text> : null}
    </View>
  );
}

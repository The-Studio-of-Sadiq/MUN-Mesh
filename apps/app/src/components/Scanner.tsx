import { useRef } from 'react';
import { Platform, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useTheme } from '../theme';
import { Btn, Row } from '../ui';

/** Embedded camera preview that reports the first QR code it sees. */
export function Scanner({ onCode, onClose }: { onCode: (text: string) => void; onClose: () => void }) {
  const { styles } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  // The camera reports the same code many times a second; act on the first.
  const done = useRef(false);
  if (!permission) return null;
  if (!permission.granted) {
    return (
      <Row>
        <Text style={styles.text}>The camera is needed to scan the join code.</Text>
        <Btn title="Allow camera" variant="primary" onPress={() => void requestPermission()} />
        <Btn title="Cancel" variant="outline" onPress={onClose} />
      </Row>
    );
  }
  return (
    <View style={{ gap: 8 }}>
      <View style={{ height: 300, borderRadius: 14, overflow: 'hidden' }}>
        <CameraView
          style={{ flex: 1 }}
          facing={Platform.OS === 'web' ? 'front' : 'back'}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={(r) => {
            if (done.current) return;
            done.current = true;
            onCode(r.data);
          }}
        />
      </View>
      <Btn title="Stop scanning" variant="outline" onPress={onClose} />
    </View>
  );
}

/**
 * Android: Google's system code scanner (Play services). It detects far more
 * reliably than an embedded preview and needs no camera permission.
 * Resolves with the scanned text, or null if the user backed out.
 */
export function scanWithSystemScanner(): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      sub.remove();
      resolve(value);
    };
    const sub = CameraView.onModernBarcodeScanned((r) => finish(r.data));
    CameraView.launchScanner({ barcodeTypes: ['qr'] }).then(
      // Settles when the scanner closes; give the scan event a moment to arrive.
      () => setTimeout(() => finish(null), 500),
      () => finish(null),
    );
  });
}

export const useSystemScanner = Platform.OS === 'android' && CameraView.isModernBarcodeScannerAvailable;

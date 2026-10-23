import { PermissionsAndroid, Platform, type Permission } from 'react-native';
import { nearbyNative } from '../../modules/nearby';

/** Android with Google Play services' Nearby built in (not iOS, not Expo Go). */
export const nearby = Platform.OS === 'android' ? nearbyNative : null;

/**
 * Asks for what Nearby needs on this Android version. True if everything
 * essential was granted.
 */
export async function requestNearbyPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const v = typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version);
  const wanted: string[] =
    v >= 31
      ? ['android.permission.BLUETOOTH_SCAN', 'android.permission.BLUETOOTH_ADVERTISE', 'android.permission.BLUETOOTH_CONNECT']
      : ['android.permission.ACCESS_FINE_LOCATION'];
  if (v >= 33) wanted.push('android.permission.NEARBY_WIFI_DEVICES');
  else if (v >= 31) wanted.push('android.permission.ACCESS_FINE_LOCATION');
  const result = await PermissionsAndroid.requestMultiple(wanted as Permission[]);
  return wanted.every((p) => result[p as Permission] === PermissionsAndroid.RESULTS.GRANTED);
}

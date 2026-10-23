import type { NearbyNative } from '@mun/core';

// Nearby Connections is Android-only; laptops link over Wi-Fi and cables instead.
export const nearby: NearbyNative | null = null;

export async function requestNearbyPermissions(): Promise<boolean> {
  return false;
}

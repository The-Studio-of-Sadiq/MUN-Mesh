import { requireOptionalNativeModule } from 'expo';
import type { NearbyEvent, NearbyNative } from '@mun/core';

interface MunNearbyModule {
  start(serviceId: string, name: string): Promise<void>;
  stop(): Promise<void>;
  connect(endpoint: string, name: string): Promise<void>;
  send(endpoint: string, text: string): Promise<void>;
  disconnect(endpoint: string): void;
  addListener(event: 'onNearby', cb: (e: NearbyEvent) => void): { remove(): void };
}

const native = requireOptionalNativeModule<MunNearbyModule>('MunNearby');

/** Android Nearby Connections; null where it isn't built in (Windows, web, iOS, Expo Go). */
export const nearbyNative: NearbyNative | null = native
  ? {
      start: (serviceId, name) => native.start(serviceId, name),
      stop: () => native.stop(),
      connect: (endpoint, name) => native.connect(endpoint, name),
      send: (endpoint, text) => native.send(endpoint, text),
      disconnect: (endpoint) => native.disconnect(endpoint),
      onEvent: (cb) => {
        const sub = native.addListener('onNearby', cb);
        return () => sub.remove();
      },
    }
  : null;

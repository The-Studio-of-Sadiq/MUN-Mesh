/** Hub beacons over UDP, from apps/desktop/discovery.js. */
interface DiscoveryBridge {
  start(): Promise<void>;
  announce(text: string | null): Promise<void>;
  stop(): Promise<void>;
  onBeacon(cb: (b: { text: string; host: string }) => void): () => void;
}

const bridge = (globalThis as { munDiscovery?: DiscoveryBridge }).munDiscovery;

export const discovery = {
  available: !!bridge,
  start: () => bridge?.start() ?? Promise.resolve(),
  announce: (text: string | null) => bridge?.announce(text) ?? Promise.resolve(),
  stop: () => bridge?.stop() ?? Promise.resolve(),
  onBeacon: (cb: (b: { text: string; host: string }) => void) => bridge?.onBeacon(cb) ?? (() => {}),
};

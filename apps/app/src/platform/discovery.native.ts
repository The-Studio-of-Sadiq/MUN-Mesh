// Phones find hubs from the join QR code and the addresses hubs share; no UDP listener yet.
export const discovery = {
  available: false,
  start: () => Promise.resolve(),
  announce: (_text: string | null) => Promise.resolve(),
  stop: () => Promise.resolve(),
  onBeacon: (_cb: (b: { text: string; host: string }) => void) => () => {},
};

// LAN discovery for hubs: broadcasts a small UDP beacon on every network the
// laptop is on, and reports beacons heard from other hubs to the UI. A laptop
// on two networks (Wi-Fi plus a USB adapter or cable) hears both, which is
// how it ends up bridging them.
const { ipcMain } = require('electron');
const dgram = require('node:dgram');
const os = require('node:os');

const BEACON_PORT = 47901;
const EVERY_MS = 3000;

let socket = null;
let timer = null;
let payload = null;
let target = null;

/** Directed broadcast address of each IPv4 interface, e.g. 192.168.1.255. */
function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...out];
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  socket?.close();
  socket = null;
  payload = null;
}

function start(contents) {
  stop();
  target = contents;
  socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('error', () => {});
  socket.on('message', (msg, rinfo) => {
    if (msg.length > 300 || !target || target.isDestroyed()) return;
    target.send('discovery:beacon', { text: msg.toString('utf8'), host: rinfo.address });
  });
  socket.bind(BEACON_PORT, () => {
    socket.setBroadcast(true);
    timer = setInterval(() => {
      if (!payload) return;
      const buf = Buffer.from(payload, 'utf8');
      for (const addr of broadcastAddresses()) socket?.send(buf, BEACON_PORT, addr, () => {});
    }, EVERY_MS);
  });
}

function register() {
  // Listening for beacons needs no payload; hubs also set one to announce themselves.
  ipcMain.handle('discovery:start', (e) => start(e.sender));
  ipcMain.handle('discovery:announce', (_e, text) => {
    payload = typeof text === 'string' && text.length <= 300 ? text : null;
  });
  ipcMain.handle('discovery:stop', () => stop());
}

module.exports = { register, stop };

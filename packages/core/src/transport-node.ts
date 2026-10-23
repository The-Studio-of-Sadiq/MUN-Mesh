import net from 'node:net';
import os from 'node:os';
import type { ListeningServer, SocketLike, Transport } from './device';

/** TCP for Node: tests, bots and anything running outside the apps. */
export const nodeTransport: Transport = {
  listen(port, onSocket) {
    const start = (p: number) =>
      new Promise<ListeningServer>((resolve, reject) => {
        const server = net.createServer((socket) => {
          socket.setEncoding('utf8');
          socket.setNoDelay(true);
          onSocket(socket as unknown as SocketLike);
        });
        server.once('error', reject);
        server.listen(p, '0.0.0.0', () => {
          const addr = server.address();
          resolve({ port: typeof addr === 'object' && addr ? addr.port : p, close: () => server.close() });
        });
      });
    return start(port).catch(() => start(0));
  },

  connect(host, port, timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      socket.setEncoding('utf8');
      socket.setNoDelay(true);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`No answer from ${host}:${port}`));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(socket as unknown as SocketLike);
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  },

  async localAddresses() {
    return Object.values(os.networkInterfaces())
      .flat()
      .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === 'IPv4' && !a.internal)
      .map((a) => a.address);
  },
};

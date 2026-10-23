import TcpSocket from 'react-native-tcp-socket';
import * as Network from 'expo-network';
import type { ListeningServer, SocketLike, Transport } from '@mun/core';
import { rankAddresses } from './addresses';

function listenOn(port: number, onSocket: (s: SocketLike) => void): Promise<ListeningServer> {
  return new Promise((resolve, reject) => {
    const server = TcpSocket.createServer((socket) => {
      socket.setEncoding('utf8');
      onSocket(socket as unknown as SocketLike);
    });
    server.once('error', reject);
    server.listen({ port, host: '0.0.0.0' }, () => {
      const addr = server.address();
      resolve({ port: addr && typeof addr === 'object' ? addr.port : port, close: () => server.close() });
    });
  });
}

export const socketsAvailable = true;

/** Phones dial hubs; hosting (Nearby relay) comes in M4. */
export const canHost = false;

export const transport: Transport = {
  async listen(port, onSocket) {
    try {
      return await listenOn(port, onSocket);
    } catch {
      return listenOn(0, onSocket);
    }
  },

  connect(host, port, timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = TcpSocket.createConnection({ host, port }, () => {
        clearTimeout(timer);
        resolve(socket as unknown as SocketLike);
      });
      socket.setEncoding('utf8');
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`No answer from ${host}`));
      }, timeoutMs);
      socket.once('error', (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  },

  async localAddresses() {
    try {
      return rankAddresses([await Network.getIpAddressAsync()]);
    } catch {
      return [];
    }
  },
};

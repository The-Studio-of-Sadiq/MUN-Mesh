// TCP sockets for the UI, bridged over IPC. One listening server per window.
const { ipcMain } = require('electron');
const net = require('node:net');
const os = require('node:os');

const sockets = new Map();
let server = null;
let nextId = 1;

function emit(contents, event) {
  if (!contents.isDestroyed()) contents.send('net:event', event);
}

function track(contents, socket) {
  const id = nextId++;
  sockets.set(id, socket);
  socket.setEncoding('utf8');
  socket.setNoDelay(true);
  socket.on('data', (data) => emit(contents, { type: 'data', id, data }));
  socket.on('error', (err) => emit(contents, { type: 'error', id, message: err.message }));
  socket.on('close', () => {
    sockets.delete(id);
    emit(contents, { type: 'close', id });
  });
  return id;
}

function closeAll() {
  for (const s of sockets.values()) s.destroy();
  sockets.clear();
  server?.close();
  server = null;
}

function register() {
  ipcMain.handle('net:listen', (e, port) => {
    closeAll();
    return new Promise((resolve, reject) => {
      const srv = net.createServer((socket) => emit(e.sender, { type: 'connection', id: track(e.sender, socket) }));
      srv.once('error', (err) => {
        // Preferred port busy (e.g. a second instance): take any free one.
        if (err.code === 'EADDRINUSE' && port !== 0) srv.listen(0, '0.0.0.0');
        else reject(err);
      });
      srv.listen(port, '0.0.0.0', () => {
        server = srv;
        resolve(srv.address().port);
      });
    });
  });

  ipcMain.handle('net:unlisten', () => closeAll());

  ipcMain.handle(
    'net:connect',
    (e, host, port, timeoutMs) =>
      new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port });
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error(`No answer from ${host}`));
        }, timeoutMs);
        socket.once('connect', () => {
          clearTimeout(timer);
          resolve(track(e.sender, socket));
        });
        socket.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      }),
  );

  ipcMain.on('net:write', (_e, id, data) => sockets.get(id)?.write(data));
  ipcMain.on('net:end', (_e, id) => sockets.get(id)?.end());
  ipcMain.on('net:destroy', (_e, id) => sockets.get(id)?.destroy());

  ipcMain.handle('net:addresses', () =>
    Object.values(os.networkInterfaces())
      .flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal)
      .map((a) => a.address),
  );
}

module.exports = { register, closeAll };

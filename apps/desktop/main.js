// Windows shell: hosts the shared Expo web UI and gives it Node services over
// IPC: LAN sockets (net.js), hub discovery (discovery.js) and disk storage.
const { app, BrowserWindow, ipcMain, nativeTheme, net, protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const lanNet = require('./net');
const discovery = require('./discovery');

const DEV = process.argv.includes('--dev');

// `--profile=name` runs another instance with its own storage and keys, e.g.
// the Secretariat and two EB laptops on one PC for testing.
const profile = process.argv.find((a) => a.startsWith('--profile='))?.slice('--profile='.length);
// Automated tests keep their profiles in a throwaway folder (never in the installed app).
const base = !app.isPackaged && process.env.MUN_USER_DATA ? process.env.MUN_USER_DATA : app.getPath('userData');
if (profile || base !== app.getPath('userData')) app.setPath('userData', profile ? path.join(base, `profile-${profile}`) : base);
const DEV_URL = process.env.EXPO_WEB_URL || 'http://localhost:8081';
const WEB_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.resolve(__dirname, '../app/dist');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function resolveAsset(urlPath) {
  const file = path.normalize(path.join(WEB_ROOT, decodeURIComponent(urlPath)));
  if (!file.startsWith(WEB_ROOT)) return null;
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  return path.join(WEB_ROOT, 'index.html');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 380,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#000000' : '#ffffff',
    title: profile ? `MUN Toolkit (${profile})` : 'MUN Toolkit',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      // A hub keeps relaying while its window is minimised.
      backgroundThrottling: false,
    },
  });
  // A reload starts a fresh UI; drop sockets and beacons that belonged to the old one.
  win.webContents.on('did-start-loading', () => {
    lanNet.closeAll();
    discovery.stop();
  });
  win.loadURL(DEV ? DEV_URL : 'app://bundle/');
  if (!app.isPackaged) testHooks(win);
}

/**
 * For automated checks from a terminal (never in the installed app):
 * MUN_EVAL=file.js runs a script in the page once loaded;
 * MUN_CAPTURE=out.png@ms saves a screenshot after that many ms;
 * MUN_CONSOLE=1 prints the page's console here.
 * scripts/e2e.ts drives the app over --remote-debugging-port instead.
 */
function testHooks(win) {
  if (process.env.MUN_CONSOLE) {
    win.webContents.on('console-message', (e) => console.log(`[${profile ?? 'app'}] ${e.message}`));
  }
  win.webContents.once('did-finish-load', () => {
    if (process.env.MUN_EVAL) {
      const code = fs.readFileSync(process.env.MUN_EVAL, 'utf8');
      win.webContents.executeJavaScript(code).catch((err) => console.error('MUN_EVAL failed:', err));
    }
    if (process.env.MUN_CAPTURE) {
      const [file, ms] = process.env.MUN_CAPTURE.split('@');
      setTimeout(async () => {
        const image = await win.webContents.capturePage();
        fs.writeFileSync(file, image.toPNG());
        console.log(`captured ${file}`);
      }, Number(ms) || 5000);
    }
  });
}

// ── Key-value files ──
const storeDir = () => path.join(app.getPath('userData'), 'store');
const storeFile = (key) => {
  if (typeof key !== 'string' || !/^[\w:.-]{1,100}$/.test(key)) throw new Error('Bad store key');
  return path.join(storeDir(), `${key.replace(/:/g, '__')}.json`);
};

ipcMain.handle('store:get', async (_e, key) => {
  try {
    return await fs.promises.readFile(storeFile(key), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
});

ipcMain.handle('store:set', async (_e, key, value) => {
  const file = storeFile(key);
  await fs.promises.mkdir(storeDir(), { recursive: true });
  // Write then rename, so a crash mid-write never leaves a half file.
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, value, 'utf8');
  await fs.promises.rename(tmp, file);
});

ipcMain.handle('store:remove', async (_e, key) => {
  await fs.promises.rm(storeFile(key), { force: true });
});

// ── Event log: one JSON event per line, only ever appended ──
const logFile = () => path.join(app.getPath('userData'), 'events.ndjson');

ipcMain.handle('log:append', async (_e, text) => {
  if (typeof text !== 'string') throw new Error('Bad log entry');
  await fs.promises.mkdir(app.getPath('userData'), { recursive: true });
  await fs.promises.appendFile(logFile(), text, 'utf8');
});

ipcMain.handle('log:read', async () => {
  try {
    return await fs.promises.readFile(logFile(), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
});

ipcMain.handle('log:clear', async () => {
  await fs.promises.rm(logFile(), { force: true });
});

app.whenReady().then(() => {
  lanNet.register();
  discovery.register();
  protocol.handle('app', (req) => {
    const file = resolveAsset(new URL(req.url).pathname);
    if (!file || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  if (!DEV && !fs.existsSync(path.join(WEB_ROOT, 'index.html'))) {
    console.error(`No web build at ${WEB_ROOT}. Run: npm run export:web -w app`);
  }
  createWindow();
});

app.on('window-all-closed', () => app.quit());

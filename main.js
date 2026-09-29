'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, nativeImage } = require('electron');
const path = require('path');
const { BleHid } = require('./src/ble');
const { Router } = require('./src/router');

// Electron's sandbox needs a setuid helper that is often unavailable in containers/CI;
// harmless to disable for this kind of trusted local utility.
app.commandLine.appendSwitch('no-sandbox');

process.on('uncaughtException', (e) => console.error('[main] uncaughtException:', e.stack || e));
process.on('unhandledRejection', (e) => console.error('[main] unhandledRejection:', e && e.stack || e));

let win, tray, ble, router, motionTimer;
const MOTION_FLUSH_MS = 15; // ~66 Hz, well under BLE connection-interval limits

const ICONS = {
  local: '#8a8a8a',
  keyboard: '#3b82f6',
  mouse: '#22c55e',
  both: '#a855f7',
};

function dotIcon(hex) {
  // Tiny colored-dot tray icon generated at runtime (no asset files needed).
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22">
    <circle cx="11" cy="11" r="8" fill="${hex}"/></svg>`;
  return nativeImage.createFromBuffer(Buffer.from(svg), { scaleFactor: 1 });
}

function broadcastState() {
  const state = router.getState();
  if (win) win.webContents.send('state', state);
  if (tray) {
    tray.setImage(dotIcon(ICONS[state.mode] || ICONS.local));
    tray.setToolTip(`Keyboard Relay — ${state.mode}${state.ble.connected.length ? ' — ' + state.ble.connected.join(', ') : ''}`);
    tray.setContextMenu(buildTrayMenu(state));
  }
}

function buildTrayMenu(state) {
  const item = (label, mode) => ({
    label: state.mode === mode ? `● ${label}` : `  ${label}`,
    click: () => router.setMode(mode),
  });
  return Menu.buildFromTemplate([
    item('Local only', 'local'),
    item('Keyboard → PC B', 'keyboard'),
    item('Mouse → PC B', 'mouse'),
    item('Both → PC B', 'both'),
    { type: 'separator' },
    {
      label: state.ble.pairing ? 'Pairing… (open)' : 'Allow new device to pair',
      click: () => ble.setPairing(!state.ble.pairing),
    },
    { type: 'separator' },
    { label: 'Show window', click: () => win && win.show() },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function createWindow() {
  win = new BrowserWindow({
    width: 380,
    height: 520,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (!app.isQuiting) { e.preventDefault(); win.hide(); }
  });
}

async function main() {
  await app.whenReady();

  ble = new BleHid();
  router = new Router(ble);
  router.on('state', broadcastState);

  try {
    await ble.start();
  } catch (e) {
    // Surface the failure in the UI rather than crashing; common cause: no Bluetooth
    // adapter, or bluetoothd not running / not accessible over D-Bus.
    console.error('[main] ble.start() failed:', e.stack || e);
    router.status.lastError = `Bluetooth init failed: ${e.message}`;
  }
  router.attachDevices();

  motionTimer = setInterval(() => router.flushMotion(), MOTION_FLUSH_MS);

  createWindow();
  tray = new Tray(dotIcon(ICONS.local));
  broadcastState();

  // Physical fallback to get back to LOCAL even with no window in front of you:
  // Ctrl+Alt+Shift+L. Runs even while the keyboard is grabbed, because Electron's
  // globalShortcut is registered with the X server directly, not via the grabbed
  // /dev/input device.
  globalShortcut.register('Control+Alt+Shift+L', () => router.setMode('local'));

  ipcMain.handle('set-mode', (_e, mode) => router.setMode(mode));
  ipcMain.handle('get-state', () => router.getState());
  ipcMain.handle('set-pairing', (_e, open) => ble.setPairing(open));

  app.on('before-quit', () => {
    app.isQuiting = true;
    clearInterval(motionTimer);
    globalShortcut.unregisterAll();
    router.setMode('local');
    router.stop();
    ble.stop();
  });
}

app.on('window-all-closed', (e) => e.preventDefault()); // keep running in the tray
main();

'use strict';
// Run with: node test-ble.js
// Bypasses Electron completely so nothing can swallow the error.
const { BleHid } = require('./src/ble');

process.on('unhandledRejection', (e) => {
  console.error('UNHANDLED REJECTION:', e && e.stack || e);
  process.exit(1);
});

(async () => {
  console.log('Starting BLE HID peripheral...');
  const ble = new BleHid();
  try {
    await ble.start();
    console.log('ble.start() succeeded.');
    console.log('State:', ble.getState());
    console.log('Leaving running for 30s so you can check `bluetoothctl` / try pairing...');
    setTimeout(() => { ble.stop(); process.exit(0); }, 30000);
  } catch (e) {
    console.error('ble.start() FAILED. Full error below:\n');
    console.error(e.stack || e);
    process.exit(1);
  }
})();

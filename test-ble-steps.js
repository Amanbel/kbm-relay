'use strict';
// Run with: node test-ble-steps.js
// Logs progress before/after each D-Bus call so we can see exactly which
// step throws "No object received" (or anything else).
const dbus = require('dbus-next');
const { Variant } = dbus;

process.on('unhandledRejection', (e) => {
  console.error('UNHANDLED REJECTION:', e && e.stack || e);
  process.exit(1);
});

function step(name) {
  console.log(`\n--- ${name} ---`);
}

(async () => {
  step('1. dbus-next version');
  console.log(require('dbus-next/package.json').version);

  step('2. Connect to system bus');
  const bus = dbus.systemBus();
  console.log('connected, unique name:', bus.name);

  step('3. Get root proxy object at /');
  const rootProxy = await bus.getProxyObject('org.bluez', '/');
  console.log('got root proxy object');

  step('4. Get ObjectManager interface');
  const om = rootProxy.getInterface('org.freedesktop.DBus.ObjectManager');
  console.log('got interface');

  step('5. Call GetManagedObjects()');
  const objs = await om.GetManagedObjects();
  console.log('got objects, paths:', Object.keys(objs));

  step('6. Find adapter with GattManager1');
  const adapterPath = Object.keys(objs).find((p) => objs[p]['org.bluez.GattManager1']);
  console.log('adapterPath:', adapterPath);
  if (!adapterPath) {
    console.error('No adapter with GattManager1 found. Stopping here.');
    process.exit(1);
  }

  step('7. Get proxy object for adapter');
  const adapter = await bus.getProxyObject('org.bluez', adapterPath);
  console.log('got adapter proxy');

  step('8. Get Properties interface on adapter');
  const props = adapter.getInterface('org.freedesktop.DBus.Properties');
  console.log('got Properties interface');

  step('9. Set adapter Powered = true');
  await props.Set('org.bluez.Adapter1', 'Powered', new Variant('b', true));
  console.log('Powered set OK');

  step('10. Set adapter Pairable = true');
  await props.Set('org.bluez.Adapter1', 'Pairable', new Variant('b', true));
  console.log('Pairable set OK');

  step('11. Set adapter Alias');
  await props.Set('org.bluez.Adapter1', 'Alias', new Variant('s', 'Keyboard Relay Test'));
  console.log('Alias set OK');

  step('12. Get GattManager1 interface');
  const gattMgr = adapter.getInterface('org.bluez.GattManager1');
  console.log('got GattManager1 interface');

  step('All steps up to (but not including) RegisterApplication succeeded.');
  console.log('If the real app fails at "No object received", the bug is at or after RegisterApplication.');
  process.exit(0);
})().catch((e) => {
  console.error('\nFAILED. Full error:\n');
  console.error(e.stack || e);
  process.exit(1);
});

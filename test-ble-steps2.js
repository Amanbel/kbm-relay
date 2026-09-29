'use strict';
// Run with: node test-ble-steps2.js
// Continues from where test-ble-steps.js left off (that part is confirmed working):
// this isolates the GATT tree export + RegisterApplication + advertisement + agent steps.
const dbus = require('dbus-next');
const { Variant } = dbus;
const { buildTree, AppObjectManager, Advertisement, Agent, ROOT, ADV_PATH, AGENT_PATH } = require('./src/ble');

process.on('unhandledRejection', (e) => {
  console.error('UNHANDLED REJECTION:', e && e.stack || e);
  process.exit(1);
});

function step(name) { console.log(`\n--- ${name} ---`); }

(async () => {
  const bus = dbus.systemBus();

  const rootProxy = await bus.getProxyObject('org.bluez', '/');
  const om = rootProxy.getInterface('org.freedesktop.DBus.ObjectManager');
  const objs = await om.GetManagedObjects();
  const adapterPath = Object.keys(objs).find((p) => objs[p]['org.bluez.GattManager1']);
  const adapter = await bus.getProxyObject('org.bluez', adapterPath);
  const props = adapter.getInterface('org.freedesktop.DBus.Properties');
  await props.Set('org.bluez.Adapter1', 'Powered', new Variant('b', true));
  console.log('(setup steps repeated OK, resuming from here)');

  step('13. Build GATT tree (buildTree())');
  const { nodes, kb, mouse } = buildTree();
  console.log(`built ${nodes.length} nodes`);

  step('14. Export ObjectManager at ROOT');
  bus.export(ROOT, new AppObjectManager(nodes));
  console.log('exported ROOT ObjectManager');

  step('15. Export each GATT node');
  for (const n of nodes) {
    bus.export(n.objPath, n);
  }
  console.log(`exported ${nodes.length} node objects`);

  step('16. Get GattManager1 interface');
  const gattMgr = adapter.getInterface('org.bluez.GattManager1');
  console.log('got GattManager1');

  step('17. Call RegisterApplication(ROOT, {})  <-- suspect step');
  await gattMgr.RegisterApplication(ROOT, {});
  console.log('RegisterApplication SUCCEEDED');

  step('18. Export Advertisement');
  bus.export(ADV_PATH, new Advertisement());
  console.log('exported advertisement object');

  step('19. Get LEAdvertisingManager1 and RegisterAdvertisement');
  const advMgr = adapter.getInterface('org.bluez.LEAdvertisingManager1');
  await advMgr.RegisterAdvertisement(ADV_PATH, {});
  console.log('RegisterAdvertisement SUCCEEDED');

  step('20. Export Agent and register it');
  bus.export(AGENT_PATH, new Agent(() => true));
  const bluezRoot = await bus.getProxyObject('org.bluez', '/org/bluez');
  const agentMgr = bluezRoot.getInterface('org.bluez.AgentManager1');
  await agentMgr.RegisterAgent(AGENT_PATH, 'NoInputNoOutput');
  console.log('RegisterAgent SUCCEEDED');

  step('21. RequestDefaultAgent');
  await agentMgr.RequestDefaultAgent(AGENT_PATH);
  console.log('RequestDefaultAgent SUCCEEDED');

  step('ALL STEPS SUCCEEDED. Leaving running 20s, check bluetoothctl in another terminal.');
  setTimeout(() => process.exit(0), 20000);
})().catch((e) => {
  console.error('\nFAILED. Full error:\n');
  console.error(e.stack || e);
  process.exit(1);
});

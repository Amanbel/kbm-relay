'use strict';
// Turns this Linux PC into a Bluetooth LE HID keyboard + mouse using BlueZ's D-Bus API.
// bluetoothd stays running and handles pairing/bonding; we register a GATT application,
// an advertisement, and a pairing agent.
const dbus = require('dbus-next');
const EventEmitter = require('events');

const { Variant, DBusError } = dbus;
const { Interface, ACCESS_READ } = dbus.interface;
const { REPORT_MAP, REPORT_ID_KEYBOARD, REPORT_ID_MOUSE } = require('./hid');

const ROOT = '/org/kbmrelay';
const AGENT_PATH = `${ROOT}/agent`;
const ADV_PATH = `${ROOT}/adv0`;
const DEVICE_NAME = 'Keyboard Relay';
const PAIRING_WINDOW_MS = 120000;
const uuid16 = (h) => `0000${h}-0000-1000-8000-00805f9b34fb`;

// ---------- D-Bus GATT objects ----------

class Service extends Interface {
  constructor(objPath, uuid) {
    super('org.bluez.GattService1');
    this.objPath = objPath;
    this.ifaceName = 'org.bluez.GattService1';
    this._uuid = uuid;
  }
  get UUID() { return this._uuid; }
  get Primary() { return true; }
  dbusProps() { return { UUID: new Variant('s', this._uuid), Primary: new Variant('b', true) }; }
}
Service.configureMembers({
  properties: {
    UUID: { signature: 's', access: ACCESS_READ },
    Primary: { signature: 'b', access: ACCESS_READ },
  },
});

class Characteristic extends Interface {
  constructor(objPath, service, uuid, flags, value, onWrite) {
    super('org.bluez.GattCharacteristic1');
    this.objPath = objPath;
    this.ifaceName = 'org.bluez.GattCharacteristic1';
    this._uuid = uuid;
    this._service = service.objPath;
    this._flags = flags;
    this._value = Buffer.from(value || []);
    this.onWrite = onWrite;
    this.notifying = false;
    this.onNotifyChange = () => {};
  }
  get UUID() { return this._uuid; }
  get Service() { return this._service; }
  get Flags() { return this._flags; }
  get Value() { return this._value; }
  ReadValue(options = {}) {
    let offset = 0;
    if (options && options.offset) {
      offset = options.offset.value !== undefined ? options.offset.value : options.offset;
    }
    if (offset > this._value.length) {
      throw new DBusError('org.bluez.Error.InvalidOffset', 'Invalid offset');
    }
    return this._value.subarray(offset);
  }
  WriteValue(value, options = {}) {
    let offset = 0;
    if (options && options.offset) {
      offset = options.offset.value !== undefined ? options.offset.value : options.offset;
    }
    const valBuf = Buffer.from(value);
    if (offset === 0) {
      this._value = valBuf;
    } else {
      if (offset > this._value.length) {
        throw new DBusError('org.bluez.Error.InvalidOffset', 'Invalid offset');
      }
      this._value = Buffer.concat([this._value.subarray(0, offset), valBuf]);
    }
    if (this.onWrite) this.onWrite(this._value);
  }
  StartNotify() { this.notifying = true; this.onNotifyChange(); }
  StopNotify() { this.notifying = false; this.onNotifyChange(); }
  notify(buf) {
    if (!this.notifying) return;
    this._value = buf;
    Interface.emitPropertiesChanged(this, { Value: buf });
  }
  dbusProps() {
    return {
      UUID: new Variant('s', this._uuid),
      Service: new Variant('o', this._service),
      Flags: new Variant('as', this._flags),
      Value: new Variant('ay', Array.from(this._value)),
    };
  }
}
Characteristic.configureMembers({
  properties: {
    UUID: { signature: 's', access: ACCESS_READ },
    Service: { signature: 'o', access: ACCESS_READ },
    Flags: { signature: 'as', access: ACCESS_READ },
    Value: { signature: 'ay', access: ACCESS_READ },
  },
  methods: {
    ReadValue: { inSignature: 'a{sv}', outSignature: 'ay' },
    WriteValue: { inSignature: 'aya{sv}' },
    StartNotify: {},
    StopNotify: {},
  },
});

class Descriptor extends Interface {
  constructor(objPath, chr, uuid, flags, value) {
    super('org.bluez.GattDescriptor1');
    this.objPath = objPath;
    this.ifaceName = 'org.bluez.GattDescriptor1';
    this._uuid = uuid;
    this._chr = chr.objPath;
    this._flags = flags;
    this._value = Buffer.from(value);
  }
  get UUID() { return this._uuid; }
  get Characteristic() { return this._chr; }
  get Flags() { return this._flags; }
  ReadValue(options = {}) {
    let offset = 0;
    if (options && options.offset) {
      offset = options.offset.value !== undefined ? options.offset.value : options.offset;
    }
    if (offset > this._value.length) {
      throw new DBusError('org.bluez.Error.InvalidOffset', 'Invalid offset');
    }
    return this._value.subarray(offset);
  }
  dbusProps() {
    return {
      UUID: new Variant('s', this._uuid),
      Characteristic: new Variant('o', this._chr),
      Flags: new Variant('as', this._flags),
    };
  }
}
Descriptor.configureMembers({
  properties: {
    UUID: { signature: 's', access: ACCESS_READ },
    Characteristic: { signature: 'o', access: ACCESS_READ },
    Flags: { signature: 'as', access: ACCESS_READ },
  },
  methods: { ReadValue: { inSignature: 'a{sv}', outSignature: 'ay' } },
});

// BlueZ discovers our GATT tree through this.
class AppObjectManager extends Interface {
  constructor(nodes) {
    super('org.freedesktop.DBus.ObjectManager');
    this.nodes = nodes;
  }
  GetManagedObjects() {
    const out = {};
    for (const n of this.nodes) out[n.objPath] = { [n.ifaceName]: n.dbusProps() };
    return out;
  }
}
AppObjectManager.configureMembers({
  methods: { GetManagedObjects: { outSignature: 'a{oa{sa{sv}}}' } },
});

class Advertisement extends Interface {
  constructor() { super('org.bluez.LEAdvertisement1'); }
  get Type() { return 'peripheral'; }
  get ServiceUUIDs() { return [uuid16('1812')]; }
  get LocalName() { return DEVICE_NAME; }
  get Appearance() { return 0x03c0; } // Generic HID
  Release() {}
}
Advertisement.configureMembers({
  properties: {
    Type: { signature: 's', access: ACCESS_READ },
    ServiceUUIDs: { signature: 'as', access: ACCESS_READ },
    LocalName: { signature: 's', access: ACCESS_READ },
    Appearance: { signature: 'q', access: ACCESS_READ },
  },
  methods: { Release: {} },
});

// "Just Works" pairing agent that ONLY accepts while the pairing window is open,
// so a stranger nearby cannot pair and receive your keystrokes.
class Agent extends Interface {
  constructor(isOpen) { super('org.bluez.Agent1'); this.isOpen = isOpen; }
  _gate() {
    if (!this.isOpen()) throw new DBusError('org.bluez.Error.Rejected', 'Pairing is closed');
  }
  Release() {}
  Cancel() {}
  RequestPinCode() { this._gate(); return '0000'; }
  DisplayPinCode() {}
  RequestPasskey() { this._gate(); return 0; }
  DisplayPasskey() {}
  RequestConfirmation() { this._gate(); }
  RequestAuthorization() { this._gate(); }
  AuthorizeService() {}
}
Agent.configureMembers({
  methods: {
    Release: {},
    Cancel: {},
    RequestPinCode: { inSignature: 'o', outSignature: 's' },
    DisplayPinCode: { inSignature: 'os' },
    RequestPasskey: { inSignature: 'o', outSignature: 'u' },
    DisplayPasskey: { inSignature: 'ouq' },
    RequestConfirmation: { inSignature: 'ou' },
    RequestAuthorization: { inSignature: 'o' },
    AuthorizeService: { inSignature: 'os' },
  },
});

// ---------- GATT tree ----------

function buildTree() {
  const nodes = [];
  const add = (n) => { nodes.push(n); return n; };
  const chr = (svc, i, hex, flags, value, onWrite) =>
    add(new Characteristic(`${svc.objPath}/char${i}`, svc, uuid16(hex), flags, value, onWrite));

  // Device Information
  const dis = add(new Service(`${ROOT}/service0`, uuid16('180a')));
  chr(dis, 0, '2a29', ['read'], Buffer.from('kbm-relay'));
  chr(dis, 1, '2a50', ['read'], [0x02, 0x09, 0x12, 0x01, 0x00, 0x00, 0x01]); // PnP ID

  // Battery (static)
  const bat = add(new Service(`${ROOT}/service1`, uuid16('180f')));
  chr(bat, 0, '2a19', ['read'], [100]);

  // HID
  const hid = add(new Service(`${ROOT}/service2`, uuid16('1812')));
  chr(hid, 0, '2a4a', ['encrypt-read'], [0x11, 0x01, 0x00, 0x02]); // HID information
  chr(hid, 1, '2a4b', ['encrypt-read'], REPORT_MAP);               // Report Map
  chr(hid, 2, '2a4c', ['write-without-response'], [0x00], () => {}); // Control point
  chr(hid, 3, '2a4e', ['read', 'write-without-response'], [0x01], () => {}); // Protocol mode (report)

  const kb = chr(hid, 4, '2a4d', ['encrypt-read', 'encrypt-notify'], Buffer.alloc(8));
  add(new Descriptor(`${kb.objPath}/desc0`, kb, uuid16('2908'), ['read'], [REPORT_ID_KEYBOARD, 0x01]));
  const mouse = chr(hid, 5, '2a4d', ['encrypt-read', 'encrypt-notify'], Buffer.alloc(4));
  add(new Descriptor(`${mouse.objPath}/desc0`, mouse, uuid16('2908'), ['read'], [REPORT_ID_MOUSE, 0x01]));

  return { nodes, kb, mouse };
}

// ---------- Public class ----------

class BleHid extends EventEmitter {
  constructor() {
    super();
    this.ready = false;        // a host has subscribed to our input reports
    this.connected = [];       // names of connected remote devices
    this.pairing = false;
    this.error = '';
    this._pairTimer = null;
  }

  getState() {
    return { ready: this.ready, connected: this.connected, pairing: this.pairing, bleError: this.error };
  }

  async start() {
    const bus = (this.bus = dbus.systemBus());

    // 1. Find the adapter that supports GATT.
    const rootProxy = await bus.getProxyObject('org.bluez', '/');
    this.om = rootProxy.getInterface('org.freedesktop.DBus.ObjectManager');
    const objs = await this.om.GetManagedObjects();
    const adapterPath = Object.keys(objs).find((p) => objs[p]['org.bluez.GattManager1']);
    if (!adapterPath) throw new Error('No Bluetooth adapter with GATT support found');
    this.adapterPath = adapterPath;
    const adapter = await bus.getProxyObject('org.bluez', adapterPath);
    this.adapterProps = adapter.getInterface('org.freedesktop.DBus.Properties');
    await this._setAdapter('Powered', 'b', true);
    await this._setAdapter('Pairable', 'b', false);
    await this._setAdapter('Discoverable', 'b', false);

    // 2. Export and register the GATT application.
    const { nodes, kb, mouse } = buildTree();
    this.kb = kb;
    this.mouse = mouse;
    const onChange = () => this._refreshReady();
    kb.onNotifyChange = onChange;
    mouse.onNotifyChange = onChange;
    bus.export(ROOT, new AppObjectManager(nodes));
    for (const n of nodes) bus.export(n.objPath, n);
    await adapter.getInterface('org.bluez.GattManager1').RegisterApplication(ROOT, {});

    // 3. Advertise.
    bus.export(ADV_PATH, new Advertisement());
    await adapter.getInterface('org.bluez.LEAdvertisingManager1').RegisterAdvertisement(ADV_PATH, {});

    // 4. Pairing agent (only accepts while the pairing window is open).
    bus.export(AGENT_PATH, new Agent(() => this.pairing));
    const bluez = await bus.getProxyObject('org.bluez', '/org/bluez');
    const agentMgr = bluez.getInterface('org.bluez.AgentManager1');
    await agentMgr.RegisterAgent(AGENT_PATH, 'NoInputNoOutput');
    await agentMgr.RequestDefaultAgent(AGENT_PATH);

    // 5. Watch connections.
    this._poll = setInterval(() => this._pollConnections(), 2000);
    await this._pollConnections();
  }

  async _setAdapter(name, sig, value) {
    await this.adapterProps.Set('org.bluez.Adapter1', name, new Variant(sig, value));
  }

  _refreshReady() {
    const ready = !!(this.kb && (this.kb.notifying || this.mouse.notifying));
    if (ready !== this.ready) this.ready = ready;
    this.emit('state');
  }

  async _pollConnections() {
    try {
      const objs = await this.om.GetManagedObjects();
      const names = [];
      for (const p of Object.keys(objs)) {
        const d = objs[p]['org.bluez.Device1'];
        if (d && d.Connected && d.Connected.value) {
          names.push(d.Alias ? d.Alias.value : d.Address.value);
        }
      }
      const changed = names.join('|') !== this.connected.join('|');
      this.connected = names;
      if (!names.length && (this.kb.notifying || this.mouse.notifying)) {
        this.kb.notifying = false;
        this.mouse.notifying = false;
        this._refreshReady();
      } else if (changed) {
        this.emit('state');
      }
    } catch (e) {
      console.error('[ble] _pollConnections failed:', e.stack || e);
      this.error = e.message;
      this.emit('state');
    }
  }

  // Opens (or closes) a time-limited window in which a new host may pair.
  async setPairing(open) {
    clearTimeout(this._pairTimer);
    this.pairing = open;
    try {
      await this._setAdapter('Pairable', 'b', open);
    } catch (e) {
      console.error('[ble] setPairing failed:', e.stack || e);
      this.error = e.message;
    }
    if (open) this._pairTimer = setTimeout(() => this.setPairing(false), PAIRING_WINDOW_MS);
    this.emit('state');
  }

  sendKeyboard(buf) { if (this.kb) this.kb.notify(buf); }
  sendMouse(buf) { if (this.mouse) this.mouse.notify(buf); }

  stop() {
    clearInterval(this._poll);
    clearTimeout(this._pairTimer);
    if (this.bus) this.bus.disconnect();
  }
}

module.exports = {
  BleHid, buildTree, AppObjectManager, Advertisement, Agent,
  ROOT, ADV_PATH, AGENT_PATH,
};

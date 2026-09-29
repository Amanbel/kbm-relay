'use strict';
const EventEmitter = require('events');
const { listDevices, DeviceReader } = require('./inputDevices');
const { KeyboardReport, MouseAccumulator } = require('./hid');

// Four modes. "local" grabs nothing, so the OS on PC A behaves normally.
const MODES = ['local', 'keyboard', 'mouse', 'both'];

class Router extends EventEmitter {
  constructor(ble) {
    super();
    this.ble = ble;
    this.mode = 'local';
    this.kbReport = new KeyboardReport();
    this.mouseAcc = new MouseAccumulator();
    this.kbReader = null;
    this.mouseReader = null;
    this.status = { keyboardFound: false, mouseFound: false, lastError: '' };
    ble.on('state', () => this.emit('state'));
  }

  getState() {
    return { mode: this.mode, ...this.status, ble: this.ble.getState() };
  }

  // Call once at startup and any time devices are (re)plugged in.
  attachDevices() {
    const devices = listDevices();
    const kbd = devices.find((d) => d.kind === 'keyboard');
    const mouse = devices.find((d) => d.kind === 'mouse');
    this.status.keyboardFound = !!kbd;
    this.status.mouseFound = !!mouse;

    if (kbd && !this.kbReader) {
      this.kbReader = new DeviceReader(kbd.path);
      this.kbReader.on('event', (t, c, v) => this._onKeyEvent(t, c, v));
      this.kbReader.on('closed', () => { this.kbReader = null; this.status.keyboardFound = false; this.emit('state'); });
      this.kbReader.on('helper-error', (m) => { this.status.lastError = m; this.emit('state'); });
      this.kbReader.start();
    }
    if (mouse && !this.mouseReader) {
      this.mouseReader = new DeviceReader(mouse.path);
      this.mouseReader.on('event', (t, c, v) => this._onMouseEvent(t, c, v));
      this.mouseReader.on('closed', () => { this.mouseReader = null; this.status.mouseFound = false; this.emit('state'); });
      this.mouseReader.on('helper-error', (m) => { this.status.lastError = m; this.emit('state'); });
      this.mouseReader.start();
    }
    this._applyGrabs();
    this.emit('state');
  }

  async setMode(mode) {
    if (!MODES.includes(mode)) throw new Error(`Unknown mode: ${mode}`);
    if (mode === this.mode) return;
    // Release all keys/buttons before switching so nothing gets stuck on either side.
    this._releaseAll();
    this.mode = mode;
    this._applyGrabs();
    this.emit('state');
  }

  _applyGrabs() {
    const wantKb = this.mode === 'keyboard' || this.mode === 'both';
    const wantMouse = this.mode === 'mouse' || this.mode === 'both';
    if (this.kbReader) this.kbReader.setGrab(wantKb);
    if (this.mouseReader) this.mouseReader.setGrab(wantMouse);
  }

  _releaseAll() {
    this.kbReport.clear();
    this.ble.sendKeyboard(this.kbReport.buffer());
    this.mouseAcc.clear();
    this.ble.sendMouse(Buffer.alloc(4));
  }

  _onKeyEvent(type, code, value) {
    if (type !== 1) return; // EV_KEY only
    if (this.mode !== 'keyboard' && this.mode !== 'both') return;
    if (value === 2) return; // ignore autorepeat; the remote OS repeats held keys itself
    if (this.kbReport.handle(code, value)) {
      this.ble.sendKeyboard(this.kbReport.buffer());
    }
  }

  _onMouseEvent(type, code, value) {
    if (this.mode !== 'mouse' && this.mode !== 'both') return;
    const kind = this.mouseAcc.handle(type, code, value);
    if (kind === 'button') {
      for (const r of this.mouseAcc.drain()) this.ble.sendMouse(r);
    }
    // 'motion' events are coalesced and flushed on a timer (see flush()) to avoid
    // saturating the BLE link at raw mouse report rates.
  }

  flushMotion() {
    if (this.mouseAcc.dx || this.mouseAcc.dy || this.mouseAcc.wheel) {
      for (const r of this.mouseAcc.drain()) this.ble.sendMouse(r);
    }
  }

  stop() {
    if (this.kbReader) this.kbReader.stop();
    if (this.mouseReader) this.mouseReader.stop();
  }
}

module.exports = { Router, MODES };

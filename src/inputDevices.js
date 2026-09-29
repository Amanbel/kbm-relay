'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const BY_ID = '/dev/input/by-id';
const HELPER = path.join(__dirname, '..', 'helper', 'grabber.py');

// Stable device names (survive reboots, unlike /dev/input/eventN).
function listDevices() {
  let names = [];
  try { names = fs.readdirSync(BY_ID); } catch { return []; }
  return names
    .filter((n) => n.endsWith('-event-kbd') || n.endsWith('-event-mouse'))
    .map((n) => ({
      id: n,
      path: path.join(BY_ID, n),
      kind: n.endsWith('-event-kbd') ? 'keyboard' : 'mouse',
    }));
}

// Emits: 'event' (type, code, value), 'closed', 'helper-error' (message)
class DeviceReader extends EventEmitter {
  constructor(devPath) {
    super();
    this.devPath = devPath;
    this.grabbed = false;
    this.proc = null;
  }

  start() {
    this.proc = spawn('python3', [HELPER, this.devPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdin.on('error', () => {});
    let buf = '';
    this.proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line || line[0] === '#') continue;
        const [t, c, v] = line.split(' ').map(Number);
        this.emit('event', t, c, v);
      }
    });
    this.proc.stderr.on('data', (d) => this.emit('helper-error', d.toString().trim()));
    this.proc.on('exit', () => { this.grabbed = false; this.emit('closed'); });
  }

  setGrab(on) {
    if (this.grabbed === on || !this.proc) return;
    this.grabbed = on;
    this.proc.stdin.write(on ? 'grab\n' : 'ungrab\n');
  }

  stop() {
    if (this.proc) this.proc.kill();
    this.proc = null;
  }
}

module.exports = { listDevices, DeviceReader };

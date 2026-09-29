'use strict';

// Linux evdev keycode -> USB HID keyboard usage (usage page 0x07).
// Not covered: media/consumer keys (would need a Consumer Control report).
const KEY_TO_HID = {
  1: 0x29, 2: 0x1e, 3: 0x1f, 4: 0x20, 5: 0x21, 6: 0x22, 7: 0x23, 8: 0x24, 9: 0x25, 10: 0x26, 11: 0x27,
  12: 0x2d, 13: 0x2e, 14: 0x2a, 15: 0x2b,
  16: 0x14, 17: 0x1a, 18: 0x08, 19: 0x15, 20: 0x17, 21: 0x1c, 22: 0x18, 23: 0x0c, 24: 0x12, 25: 0x13,
  26: 0x2f, 27: 0x30, 28: 0x28,
  30: 0x04, 31: 0x16, 32: 0x07, 33: 0x09, 34: 0x0a, 35: 0x0b, 36: 0x0d, 37: 0x0e, 38: 0x0f,
  39: 0x33, 40: 0x34, 41: 0x35, 43: 0x31,
  44: 0x1d, 45: 0x1b, 46: 0x06, 47: 0x19, 48: 0x05, 49: 0x11, 50: 0x10,
  51: 0x36, 52: 0x37, 53: 0x38, 55: 0x55, 57: 0x2c, 58: 0x39,
  59: 0x3a, 60: 0x3b, 61: 0x3c, 62: 0x3d, 63: 0x3e, 64: 0x3f, 65: 0x40, 66: 0x41, 67: 0x42, 68: 0x43,
  69: 0x53, 70: 0x47,
  71: 0x5f, 72: 0x60, 73: 0x61, 74: 0x56, 75: 0x5c, 76: 0x5d, 77: 0x5e, 78: 0x57,
  79: 0x59, 80: 0x5a, 81: 0x5b, 82: 0x62, 83: 0x63,
  86: 0x64, 87: 0x44, 88: 0x45,
  96: 0x58, 98: 0x54, 99: 0x46,
  102: 0x4a, 103: 0x52, 104: 0x4b, 105: 0x50, 106: 0x4f, 107: 0x4d, 108: 0x51, 109: 0x4e,
  110: 0x49, 111: 0x4c, 119: 0x48, 127: 0x65,
};

// Modifier keys -> bit in the HID modifier byte.
const MODIFIERS = {
  29: 0x01, 42: 0x02, 56: 0x04, 125: 0x08, // LCtrl LShift LAlt LMeta
  97: 0x10, 54: 0x20, 100: 0x40, 126: 0x80, // RCtrl RShift RAlt RMeta
};

// BTN_LEFT..BTN_EXTRA -> button bits
const MOUSE_BUTTONS = { 0x110: 0x01, 0x111: 0x02, 0x112: 0x04, 0x113: 0x08, 0x114: 0x10 };

const REPORT_ID_KEYBOARD = 1;
const REPORT_ID_MOUSE = 2;

// HID Report Map: keyboard (ID 1, 8 bytes) + mouse (ID 2, 4 bytes)
const REPORT_MAP = Buffer.from([
  // Keyboard
  0x05, 0x01, 0x09, 0x06, 0xa1, 0x01, 0x85, REPORT_ID_KEYBOARD,
  0x05, 0x07, 0x19, 0xe0, 0x29, 0xe7, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x08, 0x81, 0x02, // modifiers
  0x95, 0x01, 0x75, 0x08, 0x81, 0x01, // reserved
  0x95, 0x06, 0x75, 0x08, 0x15, 0x00, 0x25, 0x65, 0x05, 0x07, 0x19, 0x00, 0x29, 0x65, 0x81, 0x00, // 6 keys
  0xc0,
  // Mouse
  0x05, 0x01, 0x09, 0x02, 0xa1, 0x01, 0x85, REPORT_ID_MOUSE, 0x09, 0x01, 0xa1, 0x00,
  0x05, 0x09, 0x19, 0x01, 0x29, 0x05, 0x15, 0x00, 0x25, 0x01, 0x95, 0x05, 0x75, 0x01, 0x81, 0x02, // 5 buttons
  0x95, 0x01, 0x75, 0x03, 0x81, 0x03, // padding
  0x05, 0x01, 0x09, 0x30, 0x09, 0x31, 0x09, 0x38, 0x15, 0x81, 0x25, 0x7f, 0x75, 0x08, 0x95, 0x03, 0x81, 0x06, // x y wheel
  0xc0, 0xc0,
]);

class KeyboardReport {
  constructor() { this.clear(); }
  clear() { this.mods = 0; this.keys = []; }
  // value: 1 = down, 0 = up. Returns true if the report changed.
  handle(code, value) {
    if (MODIFIERS[code] !== undefined) {
      if (value) this.mods |= MODIFIERS[code]; else this.mods &= ~MODIFIERS[code];
      return true;
    }
    const usage = KEY_TO_HID[code];
    if (usage === undefined) return false;
    const i = this.keys.indexOf(usage);
    if (value && i < 0) {
      if (this.keys.length >= 6) return false; // more than 6 keys: ignore extras
      this.keys.push(usage);
      return true;
    }
    if (!value && i >= 0) { this.keys.splice(i, 1); return true; }
    return false;
  }
  buffer() {
    const b = Buffer.alloc(8);
    b[0] = this.mods;
    this.keys.forEach((k, i) => { b[2 + i] = k; });
    return b;
  }
}

const clamp = (n) => Math.max(-127, Math.min(127, n));

// Collects mouse motion between flushes so we do not flood BLE at 1000 Hz.
class MouseAccumulator {
  constructor() { this.clear(); }
  clear() { this.buttons = 0; this.dx = 0; this.dy = 0; this.wheel = 0; }
  // Returns 'button', 'motion', or null (ignored).
  handle(type, code, value) {
    if (type === 1 && MOUSE_BUTTONS[code] !== undefined) {
      if (value) this.buttons |= MOUSE_BUTTONS[code]; else this.buttons &= ~MOUSE_BUTTONS[code];
      return 'button';
    }
    if (type === 2) {
      if (code === 0) this.dx += value;
      else if (code === 1) this.dy += value;
      else if (code === 8) this.wheel += value;
      else return null;
      return 'motion';
    }
    return null;
  }
  // Returns the list of 4-byte reports needed to express the pending motion.
  drain() {
    const out = [];
    let { dx, dy, wheel } = this;
    do {
      const sx = clamp(dx), sy = clamp(dy), sw = clamp(wheel);
      out.push(Buffer.from([this.buttons, sx & 0xff, sy & 0xff, sw & 0xff]));
      dx -= sx; dy -= sy; wheel -= sw;
    } while (dx || dy || wheel);
    this.dx = this.dy = this.wheel = 0;
    return out;
  }
}

module.exports = {
  REPORT_MAP, REPORT_ID_KEYBOARD, REPORT_ID_MOUSE,
  KeyboardReport, MouseAccumulator,
};

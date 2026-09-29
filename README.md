# kbm-relay

A small Electron app that lets a wired keyboard and mouse plugged into this
Linux PC (**PC A**) also work on a second PC (**PC B**) over Bluetooth — with
a toggle for exactly which device goes where:

| Mode | Keyboard | Mouse |
|---|---|---|
| Local only | stays on PC A | stays on PC A |
| Keyboard → B | goes to PC B | stays on PC A |
| Mouse → B | stays on PC A | goes to PC B |
| Both → B | goes to PC B | goes to PC B |

PC B needs no software at all — it just sees an ordinary Bluetooth keyboard
and mouse, the same as any other Bluetooth peripheral.

---

## 1. Make it work

### 1.1 Requirements

- PC A must run Linux with **BlueZ** (the standard Linux Bluetooth stack)
  and a Bluetooth adapter that supports the **LE peripheral role** (almost
  every laptop adapter and USB dongle from the last ~10 years does).
- Node.js and Python 3 (stdlib only — no pip packages needed).
- PC B can be anything that takes a normal Bluetooth keyboard/mouse —
  Windows, macOS, Linux, even a tablet or phone.

### 1.2 Install

```bash
sudo apt install bluez python3
sudo systemctl enable --now bluetooth
cd kbm-relay
npm install
```

### 1.3 Permissions

The app needs to read your keyboard/mouse's raw input device and talk to
BlueZ over D-Bus. Two one-time steps:

```bash
sudo usermod -aG input $USER
```

Then **log out and back in** (group membership only takes effect on next
login). BlueZ's D-Bus API is normally reachable by any user in a graphical
session by default — if you hit permission errors, first check that
`bluetoothctl` works for you as a normal user.

### 1.4 Run it

```bash
npm start
```

A tray icon appears plus a small window with four mode buttons. The tray
icon's color also tells you the current mode at a glance (grey = local,
blue = keyboard, green = mouse, purple = both).

### 1.5 Pair PC B

1. On PC A's window, click **"Allow a new PC to pair"**. This opens a
   2-minute pairing window (and the tray icon shows "Pairing…").
2. On PC B, open Bluetooth settings and pair with the device named
   **Keyboard Relay**.
3. Once paired, PC B remembers it — you won't need to pair again after
   reboots, on either side.

### 1.6 Switch between machines

Click **Keyboard → B**, **Mouse → B**, or **Both → B** in the window (or
right-click the tray icon for the same options). Click **Local only** to
bring control back to PC A.

If you're using **Keyboard → B** or **Both → B** and can't reach PC A's
screen to click "Local only," press:

```
Ctrl + Alt + Shift + L
```

This is a hard-coded panic key that always snaps back to Local, even while
the keyboard is mid-relay to PC B.

### 1.7 Troubleshooting

- **"No Bluetooth adapter with GATT support found"** — your adapter or
  BlueZ version doesn't support the LE peripheral role. Check
  `bluetoothctl show` for adapter capabilities.
- **Keyboard/mouse shows "not found"** — the app looks for devices under
  `/dev/input/by-id/*-event-kbd` and `*-event-mouse`; unplug/replug and
  check `ls /dev/input/by-id/` to confirm your device shows up there.
- **PC B never sees "Keyboard Relay"** — make sure pairing mode is open
  (the 2-minute window) and that PC B's Bluetooth is scanning for new
  devices, not just showing already-known ones.

---

## 2. How it works

The app is built from four cooperating pieces:

```
Dell keyboard ──USB──► /dev/input/eventN
                              │
                        helper/grabber.py   (reads raw events, can grab/ungrab)
                              │
                       src/inputDevices.js  (spawns + talks to the helper)
                              │
                        src/router.js       (mode state machine)
                              │
                          src/hid.js        (keycodes → HID reports)
                              │
                          src/ble.js        (BLE HID peripheral via BlueZ)
                              │
                          Bluetooth LE
                              │
                            PC B  (sees a normal Bluetooth keyboard/mouse)
```

### 2.1 Reading the physical device

Linux exposes every input device as a stream of raw events
(`/dev/input/eventN`) — key up/down, mouse movement, button clicks.
`helper/grabber.py` opens *one specific* device (found by its stable
`by-id` path, so it doesn't matter which `eventN` number the kernel assigns
on a given boot) and streams those raw events out over stdout as plain
text lines.

Node.js has no way to call the Linux `ioctl()` system call directly, which
is what's needed to take *exclusive* control of a device — so this one
piece is written in Python (stdlib only, no dependencies) and treated as a
subprocess that `src/inputDevices.js` spawns and pipes data to/from.

### 2.2 Grabbing vs. not grabbing

`EVIOCGRAB` is the Linux mechanism for exclusive device access: while it's
active, the kernel stops delivering that device's events to anything else
on PC A (including the desktop environment), and only this app sees them.

- **Local mode**: nothing is grabbed. Your keyboard and mouse work on PC A
  exactly as if this app weren't running.
- **Keyboard/Mouse/Both mode**: the relevant device(s) get grabbed, so PC A
  goes "deaf" to them, and every event is instead turned into a Bluetooth
  report for PC B.

`src/router.js` is what decides, based on the current mode, which
device(s) should be grabbed at any moment — and it re-grabs/ungrabs
immediately whenever you switch modes.

### 2.3 Converting to Bluetooth keyboard/mouse reports

Bluetooth keyboards and mice don't speak "Linux keycodes" — they speak the
USB HID (Human Interface Device) standard, a fixed byte layout that every
OS understands natively:

- A **keyboard report** is 8 bytes: 1 byte of modifier keys (Ctrl/Shift/
  Alt/Meta, as bits), 1 reserved byte, then up to 6 currently-held key
  codes.
- A **mouse report** is 4 bytes: 1 byte of button states, then signed
  X/Y movement and a scroll wheel value.

`src/hid.js` holds the translation table from Linux keycodes to HID usage
codes, and builds these reports from the raw events `router.js` feeds it.
Mouse movement is batched for ~15ms and sent as one report rather than
flooding Bluetooth with an event per pixel of movement.

### 2.4 Becoming a Bluetooth keyboard

This is the part that makes PC A show up as "a Bluetooth keyboard" to PC B
at all. `src/ble.js` talks to **BlueZ** (the Bluetooth daemon every Linux
desktop already runs) over **D-Bus**, and:

1. Registers a **GATT server** — the standard structure Bluetooth LE uses
   to expose data — with the specific services a keyboard/mouse are
   expected to have (the HID service, Device Information, Battery). This
   combination is what makes PC B's OS recognize it as "a keyboard," the
   same way it would recognize any off-the-shelf Bluetooth keyboard.
2. **Advertises** itself over Bluetooth LE so nearby devices can see it,
   named "Keyboard Relay."
3. Registers a **pairing agent** — this is what handles the actual
   handshake when PC B tries to pair. It's written to only accept a
   pairing attempt while you've explicitly opened the 2-minute pairing
   window in the app, so a stranger walking by can't silently pair with
   your keyboard.
4. Once PC B is paired and subscribed, every HID report built in 2.3 is
   sent to it as a Bluetooth **notification** — this is the actual
   keystroke/click arriving on PC B.

### 2.5 The mode switch itself

Whenever you change modes, `router.js` does two things before anything
else: it sends an "all keys released, no buttons held" report, and only
then grabs or ungrabs the physical devices. This ordering exists
specifically so a key can never get stuck "held down" on either machine
mid-switch — for example, if you were holding Ctrl when you switched
modes.

### 2.6 The tray app

`main.js` is the Electron entry point: it starts `ble.js` and `router.js`,
opens a small window (`renderer/index.html`) showing the current mode and
connection status, and a tray icon whose color mirrors the mode. It also
registers the `Ctrl+Alt+Shift+L` panic shortcut directly with the X
server, which is why it still works even when the keyboard device itself
is grabbed and invisible to the rest of PC A.

---

## Known limitations

- Only the standard keyboard page is mapped — media/volume/brightness keys
  aren't relayed (would need a second "Consumer Control" HID report).
- Built for one PC B at a time.
- No systemd unit yet for auto-start on login; see the implementation plan
  for that and other hardening ideas (auto-fallback to Local if the
  Bluetooth link drops, etc.).

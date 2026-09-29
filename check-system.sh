#!/usr/bin/env bash
# Checks every prerequisite kbm-relay needs, without changing anything.
set -uo pipefail
ok()   { echo -e "  [OK]   $1"; }
bad()  { echo -e "  [FAIL] $1"; }
warn() { echo -e "  [WARN] $1"; }

echo "== Node.js & npm =="
if command -v node >/dev/null 2>&1; then ok "node found: $(node -v)"; else bad "node not found — install Node.js"; fi
if command -v npm  >/dev/null 2>&1; then ok "npm found: $(npm -v)";  else bad "npm not found"; fi

echo
echo "== Python 3 =="
if command -v python3 >/dev/null 2>&1; then ok "python3 found: $(python3 -V)"; else bad "python3 not found — sudo apt install python3"; fi

echo
echo "== BlueZ (Bluetooth stack) =="
if command -v bluetoothctl >/dev/null 2>&1; then
  ok "bluetoothctl found: $(bluetoothctl --version)"
else
  bad "bluetoothctl not found — sudo apt install bluez"
fi
if systemctl is-active --quiet bluetooth 2>/dev/null; then
  ok "bluetooth.service is running"
else
  bad "bluetooth.service is NOT running — sudo systemctl enable --now bluetooth"
fi

echo
echo "== Bluetooth adapter & LE peripheral support =="
if command -v hciconfig >/dev/null 2>&1; then
  ADAPTER=$(hciconfig 2>/dev/null | head -1 | cut -d: -f1)
  [ -n "$ADAPTER" ] && ok "adapter found: $ADAPTER" || bad "no adapter found by hciconfig"
else
  warn "hciconfig not installed (optional) — try: sudo apt install bluez-hcidump"
fi
if command -v btmgmt >/dev/null 2>&1; then
  echo "  --- btmgmt info (look for 'LE' in supported settings) ---"
  sudo btmgmt info 2>/dev/null | sed 's/^/  /'
else
  warn "btmgmt not found (optional, comes with bluez); can't auto-verify LE peripheral support"
  echo "  Manually run: bluetoothctl show   (look for 'Powered: yes' and no LE-related errors)"
fi

echo
echo "== D-Bus access to BlueZ (needed for the GATT/advertising API) =="
if command -v busctl >/dev/null 2>&1; then
  if busctl --system list 2>/dev/null | grep -q org.bluez; then
    ok "org.bluez is reachable on the system bus"
  else
    bad "org.bluez not visible on the system bus — is bluetooth.service running?"
  fi
else
  warn "busctl not found (optional) — install with: sudo apt install dbus (usually already present)"
fi

echo
echo "== Input device permissions =="
if id -nG "$USER" 2>/dev/null | grep -qw input; then
  ok "$USER is in the 'input' group"
else
  bad "$USER is NOT in the 'input' group — run: sudo usermod -aG input \$USER   (then log out/in)"
fi

echo
echo "== Your keyboard/mouse visible under /dev/input/by-id =="
if [ -d /dev/input/by-id ]; then
  KBD=$(ls /dev/input/by-id 2>/dev/null | grep -- '-event-kbd' | head -1)
  MOUSE=$(ls /dev/input/by-id 2>/dev/null | grep -- '-event-mouse' | head -1)
  [ -n "$KBD" ]   && ok "keyboard device found: $KBD"   || bad "no *-event-kbd device found"
  [ -n "$MOUSE" ] && ok "mouse device found: $MOUSE"     || bad "no *-event-mouse device found"
else
  bad "/dev/input/by-id does not exist on this system"
fi

echo
echo "== npm dependency (dbus-next) =="
if [ -d "$(dirname "$0")/node_modules/dbus-next" ]; then
  ok "dbus-next installed"
else
  warn "dbus-next not installed yet — run 'npm install' inside the project folder"
fi

echo
echo "Done. Anything marked [FAIL] needs fixing before the app will work."

#!/usr/bin/env python3
"""
Reads ONE /dev/input event device and prints "type code value" lines to stdout.
Accepts "grab" / "ungrab" lines on stdin (EVIOCGRAB = exclusive access, so the
local PC stops receiving that device's events while it is grabbed).

Safety: if the parent process dies, stdin closes, we exit, and the kernel
releases the grab automatically when the file descriptor closes.

Standard library only. Needed because Node.js has no ioctl().
"""
import fcntl
import os
import select
import struct
import sys

EVIOCGRAB = 0x40044590                 # _IOW('E', 0x90, int)
EVENT = struct.Struct("llHHi")         # struct input_event: time(sec,usec), type, code, value
FORWARD_TYPES = (0, 1, 2)              # EV_SYN, EV_KEY, EV_REL


def main():
    fd = os.open(sys.argv[1], os.O_RDONLY)
    grabbed = False

    def set_grab(on):
        nonlocal grabbed
        if on == grabbed:
            return
        try:
            fcntl.ioctl(fd, EVIOCGRAB, 1 if on else 0)
            grabbed = on
        except OSError as e:
            sys.stderr.write("grab failed: %s\n" % e)
            sys.stderr.flush()
        print("# grab %d" % int(grabbed), flush=True)

    stdin_fd = sys.stdin.fileno()
    cmd = ""
    try:
        while True:
            ready, _, _ = select.select([fd, stdin_fd], [], [])
            if fd in ready:
                data = os.read(fd, EVENT.size * 64)
                for off in range(0, len(data) - EVENT.size + 1, EVENT.size):
                    _, _, etype, code, value = EVENT.unpack_from(data, off)
                    if etype in FORWARD_TYPES:
                        sys.stdout.write("%d %d %d\n" % (etype, code, value))
                sys.stdout.flush()
            if stdin_fd in ready:
                chunk = os.read(stdin_fd, 256)
                if not chunk:
                    break
                cmd += chunk.decode()
                while "\n" in cmd:
                    line, cmd = cmd.split("\n", 1)
                    if line == "grab":
                        set_grab(True)
                    elif line == "ungrab":
                        set_grab(False)
    except OSError:
        pass  # device unplugged
    finally:
        os.close(fd)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Mars workbench PTY bridge (docs/WORKBENCH.md "Terminal").

Runs argv[1:] on a new pseudo-terminal. stdin carries input bytes, stdout carries
output bytes and fd 3 carries control lines "R <cols> <rows>". The initial size comes
from MARS_PTY_COLS and MARS_PTY_ROWS, which the shell never sees. Exits with the
shell's status (128 + signal when a signal ended it).

The first stderr line is "tty <path> <shell pid>" so the host can find every process
still attached to the terminal when the session is ended.
"""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

CONTROL = 3
PENDING_LIMIT = 1 << 20


def winsize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


cols = int(os.environ.pop("MARS_PTY_COLS", "80"))
rows = int(os.environ.pop("MARS_PTY_ROWS", "24"))
report_r, report_w = os.pipe()
pid, master = pty.fork()
if pid == 0:
    try:
        os.write(report_w, os.ttyname(0).encode() + b"\n")
        # The shell gets the terminal and nothing else: not the control or report pipes.
        os.closerange(3, 1024)
        # Size the terminal before the shell starts so its first prompt already fits.
        winsize(0, cols, rows)
        os.execvp(sys.argv[1], sys.argv[1:])
    finally:
        os._exit(127)
os.close(report_w)
with os.fdopen(report_r, "rb") as report:
    sys.stderr.write(f"tty {report.readline().decode().strip()} {pid}\n")
    sys.stderr.flush()


def hangup(*_):
    """What closing a terminal window does: SIGHUP the shell and the foreground job."""
    groups = {pid}
    try:
        groups.add(os.tcgetpgrp(master))
    except OSError:
        pass
    for group in groups:
        try:
            os.killpg(group, signal.SIGHUP)
        except OSError:
            pass


def write_all(fd, data):
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view):]


signal.signal(signal.SIGTERM, hangup)
os.set_blocking(master, False)
pending = bytearray()
stdin_open = True
control_open = True
control = b""
status = None
while True:
    readers = [master]
    if stdin_open and len(pending) < PENDING_LIMIT:
        readers.append(0)
    if control_open:
        readers.append(CONTROL)
    try:
        readable, writable, _ = select.select(readers, [master] if pending else [], [], 0.5)
    except InterruptedError:
        continue
    if master in readable:
        try:
            data = os.read(master, 65536)
        except BlockingIOError:
            data = None
        except OSError:
            data = b""  # Linux reports EIO once the last slave descriptor closes.
        if data == b"":
            break
        if data:
            write_all(1, data)
    if master in writable:
        try:
            del pending[: os.write(master, pending[:65536])]
        except BlockingIOError:
            pass
        except OSError:
            pending.clear()
    if 0 in readable:
        data = os.read(0, 65536)
        if data:
            pending += data
        else:
            stdin_open = False
            hangup()
    if CONTROL in readable:
        data = os.read(CONTROL, 4096)
        if not data:
            control_open = False
        control += data
        while b"\n" in control:
            line, control = control.split(b"\n", 1)
            parts = line.split()
            if len(parts) == 3 and parts[0] == b"R" and parts[1].isdigit() and parts[2].isdigit():
                winsize(master, int(parts[1]), int(parts[2]))
    if status is None:
        done, waited = os.waitpid(pid, os.WNOHANG)
        if done:
            status = waited
    # The shell is gone and nothing more is waiting to be read.
    if status is not None and master not in readable:
        break
if status is None:
    _, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
sys.exit(128 - code if code < 0 else code & 0xFF)

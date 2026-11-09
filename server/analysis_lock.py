"""Serialise heavy local analysis across every Coro checkout on this machine.

Several worktrees may each run their own Coro instance. Demucs, YourMT3+,
GAME and the quality models must not run concurrently on one laptop, so each
analysis worker holds one advisory file lock. The OS releases it when the
process exits, including after a crash. Set CORO_ANALYSIS_LOCK=off to disable.

Command-line use for offline experiments:
    .venv/bin/python -m server.analysis_lock -- <command> [args...]
"""
from __future__ import annotations

import contextlib
import fcntl
import os
import subprocess
import sys
import time
from pathlib import Path


def lock_path() -> Path | None:
    value = os.environ.get('CORO_ANALYSIS_LOCK', '')
    if value.lower() == 'off':
        return None
    return Path(value) if value else Path.home() / '.cache' / 'coro' / 'analysis.lock'


@contextlib.contextmanager
def hold(on_wait=None, poll: float = 2.0):
    """Hold the machine-wide analysis lock. ``on_wait(first)`` runs while blocked
    and may raise (for example on cancellation) to abandon the wait."""
    path = lock_path()
    if path is None:
        yield
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open('a+')
    try:
        first = True
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if on_wait:
                    on_wait(first)
                first = False
                time.sleep(poll)
        handle.seek(0)
        handle.truncate()
        handle.write(f'{os.getpid()} {os.getcwd()} {" ".join(sys.argv)[:300]}\n')
        handle.flush()
        yield
    finally:
        handle.close()


def holder() -> str:
    path = lock_path()
    try:
        return path.read_text().strip() if path else ''
    except OSError:
        return ''


def main(argv: list[str]) -> int:
    if argv[:1] == ['--']:
        argv = argv[1:]
    if not argv:
        print(__doc__)
        return 2

    def waiting(first):
        if first:
            print(f'[coro-lock] waiting for: {holder() or "another analysis"}', file=sys.stderr, flush=True)

    with hold(waiting):
        return subprocess.run(argv).returncode


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))

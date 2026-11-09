import subprocess
import sys
import textwrap

import pytest

from server import analysis_lock
from server.storage import Cancelled, JobStatus, atomic_json


def test_lock_serialises_processes_and_releases_on_exit(tmp_path, monkeypatch):
    lock = tmp_path / 'analysis.lock'
    monkeypatch.setenv('CORO_ANALYSIS_LOCK', str(lock))
    child = textwrap.dedent('''
        import sys, time
        from server.analysis_lock import hold
        with hold():
            print('held', flush=True)
            time.sleep(30)
    ''')
    holder = subprocess.Popen([sys.executable, '-c', child], stdout=subprocess.PIPE, text=True,
                              env={**__import__('os').environ, 'CORO_ANALYSIS_LOCK': str(lock)})
    try:
        assert holder.stdout.readline().strip() == 'held'
        waits = []

        def give_up(first):
            waits.append(first)
            raise Cancelled()

        with pytest.raises(Cancelled):
            with analysis_lock.hold(give_up, poll=0.01):
                pass
        assert waits == [True]
    finally:
        holder.kill()
        holder.wait()
    # The OS releases the lock when the holder dies, even without cleanup.
    with analysis_lock.hold(lambda first: pytest.fail('lock not released'), poll=0.01):
        pass


def test_lock_can_be_disabled(monkeypatch):
    monkeypatch.setenv('CORO_ANALYSIS_LOCK', 'off')
    assert analysis_lock.lock_path() is None
    with analysis_lock.hold(lambda first: pytest.fail('should not wait')):
        pass


def test_waiting_keeps_job_queued_and_honours_cancel(tmp_path):
    atomic_json(tmp_path / 'status.json', {'id': 'x', 'status': 'queued', 'stage': 'queued'})
    status = JobStatus(tmp_path)
    status.waiting('waiting for another checkout')
    current = status.read()
    assert current['status'] == 'queued' and current['message'] == 'waiting for another checkout'
    (tmp_path / 'cancelled').touch()
    with pytest.raises(Cancelled):
        status.waiting('again')

import pytest


@pytest.fixture(autouse=True)
def _isolated_analysis_lock(tmp_path_factory, monkeypatch):
    """Tests never wait on, or block, the machine-wide lock used by real analyses
    running in other Coro checkouts. Each test gets a private lock file."""
    monkeypatch.setenv('CORO_ANALYSIS_LOCK', str(tmp_path_factory.mktemp('lock') / 'analysis.lock'))

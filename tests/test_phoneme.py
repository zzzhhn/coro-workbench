"""Optional model runtime regressions; never import Torch or load weights."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

import numpy as np
import pytest
import soundfile as sf

from server import phoneme
from server import phoneme_runner


def event(a, b, chunk=0, *, left=False, right=False, pitch=60):
    return {'source_start_seconds': a, 'source_end_seconds': b, 'start_seconds': a,
            'end_seconds': b, 'raw_start_seconds': a - .1 if left else a,
            'raw_end_seconds': b + .1 if right else b, 'chunk': chunk, 'midi_pitch': pitch,
            'continued_from_context': left, 'continues_into_context': right}


def test_context_continuation_stitches_and_preserves_native_evidence():
    original = [event(19.9, 20, right=True), event(20, 20.5, 1, left=True)]
    result = phoneme._stitch_context_events(original)
    assert len(result) == 1
    assert result[0]['source_start_seconds'] == 19.9
    assert result[0]['source_end_seconds'] == 20.5
    assert result[0]['stitched_chunks'] == [0, 1]
    assert len(result[0]['native_intervals']) == 2
    assert original[0]['source_end_seconds'] == 20


@pytest.mark.parametrize('left,right,pitch,gap', [(False, False, 60, 0), (False, True, 60, 0),
    (True, False, 60, 0), (True, True, 61, 0), (True, True, 60, .02)])
def test_repeated_attacks_different_pitches_and_gaps_are_not_stitched(left, right, pitch, gap):
    assert len(phoneme._stitch_context_events([
        event(19.9, 20, right=right), event(20 + gap, 20.5, 1, left=left, pitch=pitch)])) == 2


def test_chunk_windows_are_bounded_and_own_the_full_track():
    windows = phoneme_runner._chunk_windows(300 * 16000, 16000)
    assert len(windows) == 15
    assert windows[0]['left'] == 0 and windows[-1]['right'] == 300 * 16000
    assert all(w['right'] - w['left'] <= 22 * 16000 for w in windows)
    assert all(a['core_right'] == b['core_left'] for a, b in zip(windows, windows[1:]))
    with pytest.raises(ValueError):
        phoneme_runner._chunk_windows(300 * 16000 + 1, 16000)


def test_official_decoder_mapping_uses_raw_times_and_counts_zero_sentinel():
    window = {'chunk': 1, 'left': 1900, 'right': 4100, 'core_left': 2000, 'core_right': 4000}
    events, filtered = phoneme_runner._events_from_decoded([60.49, 0, 60.51],
        [[80, 120], [130, 140], [2080, 2120]], hop_seconds=.01, window=window, sample_rate=100)
    assert filtered == 1 and len(events) == 2
    assert events[0]['source_start_seconds'] == 20
    assert events[0]['raw_start_seconds'] == pytest.approx(19.8)
    assert events[0]['continued_from_context']
    assert events[0]['midi_pitch'] == 60 and events[1]['midi_pitch'] == 61
    assert events[1]['source_end_seconds'] == 40
    assert events[1]['continues_into_context']
    assert 'confidence' not in events[0] and 'boundary_probability' not in events[0]


@pytest.mark.parametrize('events', [[event(1, .5)], [event(0, float('nan'))],
    [event(0, float('inf'))], [event(-.1, .2)], [event(0, 2)],
    [event(0, .2, pitch=0)], [event(0, .2, pitch=60.2)], [event(0, .2, pitch=True)],
    [event(.5, .8), event(.2, .3)], [event(0, .5), event(.4, .7)]])
def test_invalid_child_notes_are_rejected(events):
    with pytest.raises(ValueError):
        phoneme._validate_events(events, 1)


def test_empty_and_adjacent_notes_are_valid():
    assert phoneme._validate_events([], 1) == []
    assert len(phoneme._validate_events([event(0, .1), event(.1, .2)], 1)) == 2


def test_phoneme_note_cannot_bridge_a_quiet_unvoiced_breath():
    times = np.arange(200) * .01
    f0 = np.where(times < .5, 261.63, np.where(times >= 1.4, 293.66, 0.))
    activation = np.where(f0 > 0, .9, 0.)
    rms = np.where(f0 > 0, .2, .002)
    original = [event(0, 2, pitch=60)]
    notes, audit = phoneme.refine_voicing(original, times, f0, activation, rms)
    assert [(n['source_start_seconds'], n['source_end_seconds'], n['midi_pitch']) for n in notes] == [
        (0, .53, 60), (1.37, 2, 62)]
    assert original == [event(0, 2, pitch=60)]
    assert audit['edits'][0]['sourceEvent'] == original[0]


def test_phoneme_keeps_short_dropouts_and_loud_missing_pitch():
    times = np.arange(200) * .01
    f0 = np.full(200, 261.63)
    f0[40:46] = 0
    f0[80:150] = 0
    activation = np.where(f0 > 0, .9, 0.)
    original = [event(0, 2, pitch=60)]
    notes, audit = phoneme.refine_voicing(original, times, f0, activation, np.full(200, .2))
    assert notes == original and audit['edits'] == []


def contour(path, **changes):
    values = {'time': np.arange(20) * .01, 'f0': np.full(20, 440.), 'activation': np.ones(20) * .8}
    values.update(changes)
    np.savez(path, **values)
    return path


@pytest.mark.parametrize('changes', [dict(time=np.arange(20).reshape(4, 5)), dict(f0=np.ones(19)),
    dict(time=np.arange(20) * .01 + 1), dict(time=np.zeros(20)), dict(activation=np.full(20, np.nan)),
    dict(activation=np.full(20, 1.1)), dict(f0=np.full(20, np.inf)), dict(f0=np.full(20, -1.)),
    dict(time=np.arange(20) * 10)])
def test_rejects_malformed_or_wrong_timebase_fcpe(tmp_path, changes):
    with pytest.raises(ValueError):
        phoneme._load_contour(contour(tmp_path / 'fcpe.npz', **changes), .2)


def test_real_missing_f0_remains_unvoiced_without_gap_interpolation(tmp_path):
    from server.vocal_groundtruth import resample_f0_track
    path = contour(tmp_path / 'fcpe.npz', f0=np.array([440.] * 8 + [0., np.nan] + [880.] * 10))
    times, frequency, activation = phoneme._load_contour(path, .2)
    f0, voiced = resample_f0_track(times, frequency, times, voicing=activation >= .03)
    assert np.all(f0[8:10] == 0) and not voiced[8:10].any()


class Process:
    def __init__(self, returncode=None, *, stuck=False):
        self.returncode = returncode
        self.terminated = self.killed = False
        self.stuck = stuck
    def poll(self):
        return self.returncode
    def terminate(self):
        self.terminated = True
    def kill(self):
        self.killed = True
        self.stuck = False
    def wait(self, timeout):
        if self.stuck:
            raise subprocess.TimeoutExpired('test child', timeout)
        self.returncode = -15
        return self.returncode


def prepare(monkeypatch, tmp_path, *, returncode=None, native=None):
    audio = tmp_path / 'input.wav'
    sf.write(audio, np.zeros(1600, dtype=np.float32), 8000)
    f0 = contour(tmp_path / 'fcpe.npz')
    process = Process(returncode)
    monkeypatch.setattr(phoneme, 'runtime_health', lambda: {'ready': True, 'engine': 'test phoneme'})
    commands = []
    def popen(command, **kwargs):
        commands.append((command, kwargs))
        if native is not None:
            (tmp_path / 'out/native.json').write_text(json.dumps(native))
        return process
    monkeypatch.setattr(phoneme.subprocess, 'Popen', popen)
    return audio, f0, process, commands


def test_complete_empty_output_is_explicit_and_evidence_is_recorded(monkeypatch, tmp_path):
    audio, f0, process, commands = prepare(monkeypatch, tmp_path, returncode=0, native={'events': [], 'success': True})
    result = phoneme.infer_phoneme(audio, tmp_path / 'out', contour_path=f0)
    assert result['events'] == [] and result['model']['pitchSummary'] == 'weighted_median'
    request = json.loads((tmp_path / 'out/request.json').read_text())
    assert request['audio_sha256'] == hashlib.sha256(audio.read_bytes()).hexdigest()
    assert request['contour_sha256'] == hashlib.sha256(f0.read_bytes()).hexdigest()
    assert commands[0][0][0] == str(phoneme.RUNTIME / '.venv/bin/python')
    assert commands[0][1]['env']['OMP_NUM_THREADS'] == '1'
    assert commands[0][1]['env']['CUDA_VISIBLE_DEVICES'] == ''
    assert not process.terminated


def test_timeout_reaps_child_and_saves_failure(monkeypatch, tmp_path):
    audio, f0, process, _ = prepare(monkeypatch, tmp_path)
    clock = iter([0., 2.])
    monkeypatch.setattr(phoneme.time, 'monotonic', lambda: next(clock))
    with pytest.raises(TimeoutError):
        phoneme.infer_phoneme(audio, tmp_path / 'out', contour_path=f0, timeout_seconds=.5)
    assert process.terminated and process.returncode is not None
    assert json.loads((tmp_path / 'out/failure.json').read_text())['errorType'] == 'TimeoutError'


@pytest.mark.parametrize('raises', [False, True])
def test_cancellation_and_callback_exception_reap_child(monkeypatch, tmp_path, raises):
    audio, f0, process, _ = prepare(monkeypatch, tmp_path)
    calls = []
    def check():
        calls.append(1)
        if len(calls) > 1:
            if raises:
                raise LookupError('job cancellation')
            return True
        return False
    with pytest.raises(LookupError if raises else InterruptedError):
        phoneme.infer_phoneme(audio, tmp_path / 'out', contour_path=f0, cancel_check=check)
    assert process.terminated and process.returncode is not None


def test_unresponsive_child_is_killed():
    process = Process(stuck=True)
    phoneme._stop_process(process)
    assert process.terminated and process.killed and process.returncode is not None


def test_model_failure_is_explicit(monkeypatch, tmp_path):
    audio, f0, _, _ = prepare(monkeypatch, tmp_path, returncode=7)
    with pytest.raises(RuntimeError, match=r'failed \(7\)'):
        phoneme.infer_phoneme(audio, tmp_path / 'out', contour_path=f0)
    assert (tmp_path / 'out/failure.json').is_file()


def test_malformed_child_output_is_rejected_and_retained(monkeypatch, tmp_path):
    audio, f0, _, _ = prepare(monkeypatch, tmp_path, returncode=0, native={'events': [event(0, 1)]})
    with pytest.raises(ValueError):
        phoneme.infer_phoneme(audio, tmp_path / 'out', contour_path=f0)
    assert (tmp_path / 'out/native.json').is_file()
    assert not (tmp_path / 'out/result.json').exists()


def test_evidence_is_never_overwritten(monkeypatch, tmp_path):
    audio, f0, _, _ = prepare(monkeypatch, tmp_path)
    out = tmp_path / 'out'
    out.mkdir()
    (out / 'inference.log').write_text('previous evidence')
    with pytest.raises(ValueError, match='overwrite'):
        phoneme.infer_phoneme(audio, out, contour_path=f0)
    assert (out / 'inference.log').read_text() == 'previous evidence'


@pytest.mark.parametrize('seconds', [0, -1, float('nan'), float('inf')])
def test_invalid_timeout_fails_before_health_or_model(tmp_path, seconds):
    with pytest.raises(ValueError):
        phoneme.infer_phoneme(tmp_path / 'absent.wav', tmp_path / 'out', contour_path=tmp_path / 'none', timeout_seconds=seconds)


def health_fixture(monkeypatch, tmp_path):
    runtime = tmp_path / 'models/phoneme-ast'
    monkeypatch.setattr(phoneme, 'ROOT', tmp_path)
    monkeypatch.setattr(phoneme, 'RUNTIME', runtime)
    for relative in ['.venv/bin/python', 'source/phn_ast/model.py', 'source/phn_ast/decoding.py']:
        path = runtime / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
    (runtime / '.venv/bin/python').chmod(0o755)
    for relative in ['server/phoneme_runner.py', 'scripts/setup-phoneme.requirements.txt']:
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
    checkpoint = runtime / 'model.pt'
    checkpoint.write_bytes(b'checkpoint')
    monkeypatch.setattr(phoneme, 'MODEL_BYTES', len(b'checkpoint'))
    monkeypatch.setattr(phoneme, 'MODEL_SHA256', hashlib.sha256(b'checkpoint').hexdigest())
    monkeypatch.setattr(phoneme, '_source_integrity', lambda path: [])
    for name, version in phoneme.EXPECTED_VERSIONS.items():
        metadata = runtime / f'.venv/lib/python3.11/site-packages/{name}-{version}.dist-info/METADATA'
        metadata.parent.mkdir(parents=True)
        metadata.write_text(f'Name: {name}\nVersion: {version}\n')
    manifest = {'sourceCommit': phoneme.SOURCE_COMMIT, 'checkpointSha256': phoneme.MODEL_SHA256, 'python': '3.11.15',
        'requirementsSha256': hashlib.sha256(b'').hexdigest()}
    (runtime / 'runtime-manifest.json').write_text(json.dumps(manifest))
    phoneme._INTEGRITY_CACHE.clear()
    return runtime


def test_health_pinned_checkpoint_is_cached_and_changes_invalidate(monkeypatch, tmp_path):
    runtime = health_fixture(monkeypatch, tmp_path)
    assert phoneme.runtime_health()['ready']
    cached = len(phoneme._INTEGRITY_CACHE)
    assert phoneme.runtime_health()['ready']
    assert len(phoneme._INTEGRITY_CACHE) == cached
    (runtime / 'model.pt').write_bytes(b'checkpoinX')
    result = phoneme.runtime_health()
    assert not result['ready'] and 'Phoneme checkpoint integrity mismatch' in result['integrityErrors']


def test_health_detects_missing_source_and_changed_dependencies(monkeypatch, tmp_path):
    runtime = health_fixture(monkeypatch, tmp_path)
    metadata = next((runtime / '.venv/lib/python3.11/site-packages').glob('torch-*/METADATA'))
    metadata.write_text('Name: torch\nVersion: 0.0.1\n')
    assert not phoneme.runtime_health()['ready']
    (runtime / 'source/phn_ast/model.py').unlink()
    assert phoneme.runtime_health()['missing']


def test_source_commit_and_local_work_are_rejected(monkeypatch, tmp_path):
    replies = iter(['wrong-commit\n', ' M phn_ast/model.py\n'])
    monkeypatch.setattr(phoneme.subprocess, 'check_output', lambda *a, **kw: next(replies))
    assert len(phoneme._source_integrity(tmp_path)) == 2


def test_health_imports_no_ml_library():
    # A fresh process makes the import boundary independent of pytest's plugins.
    code = ('import sys; from server import phoneme; phoneme.runtime_health(); '
            'assert not any(n in sys.modules for n in ("torch", "numpy", "librosa", "phn_ast"))')
    subprocess.run([__import__('sys').executable, '-c', code], check=True,
                   cwd=Path(__file__).resolve().parents[1])


@pytest.mark.parametrize('mismatch', ['source', 'model'])
def test_installer_preserves_mismatched_assets_before_install_or_download(tmp_path, mismatch):
    script = tmp_path / 'scripts/setup-phoneme.sh'
    script.parent.mkdir()
    script.write_text((Path(__file__).resolve().parents[1] / 'scripts/setup-phoneme.sh').read_text())
    runtime = tmp_path / 'models/phoneme-ast'
    runtime.mkdir(parents=True)
    fake_bin = tmp_path / 'bin'
    fake_bin.mkdir()
    for command in ('uv', 'curl'):
        executable = fake_bin / command
        executable.write_text('#!/bin/sh\necho unexpected-call > "' + str(tmp_path / 'called') + '"\nexit 99\n')
        executable.chmod(0o755)
    if mismatch == 'source':
        (runtime / 'source/.git').mkdir(parents=True)
        original = runtime / 'source/user-work.py'
        original.write_text('keep this work')
        git = fake_bin / 'git'
        git.write_text('#!/bin/sh\necho wrong-commit\n')
        git.chmod(0o755)
    else:
        original = runtime / 'model.pt'
        original.write_text('keep this checkpoint')
    before = original.read_bytes()
    result = subprocess.run(['bash', str(script)], env=os.environ | {'PATH': str(fake_bin) + os.pathsep + os.environ['PATH']},
                            capture_output=True, text=True)
    assert result.returncode != 0
    assert 'preserved' in result.stderr
    assert original.read_bytes() == before
    assert not (tmp_path / 'called').exists()
    assert not (runtime / '.venv').exists()

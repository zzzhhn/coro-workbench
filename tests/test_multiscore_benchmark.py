import importlib.util
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location('multiscore_benchmark', Path(__file__).parents[1] / 'scripts/benchmark-multiscore.py')
benchmark = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(benchmark)


def event(start, end, program=40):
    return {'start': start, 'end': end, 'midi': 60, 'program': program, 'isDrum': False}


def test_metrics_distinguish_instrument_errors_offsets_and_unmatched_parts():
    ref = [event(0, 1), event(2, 3, 42)]
    pred = [event(0, 1, 41), event(2, 2.2, 42)]
    assert benchmark.metrics(ref, pred)['f1'] == 1
    result = benchmark.metrics(ref, pred, class_aware=True)
    assert result['f1'] == .5
    assert {c['class'] for c in result['classes']} == {40, 41, 42}
    assert result['macroF1'] == pytest.approx(1 / 3)
    assert benchmark.metrics(ref, pred, class_aware=True, offsets=True)['f1'] == 0


def test_metrics_cannot_match_two_simultaneous_sources_to_one_prediction():
    assert benchmark.metrics([event(0, 1), event(0, 1)], [event(0, 1)])['matches'] == 1


def test_legacy_replay_demonstrates_short_note_deletion_without_changing_native_events():
    native = [event(.01, .04), event(.1, .8, 42)]
    result = benchmark.legacy_events(native, 120, 1)
    assert len(native) == 2 and len(result) == 1
    assert result[0]['program'] == 48  # former broad strings playback identity

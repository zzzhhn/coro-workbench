"""GAME align / syllable-boundary evidence is saved but never changes the score."""
import json

import pytest

from server import game
from server.game_align import align_regions, chunk_windows


def phones(*rows):
    return [{'phone': p, 'wordIndex': w, 'start': a, 'end': b} for p, w, a, b in rows]


def test_align_regions_are_contiguous_syllables_with_unvoiced_gaps_and_disjoint_sentences():
    alignment = {'segments': [
        {'id': 'line-0', 'text': '你好', 'phones': phones(('SP', -1, 1.0, 1.2), ('n', 0, 1.2, 1.3), ('i', 0, 1.3, 1.6),
                                                         ('h', 1, 1.6, 1.7), ('ao', 1, 1.7, 2.2), ('SP', -1, 2.2, 2.6))},
        {'id': 'line-1', 'text': '再', 'phones': phones(('SP', -1, 2.4, 2.8), ('z', 0, 2.8, 2.9), ('ai', 0, 2.9, 3.4))}]}
    regions = align_regions(alignment)
    first, second = regions
    assert [(w['start'], w['end'], w['voiced']) for w in first['words']] == [
        (1.0, 1.2, False), (1.2, 1.6, True), (1.6, 2.2, True), (2.2, 2.5, False)]
    assert second['words'][0]['start'] == 2.5
    for segment in regions:
        assert all(abs(a['end'] - b['start']) < 1e-9 for a, b in zip(segment['words'], segment['words'][1:]))


def test_chunk_windows_follow_game_segments():
    raw = {'segments': [{'offsetSeconds': 2.0, 'durationSeconds': 3.5}, {'offsetSeconds': 7.0, 'durationSeconds': 1.0}]}
    assert chunk_windows(raw) == [[2.0, 5.5], [7.0, 8.0]]


class Status:
    def __init__(self):
        self.stages = []

    def update(self, progress, stage, message, **extra):
        self.stages.append(stage)

    def check_cancelled(self):
        pass


@pytest.mark.parametrize('lyrics', [False, True])
def test_evidence_records_outcome_and_skips_align_without_lyrics(tmp_path, monkeypatch, lyrics):
    (tmp_path/'game/sofa').mkdir(parents=True)
    (tmp_path/'game/sofa/alignment.json').write_text(json.dumps({'segments': [
        {'id': 'line-0', 'text': '你', 'phones': phones(('SP', -1, 0, .2), ('n', 0, .2, .3), ('i', 0, .3, .8))}]}))
    monkeypatch.setattr(game, 'runtime_health', lambda: {'lyricsReady': True})
    commands = []
    def helper(command, output, status, timeout=1200):
        commands.append(command)
        if '--words' in command:
            target = command[command.index('--output')+1]
            open(target, 'w').write(json.dumps({'segments': [{'notes': [{'midi': 60}]}]}))
    monkeypatch.setattr(game, 'run_helper', helper)
    status = Status()
    record = game.save_vocal_evidence(tmp_path, tmp_path/'stem.wav', {'segments': []}, lyrics, status)
    assert record['usedByNotation'] is False and record['referenceNotesUsed'] is False
    assert record['syllableBoundary']['status'] == 'saved'
    assert set(status.stages) == {'game-align'}
    if lyrics:
        assert record['align'] == {'status': 'saved', 'file': 'game/align.json', 'segments': 1, 'notes': 1}
        assert any('--words' in c for c in commands)
    else:
        assert record['align'] == {'status': 'skipped', 'reason': 'no-lyrics'}
        assert not any('--words' in c for c in commands)


def test_evidence_failure_is_recorded_not_raised(tmp_path, monkeypatch):
    (tmp_path/'game').mkdir()
    monkeypatch.setattr(game, 'runtime_health', lambda: {'lyricsReady': True})
    def helper(*args, **kwargs):
        raise ValueError('GAME 人声处理失败')
    monkeypatch.setattr(game, 'run_helper', helper)
    record = game.save_vocal_evidence(tmp_path, tmp_path/'stem.wav', {'segments': []}, True, Status())
    assert record['syllableBoundary']['status'] == 'failed'
    assert record['align']['status'] == 'failed'


def test_score_is_computed_before_evidence_and_independent_of_it():
    """Source order guard: evidence runs after build_singing_notes, and notation never reads it."""
    import inspect
    from server import singing_pipeline, singing_score
    source = inspect.getsource(game.transcribe_lead)
    assert source.index('build_singing_notes(') < source.index('save_vocal_evidence(')
    for module in (singing_pipeline, singing_score):
        text = inspect.getsource(module)
        assert 'align.json' not in text and 'syllable-boundary' not in text and 'game_align' not in text

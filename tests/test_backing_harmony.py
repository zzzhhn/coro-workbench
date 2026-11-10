import json

from server import backing_harmony
from server.backing_harmony import PART_ID, backing_line_part, insert_after_lead, transcribe_backing_line


def project():
    return {'id': 'job', 'key': 'D', 'parts': [
        {'id': 'game-vocals', 'role': 'lead', 'notes': [{'id': 'g1', 'midi': 64, 'start': 0, 'duration': 1}]},
        {'id': 'piano', 'role': 'instrument', 'notes': [{'id': 'p1', 'midi': 50, 'start': 0, 'duration': 2}]}],
        'source': {'warnings': [], 'analysis': {'rhythm': {'bpm': 60, 'offsetSeconds': 0}}}}


class Status:
    def update(self, *a): pass
    def check_cancelled(self): pass


def test_backing_line_goes_right_after_the_lead_and_leaves_other_parts_unchanged():
    base = project()
    part = backing_line_part([{'id': 'b1', 'midi': 60, 'start': 0, 'duration': 1}], 'job', 'v')
    result = insert_after_lead(base, part)
    assert [p['id'] for p in result['parts']] == ['game-vocals', PART_ID, 'piano']
    assert result['parts'][0] == base['parts'][0] and result['parts'][2] == base['parts'][1]
    assert result['parts'][1]['role'] == 'harmony' and result['parts'][1]['stemUrl'] == '/api/audio/job/stem-backing.wav'
    # Re-inserting replaces, never duplicates.
    again = insert_after_lead(result, part)
    assert [p['id'] for p in again['parts']].count(PART_ID) == 1


def test_missing_inputs_skip_with_a_warning_and_keep_the_score(tmp_path):
    base = project()
    result = transcribe_backing_line(tmp_path, base, {'id': 'job'}, Status())
    assert [p['id'] for p in result['parts']] == ['game-vocals', 'piano']
    assert result['parts'] == base['parts']
    assert result['source']['analysis']['backingHarmony']['status'] == 'skipped'
    assert any('伴唱主导线未生成' in w for w in result['source']['warnings'])
    assert json.loads((tmp_path / 'quality-evidence.json').read_text())['backingHarmony']['status'] == 'skipped'


def test_a_failing_backing_model_never_fails_the_upload(tmp_path, monkeypatch):
    import sys, types
    from server import config
    # A stand-in module: CI has no onnxruntime, and the real separator is not under test here.
    lead_separation = types.ModuleType('server.lead_separation')
    monkeypatch.setitem(sys.modules, 'server.lead_separation', lead_separation)
    model = tmp_path / 'models/lead-separation/kara2.onnx'
    model.parent.mkdir(parents=True)
    model.write_bytes(b'x')
    (tmp_path / 'stem-vocals.wav').write_bytes(b'x')
    monkeypatch.setattr(config, 'MODELS_DIR', tmp_path / 'models')
    def broken(*a, **k):
        raise ValueError('separator exploded')
    lead_separation.separate_lead_backing = broken
    base = project()
    result = transcribe_backing_line(tmp_path, base, {'id': 'job'}, Status())
    assert result['parts'] == base['parts']
    audit = result['source']['analysis']['backingHarmony']
    assert audit['status'] == 'failed' and 'separator exploded' in audit['reason']


def test_missing_optional_runtime_only_skips_the_backing_line(tmp_path, monkeypatch):
    import sys
    from server import config
    model = tmp_path / 'models/lead-separation/kara2.onnx'
    model.parent.mkdir(parents=True)
    model.write_bytes(b'x')
    (tmp_path / 'stem-vocals.wav').write_bytes(b'x')
    monkeypatch.setattr(config, 'MODELS_DIR', tmp_path / 'models')
    monkeypatch.setitem(sys.modules, 'server.lead_separation', None)  # import fails like a missing onnxruntime
    base = project()
    result = transcribe_backing_line(tmp_path, base, {'id': 'job'}, Status())
    assert result['parts'] == base['parts']
    assert result['source']['analysis']['backingHarmony']['status'] == 'failed'

import json

from server import pipeline_manifest as pm
from server.storage import JobStatus, atomic_json


def test_status_updates_become_a_layered_timeline_and_diagram(tmp_path):
    atomic_json(tmp_path / 'status.json', {'id': 'x', 'status': 'queued', 'stage': 'queued'})
    status = JobStatus(tmp_path)
    status.update(3, 'decoding', 'a')
    status.update(35, 'multi', 'b')
    status.update(40, 'multi', 'c')
    status.update(95, 'game', 'd')
    status.update(97, 'experimental-stage', 'e')
    status.finish({'parts': []})
    timeline = pm.stage_timeline(pm.read_trace(tmp_path))
    assert [s['stage'] for s in timeline] == ['decoding', 'multi', 'game', 'experimental-stage', 'complete']
    assert timeline[1]['updates'] == 2 and timeline[1]['lastMessage'] == 'c'
    assert timeline[1]['layer'] == 'recognition' and timeline[3]['layer'] == 'unclassified'
    diagram = pm.mermaid(timeline)
    assert diagram.startswith('flowchart LR') and 'S0 --> S1' in diagram and 'complete' not in diagram


def test_manifest_records_versions_outputs_and_no_quality_claim(tmp_path):
    atomic_json(tmp_path / 'status.json', {'id': 'x', 'status': 'queued', 'stage': 'queued'})
    JobStatus(tmp_path).update(95, 'game', 'd')
    project = {'parts': [{'id': 'game-vocals', 'notes': [{}, {}]}],
               'source': {'analysis': {'quality': {'decoderProfile': 'game'},
                                       'game': {'notationVersion': 'syllable-phrasing-4', 'rawEvents': 3}}}}
    manifest = pm.build_manifest(tmp_path, {'id': 'x', 'lyrics_lrc': 'secret words'}, project)
    assert manifest['outputs']['parts'] == {'game-vocals': 2}
    assert manifest['outputs']['leadNotationVersion'] == 'syllable-phrasing-4'
    assert manifest['components']['singing_score'].startswith('syllable-phrasing')
    assert manifest['request']['lyricsProvided'] is True and 'lyrics_lrc' not in manifest['request']
    assert manifest['claimsMusicalCorrectness'] is False
    json.dumps(manifest)


def test_tracing_failure_never_breaks_analysis(tmp_path):
    missing = tmp_path / 'gone'
    pm.record(missing, 'decoding', 1, 'x')  # directory absent: silently ignored

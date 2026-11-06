from __future__ import annotations

import copy
import hashlib
import json
import sys

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from server.app import create_app
from server.storage import Cancelled, JobStatus, atomic_json, read_json
from server.vocal_rebuild import prepare_rebuild, rebuild_vocals, safe_file

SOURCE = "a" * 32
NEW = "b" * 32


def score():
    note = {"id": "n1", "midi": 60, "start": 0., "duration": .25, "velocity": .7, "lyric": "old"}
    vocal = {"id": "vocals", "name": "my name", "shortName": "V", "instrument": "voice", "role": "lead", "clef": "treble", "program": 53, "color": "#fff", "notes": [note], "muted": True, "solo": False, "volume": .42, "pan": -.2, "stemUrl": f"/api/audio/{SOURCE}/stem-lead.wav"}
    piano = {**copy.deepcopy(vocal), "id": "piano", "instrument": "piano", "role": "instrument", "notes": [{**note, "id": "p1", "origin": "manual"}]}
    return {"version": 1, "id": SOURCE, "title": "manual title", "composer": "me", "tempo": 90, "timeSignature": [4, 4], "key": "D", "measures": 4, "parts": [vocal, piano], "chords": [{"start": 0, "duration": 4, "symbol": "D", "pitches": [62, 66, 69]}], "source": {"kind": "audio", "warnings": [], "analysis": {"transforms": [], "rawProjectUrl": f"/api/projects/{SOURCE}/raw", "rhythm": {"bpm": 120, "offsetSeconds": .1}, "quality": {"custom": "kept"}}}, "originalAudio": {"name": "orig", "url": f"/api/audio/{SOURCE}/original.wav", "fileUrl": f"/api/source/{SOURCE}", "duration": 2., "tempo": 120., "offsetSeconds": .1}, "createdAt": "old", "updatedAt": "old"}


@pytest.fixture
def saved(tmp_path):
    directory = tmp_path / SOURCE
    directory.mkdir()
    project = score()
    atomic_json(directory / "status.json", {"id": SOURCE, "status": "complete", "project": project})
    atomic_json(directory / "project.json", project)
    atomic_json(directory / "raw-project.json", project)
    atomic_json(directory / "request.json", {"max_seconds": 2})
    sf.write(directory / "stem-lead.wav", np.zeros(32000), 16000)
    return tmp_path, directory, project


@pytest.fixture
def api(saved, monkeypatch):
    root, directory, project = saved
    app = create_app(root)
    from server import rosvot
    monkeypatch.setattr(rosvot, "runtime_health", lambda: {"ready": True})
    submitted = []
    monkeypatch.setattr(app.state.manager, "submit", submitted.append)
    with TestClient(app) as client:
        yield client, app, submitted, root, project


def event(start=.2, end=.7, pitch=60):
    return {"source_start_seconds": start, "source_end_seconds": end, "midi_pitch": pitch}


def mock_infer(monkeypatch, events=None):
    from server import rosvot
    calls = []
    def infer(stem, output, **kwargs):
        kwargs["cancel_check"]()
        calls.append(stem)
        return {"events": events or [event(), event(.7, 1.2, 62)]}
    monkeypatch.setattr(rosvot, "infer_rosvot", infer)
    return calls


def queued(root, project):
    target = root / NEW
    target.mkdir()
    atomic_json(target / "status.json", {"id": NEW, "status": "queued"})
    return target, {"id": NEW, "action": "vocal-rebuild", "source_job_id": SOURCE, "project": project}


def test_api_snapshot_queue_and_existing_cancel(api):
    client, app, submitted, root, project = api
    result = client.post(f"/api/projects/{SOURCE}/vocal-rebuild", json={"project": project})
    assert result.status_code == 202
    new = result.json()["id"]
    assert submitted == [new]
    request = read_json(root / new / "request.json")
    assert request["action"] == "vocal-rebuild" and request["max_seconds"] == 2
    assert read_json(root / new / "previous-project.json") == project
    assert app.state.manager.pending_uploads == 0
    assert client.get(f"/api/jobs/{new}").json()["status"] == "queued"
    assert client.delete(f"/api/jobs/{new}").json()["status"] == "cancelled"
    assert read_json(root / SOURCE / "project.json") == project


def test_missing_vocal_runtime_gives_setup_instruction_before_queueing(api, monkeypatch):
    from server import rosvot
    client, app, submitted, root, project = api
    monkeypatch.setattr(rosvot, "runtime_health", lambda: {"ready": False})
    response = client.post(f"/api/projects/{SOURCE}/vocal-rebuild", json={"project": project})
    assert response.status_code == 503 and "setup-rosvot.sh" in response.json()["detail"]
    assert submitted == [] and app.state.manager.pending_uploads == 0
    assert len([p for p in root.iterdir() if len(p.name) == 32]) == 1


def test_explicit_original_vocals_choice_is_queued_without_changing_source(api):
    client, app, submitted, root, project = api
    sf.write(root / SOURCE / 'stem-vocals.wav', np.zeros((32000, 2)), 16000)
    response = client.post(f'/api/projects/{SOURCE}/vocal-rebuild', json={'project': project, 'vocalSource': 'original-vocals'})
    assert response.status_code == 202
    new = response.json()['id']
    assert read_json(root / new / 'request.json')['vocal_source'] == 'original-vocals'
    assert read_json(root / SOURCE / 'project.json') == project


def test_missing_enhancement_runtime_is_clear_before_queue(api, monkeypatch):
    from server import melband
    client, app, submitted, root, project = api
    sf.write(root / SOURCE / 'analysis.wav', np.zeros((32000, 2)), 16000)
    monkeypatch.setattr(melband, 'runtime_health', lambda: {'ready': False})
    response = client.post(f'/api/projects/{SOURCE}/vocal-rebuild', json={'project': project, 'vocalSource': 'enhanced-vocals'})
    assert response.status_code == 503 and 'setup-melband.sh' in response.json()['detail']
    assert submitted == [] and app.state.manager.pending_uploads == 0


@pytest.mark.parametrize('choice', ['arbitrary.wav', 'https://example.com/voice', 2])
def test_unknown_input_choice_never_queues_a_job(api, choice):
    client, app, submitted, root, project = api
    response = client.post(f'/api/projects/{SOURCE}/vocal-rebuild', json={'project': project, 'vocalSource': choice})
    assert response.status_code == 422 and submitted == []


def test_changing_input_preserves_other_parts_and_labels_old_curves(saved, monkeypatch):
    root, source, project = saved
    sf.write(source / 'stem-vocals.wav', np.zeros((32000, 2)), 16000)
    calls = mock_infer(monkeypatch)
    target, request = queued(root, project)
    request['vocal_source'] = 'original-vocals'
    output = rebuild_vocals(target, request, JobStatus(target))
    assert calls == [source / 'stem-vocals.wav']
    assert output['parts'][0]['stemUrl'] == f'/api/audio/{SOURCE}/stem-vocals.wav'
    assert output['parts'][1:] == project['parts'][1:]
    assert output['source']['analysis']['quality']['priorPitchCurvesForSelectedInput'] is False
    assert output['source']['analysis']['quality']['vocalInputSource'] == 'original-vocals'


def test_rebuild_preserves_manual_edits_and_maps_with_source_tempo(saved, monkeypatch):
    root, source_dir, project = saved
    project["tempo"] = 40
    project["parts"][1]["notes"][0]["midi"] = 77
    project["chords"][0]["symbol"] = "A7"
    before = copy.deepcopy(project)
    calls = mock_infer(monkeypatch)
    target, request = queued(root, project)
    output = rebuild_vocals(target, request, JobStatus(target))
    assert calls == [source_dir / "stem-lead.wav"]
    assert output["tempo"] == 40 and output["key"] == "D" and output["timeSignature"] == [4, 4]
    assert output["parts"][1] == before["parts"][1]
    assert output["chords"] == before["chords"] and output["originalAudio"] == before["originalAudio"]
    assert {k: v for k, v in output["parts"][0].items() if k != "notes"} == {k: v for k, v in before["parts"][0].items() if k != "notes"}
    assert len(output["parts"][0]["notes"]) == 2
    assert output["parts"][0]["notes"][0]["start"] == .25  # (0.2 - 0.1) * 120/60, snapped
    assert all("lyric" not in n and "confidence" not in n for n in output["parts"][0]["notes"])
    assert project == before
    assert read_json(source_dir / "project.json") == score()
    assert read_json(target / "previous-project.json") == before
    assert read_json(target / "raw-project.json") == score()
    q = output["source"]["analysis"]["quality"]
    assert q["beforeVocalNotes"] == 1 and q["afterVocalNotes"] == 2 and q["verificationRerun"] is False
    assert q["decoderProfile"] == "rosvot" and q["vocalRhythmVersion"].startswith("vocal-score")
    assert output["source"]["analysis"]["rawProjectUrl"] == f"/api/projects/{NEW}/raw"


@pytest.mark.parametrize("change", [
    lambda p: p.update(arrangement={}),
    lambda p: p["source"].update(kind="midi"),
    lambda p: p["source"]["analysis"].update(rawProjectUrl=f"/api/projects/{NEW}/raw"),
    lambda p: p["originalAudio"].update(url="https://example.com/a.wav"),
    lambda p: p["originalAudio"].update(offsetSeconds=.9),
    lambda p: p["source"]["warnings"].append("插入小节后，时间线改变"),
    lambda p: p["source"]["analysis"]["rhythm"].update(offsetSeconds=.4),
    lambda p: p.update(tempo=float("nan")),
    lambda p: p["parts"][1]["notes"][0].update(duration=-1),
    lambda p: p.update(parts=[]),
])
def test_invalid_or_mismatched_snapshots_rejected(api, change):
    client, app, submitted, root, project = api
    change(project)
    data = json.dumps({"project": project})
    response = client.post(f"/api/projects/{SOURCE}/vocal-rebuild", content=data, headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert not submitted and app.state.manager.pending_uploads == 0
    assert len([p for p in root.iterdir() if len(p.name) == 32]) == 1


def test_derived_source_supported(saved):
    root, directory, project = saved
    derived = root / NEW
    derived.mkdir()
    stored = copy.deepcopy(project)
    stored["parts"][0]["stemUrl"] = f"/api/audio/{SOURCE}/stem-lead.wav"
    atomic_json(derived / "status.json", {"status": "complete", "project": stored})
    atomic_json(derived / "raw-project.json", stored)
    project["source"]["analysis"]["rawProjectUrl"] = f"/api/projects/{NEW}/raw"
    assert prepare_rebuild(root, NEW, project)[2] == directory / "stem-lead.wav"


@pytest.mark.parametrize("url", ["../../outside.wav", f"/api/audio/{SOURCE}/../stem-lead.wav", "https://example.com/stem-lead.wav", f"/api/audio/{SOURCE}/original.wav"])
def test_stored_malicious_stem_rejected(saved, url):
    root, directory, project = saved
    state = read_json(directory / "status.json")
    state["project"]["parts"][0]["stemUrl"] = url
    atomic_json(directory / "status.json", state)
    with pytest.raises(ValueError):
        prepare_rebuild(root, SOURCE, project)


def test_symlink_stem_or_parent_rejected(saved):
    root, directory, project = saved
    stem = directory / "stem-lead.wav"
    outside = root / "external.wav"
    stem.rename(outside)
    stem.symlink_to(outside)
    with pytest.raises(ValueError, match="符号链接"):
        prepare_rebuild(root, SOURCE, project)
    stem.unlink()
    stem.write_bytes(outside.read_bytes())
    moved = root / "hidden"
    directory.rename(moved)
    directory.symlink_to(moved, target_is_directory=True)
    with pytest.raises(ValueError, match="符号链接"):
        prepare_rebuild(root, SOURCE, project)


def test_queue_full_or_submit_failure_releases_reservation(api, monkeypatch):
    client, app, submitted, root, project = api
    monkeypatch.setattr(app.state.manager, "reserve_upload", lambda: False)
    assert client.post(f"/api/projects/{SOURCE}/vocal-rebuild", json={"project": project}).status_code == 429
    assert len([p for p in root.iterdir() if len(p.name) == 32]) == 1


def test_request_limit_and_nonfinite(api):
    client, app, _, root, project = api
    result = client.post(f"/api/projects/{SOURCE}/vocal-rebuild", content=b"{}", headers={"Content-Length": str(30 * 1024 * 1024 + 1)})
    assert result.status_code == 413
    for value in ("NaN", "Infinity", "1e999"):
        content = json.dumps({"project": project}).replace('"tempo": 90', f'"tempo": {value}')
        assert client.post(f"/api/projects/{SOURCE}/vocal-rebuild", content=content).status_code == 422


def test_cancellation_does_not_save_project(saved, monkeypatch):
    root, _, project = saved
    target, request = queued(root, project)
    from server import rosvot
    def cancel(*args, **kwargs):
        (target / "cancelled").touch()
        kwargs["cancel_check"]()
    monkeypatch.setattr(rosvot, "infer_rosvot", cancel)
    with pytest.raises(Cancelled):
        rebuild_vocals(target, request, JobStatus(target))
    assert not (target / "project.json").exists()
    assert JobStatus(target).read()["status"] == "cancelled"


def test_worker_dispatch_failure_marks_new_job_only(saved, monkeypatch):
    root, source, project = saved
    target, request = queued(root, project)
    atomic_json(target / "request.json", request)
    from server import worker, rosvot
    monkeypatch.setattr(worker, "DATA_DIR", root)
    monkeypatch.setattr(sys, "argv", ["worker", NEW])
    def fail(*args, **kwargs):
        raise ValueError("native failed")
    monkeypatch.setattr(rosvot, "infer_rosvot", fail)
    assert worker.main() == 1
    assert JobStatus(target).read()["status"] == "error"
    assert read_json(source / "status.json")["status"] == "complete"
    assert not (target / "project.json").exists()


def test_beat_reinterpretation_allowed(saved, monkeypatch):
    root, _, project = saved
    project["originalAudio"]["tempo"] = 240
    project["tempo"] = 180
    mock_infer(monkeypatch)
    target, request = queued(root, project)
    output = rebuild_vocals(target, request, JobStatus(target))
    assert output["originalAudio"]["tempo"] == 240 and output["tempo"] == 180
    assert output["parts"][0]["notes"][1]["start"] == 2.5


def test_stored_alignment_and_phase_progress(saved, monkeypatch):
    root, source, project = saved
    mock_infer(monkeypatch)
    contour = source / "lead-identity/lead-models/vocals-fcpe.npz"
    contour.parent.mkdir(parents=True)
    times = np.arange(0, 2, .02)
    np.savez(contour, time=times, f0=np.ones(len(times)) * 261.6, activation=np.ones(len(times)))
    from server import vocal_alignment
    called = []
    def align(events, *args):
        called.append(True)
        return events, {"version": "test-alignment", "boundaryEdits": [{"test": True}]}
    monkeypatch.setattr(vocal_alignment, "align_vocal_notes", align)
    target, request = queued(root, project)
    status = JobStatus(target)
    stages = []
    original_update = status.update
    def update(progress, stage, message, **extra):
        stages.append((progress, stage))
        original_update(progress, stage, message, **extra)
    monkeypatch.setattr(status, "update", update)
    output = rebuild_vocals(target, request, status)
    assert called
    assert [p for p, s in stages] == [5, 20, 70, 85, 95]
    assert output["source"]["analysis"]["quality"]["vocalAlignedBoundaries"] == 1


def write_dense(directory, stem):
    output = directory / "dense-voice-audit" / "owned"
    output.mkdir(parents=True)
    arrays = {"time": np.array([0., .5, 1.]), "fcpeF0": np.ones(3)*261.6, "crepeF0": np.ones(3)*261.6,
              "periodicity": np.ones(3), "activation": np.ones(3), "audible": np.ones(3, dtype=bool), "jointVoiced": np.ones(3, dtype=bool)}
    np.savez(output / "contours.npz", **arrays)
    audit = {"contourFile": str(output / "contours.npz"), "durationSeconds": 2, "thresholds": {"periodicity": .3, "fcpeActivation": .03}, "uncertaintyIntervals": []}
    atomic_json(output / "report.json", {"durationSeconds": 2})
    atomic_json(output / "cache.json", {"signature": {"leadSha256": hashlib.sha256(stem.read_bytes()).hexdigest()},
                "contourSha256": hashlib.sha256((output / "contours.npz").read_bytes()).hexdigest(),
                "reportSha256": hashlib.sha256((output / "report.json").read_bytes()).hexdigest()})
    atomic_json(directory / "quality-evidence.json", {"denseVoiceAudit": audit})
    return output, audit


def test_derived_contour_only_cache_recovers_signed_original(saved, monkeypatch):
    root, source, project = saved
    original, audit = write_dense(source, source / "stem-lead.wav")
    derived_id = "c" * 32
    derived = root / derived_id
    derived.mkdir()
    atomic_json(derived / "status.json", {"status": "complete", "project": project})
    atomic_json(derived / "raw-project.json", project)
    copied = derived / "dense-voice-audit" / "copied"
    copied.mkdir(parents=True)
    (copied / "contours.npz").write_bytes((original / "contours.npz").read_bytes())
    atomic_json(copied / "cache.json", {"contourSha256": hashlib.sha256((copied / "contours.npz").read_bytes()).hexdigest(), "copiedFromJob": SOURCE})
    atomic_json(derived / "quality-evidence.json", {"denseVoiceAudit": {**audit, "contourFile": str(copied / "contours.npz")}})
    project["source"]["analysis"]["rawProjectUrl"] = f"/api/projects/{derived_id}/raw"
    target, request = queued(root, project)
    request["source_job_id"] = derived_id
    mock_infer(monkeypatch)
    output = rebuild_vocals(target, request, JobStatus(target))
    assert output["source"]["analysis"]["quality"]["priorPitchEvidenceAvailable"] is True
    from server.pitch_evidence import read_pitch_window
    assert read_pitch_window(target, 0, 1)["integrity"] == "sha256_checked"
    evidence = read_json(target / "quality-evidence.json")
    assert evidence["denseVoiceAudit"]["verificationRerun"] is False
    assert evidence["denseVoiceAudit"]["validatesCurrentNotes"] is False
    assert evidence["denseVoiceAudit"]["reusedFromJob"] == SOURCE


def test_rebuilding_changed_input_again_keeps_the_old_curve_source_explicit(saved, monkeypatch):
    root, source, project = saved
    write_dense(source, source / 'stem-lead.wav')
    sf.write(source / 'stem-vocals.wav', np.ones((32000, 2)) * .02, 16000)
    mock_infer(monkeypatch)
    target, request = queued(root, project)
    request['vocal_source'] = 'original-vocals'
    first = rebuild_vocals(target, request, JobStatus(target))
    atomic_json(target / 'status.json', {'status': 'complete', 'project': first})
    second_dir = root / ('d' * 32)
    second_dir.mkdir()
    atomic_json(second_dir / 'status.json', {'status': 'queued'})
    second = rebuild_vocals(second_dir, {'source_job_id': NEW, 'project': first}, JobStatus(second_dir))
    quality = second['source']['analysis']['quality']
    assert quality['priorPitchEvidenceAvailable'] is True
    assert quality['priorPitchCurvesForSelectedInput'] is False
    evidence = read_json(second_dir / 'quality-evidence.json')
    assert evidence['priorPitchCurveSourceStemUrl'] == f'/api/audio/{SOURCE}/stem-lead.wav'


def test_corrupt_prior_evidence_rejected_without_failing_rebuild(saved, monkeypatch):
    root, source, project = saved
    original, audit = write_dense(source, source / "stem-lead.wav")
    (original / "contours.npz").write_bytes(b"corrupt")
    mock_infer(monkeypatch)
    target, request = queued(root, project)
    output = rebuild_vocals(target, request, JobStatus(target))
    quality = output["source"]["analysis"]["quality"]
    assert quality["priorPitchEvidenceAvailable"] is False
    assert quality["verificationStatus"] == "not_rerun"
    assert "哈希" in quality["priorPitchEvidenceError"]
    assert "denseVoiceAudit" not in read_json(target / "quality-evidence.json")


@pytest.mark.parametrize("legacy_kind", ["no_cache", "contour_hash_only"])
def test_legacy_curves_remain_readable_without_inventing_audio_binding(saved, monkeypatch, legacy_kind):
    root, source, project = saved
    folder, audit = write_dense(source, source / "stem-lead.wav")
    if legacy_kind == "no_cache":
        (folder / "cache.json").unlink()
    else:
        atomic_json(folder / "cache.json", {"contourSha256": hashlib.sha256((folder / "contours.npz").read_bytes()).hexdigest()})
    (folder / "report.json").unlink()
    mock_infer(monkeypatch)
    target, request = queued(root, project)
    output = rebuild_vocals(target, request, JobStatus(target))
    quality = output["source"]["analysis"]["quality"]
    assert quality["priorPitchEvidenceAvailable"] is True
    assert quality["priorPitchAudioBindingVerified"] is False
    assert quality["vocals.notes"] == len(output["parts"][0]["notes"])
    from server.pitch_evidence import read_pitch_window
    assert read_pitch_window(target, 0, 1)["integrity"] == "sha256_checked"


def test_submit_failure_releases_queue_slot_and_cleans_directory(api, monkeypatch):
    client, app, _, root, project = api
    def fail(_):
        raise RuntimeError("executor closed")
    monkeypatch.setattr(app.state.manager, "submit", fail)
    with pytest.raises(RuntimeError, match="executor closed"):
        client.post(f"/api/projects/{SOURCE}/vocal-rebuild", json={"project": project})
    assert app.state.manager.pending_uploads == 0
    assert len([p for p in root.iterdir() if len(p.name) == 32]) == 1


@pytest.mark.parametrize("bpm", [10, 15, 360, 480])
def test_extreme_beat_reinterpretation_keeps_physical_time(saved, monkeypatch, bpm):
    root, _, project = saved
    project["originalAudio"]["tempo"] = bpm
    mock_infer(monkeypatch)
    target, request = queued(root, project)
    output = rebuild_vocals(target, request, JobStatus(target))
    assert output["originalAudio"]["tempo"] == bpm
    notes = output["parts"][0]["notes"]
    assert abs(.1 + notes[1]["start"] * 60 / bpm - .7) < .12


def test_uuid_collision_never_deletes_existing_source(api, monkeypatch):
    client, app, _, root, project = api
    import server.app as app_module
    from types import SimpleNamespace
    sentinel = root / SOURCE / "sentinel"
    sentinel.write_text("keep")
    monkeypatch.setattr(app_module.uuid, "uuid4", lambda: SimpleNamespace(hex=SOURCE))
    with pytest.raises(FileExistsError):
        client.post(f"/api/projects/{SOURCE}/vocal-rebuild", json={"project": project})
    assert sentinel.read_text() == "keep"
    assert read_json(root / SOURCE / "status.json")["status"] == "complete"
    assert app.state.manager.pending_uploads == 0


@pytest.mark.parametrize("change", [
    lambda p: p["parts"][0].update(stemUrl="https://evil.example/stem.wav"),
    lambda p: p["parts"][1].update(stemUrl="https://evil.example/piano.wav"),
    lambda p: p["originalAudio"].update(fileUrl="https://evil.example/source"),
    lambda p: p["source"].update(pages=["https://evil.example/page.png"]),
    lambda p: p["source"]["analysis"]["quality"].update(leadAudioUrl="https://evil.example/lead.wav"),
    lambda p: p["parts"][0].update(stemUrl=f"/api/audio/{NEW}/stem-lead.wav"),
])
def test_external_snapshot_assets_or_changed_vocal_playback_rejected_before_queue(api, change):
    client, app, submitted, root, project = api
    change(project)
    response = client.post(f"/api/projects/{SOURCE}/vocal-rebuild", json={"project": project})
    assert response.status_code == 422
    assert submitted == []
    assert app.state.manager.pending_uploads == 0

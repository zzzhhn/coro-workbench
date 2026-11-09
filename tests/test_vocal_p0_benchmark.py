import importlib.util
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest


@pytest.fixture
def benchmark():
    path = Path(__file__).resolve().parents[1] / "scripts/benchmark-vocal-p0.py"
    spec = importlib.util.spec_from_file_location("vocal_p0_benchmark", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_fractional_midi_reference_is_not_rounded(benchmark, tmp_path):
    path = tmp_path / "reference.txt"
    path.write_text("1.16\t1.56\t67.85\n1.73\t2.20\t64.34\n")
    rows = benchmark.parse_reference(path)
    assert rows[:, :2] == pytest.approx(np.array([[1.16, 1.56], [1.73, 2.20]]))
    assert rows[0, 2] == pytest.approx(440 * 2 ** ((67.85 - 69) / 12))
    assert rows[0, 2] != pytest.approx(440 * 2 ** ((68 - 69) / 12))


def test_micro_counts_are_pooled_instead_of_averaging_f1(benchmark):
    rows = [{"matchedNotes": 1, "referenceNotes": 1, "estimatedNotes": 1, "f1": 1.},
            {"matchedNotes": 0, "referenceNotes": 9, "estimatedNotes": 1, "f1": 0.}]
    result = benchmark.aggregate_metrics(rows)
    assert result["microF1"] == pytest.approx(2 / 12)
    assert result["macroF1"] == .5
    assert result["microPrecision"] == .5 and result["microRecall"] == .1
    assert benchmark.aggregate_metrics([])["microF1"] is None


def test_protocol_and_evidence_conflicts_are_not_overwritten(benchmark, tmp_path):
    path = tmp_path / "protocol.json"
    benchmark.write_once(path, benchmark.protocol())
    benchmark.write_once(path, benchmark.protocol())
    original = path.read_bytes()
    with pytest.raises(ValueError, match="conflicting"):
        benchmark.write_once(path, {"ids": []})
    assert path.read_bytes() == original
    benchmark.check_protocol(tmp_path)
    path.write_text('{"ids": []}')
    with pytest.raises(ValueError, match="conflicts"):
        benchmark.check_protocol(tmp_path)


def test_freeze_is_required_and_modified_artifacts_rejected(benchmark, tmp_path):
    benchmark.write_once(tmp_path / "protocol.json", benchmark.protocol())
    benchmark.write_once(tmp_path / "dataset-manifest.json", {})
    run = tmp_path / "run"
    run.mkdir()
    with pytest.raises(FileNotFoundError):
        benchmark.verify_frozen(tmp_path, run)
    path = run / "predictions.json"
    path.write_text("{}")
    benchmark.write_once(run / "frozen.json", {
        "predictionsFrozenBeforeLabelParsing": True,
        "protocolSha256": benchmark.sha256(tmp_path / "protocol.json"),
        "datasetManifestSha256": benchmark.sha256(tmp_path / "dataset-manifest.json"),
        "artifacts": {"predictions.json": benchmark.sha256(path)}, "sources": {}, "models": {}})
    benchmark.verify_frozen(tmp_path, run)
    path.write_text('{"changed": true}')
    with pytest.raises(ValueError, match="Frozen file changed"):
        benchmark.verify_frozen(tmp_path, run)


def test_quantizers_report_collision_drop_and_preserve_raw(benchmark):
    events = [[.5 + i * .03125, .5 + (i + 1) * .03125, 60 + i % 5, .9] for i in range(8)]
    result = benchmark.quantized_variants(events, {"bpm": 120., "offsetSeconds": 0.}, 2.)
    assert result["raw"]["events"] == events
    assert result["joint_rhythm"]["outputNotes"] == 8
    assert result["joint_rhythm"]["droppedNotes"] == 0
    assert result["legacy_grid"]["droppedNotes"] > 0
    assert result["legacy_grid"]["maximumOnsetShiftSeconds"] is None


def test_legacy_baseline_matches_production_32nd_grid(benchmark):
    from server.rhythm import quantize_on_grid
    events = [[.5 + i * .0625, .5 + (i + 1) * .0625, 60 + i % 5, .9] for i in range(8)]
    grid = {"bpm": 120., "offsetSeconds": 0.}
    result = benchmark.quantized_variants(events, grid, 2.)["legacy_grid"]
    expected = benchmark.notes_to_events(quantize_on_grid(events, grid, 2., "vocals", monophonic=True, quantum=.125), grid)
    assert result["events"] == expected
    assert result["outputNotes"] == 8 and result["droppedNotes"] == 0
    assert result["maximumOnsetShiftSeconds"] == 0.
    assert benchmark.protocol()["legacyQuantizer"]["quantumBeats"] == .125
    assert len(quantize_on_grid(events, grid, 2., "vocals", monophonic=True, quantum=.25)) < 8


def test_score_reads_only_frozen_synthetic_predictions_and_keeps_reports_private(benchmark, tmp_path):
    benchmark.write_once(tmp_path / "protocol.json", benchmark.protocol())
    dataset = tmp_path / "dataset"
    dataset.mkdir()
    manifest, tracks = {}, {}
    for identifier in benchmark.IDS:
        label = dataset / f"{identifier}.txt"
        label.write_text("0.2\t0.6\t67.85\n")
        manifest[label.name] = {"sha256": benchmark.sha256(label)}
        tracks[identifier] = {"durationSeconds": 1., "grid": {"bpm": 120., "offsetSeconds": 0.},
                              "runtimeSeconds": .1, "f0RuntimeSeconds": .05,
                              "variants": {"fake/raw": {"events": [[.2, .6, 67.85, .9]],
                                                       "inputNotes": 1, "outputNotes": 1, "droppedNotes": 0}}}
    benchmark.write_once(tmp_path / "dataset-manifest.json", {"files": manifest})
    run = tmp_path / "runs/fake"
    benchmark.write_once(run / "predictions.json", {"pitchUnit": "midi", "tracks": tracks})
    benchmark.write_once(run / "frozen.json", {
        "predictionsFrozenBeforeLabelParsing": True, "versions": {},
        "protocolSha256": benchmark.sha256(tmp_path / "protocol.json"),
        "datasetManifestSha256": benchmark.sha256(tmp_path / "dataset-manifest.json"),
        "artifacts": {"predictions.json": benchmark.sha256(run / "predictions.json")}, "sources": {}, "models": {}})
    benchmark.score(tmp_path, "fake")
    report = benchmark.read_json(run / "scores.json")
    assert report["aggregate"]["fake/raw"]["onsetOffsetPitch"]["matchedNotes"] == 8
    assert report["aggregate"]["fake/raw"]["onsetOffsetPitch"]["microF1"] == 1.
    assert report["perTrack"][benchmark.IDS[0]]["runtimeSeconds"] == .1


def test_splits_have_pinned_disjoint_audio_and_label_metadata(benchmark):
    assert set(benchmark.DIAGNOSTIC_IDS).isdisjoint(benchmark.VALIDATION_IDS)
    assert benchmark.VALIDATION_IDS == ("101550", "101552", "101666", "101696", "101697", "101763", "101806", "101813")
    assert benchmark.VALIDATION_FILES["101550.flac"] == (1375135, "7a473ed4ca95b9fa550a1e2a713e6bef780a9f9e")
    assert benchmark.VALIDATION_FILES["101813.txt"] == (601, "252f1f505b276388a2de726c5872dbe047225ada")
    assert set(benchmark.VALIDATION_FILES) == {f"{identifier}.{suffix}" for identifier in benchmark.VALIDATION_IDS for suffix in ("flac", "txt")}
    for size, blob in benchmark.VALIDATION_FILES.values():
        assert size > 0 and len(blob) == 40
    original = benchmark.protocol()
    canonical = json.dumps(original, sort_keys=True, separators=(",", ":")).encode()
    assert hashlib.sha256(canonical).hexdigest() == "34adb5dc8fcbeb5c0c5588e66218038e72fe61710075bb86041ebb5caba0fa6e"
    root = benchmark.PRIVATE
    benchmark.configure_split("validation")
    assert benchmark.PRIVATE == root / "validation"
    assert benchmark.IDS == benchmark.VALIDATION_IDS
    assert benchmark.protocol()["evaluationSplit"] == "validation"
    assert benchmark.protocol()["boundedQuantizer"]["timingToleranceSeconds"] == .025
    assert benchmark.protocol()["legacyQuantizer"]["quantumBeats"] == .125
    benchmark.configure_split("diagnostic")
    assert benchmark.PRIVATE == root / "bounded-diagnostic"
    benchmark.configure_split("diagnostic", bounded=False)
    assert benchmark.PRIVATE == root and benchmark.protocol() == original
    with pytest.raises(ValueError, match="legacy protocol"):
        benchmark.configure_split("validation", bounded=False)


def test_bounded_variant_calls_explicit_limit_and_keeps_unbounded_comparison(benchmark, monkeypatch):
    import server.vocal_score as score
    calls = []
    original = score.quantize_vocal_rhythm

    def observed(events, grid, duration, **kwargs):
        calls.append(kwargs)
        # This harness test checks wiring. Server tests own numeric bound behavior.
        return original(events, grid, duration)

    monkeypatch.setattr(score, "quantize_vocal_rhythm", observed)
    benchmark.configure_split("validation")
    events = [[.2, .5, 60, .9], [.6, 1., 62, .9]]
    result = benchmark.quantized_variants(events, {"bpm": 120., "offsetSeconds": 0.}, 2.)
    assert calls == [{}, {"timing_tolerance_seconds": .025}]
    assert set(result) == {"raw", "legacy_grid", "joint_rhythm", "bounded_rhythm"}
    assert result["joint_rhythm"]["outputNotes"] == result["bounded_rhythm"]["outputNotes"] == 2

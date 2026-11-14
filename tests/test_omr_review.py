"""Server-side OMR review data (server/omr_review.py) on the public fixtures."""
import json
import re
from pathlib import Path

from server.omr_review import assemble, label_page, page_review, text_issues

FIXTURES = Path(__file__).parent / "fixtures" / "omr-review"


def strip_ids(xml: str) -> str:
    return re.sub(r' id="omr-0-\d+"', "", xml)


def test_label_page_numbers_every_note_in_document_order_and_keeps_anchors():
    raw = strip_ids((FIXTURES / "twinkle" / "homr.musicxml").read_text())
    labelled, count = label_page(raw, 3)
    assert count == 28
    assert re.findall(r'id="(omr-3-\d+)"', labelled) == [f"omr-3-{k}" for k in range(28)]
    assert labelled.count("imgpos") == raw.count("imgpos") == 28


def test_page_review_reports_real_underfull_bars_with_boxes_and_no_confidence():
    folder = FIXTURES / "airds-air"
    review = json.loads((folder / "review.json").read_text())
    assert [(i["kind"], i["measure"]) for i in review["issues"]] == [("measure-underfull", m) for m in (1, 9, 10, 18)]
    assert all("box" in i for i in review["issues"])
    assert all(n["precision"] == "approximate" and n["point"] for n in review["notes"])
    assert "confidence" not in json.dumps(review)
    # Interior measure edges were found on real barlines on this clean page.
    interior = [e for m in review["measures"] for e in m["edges"][1:]][:-1]
    assert interior.count("barline") >= len(interior) - 3


def test_missing_anchor_and_overfull_bar_are_flagged():
    xml = """<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>V</part-name></score-part></part-list><part id="P1">
    <measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes>
    <note id="omr-0-0"><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><!-- imgpos: 120, 50 --></note>
    <note id="omr-0-1"><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration></note></measure></part></score-partwise>"""
    item = page_review(xml, 0, "0 0.5 0.5 0.8 0.2\n", (200, 100), None, None, 1)
    kinds = {i["kind"] for i in item["issues"]}
    assert kinds == {"no-anchor", "measure-overfull"}
    assert next(i for i in item["issues"] if i["kind"] == "no-anchor")["noteRef"] == "omr-0-1"


def test_text_layer_evidence_becomes_check_and_info_issues():
    evidence = {"boxes": [
        {"text": "Copyright 1912", "box": [10, 900, 200, 920], "kind": "discarded", "reason": "outside every staff zone"},
        {"text": "Hel-lo", "box": [100, 130, 160, 140], "kind": "lyric", "attached": [{"syllable": "Hel"}]},
        {"text": "x", "box": [1, 1, 2, 2], "kind": "lyric", "reason": "no singable note aligned"},
    ]}
    issues = text_issues(evidence, 0)
    assert [(i["kind"], i["severity"]) for i in issues] == [("text-discarded", "check"), ("text-attached", "info")]
    assert "Copyright" in issues[0]["message"]


def test_assemble_concatenates_pages_and_caps_sizes():
    one = {"page": {"page": 0, "width": 10, "height": 10, "firstMeasure": 1, "measureCount": 1}, "staves": [], "measures": [], "notes": [], "issues": []}
    review = assemble([one, {**one, "page": {**one["page"], "page": 1, "firstMeasure": 2}}], "homr", [{"kind": "page-part-mismatch", "severity": "check", "page": 1, "message": "m"}])
    assert [p["page"] for p in review["pages"]] == [0, 1] and review["issues"][0]["kind"] == "page-part-mismatch"


def test_barline_must_cross_most_staves_of_a_system_not_one_stem():
    import numpy as np
    from server.omr_review import _barline_columns

    ink = np.zeros((300, 400), dtype=bool)
    ink[20:60, 100] = True            # a stem through staff 1 only
    ink[20:60, 200] = True            # a barline through staves 1 and 2
    ink[120:160, 200] = True
    staves = [(10, 20, 390, 60, False), (10, 120, 390, 160, False)]
    columns = _barline_columns(ink, staves)
    assert 200 in columns and 100 not in columns


def test_recognize_attaches_review_and_writes_ids(tmp_path, monkeypatch):
    import shutil
    from server import omr
    from server.storage import atomic_json

    folder = FIXTURES / "airds-air"
    request = {"id": "a" * 32, "input": "source.png", "filename": "page.png", "first_page": 1, "last_page": None, "engine": "homr"}
    shutil.copyfile(folder / "page-001.png", tmp_path / "source.png")
    atomic_json(tmp_path / "status.json", {"id": "a" * 32, "status": "queued", "progress": 0})
    raw = strip_ids((folder / "homr.musicxml").read_text())

    def fake_run(command, cwd, env, log_path, deadline, status, on_log=None):
        work = tmp_path / "recognized-homr"
        (work / "page-001.musicxml").write_text(raw)
        (work / "page-001.txt").write_text((folder / "staves.txt").read_text())
        return 0

    monkeypatch.setattr(omr, "omr_health", lambda: {"ready": True})
    monkeypatch.setattr(omr, "homr_manifest", lambda: {"version": "test"})
    monkeypatch.setattr(omr, "_run_logged", fake_run)
    monkeypatch.setattr(omr.subprocess, "run", lambda *a, **k: type("R", (), {"returncode": 1, "stdout": ""})())
    omr.recognize(tmp_path, request)
    state = json.loads((tmp_path / "status.json").read_text())
    assert state["musicxml"].count('id="omr-0-') == 84
    review = state["review"]
    assert review["engine"] == "homr" and len(review["notes"]) == 84 and review["pages"][0]["width"] == 2000
    assert (tmp_path / "review.json").is_file()
    assert "review" not in json.loads((tmp_path / "result-evidence.json").read_text())
    # homr's raw page is left untouched; ids live on a copy.
    assert 'id="omr-' not in (tmp_path / "recognized-homr" / "page-001.musicxml").read_text()

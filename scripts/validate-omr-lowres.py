"""Explicit real OMR regression for the reported low-resolution PNG failure.

The recognizer reads only the PNG. Symbolic truth is read afterward by an
independent ElementTree note decoder to score, not to repair, the OMR result.
"""
from __future__ import annotations

from collections import Counter
import hashlib
import json
from pathlib import Path
import shutil
import sys
import time
import uuid
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server.omr import recognize  # noqa: E402
from server.storage import atomic_json  # noqa: E402


def decode_nominal_measures(part: ET.Element) -> list[list[float]]:
    divisions, meter, measure_start = 1, 4.0, 0.0
    result = []
    ties = {}
    steps = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
    for measure in part.findall("measure"):
        attributes = measure.find("attributes")
        if attributes is not None:
            if attributes.find("divisions") is not None:
                divisions = int(attributes.findtext("divisions"))
            if attributes.find("time") is not None:
                meter = int(attributes.findtext("time/beats")) * 4 / int(attributes.findtext("time/beat-type"))
        cursor, last_onset = 0.0, 0.0
        for child in measure:
            if child.tag == "backup":
                cursor -= int(child.findtext("duration", "0")) / divisions
            elif child.tag == "forward":
                cursor += int(child.findtext("duration", "0")) / divisions
            elif child.tag == "note":
                duration = int(child.findtext("duration", "0")) / divisions
                onset = last_onset if child.find("chord") is not None else cursor
                if child.find("chord") is None:
                    last_onset, cursor = cursor, cursor + duration
                pitch = child.find("pitch")
                if pitch is None:
                    continue
                midi = (int(pitch.findtext("octave")) + 1) * 12 + steps[pitch.findtext("step")] + int(pitch.findtext("alter", "0"))
                key = (midi, child.findtext("voice", "1"), child.findtext("staff", "1"))
                tie_types = {tie.get("type") for tie in child.findall("tie")}
                start = measure_start + onset
                previous = ties.get(key)
                if "stop" in tie_types and previous and abs(previous[1] + previous[2] - start) < 0.00001:
                    event = previous
                    event[2] += duration
                else:
                    event = [midi, start, duration]
                    result.append(event)
                if "start" in tie_types:
                    ties[key] = event
                else:
                    ties.pop(key, None)
        # Fixed 4/4 fallback only when OMR omitted the meter; same documented
        # import convention as Coro, not derived from this test's known notes.
        measure_start += meter
    return result


def main() -> None:
    source = ROOT / "evidence/pdf-preview/blue-hour-page1.png"
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    job_id = uuid.uuid4().hex
    directory = ROOT / "data" / "omr" / job_id
    directory.mkdir(parents=True)
    shutil.copyfile(source, directory / "source.png")
    request = {"id": job_id, "filename": source.name, "input": "source.png", "first_page": 1, "last_page": None, "read_text": False}
    atomic_json(directory / "request.json", request)
    atomic_json(directory / "status.json", {"id": job_id, "status": "queued", "progress": 0})
    started = time.monotonic()
    recognize(directory, request)
    state = json.loads((directory / "status.json").read_text())
    assert state["status"] == "complete"
    assert hashlib.sha256(source.read_bytes()).hexdigest() == source_hash
    assert "too low interline value of 8 pixels" in (directory / "omr.log").read_text()
    assert (directory / "omr-retry.log").exists()
    xml = ET.fromstring(state["musicxml"])
    truth = json.loads((ROOT / "evidence/music-roundtrip/original.json").read_text())
    counts = {"reference": 0, "predicted": 0, "matched": 0}
    parts = []
    for actual_part, expected_part in zip(xml.findall("part"), truth["parts"]):
        if expected_part["role"] == "percussion":
            continue
        expected = Counter((note["midi"], round(note["start"], 5), round(note["duration"], 5)) for note in expected_part["notes"] if note["midi"] is not None and note["start"] < 32)
        actual = Counter(tuple(round(value, 5) for value in event) for event in decode_nominal_measures(actual_part))
        row = {"part": expected_part["name"], "reference": sum(expected.values()), "predicted": sum(actual.values()), "matched": sum((actual & expected).values()), "missing": list((expected - actual).elements()), "extra": list((actual - expected).elements())}
        for key in counts:
            counts[key] += row[key]
        parts.append(row)
    report = {"scope": "Real exact requested PNG regression. Only one engine-evidence-triggered Lanczos retry; no generated or ground-truth notes inserted.", "source": str(source), "sourceSha256": source_hash, "sourceUnchanged": True, "jobId": job_id, "directory": str(directory), "wallSeconds": round(time.monotonic() - started, 3), "counts": counts, "precision": counts["matched"] / counts["predicted"], "recall": counts["matched"] / counts["reference"], "parts": parts, "resampling": state["source"]["resampling"], "warnings": state["warnings"]}
    (ROOT / "evidence/omr-lowres-recheck.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({"jobId": job_id, **counts, "precision": report["precision"], "recall": report["recall"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()

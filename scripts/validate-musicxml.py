"""Independent MusicXML import, not a round trip through our own parser."""
from collections import Counter
from datetime import datetime
from pathlib import Path
import hashlib
import json
import music21

root = Path(__file__).resolve().parents[1]
directory = root / "evidence" / "music-roundtrip"
report = {"reader": f"music21 {music21.__version__}", "scope": "Exact concert pitch/onset/duration of pitched events. Not a singing or transcription accuracy assessment.", "cases": [], "pitchedEvents": 0}
for name in ("original", "satb"):
    project = json.loads((directory / f"{name}.json").read_text())
    xml_path = directory / f"{name}.musicxml"
    parsed = music21.converter.parse(xml_path)
    assert len(parsed.parts) == len(project["parts"])
    checks = []
    for expected_part, imported in zip(project["parts"], parsed.parts):
        if expected_part["role"] == "percussion":
            continue
        expected = Counter((n["midi"], round(n["start"], 5), round(n["duration"], 5)) for n in expected_part["notes"] if n["midi"] is not None)
        actual = Counter()
        for event in imported.stripTies(inPlace=False).flatten().notes:
            if isinstance(event, music21.harmony.ChordSymbol):
                continue
            for pitch in event.pitches:
                actual[(pitch.midi, round(float(event.offset), 5), round(float(event.duration.quarterLength), 5))] += 1
        passed = expected == actual
        checks.append({"part": expected_part["name"], "expected": sum(expected.values()), "parsed": sum(actual.values()), "passed": passed, "missing": list((expected - actual).elements())[:10], "extra": list((actual - expected).elements())[:10]})
        report["pitchedEvents"] += sum(expected.values())
        assert passed, checks[-1]
    report["cases"].append({"case": name, "sha256": hashlib.sha256(xml_path.read_bytes()).hexdigest(), "checks": checks})
report["passed"] = True
(root / "evidence" / "independent-musicxml-validation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
print(json.dumps({"reader": report["reader"], "pitchedEvents": report["pitchedEvents"], "passed": True}, ensure_ascii=False))

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server.harmony import VERSION, extract_acoustic_features, file_sha256, infer_audio_harmony
from server.harmony_fixtures import build_fixture


def main():
    output = ROOT / "data/phase3/harmony-fixtures"
    cases = []
    for name, held_out, sampled in [("development-synthetic", False, False), ("development-piano", False, True), ("heldout-synthetic", True, False), ("heldout-guitar", True, True)]:
        directory = output / name
        truth = build_fixture(directory, held_out=held_out, sampled=sampled, conflicting_melody=True)
        started = time.monotonic()
        features = extract_acoustic_features({"piano": directory / "piano.wav", "bass": directory / "bass.wav"}, output=directory)
        result = infer_audio_harmony(features, truth["bpm"], truth["offsetSeconds"], beats_per_window=2, output=directory)
        correct = top3 = total = wrong_candidate = no_evidence = correct_no_evidence = 0
        errors = []
        for segment in result["segments"]:
            expected = next(note for note in truth["notes"] if note["startSeconds"] <= (segment["sourceStartSeconds"] + segment["sourceEndSeconds"]) / 2 < note["endSeconds"])
            exact = segment["symbol"] == expected["expectedSymbol"]
            alternate = exact or expected["expectedSymbol"] in [candidate["symbol"] for candidate in segment["candidates"][:3]]
            wrong_candidate += not exact and segment["status"] == "candidate"
            no_evidence += segment["symbol"] == "N"
            correct_no_evidence += segment["symbol"] == "N" and expected["expectedSymbol"] == "N"
            correct += exact
            top3 += alternate
            total += 1
            if not exact:
                errors.append({"expected": expected["expectedSymbol"], "predicted": segment["symbol"], "sourceStartSeconds": segment["sourceStartSeconds"], "candidates": [candidate["symbol"] for candidate in segment["candidates"][:3]], "status": segment["status"], "chroma": segment["evidence"]["chroma"]})
        row = {"fixture": name, "windows": total, "top1Correct": correct, "top3ContainsExpected": top3, "top1AccuracyOnConstructedFixture": round(correct / total, 4), "top3RecallOnConstructedFixture": round(top3 / total, 4), "wrongTop1WithCandidateStatus": wrong_candidate, "predictedNoEvidenceWindows": no_evidence, "correctNoEvidenceWindows": correct_no_evidence, "runtimeSeconds": round(time.monotonic() - started, 3), "errors": errors, "truth": str(directory / "truth.json"), "result": str(directory / "harmony-candidates.json")}
        cases.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
    report = {"version": VERSION, "codeSha256": file_sha256(ROOT / "server/harmony.py"), "validationLimits": "Authored labels and explicit played pitches are independent of inference templates, but simple sustained tones favor template recognition. Low-level template unit tests are implementation checks, not accuracy evidence. Heldout examples were inspected in earlier baseline, so are not a blind benchmark. Wrong candidate-status counts expose uncalibrated certainty.", "scope": "Independent explicitly authored fixture truth, not commercial-song chord accuracy. Four synthetic/sampled progressions include inversions,7ths,sus,dim,noise,silence and excluded conflicting lead. No production chord-vocabulary import in generator.", "cases": cases}
    target = ROOT / "evidence/phase3/harmony-fixtures.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()

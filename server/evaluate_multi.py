"""Independent detailed scoring of saved multi-instrument validation artifacts."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from scipy.optimize import linear_sum_assignment

from .config import ROOT


def score(reference: list[dict], predicted: list[dict], tolerance: float, pitch_class: bool = False) -> dict:
    cost = np.full((len(reference), len(predicted)), 1e6)
    for i, ref in enumerate(reference):
        for j, pred in enumerate(predicted):
            pitch_match = (ref["midi"] - pred["midi"]) % 12 == 0 if pitch_class else ref["midi"] == pred["midi"]
            delta = abs(ref["start"] - pred["start"])
            if pitch_match and delta <= tolerance:
                cost[i, j] = delta + (0.001 if ref["midi"] != pred["midi"] else 0)
    rows, cols = linear_sum_assignment(cost)
    matches = [(i, j) for i, j in zip(rows, cols) if cost[i, j] < 1e5]
    count = len(matches)
    precision = count / max(1, len(predicted))
    recall = count / max(1, len(reference))
    return {"reference": len(reference), "predicted": len(predicted), "matches": count, "precision": round(precision, 4), "recall": round(recall, 4), "f1": round(2 * precision * recall / max(1e-9, precision + recall), 4), "pitchClassOnly": pitch_class, "onsetToleranceSeconds": tolerance, "octaveErrorsAmongPitchClassMatches": [{"start": reference[i]["start"], "expectedMidi": reference[i]["midi"], "predictedMidi": predicted[j]["midi"], "differenceSemitones": predicted[j]["midi"] - reference[i]["midi"]} for i, j in matches if reference[i]["midi"] != predicted[j]["midi"]]}


def main() -> None:
    report = json.loads((ROOT / "evidence" / "yourmt3-validation.json").read_text())
    root = Path(report["dataDirectory"])
    rows = []
    mapping = {"flute": "pipes", "violin": "strings", "cello": "strings"}
    for case in report["results"]:
        project = json.loads((root / case["jobId"] / "verified-project.json").read_text())
        source = json.loads((ROOT / "data" / "fixtures" / f"{case['fixture']}.truth.json").read_text())
        truth = source["notes"]
        groups = {}
        for note in truth:
            family = mapping.get(note["part"], note["part"])
            groups.setdefault(family, []).append(note)
        predicted = {part["id"]: [{"midi": n["midi"], "start": n["start"] * 60 / project["tempo"]} for n in part["notes"]] for part in project["parts"]}
        per_family = {}
        for family in groups.keys() | predicted.keys():
            ref, pred = groups.get(family, []), predicted.get(family, [])
            per_family[family] = {"exact50ms": score(ref, pred, .05), "exact125ms": score(ref, pred, .125), "pitchClass125ms": score(ref, pred, .125, pitch_class=True)}
        rows.append({"fixture": case["fixture"], "mode": case["mode"], "jobId": case["jobId"], "perFamily": per_family})
    final = {"scope": "Independent held-out family-aware scoring. Strings combines violin/cello; cannot measure exact individual identity in this vocabulary. Drum metric requires exact GM pitch. No filtering or model parameter tuning on the held-out test.", "results": rows}
    (ROOT / "evidence" / "yourmt3-detailed-metrics.json").write_text(json.dumps(final, ensure_ascii=False, indent=2) + "\n")
    for row in rows:
        print(row["fixture"], row["mode"])
        for family, metrics in row["perFamily"].items():
            print(" ", family, metrics["exact125ms"], flush=True)


if __name__ == "__main__":
    main()

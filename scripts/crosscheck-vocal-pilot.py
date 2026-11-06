"""Independent resampling plus mir_eval; does not import the primary checker."""
from pathlib import Path
import json

import mir_eval
import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]


def sample_track(times, frequencies, query, voice=None):
    pitch = np.abs(np.nan_to_num(frequencies, nan=0))
    voiced = frequencies > 0 if voice is None else voice
    hop = np.median(np.diff(times))
    after = np.clip(np.searchsorted(times, query), 0, len(times) - 1)
    before = np.maximum(0, after - 1)
    # Ties belong to the later sample's cell.
    nearest = np.where(np.round(abs(query - times[before]), 12) < np.round(abs(query - times[after]), 12), before, after)
    result = pitch[nearest].copy()
    outside = abs(times[nearest] - query) > hop / 2 + 1e-10
    result[outside] = 0
    interpolate = ((before != after) & (times[after] - times[before] <= 1.5 * hop + 1e-12)
                   & (pitch[before] > 0) & (pitch[after] > 0) & (query >= times[before]))
    weight = (query[interpolate] - times[before[interpolate]]) / (times[after[interpolate]] - times[before[interpolate]])
    result[interpolate] = np.exp(np.log(pitch[before[interpolate]]) * (1 - weight) + np.log(pitch[after[interpolate]]) * weight)
    return result, voiced[nearest] & (result > 0)


def main():
    protocol = json.loads((ROOT / "evidence/phase4/vocadito-protocol.json").read_text())
    predictions = json.loads((ROOT / "data/phase4/vocadito-pilot/predictions.json").read_text())["models"]
    dataset = ROOT / "data/benchmarks/vocadito"
    rows = []
    for engine, tracks in predictions.items():
        for identifier in protocol["pilotIds"]:
            duration = sf.info(dataset / "Audio" / f"vocadito_{identifier}.wav").duration
            grid = np.round(np.arange(0, duration, .01), 12)
            reference = np.loadtxt(dataset / "Annotations/F0" / f"vocadito_{identifier}_f0.csv", delimiter=",")
            ref, rv = sample_track(reference[:, 0], reference[:, 1], grid)
            with np.load(tracks[identifier]["f0"], allow_pickle=False) as stored:
                est, ev = sample_track(stored["time"], stored["f0"], grid, stored["voicing"])
            rc, ec = mir_eval.melody.hz2cents(ref), mir_eval.melody.hz2cents(est)
            recall, false_alarm = mir_eval.melody.voicing_measures(rv, ev)
            f0 = {"overallAccuracy": mir_eval.melody.overall_accuracy(rv, rc, ev, ec),
                  "voicingRecall": recall, "voicingFalseAlarm": false_alarm,
                  "rawPitchAccuracy": mir_eval.melody.raw_pitch_accuracy(rv, rc, ev, ec),
                  "rawChromaAccuracy": mir_eval.melody.raw_chroma_accuracy(rv, rc, ev, ec)}
            events = np.array(json.loads(Path(tracks[identifier]["notes"]).read_text())["events"])
            intervals, pitches = events[:, :2], 440 * 2 ** ((events[:, 2] - 69) / 12)
            notes = {}
            for annotator in ("A1", "A2"):
                source = np.loadtxt(dataset / "Annotations/Notes" / f"vocadito_{identifier}_notes{annotator}.csv", delimiter=",")
                ri = np.column_stack([source[:, 0], source[:, 0] + source[:, 2]])
                notes[annotator] = {}
                for name, ratio in [("onsetPitch", None), ("onsetOffsetPitch", .2)]:
                    matched = mir_eval.transcription.match_notes(ri, source[:, 1], intervals, pitches, offset_ratio=ratio)
                    notes[annotator][name] = {"matchedNotes": len(matched), "referenceNotes": len(source),
                                            "estimatedNotes": len(events), "f1": 2 * len(matched) / (len(source) + len(events))}
            rows.append({"engine": engine, "id": identifier, "f0": f0, "notes": notes})
    report = {"method": "Independent nearest-cell/gap-safe log interpolation and mir_eval", "mirEvalVersion": mir_eval.__version__,
              "scope": "8 predeclared unaccompanied-singing pilot recordings, not separated commercial mixtures",
              "rows": rows, "macro": {engine: {
                  "f0": {key: float(np.mean([r["f0"][key] for r in rows if r["engine"] == engine])) for key in rows[0]["f0"]},
                  "notes": {a: {mode: float(np.mean([r["notes"][a][mode]["f1"] for r in rows if r["engine"] == engine])) for mode in ("onsetPitch", "onsetOffsetPitch")} for a in ("A1", "A2")}
              } for engine in predictions}}
    (ROOT / "evidence/phase4/vocadito-independent.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report["macro"], indent=2))


if __name__ == "__main__":
    main()

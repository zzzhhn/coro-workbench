"""Full-length independent lead pitch audit; never rewrites predicted notes."""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np


def merge_spans(spans: list[dict]) -> list[dict]:
    result = []
    for span in sorted(spans, key=lambda item: item["startSeconds"]):
        if result and span["startSeconds"] <= result[-1]["endSeconds"] + .05 and span["reason"] == result[-1]["reason"]:
            result[-1]["endSeconds"] = max(result[-1]["endSeconds"], span["endSeconds"])
        else:
            result.append(dict(span))
    return result


def main() -> None:
    import librosa
    import soundfile as sf
    import torch
    import torchcrepe
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True, type=Path)
    parser.add_argument("--fcpe", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    audio, sr = sf.read(args.audio, dtype="float32", always_2d=True)
    y = librosa.resample(audio.mean(axis=1), orig_sr=sr, target_sr=16000)
    torch.set_num_threads(4)
    duration = len(y) / 16000
    started = time.monotonic()
    records = []
    for start in np.arange(0, duration, 16):
        stop = min(duration, start + 16)
        left, right = max(0., start - .3), min(duration, stop + .3)
        chunk = y[round(left * 16000):round(right * 16000)]
        with torch.inference_mode():
            pitch, period = torchcrepe.predict(torch.from_numpy(chunk)[None], 16000, 320, 55, 1100, "full", batch_size=256, device="cpu", return_periodicity=True, pad=True)
        times = left + np.arange(pitch.shape[-1]) * .02
        valid = (times >= start - .000001) & (times < stop - .000001)
        records.append((times[valid], pitch.numpy().reshape(-1)[valid], period.numpy().reshape(-1)[valid]))
        progress = {"doneSeconds": round(stop, 3), "durationSeconds": round(duration, 3), "runtimeSeconds": round(time.monotonic() - started, 2)}
        temporary = args.output / "progress.tmp"
        temporary.write_text(json.dumps(progress))
        temporary.replace(args.output / "progress.json")
    times = np.concatenate([r[0] for r in records])
    pitch = np.concatenate([r[1] for r in records])
    periodicity = np.concatenate([r[2] for r in records])
    fcpe = np.load(args.fcpe)
    f0 = np.interp(times, fcpe["time"], fcpe["f0"])
    activation = np.interp(times, fcpe["time"], fcpe["activation"])
    rms = librosa.feature.rms(y=y, frame_length=640, hop_length=320, center=True)[0]
    energy = np.interp(times, np.arange(len(rms)) * .02, rms)
    audible = energy >= max(1e-4, float(np.quantile(energy, .95)) * .015)
    fcpe_voiced = (f0 > 55) & (activation >= .03) & audible
    crepe_voiced = (periodicity >= .3) & audible
    joint = fcpe_voiced & crepe_voiced
    difference = np.zeros(len(times))
    difference[joint] = np.abs(12 * np.log2(pitch[joint] / f0[joint]))
    severe = joint & (difference > 6)
    precise = joint & (difference <= .5)
    spans = []
    unverified = []
    for start in np.arange(0, duration, .25):
        end = min(duration, start + 1)
        window = (times >= start) & (times < end)
        joint_count = int(np.sum(joint & window))
        if joint_count >= 15 and np.sum(severe & window) / joint_count > .25:
            spans.append({"partId": "vocals", "startSeconds": round(float(start), 3), "endSeconds": round(float(end), 3), "reason": "Dense CREPE/FCPE audit: >25% of jointly voiced frames differ by >6 semitones in a1s window", "alternatives": ["KARA2 lead FCPE proposal retained", "full-length CREPE lead contour in evidence", "original polyphonic candidates"]})
        fcpe_count = int(np.sum(fcpe_voiced & window))
        if fcpe_count >= 15 and joint_count / fcpe_count < .5:
            unverified.append({"startSeconds": round(float(start), 3), "endSeconds": round(float(end), 3), "reason": "FCPE voiced but CREPE periodicity insufficient; pitch identity unverified, not scored as agreement"})
    np.savez_compressed(args.output / "contours.npz", time=times, fcpeF0=f0, crepeF0=pitch, periodicity=periodicity, activation=activation, audible=audible, jointVoiced=joint)
    report = {"method": "Full-length CREPE full model Viterbi at20ms on KARA2 lead, independent of FCPE; no note replacement", "durationSeconds": round(duration, 3), "processedSeconds": round(float(len(times) * .02), 3), "runtimeSeconds": round(time.monotonic() - started, 3), "jointVoicedSeconds": round(float(joint.sum() * .02), 3), "fcpeVoicedSeconds": round(float(fcpe_voiced.sum() * .02), 3), "crepeVoicedSeconds": round(float(crepe_voiced.sum() * .02), 3), "unvoicedOrLowEvidenceSeconds": round(float((~joint).sum() * .02), 3), "within50CentsOnJointVoiced": round(float(precise.sum() / max(1, joint.sum())), 5), "over6SemitonesOnJointVoiced": round(float(severe.sum() / max(1, joint.sum())), 5), "uncertaintyIntervals": merge_spans(spans), "lowPeriodicityIntervals": merge_spans(unverified), "scope": "Agreement between independent models is not ground truth or human singing acceptance. Low-periodicity/unvoiced frames excluded from pitch success. Severe regions annotated; original note proposal unchanged.", "contourFile": str((args.output / "contours.npz").resolve()), "thresholds": {"periodicity": .3, "fcpeActivation": .03, "windowSeconds": 1, "stepSeconds": .25, "minimumJointFrames": 15, "severeFraction": .25, "severeSemitones": 6}}
    (args.output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()

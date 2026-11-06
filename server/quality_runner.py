"""Isolated role-specific models; never downloads models during inference."""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
import torch


def mono_audio(path: Path, sample_rate: int = 16000) -> tuple[np.ndarray, int]:
    audio, sr = sf.read(path, dtype="float32", always_2d=True)
    mono = audio.mean(axis=1)
    if sr != sample_rate:
        mono = librosa.resample(mono, orig_sr=sr, target_sr=sample_rate)
    maximum = max(1.0, float(np.max(np.abs(mono))))
    return (mono / maximum).astype(np.float32), sample_rate


def extract_f0(path: Path, output: Path, model) -> dict:
    audio, sr = mono_audio(path)
    hop = model.get_hop_size_ms() / 1000
    all_times, frequency, activation = [], [], []
    # Context overlap avoids stitching a fresh extra frame every 30 seconds.
    core = 20 * sr
    context = sr
    for start in range(0, len(audio), core):
        end = min(len(audio), start + core)
        left, right = max(0, start - context), min(len(audio), end + context)
        waveform = torch.from_numpy(audio[left:right])[None, :, None]
        with torch.inference_mode():
            mel = model.wav2mel(waveform, sr)
            latent = model.model(mel)
            cents = model.model.latent2cents_local_decoder(latent, threshold=.006)
            f0 = model.model.cent_to_f0(cents).reshape(-1).cpu().numpy()
            strength = latent.max(-1)[0].reshape(-1).cpu().numpy()
        times = left / sr + np.arange(len(f0)) * hop
        valid = (times >= start / sr - .00001) & (times < end / sr - .00001)
        all_times.extend(times[valid].tolist())
        frequency.extend(f0[valid].tolist())
        activation.extend(strength[valid].tolist())
    np.savez_compressed(output, time=all_times, f0=frequency, activation=activation)
    return {"frames": len(frequency), "hopSeconds": hop, "rawContour": output.name, "model": "FCPE bundled fcpe_c_v001 / torchfcpe0.0.4"}


def verify_dominant_voice(path: Path, contour_path: Path, output: Path) -> dict:
    """Independent short-window pitch checks; disagreement triggers abstention, not pitch correction."""
    try:
        import torchcrepe
    except ImportError:
        result = {"available": False, "abstain": True, "reason": "Independent CREPE verifier not installed; raw vocal track retained"}
        output.write_text(json.dumps(result), encoding="utf-8")
        return result
    audio, sr = mono_audio(path)
    contour = np.load(contour_path)
    voiced = (contour["f0"] > 55) & (contour["activation"] >= .03)
    length = len(audio) / sr
    window = min(3.0, length)
    starts = []
    # One strongest-voiced 3s candidate per third, independent of song identity/held-out metrics.
    for section in range(3):
        lower, upper = section * length / 3, (section + 1) * length / 3
        candidates = np.arange(lower, max(lower + .01, upper - window), max(1., window / 2))
        scored = []
        for start in candidates:
            mask = (contour["time"] >= start) & (contour["time"] < start + window)
            score = float(np.mean(voiced[mask])) if mask.any() else 0
            if score >= .5:
                scored.append((score, float(start)))
        if scored:
            starts.append(max(scored)[1])
    rows = []
    for start in starts:
        segment = audio[round(start * sr):round((start + window) * sr)]
        with torch.inference_mode():
            pitch, periodicity = torchcrepe.predict(torch.from_numpy(segment)[None], sr, 320, 55, 1100, "full", batch_size=256, device="cpu", return_periodicity=True, pad=True)
        pitch = pitch.numpy().reshape(-1)
        periodicity = periodicity.numpy().reshape(-1)
        times = start + np.arange(len(pitch)) * .02
        f0 = np.interp(times, contour["time"], contour["f0"])
        activation = np.interp(times, contour["time"], contour["activation"])
        reliable = (periodicity >= .3) & (f0 > 55) & (activation >= .03)
        difference = np.abs(12 * np.log2(pitch[reliable] / f0[reliable]))
        row = {"startSeconds": round(start, 3), "durationSeconds": window, "comparedFrames": int(reliable.sum()), "within50Cents": float(np.mean(difference <= .5)) if len(difference) else None, "over6Semitones": float(np.mean(difference > 6)) if len(difference) else None}
        rows.append(row)
        np.savez_compressed(output.parent / f"voice-check-{start:.3f}.npz", time=times, crepeF0=pitch, periodicity=periodicity, fcpeF0=f0)
    severe = [row for row in rows if row["comparedFrames"] >= 40 and row["over6Semitones"] > .25]
    insufficient = not any(row["comparedFrames"] >= 40 for row in rows)
    result = {"available": True, "abstain": bool(severe or insufficient), "method": "CREPE full Viterbi; three data-independent voiced-window samples; model agreement is not ground truth", "threshold": {"minimumComparedFrames": 40, "severeOctaveFraction": .25, "periodicity": .3}, "intervals": rows, "reason": "Severe octave/voice disagreement" if severe else "Insufficient independently voiced evidence" if insufficient else "No severe disagreement in sampled windows; unsampled passages remain unverified"}
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--models", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--skip-voice-verification", action="store_true", help="Extract a new input's FCPE contour without claiming an independent CREPE check")
    args = parser.parse_args()
    inputs = json.loads(Path(args.input).read_text())
    models = Path(args.models).resolve()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(4)
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", WANDB_MODE="disabled")
    started = time.monotonic()
    evidence = {"engines": {}, "errors": {}}
    if args.verify_only:
        if inputs.get("vocals") and (output / "vocals-fcpe.npz").exists():
            print(json.dumps(verify_dominant_voice(Path(inputs["vocals"]), output / "vocals-fcpe.npz", output / "voice-check.json")), flush=True)
        return
    if inputs.get("audio"):
        from beat_this.inference import File2Beats
        checkpoint = models / "beat-this-final0.ckpt"
        if not checkpoint.is_file():
            raise RuntimeError("Beat This checkpoint missing; install quality models first")
        tracker = File2Beats(checkpoint_path=str(checkpoint), device="cpu", dbn=False)
        beats, downbeats = tracker(inputs["audio"])
        np.savez_compressed(output / "rhythm.npz", beats=beats, downbeats=downbeats)
        evidence["engines"]["rhythm"] = "Beat This! final0 / beat-this1.0"
    if inputs.get("vocals") or inputs.get("bass"):
        from torchfcpe import spawn_bundled_infer_model
        pitch = spawn_bundled_infer_model(device="cpu")
        for role in ("vocals", "bass"):
            if not inputs.get(role):
                continue
            evidence["engines"][role] = extract_f0(Path(inputs[role]), output / f"{role}-fcpe.npz", pitch)
        if inputs.get("vocals") and not args.skip_voice_verification:
            evidence["engines"]["voiceVerification"] = verify_dominant_voice(Path(inputs["vocals"]), output / "vocals-fcpe.npz", output / "voice-check.json")
    if inputs.get("piano"):
        checkpoint = models / "piano-regression.pth"
        if not checkpoint.is_file() or checkpoint.stat().st_size < 160_000_000:
            evidence["errors"]["piano"] = "Dedicated piano model not installed; baseline preserved"
        else:
            try:
                from piano_transcription_inference import PianoTranscription
                transcriber = PianoTranscription(device="cpu", checkpoint_path=str(checkpoint))
                audio, _ = mono_audio(Path(inputs["piano"]))
                result = transcriber.transcribe(audio, None)
                note_events = []
                frames = result["output_dict"]["reg_onset_output"]
                for note in result["est_note_events"]:
                    position = min(len(frames) - 1, max(0, round(float(note["onset_time"]) * 100)))
                    pitch_index = int(note["midi_note"]) - 21
                    strength = float(np.max(frames[max(0, position - 2):position + 3, pitch_index]))
                    note_events.append([float(note["onset_time"]), float(note["offset_time"]), int(note["midi_note"]), float(note["velocity"]) / 127, strength])
                pedals = [{key: float(value) for key, value in event.items()} for event in result["est_pedal_events"]]
                (output / "piano.json").write_text(json.dumps({"notes": note_events, "pedals": pedals, "noteConfidenceMethod": "regressed onset activation; not calibrated correctness"}), encoding="utf-8")
                np.savez_compressed(output / "piano-activations.npz", **result["output_dict"])
                evidence["engines"]["piano"] = "ByteDance/Qiuqiang Kong note/pedal onset-offset regression CRNN"
            except Exception as error:
                evidence["errors"]["piano"] = f"Dedicated piano model failed: {type(error).__name__}; baseline preserved"
                import traceback
                traceback.print_exc()
    evidence["runtimeSeconds"] = round(time.monotonic() - started, 3)
    (output / "models.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(evidence), flush=True)


if __name__ == "__main__":
    main()

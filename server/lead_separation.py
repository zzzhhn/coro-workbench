"""Optional KARA2 lead/backing probe. Caller must supply an isolated vocal stem."""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import soundfile as sf
import torch


KARA2_SHA256 = "f90e997ad60af6bf25bac77ad02f5e127a564d363a2b60ecb41100cd83e4ba12"


def separate_lead_backing(audio_path: Path, model_path: Path, output_dir: Path, check_cancelled=None) -> dict:
    if hashlib.sha256(model_path.read_bytes()).hexdigest() != KARA2_SHA256:
        raise ValueError("KARA2 checkpoint differs from pinned public model")
    audio, sr = sf.read(audio_path, dtype="float32", always_2d=True)
    if sr != 44100 or audio.shape[1] != 2:
        raise ValueError("KARA2 requires 44100 Hz stereo isolated vocals")
    output_dir.mkdir(parents=True, exist_ok=True)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(model_path), sess_options=options, providers=["CPUExecutionProvider"])
    torch.set_num_threads(4)
    n_fft, hop, frames, bins = 5120, 1024, 256, 2048
    chunk_size = (frames - 1) * hop
    trim = n_fft // 2
    stride = (chunk_size - 2 * trim) // 2
    normalized = audio.T / max(float(np.max(np.abs(audio))), 1e-8)
    peak = max(float(np.max(np.abs(audio))), 1e-8)
    padded = np.pad(normalized, ((0, 0), (trim, chunk_size)), mode="constant")
    output = np.zeros_like(padded)
    weights = np.zeros(padded.shape[-1], dtype=np.float32)
    window = torch.hann_window(n_fft, periodic=True)
    blend = np.hanning(chunk_size - 2 * trim).astype(np.float32)
    started = time.monotonic()
    chunks = 0
    for begin in range(0, len(audio) + trim, stride):
        if check_cancelled:
            check_cancelled()
        chunk = torch.from_numpy(padded[:, begin:begin + chunk_size].copy())
        spectrum = torch.stft(chunk, n_fft=n_fft, hop_length=hop, win_length=n_fft, window=window, center=True, pad_mode="reflect", return_complex=True)
        model_input = torch.stack([spectrum[0].real, spectrum[0].imag, spectrum[1].real, spectrum[1].imag], dim=0)[:, :bins, :].numpy()[None]
        model_input[:, :, :3, :] = 0
        predicted = session.run(["output"], {"input": model_input.astype(np.float32)})[0][0]
        complex_spectrum = np.zeros((2, n_fft // 2 + 1, frames), dtype=np.complex64)
        complex_spectrum[0, :bins] = predicted[0] + 1j * predicted[1]
        complex_spectrum[1, :bins] = predicted[2] + 1j * predicted[3]
        separated = torch.istft(torch.from_numpy(complex_spectrum), n_fft=n_fft, hop_length=hop, win_length=n_fft, window=window, center=True, length=chunk_size).numpy()
        valid = separated[:, trim:-trim]
        output[:, begin + trim:begin + chunk_size - trim] += valid * blend
        weights[begin + trim:begin + chunk_size - trim] += blend
        chunks += 1
    output /= np.maximum(weights, 1e-8)
    backing = output[:, trim:trim + len(audio)] * peak
    lead = audio.T - 1.065 * backing
    sf.write(output_dir / "lead.wav", lead.T, sr, subtype="FLOAT")
    sf.write(output_dir / "backing.wav", backing.T, sr, subtype="FLOAT")
    reconstruction = lead + 1.065 * backing
    error = float(np.sqrt(np.mean((reconstruction - audio.T) ** 2)))
    report = {"model": "UVR KARA2 network (musetric time-band ONNX repack)", "sha256": KARA2_SHA256, "input": str(audio_path), "sampleRate": sr, "samples": len(audio), "runtimeSeconds": round(time.monotonic() - started, 3), "chunks": chunks, "leadRms": float(np.sqrt(np.mean(lead ** 2))), "backingRms": float(np.sqrt(np.mean(backing ** 2))), "compensatedReconstructionRmsError": error, "limitations": "Model-specific lead/backing hypotheses; reconstruction identity is arithmetic, not proof of vocal identity or separation quality."}
    (output_dir / "evidence.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("model")
    parser.add_argument("output")
    args = parser.parse_args()
    print(json.dumps(separate_lead_backing(Path(args.audio), Path(args.model), Path(args.output)), indent=2))

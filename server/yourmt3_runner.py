"""Subprocess adapter for optional, separately installed YourMT3 source and weights."""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import torchaudio


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--progress", required=True)
    cli = parser.parse_args()
    source = Path(cli.source).resolve()
    audio_path = Path(cli.audio).resolve()
    output = Path(cli.output).resolve()
    progress = Path(cli.progress).resolve()
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", WANDB_MODE="disabled", WANDB_SILENT="true")
    os.chdir(source)
    # Upstream uses a namespace named config; do not let our server/config.py shadow it.
    adapter_dir = Path(__file__).resolve().parent
    sys.path = [str(source), str(source / "amt" / "src")] + [p for p in sys.path if Path(p).resolve() != adapter_dir]
    torch.set_num_threads(4)
    torch.manual_seed(0)

    from model_helper import load_model_checkpoint
    from utils.audio import slice_padded_array
    from utils.event2note import merge_zipped_note_events_and_ties_to_notes
    from utils.note2event import mix_notes
    from config.config import shared_cfg

    # No training, logging, cloud callbacks or GPU allocation is needed for local inference.
    shared_cfg["TRAINER"]["accelerator"] = "cpu"
    args = ["mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops@last.ckpt", "-p", "2024", "-tk", "mc13_full_plus_256", "-dec", "multi-t5", "-nl", "26", "-enc", "perceiver-tf", "-sqr", "1", "-ff", "moe", "-wf", "4", "-nmoe", "8", "-kmoe", "2", "-act", "silu", "-epe", "rope", "-rp", "1", "-ac", "spec", "-hop", "300", "-atc", "1", "-pr", "32", "-g", "1", "-w", "0"]
    start = time.monotonic()
    with contextlib.redirect_stdout(io.StringIO()):
        model = load_model_checkpoint(args=args, device="cpu")
    load_seconds = time.monotonic() - start
    waveform, sr = sf.read(audio_path, dtype="float32", always_2d=True)
    audio = torch.from_numpy(waveform.mean(axis=1).copy()).unsqueeze(0)
    audio = torchaudio.functional.resample(audio, sr, model.audio_cfg["sample_rate"])
    segments = slice_padded_array(audio, model.audio_cfg["input_frames"], model.audio_cfg["input_frames"])
    segments = torch.from_numpy(segments.astype("float32")).unsqueeze(1)
    predictions = []
    inference_start = time.monotonic()
    batch_size = 4
    for offset in range(0, len(segments), batch_size):
        with torch.inference_mode():
            result, _ = model.inference_file(bsz=batch_size, audio_segments=segments[offset:offset + batch_size])
        predictions.extend(result)
        temp = progress.with_suffix(".tmp")
        temp.write_text(json.dumps({"done": min(offset + batch_size, len(segments)), "total": len(segments)}), encoding="utf-8")
        temp.replace(progress)
    inference_seconds = time.monotonic() - inference_start
    starts = [model.audio_cfg["input_frames"] * i / model.audio_cfg["sample_rate"] for i in range(len(segments))]
    channels = []
    errors = Counter()
    for channel in range(model.task_manager.num_decoding_channels):
        tokens = [batch[:, channel, :] for batch in predictions]
        zipped, _, token_errors = model.task_manager.detokenize_list_batches(tokens, starts, return_events=True)
        notes, note_errors = merge_zipped_note_events_and_ties_to_notes(zipped)
        channels.append(notes)
        errors += token_errors
        errors += note_errors
    notes = mix_notes(channels)
    events = [{"midi": int(note.pitch), "start": float(note.onset), "end": float(note.offset), "program": int(note.program), "isDrum": bool(note.is_drum)} for note in notes]
    output.write_text(json.dumps({"events": events, "decodeErrors": dict(errors), "loadSeconds": round(load_seconds, 3), "inferenceSeconds": round(inference_seconds, 3), "runtimeSeconds": round(time.monotonic() - start, 3), "numSegments": len(segments), "instrumentVocabulary": "GM_INSTR_EXT_CLASS_PLUS", "confidenceAvailable": False}), encoding="utf-8")
    print(f"YourMT3 local CPU completed: {len(events)} events in {time.monotonic() - start:.2f}s", flush=True)


if __name__ == "__main__":
    main()

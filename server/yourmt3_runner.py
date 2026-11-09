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
    sys.path.append(str(adapter_dir.parent))
    from server.multi_decode import decoder_segment_starts, decoded_note, extend_capped_channels
    torch.set_num_threads(1)
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
    capped_predictions, retries = {}, []
    inference_start = time.monotonic()
    batch_size = 1
    for offset in range(0, len(segments), batch_size):
        with torch.inference_mode():
            result, _ = model.inference_file(bsz=batch_size, audio_segments=segments[offset:offset + batch_size])
            initial = result[0]
            tokenizer = model.task_manager.tokenizer
            if not np.all(np.any(initial == tokenizer.eos_id, axis=-1)):
                # Dense channels can exhaust their 256-token budget. Retry
                # only that segment once, and preserve all completed channels.
                capped_predictions[f'capped_{offset:05d}'] = initial.astype(np.int32)
                extended = model.inference(segments[offset:offset + batch_size], None,
                                           max_token_length=model.max_total_token_length * 2).cpu().numpy()
                result[0], retry = extend_capped_channels(initial, extended, tokenizer.eos_id, tokenizer.pad_id)
                retries.append({'segment': offset, **retry})
        predictions.extend(result)
        temp = progress.with_suffix(".tmp")
        temp.write_text(json.dumps({"done": min(offset + batch_size, len(segments)), "total": len(segments)}), encoding="utf-8")
        temp.replace(progress)
    inference_seconds = time.monotonic() - inference_start
    starts = decoder_segment_starts(len(segments), model.audio_cfg['input_frames'],
                                    model.audio_cfg['sample_rate'], model.task_manager.tokenizer.tps)
    # Keep compact native token evidence so decoding fixes can be replayed
    # without rerunning inference or consulting the reference score.
    token_path = output.with_suffix('.tokens.npz')
    np.savez_compressed(token_path, **{f'batch_{i:05d}': np.asarray(batch, dtype=np.int32)
                                     for i, batch in enumerate(predictions)}, **capped_predictions,
                        starts=np.asarray(starts), input_frames=model.audio_cfg['input_frames'],
                        sample_rate=model.audio_cfg['sample_rate'], tps=model.task_manager.tokenizer.tps)
    channels = []
    channel_events, channel_evidence, channel_by_object = [], [], {}
    errors = Counter()
    for channel in range(model.task_manager.num_decoding_channels):
        tokens = [batch[:, channel, :] for batch in predictions]
        zipped, _, token_errors = model.task_manager.detokenize_list_batches(tokens, starts, return_events=True)
        notes, note_errors = merge_zipped_note_events_and_ties_to_notes(zipped)
        channel_events.extend(decoded_note(note, channel) for note in notes)
        channel_by_object.update({id(note): channel for note in notes})
        missing_eos = [i for i, batch in enumerate(tokens)
                       if not np.any(batch == model.task_manager.tokenizer.eos_id)]
        channel_evidence.append({'channel': channel, 'notes': len(notes),
                                 'tokenErrors': dict(token_errors), 'noteErrors': dict(note_errors),
                                 'segmentsWithoutEos': missing_eos})
        channels.append(notes)
        errors += token_errors
        errors += note_errors
    notes = mix_notes(channels)
    events = [decoded_note(note, channel_by_object[id(note)]) for note in notes]
    output.write_text(json.dumps({"events": events, "decodeErrors": dict(errors),
        "decoderClock": {"version": "shared-token-clock-1", "ticksPerSecond": model.task_manager.tokenizer.tps,
                         "segmentStartsSeconds": starts},
        "channelEvents": channel_events, "channelEvidence": channel_evidence,
        "tokenBudgetRetries": retries,
        "crossChannelDiscardedEvents": len(channel_events) - len(events), "nativeTokenFile": token_path.name,
        "loadSeconds": round(load_seconds, 3), "inferenceSeconds": round(inference_seconds, 3), "runtimeSeconds": round(time.monotonic() - start, 3), "numSegments": len(segments), "instrumentVocabulary": "MT3_FULL_PLUS", "cpuThreads": 1, "batchSize": batch_size, "confidenceAvailable": False}), encoding="utf-8")
    print(f"YourMT3 local CPU completed: {len(events)} events in {time.monotonic() - start:.2f}s", flush=True)


if __name__ == "__main__":
    main()

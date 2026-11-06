# Optional enhanced full-vocals separation

Mel-Band-RoFormer (Kimberley Jensen weights) is an optional local full-vocals source. It separates vocals from instrumental and may retain harmonies/backing. It does not identify the main singer or establish transcription accuracy. Selecting it must create a separate source/result and preserve existing edits.

## Install

From the repository root:

```sh
bash scripts/setup-melband.sh
```

`uv`, `git`, and `curl` are required. Setup creates `models/melband-roformer/.venv`, installs pinned runtime requirements there, checks out author source revision `25f44ffb55ee3c301281bba21b2d6d311cb69ae2`, applies the reviewed small CPU/MPS autocast patch, and downloads the author checkpoint from a pinned Hugging Face revision. It never upgrades the app Python environment. About 1 GB of weights plus the isolated Python environment is needed. After setup, inference is offline.

The supplied dependency pins were validated on macOS Apple Silicon with
Python3.11. Installation on Intel macOS, Linux or Windows has not been validated.

Checkpoint: 913106900 bytes, SHA256 `87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e`. This was checked against the author HF LFS hash. Runtime health checks the checkpoint and author YAML before every request (digest cache keys include file size/mtime/ctime).

Author model source: https://github.com/KimberleyJensen/Mel-Band-Roformer-Vocal-Model

Author weights: https://huggingface.co/KimberleyJSN/melbandroformer

Training framework's author-model listing: https://github.com/ZFTurbo/Music-Source-Separation-Training/blob/main/docs/pretrained_models.md

## API and boundaries

```python
from pathlib import Path
from server.melband import runtime_health, separate_vocals

assert runtime_health()['ready']
result = separate_vocals(Path('/absolute/local/source.wav'),
                         Path('/absolute/new/output'),
                         device='auto', timeout_seconds=1800,
                         cancel_check=None)
# result['paths']['vocals'], result['paths']['instrumental']
```

The wrapper isolates all heavy model imports in a subprocess, reaps it on cancellation/timeout, rejects output aliases that overwrite the input, verifies the source SHA256 before/after, and checks output frames/sample rate/channel count. Use mono/stereo local audio. Non-44100 Hz inputs are resampled for the model and restored to the input sample count/rate. Outputs are FLOAT WAV with no normalization or clipping; values above 1 are preserved. The instrumental is the arithmetic residual, so reconstruction alone proves no source quality.

The whole input timeline is preserved: input/output start 0, end `frames/sampleRate`. A caller using a crop must retain the crop's parent source offset. No onset delay, beat snapping, pitch change, note pruning or source-file rewrite occurs.

`device='auto'` selects MPS when available; an MPS RuntimeError/NotImplementedError is reported and retried on CPU. `device='cpu'` explicitly requests CPU. `device='mps'` fails instead of silently switching devices. The actual used device and fallback reason are in `separation.json`. CPU support has a real synthetic mono 16 kHz resampling smoke; this is not a full-song CPU speed/quality test. The automatic MPS-failure path is implemented but has not been induced on this machine. Check `runtime_health()['localValidation']` for this installation's recorded actual runs.

## Local evidence and limitations

Two actual 20 s commercial-song clips completed MPS inference in 8.80/7.55 s (excluding process startup); source files were read-only. The full 178.02449-second Attention source completed through the wrapper on MPS in 64.2547 seconds (model 60.5203 seconds). All 7850880 stereo 44100 Hz frames were preserved; the source SHA256 stayed unchanged. Peak 1.2904 was retained in FLOAT output. A synthetic 0.5-second mono 16000 Hz CPU smoke also restored its original 8000-frame mono output (model 5.1769 seconds, wrapper 20.5467 seconds including startup). Reports stay in local ignored evidence. Unit coverage checks cancellation/timeout cleanup, source/output aliases, runtime weight tampering, source preservation, output timing, and float headroom.

Attention 130–150 s changes substantially when KARA2 follows the enhanced fullvocals, while Out of Time 70–90 s changes little. This confirms source-selection sensitivity; it is not evidence that enhanced fullvocals or KARA2 is correct. Keep a selectable alternative, review against source audio, and do not advertise a default accuracy win.

## Distribution

The author HF model metadata declares MIT. The pinned author inference-code checkout has no top-level LICENSE file. This integration does not redistribute that checkout or the weights; they are downloaded locally into the ignored `models/` directory. The app's source installer/wrapper/patch does not settle upstream source redistribution rights. Review the current author terms before bundling upstream code or weights. Recording rights are separate. No commercial song media or generated private evidence belongs in the public repository.

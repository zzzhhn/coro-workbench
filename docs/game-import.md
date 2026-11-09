# GAME Medium in normal audio imports

The normal **多声部总谱 → GAME Medium 人声跟唱谱** upload now sends `decoder=game` to `/api/analyze`. It runs YourMT3+ for instruments, Demucs for the vocal waveform, GAME 1.0.3 Medium (8 steps, thresholds 0.2), FCPE evidence and the shared `singing_pipeline`/`singing_score` notation inference. The separate-stems mode also defaults to GAME. Direct transcription and explicitly selected legacy raw output retain their old engines.

This is fresh inference from uploaded audio. Runtime modules never read private review JSON, MIDI, manual reference scores or song-specific bar numbers. `scripts/build-lyrics-pilot.py` now calls the same acoustic-evidence and score-inference functions as uploads. A failed requested GAME run fails visibly instead of silently returning legacy vocals.

Optional Mandarin LRC input supplies sentence times and lyric text, e.g. `[00:18.20]这一句歌词`. SOFA derives individual syllable boundaries from the actual separated waveform. Each line must be at most 32 seconds and 70 characters; an empty timestamp can end a line before an instrumental interlude. No lyrics means no lyric-conditioned syllable abstraction. It does **not** reproduce the lyric-assisted V3 candidate simply by selecting GAME.

After the lead score is final, each GAME upload also saves raw vocal evidence
that notation never reads (stage `game-align`): `game/syllable-boundary.npz`,
SOFA's text-free phone-boundary posterior over GAME's own chunks, and, only
when LRC was given, `game/align.json`, the official GAME align output over the
SOFA word regions. The outcome is recorded under `vocalEvidence` in
`game/score-evidence.json`; a failure there never fails the upload.

## Local installation

Use the existing audio and quality environments. Register official GAME 1.0.3 Medium ONNX weights and GAME 1.0.3 source with:

Obtain these from the [official GAME releases](https://github.com/openvpi/GAME/releases).
The base `requirements-audio.txt` already pins `onnxruntime==1.20.1`.

```sh
.venv/bin/python scripts/setup-game.py --model /absolute/path/to/GAME-1.0.3-medium-onnx --source /absolute/path/to/GAME-1.0.3
```

The installer links existing assets rather than downloading/copying large weights. Keep their target directories. An alternate installation root can be set with `CORO_GAME_ROOT` (containing `medium/` and `source/`). Model/source licensing still applies to distribution. The optional SOFA route uses the existing pinned `models/sofa-source` and `models/sofa-mandarin` installation plus the main Python runtime's torch, numba, yaml and pypinyin dependencies.

When moving computers, transfer the actual target directories, not just the
`models/game/medium` and `models/game/source` symlinks. Rerun registration with the
new absolute paths. Python virtual environments must be recreated on the new host.

For optional lyric alignment, obtain [SOFA source](https://github.com/qiuqiao/SOFA)
at commit `9549c6a86d16019c817eefe4bb8183405da524cc` under `models/sofa-source`.
A git checkout is checked by revision; a release archive without `.git` is
checked by the SHA-256 of every file the adapter executes
(`SOFA_FILES` in `server/lyrics_alignment.py`). Any other source is rejected.
From its official v1.0.1 release, install the Mandarin singing checkpoint at
`models/sofa-mandarin/pretrained_mandarin_singing/v1.0.0_mandarin_singing.ckpt`,
retaining upstream license and configuration files. The verified extra packages
in the main Python 3.11 environment are `numba==0.68.1`, `PyYAML==6.0.3`, and
`pypinyin==0.55.0`; torch is already pinned by the base audio requirements.
After installation, restart an idle owned backend and inspect `/api/health` for
GAME readiness and `lyricsReady`. A green unrelated engine is not enough.

## Evidence for a new job

- `request.json`: selected decoder and optional lyric input.
- `game/raw.json`: freshly inferred events, source waveform hash, model hashes and settings.
- `game/score-evidence.json`: automatic transformations and their source events.
- `game-raw-project.json`: original GAME timing with the same accompanying parts; downloadable through `/api/projects/{id}/game-raw`.
- `analysis-evidence.json` and final `project.json`: actual engines and final note counts.

Old projects are preserved. Re-upload audio to run the new pipeline. Legacy cached score-rebuild operations are disabled for GAME projects so they cannot replace the new lead with YourMT3/phoneme results.

This integration does not establish musical correctness, eliminate instrumental confusion, or imply that an audio-only upload equals a lyric-assisted candidate. Auditory and score review remain separate from verifying which model ran.

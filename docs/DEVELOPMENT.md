# Development map

## Application

- `src/App.tsx`: separate source/arrangement documents, history, editor and rehearsal.
- `src/lib/types.ts`: canonical note/part/project schema. Time is absolute
  quarter-note beats, not seconds or measure-relative time. Null pitch is a rest.
- `src/lib/music.ts`, `src/lib/engraving.ts`: MusicXML/ABC/MIDI conversion and
  note-to-glyph mappings. The canonical project, not ABC, is the source of truth.
  Independent rhythm voices must not be synchronized to the union of every
  note boundary: this fragments held notes into unreadable chains. Additional
  notation staves represent rhythm layers, not identified performers.
- `src/lib/arrange.ts`, `src/lib/harmonyRhythm.ts`, `src/lib/vocalBreathing.ts`: vocal ranges, voice leading,
  melody adaptation, syllables and physical-time breath planning.
- `src/lib/dynamics.ts`: persistent staff/voice dynamics for playback and audio/MIDI
  export, without writing repeated markings into the canonical score.
- `src/lib/audio.ts`: local sampled playback, score/source transport, loops,
  metronome and offline WAV rendering.
- `src/lib/projectBundle.ts`: portable projects with separate original and
  decoded playback assets, SHA256 verification and IndexedDB restoration.
- `src/components/ScoreView.tsx`: interactive notation and independent phone panning.

## Backend

- `server/game.py`, `server/game_runner.py`: default multi/separate upload vocal
  inference using GAME 1.0.3 Medium, 8 steps. Explicit failure, original events
  and model/input provenance are retained. Optional LRC uses `lyrics_alignment.py`.
- `server/singing_pipeline.py`, `server/singing_evidence.py`, `server/singing_score.py`:
  shared acoustic evidence and notation inference for real uploads and lyric
  review candidates. This path is separate from the older 25 ms vocal quantizer.
  Runtime inference must never read manual reference notes or private candidates.
- `server/app.py`: loopback API, bounded analysis queue and cancellation.
- `server/pipeline.py`: decoding, separation and base transcription.
- `server/multi.py`, `server/yourmt3_runner.py`: optional whole-recording
  multi-instrument inference. Preserve `MT3_FULL_PLUS` classes; the 13 decoder
  channels are not 13 output instrument identities. Do not collapse violin,
  viola and cello or invent separate players of the same instrument class.
- `server/polyphonic_score.py`: polyphonic notation with a 25 ms pitched-boundary
  bound and a local 960-tick collision fallback. One collision must not refine
  an entire song's pitch group. Drum onsets retain the bound; drum durations
  represent hit rhythm, not the decoder's arbitrary 10 ms offset convention.
  There is no short-note filtering or attack deduplication. Multi-mode
  quality refinement starts from native events, never an already-rounded score.
- `scripts/renotate-multi.py`: rebuilds a separate JSON score and audit from
  cached native events without running models or overwriting the old analysis.
- `server/audio_quality.py`: beat alignment, lead/backing proposals, learned vocal
  notes, piano onset evidence and audio-derived harmony.
- `server/rosvot.py`, `server/rosvot_runner.py`: isolated learned word/note boundary
  inference. Context-overlapped chunks preserve long notes across seams.
- `server/phoneme.py`, `server/phoneme_runner.py`: optional isolated CPU inference
  for phoneme-informed boundaries using real FCPE pitch from exactly the selected
  waveform. Keeps native logits, chunk intervals and input hashes; no calibrated
  note confidence is claimed. Adjacent equal pitches merge only when both chunks
  predict continuation across the same cut, never simply because pitch matches.
- Full independent pitch verification and review playback follow the selected
  vocal waveform, not merely an existing lead-hypothesis file. Completing a
  full check on the ordinary vocal stem never marks singer identity accepted.
- `server/vocal_score.py`: joint score-time path. Rhythmic complexity, adjacent
  boundaries and meaningful rests are considered together; it does not discard
  attacks because two events collide on a rounded onset.
  Production monophonic vocal paths use a 25 ms boundary-shift limit. A fine
  score-time grid is permitted when a conventional subdivision exceeds that
  limit; older unbounded quantization remains only for regression comparison.
- `server/vocal_alignment.py`: local pitch-entry, reattack and release evidence
  refines the learned syllable boundaries while retaining the note count and
  pitch sequence. No human-reference delay is applied to the audio.
- `server/vocal_rebuild.py`: reuses a saved vocal stem with a current edited
  project snapshot. It creates a new source document without reseparating audio
  or changing other parts; see `VOCAL_REBUILD_API.md`.
- `server/vocal_input.py`: authoritative saved/enhanced input selection, new-input
  FCPE extraction and source-timeline preservation.
- `server/melband.py`, `server/melband_runner.py`: optional isolated MPS/CPU
  full-vocal separation; it is not a lead-singer identity classifier.
- `server/chordino.py`, `server/audio_harmony.py`: accompaniment-audio harmony,
  explicit no-chord gaps, slash bass and source-time provenance.
- `server/pitch_evidence.py`, `server/voice_verification.py`: stored independent
  pitch curves for source-aligned correction; not note-accuracy ground truth.
- `server/omr.py`, `server/video.py`: external optical recognition and MP4 encoding.

## Current quality priority

P0 is **complete-song multi-part transcription**, clarified on 2026-11-07.
Evaluate the whole mixture, pitched notes, offsets, drums and instrument classes;
clean-singing scores cannot stand in for this outcome. The reproducible
`scripts/benchmark-multiscore.py` freezes complete predictions before acquiring
per-stem labels. BabySlakh is synthetic, with probable training overlap, so this
is development regression and not evidence of real-song generalization.

Lead-melody rhythm remains one component: a dense collection of pitch fragments
is not a useful vocal score. GAME Medium with shared singing notation is now the
default for multi/separate imports; see [current handoff](WORK_COMPUTER_HANDOFF.md).
Shared singing notation version 4 changes only audio-only score inference. It
retains overlapping chunk attacks, notates connected ascending scoops at their
sung destination when contour evidence agrees, keeps short runs, and applies a
bounded positive vocal phase correction from the song's own onsets. Raw GAME
events remain separate; lyric uploads keep their aligned syllable timing.
In the legacy comparison route the learned `rosvot` path precedes joint rhythmic notation;
`acoustic`, `standard` and `legato` remain comparison choices. This is an
engineering choice for rehearsal legibility, not a claim of universally higher
transcription accuracy. The source and old results remain separate.

Joint rhythm version3 prioritizes shared boundaries for touching events before
rhythmic cost, with an audited minimum-break fallback when candidates cannot all
connect. `toAbc` puts timed chord labels on an invisible annotation voice rather
than splitting melody notes. That silent voice is included in `staffMap.voiceIds`
and identified by `harmonyVoiceId`; consumers must map ABC audio tracks through
`staffMap`, not assume one track per part. It has no canonical notes or new staff.

Do not solve this by deleting all short notes, merging all repeated pitches,
stretching rests away, or changing tempo solely to make glyphs larger. Genuine
fast singing, repeated syllables and breath gaps must remain representable.

## Reference-score evaluation

`server/score_eval.py` compares any Coro projects with a private human reference
MIDI in score beats. It is evaluation-only; the analysis pipeline never imports
it, and a reference must never become an inference input or a tuning target.

```sh
.venv/bin/python -m server.score_eval --reference "<private.mid>" \
  --tracks "lead=0;piano=1,2;strings=3" --first-bar-beat 4 \
  --candidate raw=data/<job>/game-raw-project.json \
  --candidate previous=data/<old-job>/project.json --candidate current=data/<job>/project.json \
  --output evidence/<private-dir>/score-eval.json
```

It reports, per section: exact pitch and sixteenth matches, F1, octave-only
matches, duration agreement, and written dotted notes. For the lead it also
reports recovered same-pitch re-attacks. For keyboards it reports sustained-bass
coverage, sub-beat low notes and arpeggio marks. These numbers support a review;
they are not musical acceptance.

## Parallel worktrees

Several checkouts can each run a formal Coro without sharing a stale backend.
Set ports per worktree and reuse the local runtimes; private assets stay in the
main checkout and are linked, never copied or committed:

```sh
scripts/link-local-assets.sh "/path/to/main/checkout"
CORO_BACKEND_PORT=8775 CORO_FRONTEND_PORT=5183 npm start
```

Each worktree keeps its own `data/`. A backend fails interrupted jobs in its data
directory on startup, so sharing one would break another checkout's analysis.

Every analysis worker takes a machine-wide lock (`~/.cache/coro/analysis.lock`)
before loading models, so uploads from different checkouts queue rather than
running Demucs, YourMT3+ and GAME at the same time. While waiting, a job stays
`queued` with an explanatory message and can still be cancelled. Offline
experiments use the same lock:

```sh
.venv/bin/python -m server.analysis_lock -- .venv/bin/python my_experiment.py
```

`CORO_ANALYSIS_LOCK=off` disables it (tests, CI); another path selects a
different lock file.

## Local tests and evidence

Unit tests contain synthetic, owned fixtures. Some integration tests optionally
read local evidence, which is not distributed. Never add private song arrays or
recordings to the public repository just to make those optional tests run.

`pytest.ini` scopes the default Python run to `tests/`. Downloaded third-party
tool tests and private experiment checks are not counted as product regressions;
they can still be run separately with an explicit path.

Check normal UI interactions and real browser audio as well as unit tests. A
passing XML round trip proves faithful serialization, not that the model heard
the song correctly. Keep source recognition, score normalization and vocal
arrangement quality distinct in reports.

The browser audio page includes an explicit-marking control for dynamic playback.
`tests/browser-storage.html` runs the real app with isolated in-memory storage to
test failed archival and recovery without modifying the user's browser projects.

## Project persistence

The active workspace lives in browser local storage. `src/lib/library.ts` stores
all projects and immutable named versions in the `coro-projects` IndexedDB;
`projectDatabase.ts` owns its transactions. The recent list is only a view, not
a retention policy. Legacy migration is atomic and never replaces an existing
new-format record. All callers must await archival before switching workspaces
or starting a rebuild. Media lives in its separate IndexedDB or the backend
`data/` tree. Do not change a saved project in place
when re-running models: create a separate result and preserve user edits.

If archival fails, imports and workspace switches must abort before replacing
source/arrangement or clearing undo history. Do not replace that error with a
success toast. Note dynamics persist until changed within their staff or explicit
voice scope; a tied continuation does not set an accidental for a later attack
in the next measure.

`src/lib/localCodec.ts` compresses the workspace and reads legacy recent-library JSON.
Existing uncompressed
records remain readable; public export formats are unchanged. Preserve both
documents before asynchronous rebuilds, not only when their result is opened.

Model installers live in `scripts/`; runtimes and weights remain ignored. If a
new engine needs different dependency versions, give it an isolated environment
and subprocess boundary rather than upgrading the base runtime blindly.

`reviewDraft.ts` persists pending vocal edits, undo/redo, explicit reviewer states
and source position separately from the score. Compare the original vocal
timeline before recovery; never overwrite a newer vocal edit. On Apply, merge
only vocal notes and review metadata into the current project so independent part
edits survive. Evidence and model agreement never mark a checkpoint confirmed.

`server/runtime.py` captures backend code identity when `create_app` runs;
`scripts/runtime.mjs` uses the same hash for doctor and startup. Do not calculate
the live health hash on each request: that would misidentify stale running code
as newly loaded code. The CI suite uses `requirements-test.txt`, not the model
installation environment.

## Recording-to-score regression

`scripts/benchmark-vocal-p0.py` pins SSVD-v2.0 source files by Git blob and SHA256.
The diagnostic and validation groups contain eight disjoint recordings each,
selected in fixed lexicographic order. It freezes predictions, code, models and
audio-derived tempo before reading human note labels. Scoring uses continuous
reference pitch, 50-cent pitch / 50-ms onset tolerances, and for full-note F1 an
offset tolerance of max(50 ms, 20% duration). There is no reference-derived tempo,
timing shift or octave repair. Training-set overlap is unknown; these are small
clean-singing regressions, not a blinded ranking on commercial mixes.

```bash
uv venv --python 3.11 .venv-benchmark
uv pip install --python .venv-benchmark/bin/python -r requirements-benchmark.txt
uv pip install --python .venv-benchmark/bin/python --no-deps basic-pitch==0.4.0
.venv-benchmark/bin/python scripts/benchmark-vocal-p0.py prepare --split validation
.venv-benchmark/bin/python scripts/benchmark-vocal-p0.py infer --split validation --run baseline-v1 --basic-pitch
.venv-benchmark/bin/python scripts/benchmark-vocal-p0.py score --split validation --run baseline-v1
bash scripts/setup-phoneme.sh
.venv-benchmark/bin/python scripts/benchmark-phoneme-p0.py infer --split validation --baseline baseline-v1 --run runtime-v1 --runtime
.venv-benchmark/bin/python scripts/benchmark-phoneme-p0.py score --split validation --run runtime-v1
```

Use a new run name after code changes; evidence is never overwritten and scoring
rejects changed dependencies. `--runtime` evaluates the real subprocess, chunking
and stitching path; omitting it selects the whole-recording research prototype.
Both reuse the same frozen FCPE contour and audio-only beat grid. Results include
raw, legacy 32nd-grid, unbounded joint, and bounded vocal rhythm variants to
separate recognition errors from notation errors. A local inference run, browser
tests and model-free CI are different evidence and should be reported separately.
All downloaded recordings, labels and per-note outputs remain in ignored `data/`:
no explicit upstream dataset license was found, so do not redistribute them.

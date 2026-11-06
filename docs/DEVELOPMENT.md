# Development map

## Application

- `src/App.tsx`: separate source/arrangement documents, history, editor and rehearsal.
- `src/lib/types.ts`: canonical note/part/project schema. Time is absolute
  quarter-note beats, not seconds or measure-relative time. Null pitch is a rest.
- `src/lib/music.ts`, `src/lib/engraving.ts`: MusicXML/ABC/MIDI conversion and
  note-to-glyph mappings. The canonical project, not ABC, is the source of truth.
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

- `server/app.py`: loopback API, bounded analysis queue and cancellation.
- `server/pipeline.py`: decoding, separation and base transcription.
- `server/audio_quality.py`: beat alignment, lead/backing proposals, learned vocal
  notes, piano onset evidence and audio-derived harmony.
- `server/rosvot.py`, `server/rosvot_runner.py`: isolated learned word/note boundary
  inference. Context-overlapped chunks preserve long notes across seams.
- `server/vocal_score.py`: joint score-time path. Rhythmic complexity, adjacent
  boundaries and meaningful rests are considered together; it does not discard
  attacks because two events collide on a rounded onset.
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

P0 is lead-melody rhythm: a dense collection of pitch fragments is not a useful
vocal score. The learned `rosvot` path now precedes joint rhythmic notation;
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

The current workspace and recent list live in browser local storage. Media lives
in IndexedDB or the backend `data/` tree. Do not change a saved project in place
when re-running models: create a separate result and preserve user edits.

If archival fails, imports and workspace switches must abort before replacing
source/arrangement or clearing undo history. Do not replace that error with a
success toast. Note dynamics persist until changed within their staff or explicit
voice scope; a tied continuation does not set an accidental for a later attack
in the next measure.

`src/lib/localCodec.ts` compresses the workspace and recent-library JSON to avoid
exhausting browser quotas with repeated note fields. Existing uncompressed
records remain readable; public export formats are unchanged. Preserve both
documents before asynchronous rebuilds, not only when their result is opened.

Model installers live in `scripts/`; runtimes and weights remain ignored. If a
new engine needs different dependency versions, give it an isolated environment
and subprocess boundary rather than upgrading the base runtime blindly.

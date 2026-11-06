# Development map

## Application

- `src/App.tsx`: separate source/arrangement documents, history, editor and rehearsal.
- `src/lib/types.ts`: canonical note/part/project schema. Time is absolute
  quarter-note beats, not seconds or measure-relative time. Null pitch is a rest.
- `src/lib/music.ts`, `src/lib/engraving.ts`: MusicXML/ABC/MIDI conversion and
  note-to-glyph mappings. The canonical project, not ABC, is the source of truth.
- `src/lib/arrange.ts`, `src/lib/vocalBreathing.ts`: vocal ranges, voice leading,
  melody adaptation, syllables and physical-time breath planning.
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

Do not solve this by deleting all short notes, merging all repeated pitches,
stretching rests away, or changing tempo solely to make glyphs larger. Genuine
fast singing, repeated syllables and breath gaps must remain representable.

## Local tests and evidence

Unit tests contain synthetic, owned fixtures. Some integration tests optionally
read local evidence, which is not distributed. Never add private song arrays or
recordings to the public repository just to make those optional tests run.

Check normal UI interactions and real browser audio as well as unit tests. A
passing XML round trip proves faithful serialization, not that the model heard
the song correctly. Keep source recognition, score normalization and vocal
arrangement quality distinct in reports.

## Project persistence

The current workspace and recent list live in browser local storage. Media lives
in IndexedDB or the backend `data/` tree. Do not change a saved project in place
when re-running models: create a separate result and preserve user edits.

Model installers live in `scripts/`; runtimes and weights remain ignored. If a
new engine needs different dependency versions, give it an isolated environment
and subprocess boundary rather than upgrading the base runtime blindly.

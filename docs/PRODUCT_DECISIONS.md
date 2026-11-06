# Product decisions

Coro is organized around arranging and rehearsing, not around a model benchmark
dashboard. The score must be editable, understandable and transferable even when
the first transcription is imperfect.

## Distinguish the musical layers

Source separation, instrument classification, pitch tracking, note/word segmentation,
rhythmic notation and vocal arrangement are different problems. A clean vocal stem
does not prove it contains the lead singer. Accurate frame-level pitch does not
prove the note boundaries or notated rhythm are correct. A valid MusicXML file
does not prove the transcription matches the recording.

Keep model evidence, score proposals and manual edits separate. A model disagreement
is not a confirmed wrong note; an unmarked interval is not confirmed correct.

## Put the score at the center

The canonical project owns pitches, starts, durations and metadata. ABC is a view,
not a second source of truth. Rendering must not silently delete dense/polyphonic
notes. Source and vocal arrangement are separate documents, with reversible editing.
Voice/staff metadata from an instrumental source must not accidentally create two
staves for one singer.

Vocal rhythm needs musical structure, not a printout of every pitch-frame fluctuation.
Learned word/note boundaries, acoustic alignment and joint notation are separate
steps. Do not improve a short-note counter by deleting all fast notes or changing
tempo solely to make symbols larger. Preserve real reattacks and breaths.
Two events that share an acoustic boundary should share its quantized time when
feasible; report bounded-candidate exceptions rather than hiding them. Timed chord
labels belong to an independent annotation layer, not artificial melody cuts.

## Make the generated arrangement singable

Ranges and non-crossing voices are necessary but insufficient. Tessitura, phrase
length, vowel continuity, density, voice leading and breathing matter too.
Artificial pulse boundaries are optional; real harmonic changes are not. Do not
subtract a fixed release from a short slot and force a tiny leftover note.
Common sustained tones can connect without an extra syllable. Plan breaths in
seconds and avoid making a new tiny note just to insert a breath.

Playback must preserve musical state: dynamics continue until changed, MIDI
velocity should reflect them, and a resumed or looped phrase must retain its
effective dynamic. Printed markings remain sparse. Rehearsal mute/solo and display
scope must not destructively alter the score or silently change export scope.

## Learn from existing tools without copying their assumptions

Crescendo11.30 was inspected read-only using REA bundle/dependency analysis and
actual menus. High-ROI capabilities adopted include grand staves, notation voices,
region-based correction, keyboard entry, lyrics, audition, metronome and interchange.
The native decompiler adapter did not fully work; no claim of reverse-engineering
its proprietary algorithms or matching every feature is made.

The supplied [DJC repository](https://github.com/zzzhhn/dj-controller) was reviewed
at `1fcef65621ea2ef6fbea2134ecc04996769c5fa6`. Useful patterns were local worker-owned
models, explicit beat phase, retaining original bytes, verifying backups before
restoring, and choosing file formats by actual encoder support. Its DJ-oriented
tempo preferences are not notation ground truth. No blanket source license or
additional local language-model transcription capability was assumed.

## Preserve work before replacing it

Archive source and arrangement before a rebuild. Do not replace a current workspace
if archival fails. Completed analysis jobs are separate results, not silent writes
to the user's current score. Keep original uploaded bytes separate from a decoded
playback WAV. Portable projects verify every asset before import writes occur.

Compression helps local-storage quotas; it is not a backup. Provide portable
exports and explain which media and model evidence are not included. GitHub sync
publishes code, not private recordings, generated scores or model weights.

## Treat model and release choices explicitly

Use suitable stronger models when useful, with reproducible installation and
honest failure states. A larger separator is not automatically more accurate for
the intended lead melody. Keep alternatives selectable and preserve their source
identity. Do not reuse an old input's F0 as if it was extracted from a new waveform.

Before a public service or commercial distribution, separately address user/data
isolation, operational budgets, recording and composition rights, and each model,
code, font and sample license. The current loopback workbench is not a public
multi-user service, and pretrained model terms are not interchangeable.

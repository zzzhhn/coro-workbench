# MVP status

Validated locally on2026-11-06, macOS Apple Silicon. This is a functional editable
music-workbench MVP, not a claim of perfect transcription or publication-ready
arrangements for arbitrary recordings.

| Requested capability | Delivered workflow and evidence | Boundary |
| --- | --- | --- |
| Audio and score-image import | Local separation/transcription; actual Audiveris PDF/PNG recognition; source-page comparison; editable/playable notes | Recognition can miss notes, voices and accidentals. A fresh PNG run produced5parts/8measures and parsed into the current editor/export model. |
| Score and vocal export | PDF, MIDI, WAV, MP4, MusicXML, ABC; full-score or selected-part exports | MIDI does not preserve publication layout. MP4 uses synthesized rehearsal audio, not the original commercial recording. |
| Useful Crescendo capabilities | REA-assisted bundle/dependency inspection, actual menu review, grand staff, region correction, notation entry, audition and rehearsal controls | No claim of full Crescendo parity or successful proprietary algorithm decompilation. |
| DJC reference and portable work | Reviewed supplied source, independent local worker/persistence design; portable source+arrangement+original media | Original media, model weights and private evidence are not in the public code repository. |
| Targeted real-song improvement | Four diverse complete recordings, learned vocal-note segmentation, acoustic timing alignment, independent curve review, audio harmony, selectable enhanced vocal input, source-preserving rebuild | Real-song pitch/identity errors remain. Smaller note counts and model agreement are not accuracy measurements. |
| GitHub handoff | Public source, tests, dependency manifests, reproducible optional-model installers and migration notes | Some native dependencies are macOS-specific; other platforms are not fully validated. |

## Final rehearsal checks

The P0 lead-rhythm audit found and fixed two downstream artifacts: independent
rounding inserted7 tiny rests at genuinely touching vocal boundaries, and timed
chord labels split sung notes into extra tied glyphs. All1,709 touching boundaries
in the four saved aligned sequences now share a score boundary. All1,946 vocal
events and their pitch order remain; this is not a short-note deletion pass.
Chord annotations have a separate silent timing lane, not a new sounding part or
staff. On the same canonical notes this removes25/31/30/19 unnecessary note glyphs.
Beams are grouped by metrical beat even for offbeat runs; compound6/8 keeps its
three-eighth grouping. Dense chord annotations use shorter systems for legibility.
The four new results are separate local projects titled `词音连贯`.

The four source scores were arranged as SATB/SSAA/TTBB in pop and choral styles
(24cases). Lead note timing/pitch, source harmony records and original audio stayed
unchanged. Generated ranges, no-crossing checks, no-chord gaps and planned breath
gaps passed. Every backing phrase is now within the10-second medium-difficulty
target, checked independently from sounding intervals. An edge case near a
sustain's end previously left two roughly100-second backing phrases; the planner
now considers an earlier split without making a tiny resumed vowel or dropping
an attack. ABC/MusicXML notes were independently decoded and compared exactly.

In the SATB-pop examples, each backing part's generated notes shorter than200ms
fell from56/64/70/42 to0/0/0/0 across the four recordings. This addresses an arranger
artifact, not the correctness of the source transcription. Existing arrangements
are not overwritten; regenerate to use the revised rhythm.

The latest real full-song export was checked as a7-page PDF,5-part MIDI/XML,
stereo44.1kHz WAV and1920x1080 H.264/AAC MP4. Audio/video duration was181.33seconds
with preserved tail. The portable project retained separate source/arrangement
documents and the original MP3 byte-for-byte, with all bundled media hashes valid.

Actual browser checks cover sound output, mute/solo, pause/resume, loops,
metronome/count-in, original-audio playback, dynamic persistence and offline audio.
A quota-failure test blocks workspace replacement, and successful recovery keeps
the archived manual edit. Mobile part switching keeps the current measure visible.
The updated lead notation was also opened through the normal library, inspected
and played at the affected passages in all four songs. A fresh selected-lead PDF
and MP4 were exported after the chord-annotation change.

## Remaining product limits

The result is an editable rehearsal draft, not a verified original publisher score
or an automatically approved concert arrangement. Lead/backing identity, octave
errors, omitted instruments, flexible tempo and complex notation still require
judgment and editing. See `LIMITATIONS.md` for the concrete model and format scope.
These limits are disclosed rather than hidden behind a demo or a benchmark score.

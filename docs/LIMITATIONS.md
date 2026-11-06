# Capabilities and known limitations

Coro is a working local music workbench, not a promise of exact orchestral
transcription or feature parity with a professional notation publisher.

## Transcription

- Demucs separates six source families, not every individual instrument. Strings,
  winds and brass can remain combined. Instrument classifier labels are candidates.
- Main-vocal separation can contain backing vocals, leakage, missing fundamentals
  and octave errors. No algorithm here proves singer identity.
- Optional MelBand separation is a selectable alternative, not a default quality
  guarantee. In a layered-vocal test passage, full-vocal and lead-only inputs
  produced substantial octave differences even after enhanced separation. More
  audible vocal content or a larger model does not identify the intended melody.
- ROSVOT predicts learned word/note boundaries; it does not transcribe lyrics.
  Its checkpoint was trained on Mandarin M4Singer. English and other styles can
  differ substantially from the training distribution.
- A small existing eight-recording human-reviewed singing regression gave native
  ROSVOT strict onset+pitch+offset micro F1 of 0.2114 / 0.2188 against two annotators.
  This is not a ranking on commercial mixed songs. Readability gains do not
  override those accuracy limitations. Predicted boundaries often precede the
  reference's pitched onset; no reference-derived delay is applied to the product.
- The additional acoustic alignment improves, but does not solve, onset timing.
  On another 32 existing human-reviewed recordings, native/aligned onset+pitch
  micro F1 is 0.2546/0.5506 (A1) and 0.2762/0.5744 (A2); including note offsets
  gives 0.1755/0.3106 and 0.2217/0.3337. This is development regression, not a
  new blinded mixed-song benchmark. One recording in that group and one in the
  original eight-recording group lose full-note F1. No notes or pitches are
  added/deleted by the alignment step.
- Vocal notation uses a joint timing path with a preference for simpler rhythm.
  It can shift note boundaries by roughly a tenth of a second after acoustic
  alignment, whose separate bound is 160 ms. Original model
  intervals remain in local evidence. Free time and intentional microtiming need editing.
- Chordino has dictionary and separation limitations, particularly suspended and
  diminished-seventh chords. N means no chord was recognized, not proven silence.
- Tempo is currently constant; time signature is initially 4/4 for audio imports.
  Pickup, half/double-time interpretation and changing meter need review.

## Vocal arrangement

SATB, SSAA and TTBB are editable proposals. Melody register adaptation, range
constraints, non-crossing harmony and breath timing are implemented; actual
tessitura, pronunciation, fatigue and musical phrasing are not guaranteed.
Accompaniment texture can still be mechanical. Choir samples provide pitches,
not original lyrics or a cloned singer. Vocal percussion playback uses a drum
reference, not a human beatbox performance.

## OMR and notation

PDF and image imports use Audiveris. Printed, clear scores work better than
handwriting, photographs or low-resolution scans. Recognition can introduce
wrong accidentals, ties, meter, voice assignments and extra/missing notes.

MusicXML supports core notes, rests, ties, staves, voice assignments, lyrics,
basic dynamics, articulations and harmony. Variable tempo/meter/key, arbitrary
slurs, advanced repeats, grace notes and engraving are not a lossless round trip.
Some unsupported content is reported rather than silently treated as supported.

Hardware MIDI input, tablature, guitar chord diagrams and advanced publishing
features are not implemented. Crescendo was used as a capability reference, not
as copied proprietary source code. Use MusicXML to continue in another editor.

## Export and hosting

PDF/MIDI/WAV/MP4 and portable projects are real generated files. MIDI does not
preserve publication layout or full lyrics. MP4 contains rendered score pages and
the synthesized rehearsal audio, not the original commercial recording.

The app listens on loopback and has no public multi-user authorization layer.
Do not expose the backend directly to the Internet. The public GitHub repository
is source distribution; it is not an online transcription service.

Only use recordings and scores you have the right to process. Recording, work,
lyrics, software and model licenses are separate questions. See
`../THIRD_PARTY_NOTICES.md` before redistribution.

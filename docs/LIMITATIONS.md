# Capabilities and known limitations

Coro is a working local music workbench, not a promise of exact orchestral
transcription or feature parity with a professional notation publisher.

## Transcription

- The import dialog now defaults to whole-song YourMT3+ transcription, with an
  explicit experimental label. The former recommended separation choice used
  Demucs six-family stems plus Basic Pitch and initially selected only 90 seconds.
  Multi/separate imports now default to GAME Medium for vocals while retaining
  the accompanying instrument pipeline. GAME failure is explicit, with no silent
  legacy vocal fallback. Optional LRC activates SOFA alignment; audio alone does
  not reproduce the lyric-assisted review candidate. Existing saved projects do
  not change automatically. Unavailable learned engines are rejected before queueing.
  Different engines or analysis ranges are not interchangeable result versions.
- Audio-only GAME notation can treat a connected, short rising entrance as a
  scoop into the sustained destination pitch. This reduces fragments but may
  hide an intended grace note; chains of short notes remain. A global vocal
  phase correction is used only when the vocal onsets clearly prefer it.
- Readable vocal notation separates acoustic boundaries from written rhythm.
  It can move slow sung boundaries by up to 160 ms in ordinary cases; short
  attacks retain length-scaled bounds. Every source boundary is retained in the
  audit. This is an editorial proposal, not timing or pitch ground truth.
  Phoneme notes that bridge at least 180 ms of both absent F0 and quiet audio
  are split around that span; short dropouts and loud uncertain spans remain.
  Raw learned intervals and changes are preserved. This does not fix singer
  identity, all wrong pitches, or missing notes.

- The optional YourMT3+ whole-song mode accepts up to 600 seconds; other audio
  analysis modes retain their 300-second limit. Its pinned `MT3_FULL_PLUS`
  vocabulary distinguishes violin, viola and cello, but groups some timbres
  (for example soprano/alto sax). Decoder channels are not performer identities.
  Multiple players of the same class can share one polyphonic part. Existing
  independent source IDs remain separate, but the system does not infer player
  identities. Full verification can attach piano/vocal preview stems when local
  separation and quality models are installed. These stems can leak other parts;
  model activation and stem energy are not calibrated note confidence.
- Default multi-part notation infers common rhythmic patterns from native model
  seconds on the audio-derived grid. The older exact mode retains its 25 ms
  boundary bound; the default editorial score can move boundaries farther and
  records original and written times separately. It retains staccato, chords, overlapping
  same-pitch notes and repeated drum attacks. This prevents downstream deletion;
  it does not fix incorrect model pitches, missing notes or instrument labels.
  Decoder tie errors at chunk boundaries remain in local evidence.
  Unpitched drum durations follow the notated hit rhythm; the model's synthetic
  short offsets are not acoustic release estimates. Independent rhythm layers
  may need extra staves. A few fine-grid events can still produce awkward
  notation; successful rendering and a faithful export are not legibility approval.
- Piano pedal resonance and finger durations are separate proposals. Compact
  held rolls may become arpeggiated chords; freely timed playing can be misread.
  Live playback, WAV and MIDI now share arpeggio attack offsets across staves.
  Measured offsets take priority; manually marked chords use a bounded ascending
  roll. MusicXML retains the arpeggio mark but not these measured offsets, so an
  XML round trip uses the default roll. Pedal resonance proposals are not a
  complete pedal-notation/playback implementation or Crescendo parity.
  Empty auxiliary staves collapse per system, while active auxiliary voices
  remain. Independent-model additions stay pending by default: whole-song
  inspection rejected blindly adding every source-supported onset. The private
  Konger case still has missed notes, class drift and unreadable passages.
- Full verification now cross-checks sustained strings with instrumental
  YourMT3, Basic Pitch on the residual family, and whole-note harmonic evidence.
  Only long corroborated spans are promoted; competing octaves and short
  residual pitches remain pending. This optional second instrumental pass adds
  inference time. It does not identify individual string players or recover
  every quiet inner voice. Native events and each applied change are retained.
- Disputed lead octaves are checked against the original mixture and isolated
  vocal harmonic series. Source-owned low fundamentals can still be ambiguous;
  unresolved events remain unchanged. This is an acoustic check, not listening
  or full-song performance acceptance.
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
- The optional phoneme-informed engine uses learned boundaries plus same-waveform
  FCPE pitch. Small SSVD clean-singing regressions are promising but do not prove
  the intended singer was isolated from a mix. Training overlap is unknown.
  Unvoiced pitch is left missing, not filled with invented notes. One-second
  chunk context can still miss continuity across long held notes. It does not
  produce lyrics, and is currently an import choice rather than a rebuild mode.
- Vocal notation now limits each boundary shift to 25 ms and retains distinct
  repeated attacks. A fine score-time grid may be necessary, so notation can be
  less simple. ROSVOT's preceding acoustic alignment has its own separate bound
  of 160 ms; the phoneme path does not apply that alignment again. Original model
  intervals remain in local evidence. Free time and intentional microtiming need editing.
- Chordino has dictionary and separation limitations, particularly suspended and
  diminished-seventh chords. N means no chord was recognized, not proven silence.
- Tempo is currently constant; time signature is initially 4/4 for audio imports.
  Pickup, half/double-time interpretation and changing meter need review.

## Vocal arrangement

SATB, SSAA and TTBB are editable proposals. Melody register adaptation, range
constraints, non-crossing harmony and breath timing are implemented; actual
tessitura, pronunciation, fatigue and musical phrasing are not guaranteed.
Accompaniment texture is mechanical: on a correct reference score the current arranger
moves the lead an octave up into Soprano, repeats one rhythm in all inner voices for the whole
song and uses a fixed VP pattern (2026-11-13 baseline). Arranger v2 is being planned; see
[PRODUCT_DIRECTION.md](PRODUCT_DIRECTION.md). MIDI files exported with a ~95% note gate import
with shortened durations and fragment into 64th notes on MusicXML export; prefer MusicXML. Choir samples provide pitches,
not original lyrics or a cloned singer. Vocal percussion playback uses a drum
reference, not a human beatbox performance.

## OMR and notation

PDF and image imports use homr by default and Audiveris as a selectable or
automatic fallback engine. On simulated scans and phone photos of printed pages
homr held up far better than Audiveris (2026-11-14 A/B in PIPELINE.md); real
photos, real scans, handwriting and jianpu are not yet measured. homr does not
read lyrics, chord symbols or part names, and reads fewer ties than printed.
Either engine can introduce wrong accidentals, ties, meter, voice assignments
and extra/missing notes.

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

# Third-party components

Coro uses separately licensed software, fonts, samples and optional model weights.
Making the source repository public does not grant rights to uploaded recordings,
lyrics, model training data, or another person's voice. No user recordings or
downloaded model weights are distributed in this repository.

## Bundled assets

- FluidR3_GM samples: Frank Wen and contributors, CC BY 3.0. JSON conversion is
  derived from Benjamin Gleitzman's MIDI.js soundfonts repository (MIT tooling).
  See `public/soundfonts/README.md` and `public/soundfonts/LICENSE.txt`.
- Noto Sans SC: SIL Open Font License 1.1. See `public/fonts/OFL-NotoSansSC.txt`.
- Bravura music font: SIL Open Font License, installed through `@vexflow-fonts/bravura`.
- Newsreader, DM Sans and DM Mono: SIL Open Font License, installed through Fontsource.

## Core libraries

See package metadata and the installed licenses for the exact versions in
`package-lock.json` and `requirements-audio.txt`.

- React, Vite, abcjs, Fast XML Parser, fflate, Tonejs MIDI, midi-file, jsPDF,
  svg2pdf.js and Phosphor Icons have their own upstream licenses; retain notices
  when building a distribution.
- Basic Pitch and Demucs are separate upstream projects. The installer preserves
  their package metadata; model provenance is recorded separately.
- FFmpeg is a system dependency, not a bundled binary. Its applicable license
  depends on the build and enabled codecs.

## Optional engines, downloaded locally

| Component | Source / license considerations |
| --- | --- |
| ROSVOT / RWBD | [Official repository](https://github.com/RickyL-2000/ROSVOT), MIT code; official checkpoints trained on M4Singer. Respect the upstream consent and use disclaimer. Source patches are included; weights are downloaded and hash checked, not redistributed. |
| RMVPE | Comes from the official ROSVOT checkpoint bundle for this integration. Do not substitute arbitrary similarly named checkpoints. |
| Beat This! / FCPE / CREPE | Separate upstream code and checkpoint provenance; see the setup scripts and installed package notices. |
| Piano transcription | MIT package; downloaded piano checkpoint is CC BY 4.0, [Zenodo 4034264](https://zenodo.org/records/4034264). |
| KARA2 | UVR lead/backing separation, ONNX repack from musetric; preserve downloaded model card and provenance. |
| Chordino / sonic-annotator | GPL-2.0-or-later components. Installed as separate local processes; distribution can require notices and corresponding source. Do not describe the complete application bundle as permissively licensed. |
| Audiveris | AGPL-3.0 optical music recognition. Separate local installation, including its Java runtime. Review obligations before distributing a product with it. |
| YourMT3+ | Experimental, separately installed. Upstream code and model-card license statements differ; review before commercial redistribution. |

This list is not a legal opinion or a substitute for the actual licenses. Coro's
own source-code license has not yet been selected by the repository owner.

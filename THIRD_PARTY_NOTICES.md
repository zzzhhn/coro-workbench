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
| Phoneme-informed singing transcription | [Official repository](https://github.com/seyong92/phoneme-informed-note-level-singing-transcription), MIT code. Optional official release checkpoint is downloaded locally and verified against its Git LFS SHA-256; no source or weights are bundled. Coro uses the learned boundaries with separately extracted FCPE pitch. |
| RMVPE | Comes from the official ROSVOT checkpoint bundle for this integration. Do not substitute arbitrary similarly named checkpoints. |
| Beat This! / FCPE / CREPE | Separate upstream code and checkpoint provenance; see the setup scripts and installed package notices. |
| Piano transcription | MIT package; downloaded piano checkpoint is CC BY 4.0, [Zenodo 4034264](https://zenodo.org/records/4034264). |
| KARA2 | UVR lead/backing separation, ONNX repack from musetric; preserve downloaded model card and provenance. |
| Mel-Band-RoFormer | Optional Kimberley Jensen full-vocal weights. Author HF metadata declares MIT; the pinned author code checkout has no top-level LICENSE. The installer downloads source and weights locally; neither is bundled in this repository. Review author terms before redistribution. See `docs/MELBAND_SETUP.md`. |
| Chordino / sonic-annotator | GPL-2.0-or-later components. Installed as separate local processes; distribution can require notices and corresponding source. Do not describe the complete application bundle as permissively licensed. |
| Audiveris | AGPL-3.0 optical music recognition. Separate local installation, including its Java runtime. Review obligations before distributing a product with it. |
| YourMT3+ | Experimental, separately installed. Upstream code and model-card license statements differ; review before commercial redistribution. |
| SOFA | Optional local Mandarin singing alignment experiment. [Official source](https://github.com/qiuqiao/SOFA), MIT, copyright (c) 2023 suco; pinned at `9549c6a86d16019c817eefe4bb8183405da524cc`. Network, mel extraction and forced decoding are loaded from the separately installed checkout with its LICENSE retained. Mandarin singing v1.0.0 checkpoint comes from the official v1.0.1 release asset; source and weights are not bundled. |
| MLX Whisper | Optional local ASR cross-check through the `mlx-whisper` package and the separately cached `mlx-community/whisper-large-v3-turbo` weights. Audio and recognition artifacts stay in ignored local directories. |

GAME 1.0.3 Medium uses the [official GAME source and releases](https://github.com/openvpi/GAME).
The source declares MIT. ONNX weights and source are installed separately and
are not bundled here; retain the upstream notices and check the downloaded
checkpoint's terms before redistribution.

This list is not a legal opinion or a substitute for the actual licenses. Coro's
own source-code license has not yet been selected by the repository owner.

The optional diagnostic scripts download small subsets of
[SSVD-v2.0](https://github.com/xk-wang/SSVD-v2.0) into ignored `data/` only.
No explicit dataset redistribution license was found. Do not bundle its audio,
human annotations, or per-note prediction artifacts with the public repository.

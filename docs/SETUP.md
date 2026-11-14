# Setup and moving to another computer

The currently verified development environment is macOS on Apple Silicon,
Node.js 22.12+ (22.x; see `.nvmrc`), Python 3.11, `uv`, Git, FFmpeg and Poppler (for PDF rendering). CPU inference works; a GPU is not
required. Linux and Windows installers are not yet verified end-to-end. At least
16 GB RAM and several GB of free disk space are recommended for all models.

## Score-only development

```bash
npm ci
npm run doctor
npm run dev
```

Open <http://127.0.0.1:5173/>. Score editing, MIDI/MusicXML import, arrangement and
sampled playback run in the browser. Audio transcription, OMR and MP4 encoding
need the backend and their dependencies.

## Full local workbench

Install Node.js, `uv`, Git and FFmpeg using your preferred package manager, then:

```bash
npm ci
bash scripts/setup-audio.sh
bash scripts/setup-audio-quality.sh
bash scripts/setup-lead-separation.sh
bash scripts/setup-rosvot.sh
bash scripts/setup-omr.sh
bash scripts/setup-omr-homr.sh   # default OMR engine (AGPL-3.0, separate venv)
.venv/bin/python scripts/setup-chordino.py
npm start
```

For the current default vocal pipeline, also install YourMT3+ for multi-part
imports and register GAME Medium as described in [GAME import setup](game-import.md).
GAME source and ONNX weights are separate local assets; cloning this repository
does not install them. Optional Mandarin LRC alignment additionally needs SOFA.
ROSVOT below is a legacy comparison/rebuild engine, not the default GAME upload.

Some installers download large public checkpoints. They do not upload music.
`setup-audio.sh` creates the base `.venv`; quality, vocal-note and experimental
engines have separate environments. The ROSVOT installer pins its source revision,
applies the included macOS/CPU compatibility patch, and verifies checkpoint hashes.
It does not rely on an earlier user's model cache or an absolute home directory.

Chordino installation details and supported platforms are in `CHORDINO_SETUP.md`.
If an optional engine is unavailable, the app reports its state or labels the
fallback; it never substitutes a generated demo for transcription.

Optional whole-song multi-instrument experiment:

```bash
bash scripts/setup-yourmt3.sh
```

YourMT3+ enables the import choice **多声部总谱**. Selecting it defaults to the
complete recording (up to 10 minutes); shorter previews remain available. The
isolated CPU runner uses one thread and one segment per batch to limit resource
pressure. Other transcription modes remain capped at 5 minutes per analysis.
The model is experimental: instrument classes are candidates, and same-class
performers are not independently identified. Weights are local and are not
copied by Git; run the installer separately on each computer.

Optional enhanced vocal separation, isolated from the base Torch environment:

```bash
bash scripts/setup-melband.sh
```

This downloads about 1 GB of author weights. Choose an enhanced input explicitly in
the vocal-rebuild dialog; it does not replace the default input automatically.
See `MELBAND_SETUP.md` for MPS/CPU support, exact hashes and source-license caveats.

Read the license notes before using optional engines in a redistributed product.
Audiveris setup currently targets macOS ARM64.

Optional phoneme-informed vocal note boundaries:

```bash
bash scripts/setup-phoneme.sh
```

After base audio and quality setup, choose **分离音轨 → 自动整理 → 发音边界**
in audio import. This experimental choice combines the author's boundary model
with FCPE pitch from the same waveform. It runs offline on one CPU thread in an
isolated Python 3.11 environment, using 20-second cores with 1-second context;
the existing 300-second input limit applies. The installer pins source and
dependencies and checks the 106 MB official checkpoint by SHA256. It preserves
unexpected existing assets rather than replacing them. `npm run doctor` and
backend health report readiness. Missing runtime blocks this explicit choice;
inference failure or empty output retains an available earlier candidate and
records the actual fallback. This describes the legacy phoneme path; current
multi/separate imports default to GAME and fail explicitly if requested GAME
inference cannot run. Saved-stem ROSVOT rebuilds remain available for legacy
projects and are disabled for GAME results.

Full pitch verification follows the waveform actually selected for the score,
including the ordinary vocal stem when no accepted lead-separation branch exists.
It can therefore provide FCPE/CREPE comparison without installing KARA2. This does
not confirm singer identity. Sampled verification does not produce the full
pitch-review curve.

This engine was evaluated on short clean singing recordings, not established as
a lead-identity solution for mixed commercial songs. See `LIMITATIONS.md` and
`DEVELOPMENT.md` for the evaluation protocol.

## Startup

`npm run doctor` checks the score-development environment, native tools, ports and
any installed audio engines without downloading weights or running inference.
Use `npm run doctor -- --full` to require the base audio environment, or add
`--json` for structured output. Optional engines remain separately reported.
Node 25 is not supported by the current test runner; use Node 22 from `.nvmrc`,
Node 24, or a compatible newer version declared in `package.json`.

```bash
npm start
```

Frontend: <http://127.0.0.1:5173/>. Backend health:
<http://127.0.0.1:8765/api/health>. Keep the terminal open. On macOS,
`Start-Coro.command` is an equivalent launcher. It only stops its own processes.

The backend is not hot-reloaded. Startup and doctor compare the running server's
startup source fingerprint and checkout identity against this directory. A stale,
unidentified or different-checkout server is not silently reused or stopped.
After changing Python code, wait for active
analysis jobs to finish, stop the owned server, and start again. Restarting during
analysis marks interrupted jobs as failed and retains the original uploads.

## What GitHub contains

Application source, tests, setup scripts, dependency manifests, local playback
samples and their licenses. It deliberately does not contain:

- Original user songs or uploaded scores.
- `data/` analysis jobs and model outputs.
- `models/` checkpoints, isolated environments or cloned model sources.
- `evidence/`, `output/`, browser screenshots or local research reports.
- API keys, credentials, browser storage or workstation-specific configuration.

Use a portable `.coro` export to move a composition with its original recording
and selected stems privately. A `.coro.json` export contains editing data only.
Clone the repository and rerun setup to move development; copying only the Git
repository does not copy your projects or installed models.

The active workspace remains compressed in local storage. The full project
library and pitch-review drafts are stored per project in IndexedDB. Legacy
library entries migrate in a single transaction and are removed from their old
location only after success. Projects are never evicted by a count limit; only
the recent view is limited to 12 other projects. Records already evicted by an
older release cannot be reconstructed by this migration.

Named versions preserve source and arrangement together and open as independent
copies. Explicit deletion removes the selected library record, not media assets.
The export indicator records that a portable archive was generated and download
started; it cannot confirm that the user retained the downloaded file. Clearing
site data still removes local projects and drafts, so keep private `.coro` backups.

Pitch-review changes and undo/redo history (40 steps), manual checkpoint statuses,
and position survive closing and reloading in this browser. Close keeps the draft;
discard requires an explicit choice. Changes reach the score only on Apply.
An altered vocal timeline blocks automatic draft restoration and offers an export
of the old draft before starting over. Applied checkpoint statuses travel in the
project; an unapplied draft remains local. This is not cross-computer cloud sync.

The vocal-rebuild action uses original server-side
stems and therefore requires the original local analysis directory; a portable
project without that directory still supports editing, playback and export, but
needs a new audio analysis before this server-side action is available.

## Checks

```bash
npm test
npm run build
.venv/bin/python -m pytest -q
```

Some optional native/recording checks skip when the corresponding local runtime
or private fixture is absent. Browser audio regression is available at
<http://127.0.0.1:5173/tests/browser-audio.html> in the development server.
It requires a real click to unlock audio. Machine checks do not establish musical
correctness on an arbitrary song.

For the model-free Python regression suite used in CI:

```bash
uv venv --python 3.11 .venv-tests
uv pip install --python .venv-tests/bin/python -r requirements-test.txt
.venv-tests/bin/python -m pytest -q
npm run test:scripts
```

GitHub Actions runs frontend tests, build, Chromium browser tests and the
model-free Python suite on pushes and pull requests. It does not run inference
or fetch private fixtures. Optional native-runtime and private-recording tests
explicitly skip when absent. Local browser checks can use an installed Chrome
binary with `CORO_TEST_BROWSER=chrome npm run test:e2e`.

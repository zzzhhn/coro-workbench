# Setup and moving to another computer

The currently verified development environment is macOS on Apple Silicon,
Node.js 22+, Python 3.11, `uv`, Git, FFmpeg and Poppler (for PDF rendering). CPU inference works; a GPU is not
required. Linux and Windows installers are not yet verified end-to-end. At least
16 GB RAM and several GB of free disk space are recommended for all models.

## Score-only development

```bash
npm ci
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
.venv/bin/python scripts/setup-chordino.py
npm start
```

Some installers download large public checkpoints. They do not upload music.
`setup-audio.sh` creates the base `.venv`; quality, vocal-note and experimental
engines have separate environments. The ROSVOT installer pins its source revision,
applies the included macOS/CPU compatibility patch, and verifies checkpoint hashes.
It does not rely on an earlier user's model cache or an absolute home directory.

Chordino installation details and supported platforms are in `CHORDINO_SETUP.md`.
If an optional engine is unavailable, the app reports its state or labels the
fallback; it never substitutes a generated demo for transcription.

Optional instrument-family experiment:

```bash
bash scripts/setup-yourmt3.sh
```

Read the license notes before using optional engines in a redistributed product.
Audiveris setup currently targets macOS ARM64.

## Startup

```bash
npm start
```

Frontend: <http://127.0.0.1:5173/>. Backend health:
<http://127.0.0.1:8765/api/health>. Keep the terminal open. On macOS,
`Start-Coro.command` is an equivalent launcher. It only stops its own processes.

The backend is not hot-reloaded. After changing Python code, wait for active
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

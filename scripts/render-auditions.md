# Audition renderer

```sh
node scripts/render-auditions.mjs /absolute/path/to/arrangement-directory
```

The directory must contain a validated `ScoreProject` named `arrangement.json`, with a lead part and four SATB parts, all using the official `choir_aahs` bank. Other soundbanks and percussion are rejected so cache fingerprints cover every used asset. SATB is selected by `voice-s`, `voice-a`, `voice-t`, `voice-b` IDs or matching short names; the lead is selected by `solo` ID or lead role. Outputs are `mix.m4a`, `solo.m4a`, `s.m4a`, `a.m4a`, `t.m4a`, `b.m4a`, and `audio.json`.

## Runtime assumptions

Use the repository's supported Node version and installed dependencies, including `@playwright/test`. `ffmpeg` and `ffprobe` must be on `PATH`. A system Chrome installation is selected through Playwright's `chrome` channel; `AUDITION_BROWSER_EXECUTABLE` may specify another compatible installed Chromium executable. The script never downloads a browser.

The repository's development server must already be running at `http://127.0.0.1:5173`, with its provisioned local soundfonts. `AUDITION_ORIGIN` may override only a loopback HTTP origin using `127.0.0.1`, `localhost`, or `::1`; remote destinations, HTTPS, credentials, and URL paths are rejected. Soundfonts and media are runtime inputs, not bundled into this script. The CLI imports the official `renderProjectAudioBuffer` sampler directly; it does not patch application source or use a user browser profile.

Before launch, the caller must inspect existing browsers and native memory pressure/swap when required by its operating environment. The CLI always serializes rendering and reports disk/free-memory information. Set `AUDITION_PREFLIGHT_SCRIPT` to a JSON-producing Python resource check and optionally `AUDITION_PREFLIGHT_PYTHON` to its interpreter; it runs immediately before the task-owned browser launches.

The offscreen page and PCM receiver share a short-lived HTTP server bound only to `127.0.0.1`. Four-second binary PCM requests use a random capability path and encoder backpressure. One complete-score buffer is held at a time, so memory scales with the longest score, not the number of songs. Each isolated file renders the full timeline once, preserving held notes without chunk re-attacks. A single transient FLAC is removed after final AAC validation. The browser and receiver close after the queue finishes.

## Loudness and verification

Every file independently targets -23 LUFS. Linear gain is used when true-peak headroom permits; a two-pass `loudnorm` fallback handles peak-limited material at -2 dBTP. Final files must measure within 0.25 LU and at or below -1.5 dBTP after AAC encoding. Every output is fully decoded by `ebur128=peak=true`, probed for complete duration, and SHA256 hashed. The manifest records PCM frame count, raw PCM hash, sampler/performance/dynamics fingerprint, choir soundbank hash, codec, runtime, and measured results. Independently normalized stems represent isolated auditions; the full mix retains the arrangement's relative mixer balance.

Multiple directory arguments render sequentially in one context. `--cache-root=DIR` searches a prior output tree for matching rendering signatures and verified audio hashes; identical audio is hardlinked when possible. Signatures include sounding notes, timing, dynamics, articulation, pedals, instrument, volume, pan, sampler code, and bank hash. IDs, lyric text, and provenance fields do not affect the sampler and are excluded.

`--watch DIR` discovers new arrangement directories, ignoring hidden staging directories. `--exclude=DIR_NAME` excludes an input. A `.audio-stop` file in a watched root finishes the current directory and closes the browser. Completed inputs are skipped only when arrangement, rendering fingerprint, soundbank, and every output hash still match. `--verify-buffer` compares the direct-buffer API with the WAV wrapper on the first supplied fixture; use a small synthetic fixture because it performs two extra complete renders.

`AUDITION_COMPATIBLE_RENDERER_SHA256` accepts comma-separated prior sampler hashes only when the caller has separately verified an algorithm-preserving refactor. This imports prior validated manifests while retaining their original renderer provenance and adding a compatibility receipt. It must not be used to conceal a sounding change.

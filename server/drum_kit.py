"""Whole-song drum-kit evidence for YourMT3+ percussion events (recognition layer).

YourMT3+ can emit GM drum events at low-frequency impacts, piano or bass
attacks, string articulations and vocal sibilance. A drum kit, however,
produces steep broadband transients (hi-hat, snare wires, cymbals, beater
click) that the separated drum source owns. Low thumps alone are not kit
evidence. The gate is song-level: it either keeps every native drum event or
withholds all of them from the default score. Nothing is deleted; withheld
events stay in the audit and in candidateEvents. Thresholds were registered
before measurement; no reference score and no song-specific times.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

VERSION = 'drum-kit-evidence-1'
BAND_HZ = (3000., 12000.)
RISE_DB = 12.
SHARE_DB = -10.
MIN_ONSETS = 32
LOOKBACK_FRAMES = 10
PEAK_FRAMES = 3
MERGE_SECONDS = .05
FRAME_RATE = 100


def _band_db(audio: np.ndarray, sr: int) -> np.ndarray:
    """3-12 kHz energy in dB at 10 ms frames."""
    hop, n_fft = max(1, sr // FRAME_RATE), 1024
    audio = np.asarray(audio, dtype=np.float32)
    if len(audio) < n_fft:
        audio = np.pad(audio, (0, n_fft - len(audio)))
    frames = 1 + (len(audio) - n_fft) // hop
    window = np.hanning(n_fft).astype(np.float32)
    freqs = np.fft.rfftfreq(n_fft, 1 / sr)
    band = (freqs >= BAND_HZ[0]) & (freqs < min(BAND_HZ[1], sr / 2))
    out = np.empty(frames, dtype=np.float64)
    for start in range(0, frames, 2048):
        idx = np.arange(start, min(frames, start + 2048))[:, None] * hop + np.arange(n_fft)
        spectrum = np.abs(np.fft.rfft(audio[idx] * window, axis=1)) ** 2
        out[start:start + len(idx)] = spectrum[:, band].sum(axis=1)
    return 10 * np.log10(out + 1e-12)


def kit_onsets(drums: np.ndarray, mixture: np.ndarray, sr: int) -> list[float]:
    """Steep broadband onsets that the drum source owns within the mixture."""
    ed, em = _band_db(drums, sr), _band_db(mixture, sr)
    count = min(len(ed), len(em))
    ed, em = ed[:count], em[:count]
    times: list[float] = []
    for t in range(LOOKBACK_FRAMES, count):
        if ed[t] - ed[t - LOOKBACK_FRAMES:t].min() < RISE_DB or ed[t] < em[t] + SHARE_DB:
            continue
        if ed[t] < ed[max(0, t - PEAK_FRAMES):t + PEAK_FRAMES + 1].max():
            continue
        seconds = t / FRAME_RATE
        if not times or seconds - times[-1] >= MERGE_SECONDS:
            times.append(seconds)
    return times


def _mono(path: Path, sr: int | None = None) -> tuple[np.ndarray, int]:
    import soundfile as sf
    audio, rate = sf.read(path, dtype='float32', always_2d=True)
    audio = audio.mean(axis=1)
    if sr is not None and rate != sr:
        import librosa
        audio, rate = librosa.resample(audio, orig_sr=rate, target_sr=sr), sr
    return audio, rate


def gate_drum_events(events: list[dict], drums_path: Path | None,
                     mixture_path: Path | None) -> tuple[list[dict], dict]:
    native = [e for e in events if e.get('isDrum')]
    audit = {'version': VERSION, 'layer': 'recognition', 'nativeDrumEvents': len(native),
             'thresholds': {'bandHz': list(BAND_HZ), 'riseDb': RISE_DB,
                            'drumShareOfMixDb': SHARE_DB, 'minKitOnsets': MIN_ONSETS},
             'claimsInstrumentTruth': False, 'groundTruthAvailable': False}
    if not native:
        return events, {**audit, 'status': 'no_drum_events'}
    if not drums_path or not mixture_path or not Path(drums_path).is_file() or not Path(mixture_path).is_file():
        return events, {**audit, 'status': 'unavailable', 'decision': 'keep'}
    try:
        mix, sr = _mono(Path(mixture_path))
        drums, _ = _mono(Path(drums_path), sr)
        onsets = kit_onsets(drums, mix, sr)
    except (OSError, ValueError, RuntimeError):
        return events, {**audit, 'status': 'unavailable', 'decision': 'keep'}
    kit = len(onsets) >= MIN_ONSETS
    audit.update(status='measured', kitOnsets=len(onsets),
                 kitOnsetSample=[round(t, 2) for t in onsets[:12]],
                 decision='keep' if kit else 'withhold')
    if kit:
        return events, audit
    audit['withheldEvents'] = native
    return [e for e in events if not e.get('isDrum')], audit

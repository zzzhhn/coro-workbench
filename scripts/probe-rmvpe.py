"""Frozen optional RMVPE probe; never writes saved projects or default pipelines."""
from __future__ import annotations

import os
os.environ['TORCH_FORCE_WEIGHTS_ONLY_LOAD'] = '1'
os.environ['RVC_CUDA_GRAPH'] = '0'

import hashlib
import json
import sys
import time
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
import torch
from scipy.signal import butter, sosfilt

ROOT = Path(__file__).resolve().parents[1]
REFS = ROOT / 'work/refs/rmvpe-review'
OUTPUT = ROOT / 'data/phase4/rmvpe'
REPORT = ROOT / 'evidence/phase4/rmvpe-probe.json'
SR = 16000
HOP = .01
THRESHOLD = .03
JOBS = [('Ariana - bye', 'f70ebab316d54d62abb0f56d19e0356e'), ('NewJeans - Attention', '22d62c8049d04e39b9062b60513bf9c5'), ('Weeknd - Out of Time', '1eac4381bbfd4904a66bf0ca97e2f72d'), ('单依纯 - 空耳', 'a6be0eb965d048a0ad57819135164463')]


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def nearest(times, source_times, values):
    right = np.clip(np.searchsorted(source_times, times), 0, len(source_times) - 1)
    left = np.maximum(right - 1, 0)
    index = np.where(np.abs(source_times[left] - times) <= np.abs(source_times[right] - times), left, right)
    return values[index]


def median(values):
    return round(float(np.median(values)), 5) if len(values) else None


def fixtures():
    """Explicit waveform truth; no neural output, model vocab, or CREPE labels used."""
    target = OUTPUT / 'fixtures'
    target.mkdir(parents=True, exist_ok=True)
    t = np.arange(SR * 5) / SR
    rng = np.random.default_rng(20261106)
    envelope = np.minimum(1., t / .04) * np.minimum(1., (5 - t) / .08)
    pitch = np.select([t < 1.5, t < 3], [196., 261.625565], 329.627557)
    vibrato = 220 * 2 ** (35 * np.sin(2 * np.pi * 5.2 * t) / 1200)
    definitions = []
    for name, truth, harmonics in [('harmonic-notes', pitch, [(1, 1), (2, .45), (3, .25), (4, .12)]), ('missing-fundamental', np.full(len(t), 220.), [(2, 1), (3, .6), (4, .35), (5, .2)]), ('vibrato', vibrato, [(1, 1), (2, .4), (3, .2)]), ('low-harmonic', np.full(len(t), 110.), [(1, 1), (2, .5), (3, .3), (5, .1)])]:
        phase = 2 * np.pi * np.cumsum(truth) / SR
        y = sum(gain * np.sin(number * phase + .13 * number) for number, gain in harmonics)
        y = y / max(1., np.max(np.abs(y))) * .18 * envelope
        definitions.append((name, y, truth))
    white = rng.normal(0, .02, len(t))
    breath = sosfilt(butter(4, [1200, 6500], btype='bandpass', fs=SR, output='sos'), rng.normal(0, 1, len(t)))
    breath = breath / np.std(breath) * .015 * envelope
    definitions += [('white-noise', white, np.zeros(len(t))), ('breath-noise', breath, np.zeros(len(t))), ('silence', np.zeros(len(t)), np.zeros(len(t)))]
    metadata = {'seed': 20261106, 'sampleRate': SR, 'durationSeconds': 5, 'threshold': THRESHOLD, 'thresholdSweep': False, 'truthMeaning': 'Explicit waveform frequency or aperiodic negative, not a neural consensus label', 'cases': []}
    for name, y, truth in definitions:
        path = target / f'{name}.wav'
        sf.write(path, y, SR, subtype='FLOAT')
        np.savez_compressed(target / f'{name}-truth.npz', sampleTime=t, f0=truth)
        metadata['cases'].append({'name': name, 'audioSha256': sha(path), 'truthSha256': sha(target / f'{name}-truth.npz'), 'harmonics': dict((row[0], row[2]) for row in [('harmonic-notes', 0, [1, 2, 3, 4]), ('missing-fundamental', 0, [2, 3, 4, 5]), ('vibrato', 0, [1, 2, 3]), ('low-harmonic', 0, [1, 2, 3, 5])]).get(name, []), 'knownVoiced': bool(np.any(truth))})
    save_json(target / 'truth.json', metadata)
    return definitions, metadata


def acoustic_support(y, f0):
    """Independent waveform diagnostics, not calibrated voice identity/accuracy."""
    padded = np.pad(y, (512, 512))
    frames = np.lib.stride_tricks.sliding_window_view(padded, 1024)[::160][:len(f0)].copy()
    rms = np.sqrt(np.mean(frames ** 2, axis=1))
    acf = np.zeros(len(f0))
    concentration = np.zeros(len(f0))
    power = np.abs(np.fft.rfft(frames * np.hanning(1024), n=2048)) ** 2
    for i, hz in enumerate(f0):
        if hz <= 0 or i >= len(frames):
            continue
        lag = int(round(SR / hz))
        frame = frames[i] - frames[i].mean()
        if 1 <= lag < 700:
            first, second = frame[:-lag], frame[lag:]
            acf[i] = np.dot(first, second) / max(1e-12, np.linalg.norm(first) * np.linalg.norm(second))
        bins = set()
        for h in range(1, 7):
            center = int(round(h * hz * 2048 / SR))
            bins.update(range(max(1, center - 1), min(1025, center + 2)))
        concentration[i] = power[i, sorted(bins)].sum() / max(power[i, 1:].sum(), 1e-12)
    return rms, acf, concentration


def summarize_support(mask, rms, acf, concentration):
    return {'seconds': round(float(mask.sum() * HOP), 3), 'rmsMedian': median(rms[mask]), 'acfAtPredictedPeriodMedian': median(acf[mask]), 'firstSixHarmonicsEnergyFractionMedian': median(concentration[mask]), 'lowAcfBelowPoint3Seconds': round(float(np.sum(mask & (acf < .3)) * HOP), 3)}


def run_fixtures(model, definitions):
    rows = []
    for name, y, truth in definitions:
        started = time.monotonic()
        with torch.inference_mode():
            f0 = model.infer_from_audio(y.astype(np.float32), thred=THRESHOLD)
        times = np.arange(len(f0)) * HOP
        keep = times < 5 - 1e-7
        times, f0 = times[keep], f0[keep]
        expected = truth[np.minimum(np.round(times * SR).astype(int), len(truth) - 1)]
        valid = (times >= .1) & (times < 4.9)
        if name == 'harmonic-notes':
            valid &= (np.abs(times - 1.5) > .1) & (np.abs(times - 3) > .1)
        known = expected > 0
        cents = np.full(len(f0), np.nan)
        both = (f0 > 0) & known
        cents[both] = 1200 * np.abs(np.log2(f0[both] / expected[both]))
        np.savez_compressed(OUTPUT / 'fixtures' / f'{name}-result.npz', time=times, rmvpeF0=f0, expectedF0=expected, scored=valid)
        rows.append({'fixture': name, 'knownVoiced': bool(known.any()), 'scoredFrames': int(valid.sum()), 'voicedFrames': int(np.sum(valid & (f0 > 0))), 'knownVoicedButMissedFrames': int(np.sum(valid & known & (f0 <= 0))) if known.any() else None, 'octaveErrorFrames': int(np.sum(valid & (np.abs(cents - 1200) <= 100))) if known.any() else None, 'correctWithin50CentsOfAuthoredTruth': int(np.sum(valid & (cents <= 50))) if known.any() else None, 'medianAbsoluteCentsOnPredictedVoiced': median(cents[valid & both]) if known.any() else None, 'falseVoicedSecondsOnAuthoredNegative': round(float(np.sum(valid & (f0 > 0)) * HOP), 3) if not known.any() else None, 'runtimeSeconds': round(time.monotonic() - started, 3)})
        print(json.dumps(rows[-1]), flush=True)
    return rows


def load_slice(path, start, end):
    info = sf.info(path)
    y, _ = sf.read(path, start=round(start * info.samplerate), stop=round(end * info.samplerate), dtype='float32', always_2d=True)
    return librosa.resample(y.mean(axis=1), orig_sr=info.samplerate, target_sr=SR)


def run_real(model, name, job, split, start, end):
    started = time.monotonic()
    directory = ROOT / 'data' / job
    audio = directory / 'stem-lead.wav'
    dense_path = directory / 'dense-voice-audit/contours.npz'
    fcpe_path = directory / 'lead-identity/lead-models/vocals-fcpe.npz'
    source_paths = [audio, dense_path, fcpe_path, directory / 'status.json']
    hashes = {str(path.relative_to(ROOT)): sha(path) for path in source_paths}
    duration = sf.info(audio).duration
    left, right = max(0, start - .25), min(duration, end + .25)
    context = load_slice(audio, left, right)
    with torch.inference_mode():
        f0_context = model.infer_from_audio(context, thred=THRESHOLD)
    times_context = left + np.arange(len(f0_context)) * HOP
    keep = (times_context >= start - 1e-7) & (times_context < end - 1e-7)
    f0, times = f0_context[keep], times_context[keep]
    y = load_slice(audio, start, end)
    rms, acf, concentration = acoustic_support(y, f0)
    dense, fcpe = np.load(dense_path), np.load(fcpe_path)
    fcpe_f0 = nearest(times, fcpe['time'], fcpe['f0'])
    activation = nearest(times, fcpe['time'], fcpe['activation'])
    crepe_f0 = nearest(times, dense['time'], dense['crepeF0'])
    periodicity = nearest(times, dense['time'], dense['periodicity'])
    # Frozen independent energy gate matches the prior audit, keeping raw results too.
    audible = nearest(times, dense['time'], dense['audible']).astype(bool)
    voiced = {'rmvpe': f0 > 0, 'fcpe': (fcpe_f0 > 55) & (activation >= .03), 'crepe': (crepe_f0 > 55) & (periodicity >= .3)}
    candidates = {'rmvpe': f0, 'fcpe': fcpe_f0, 'crepe': crepe_f0}
    comparisons = {}
    for other in ('fcpe', 'crepe'):
        joint = voiced['rmvpe'] & voiced[other] & audible
        cents = 1200 * np.abs(np.log2(np.maximum(f0[joint], 1) / np.maximum(candidates[other][joint], 1)))
        comparisons[other] = {'jointAudibleSeconds': round(float(joint.sum() * HOP), 3), 'medianAbsoluteCents': median(cents), 'within50CentsFraction': round(float(np.mean(cents <= 50)), 5) if len(cents) else None, 'over600CentsSeconds': round(float(np.sum(cents > 600) * HOP), 3)}
    newly_fcpe = voiced['rmvpe'] & ~voiced['fcpe']
    newly_both = newly_fcpe & ~voiced['crepe']
    masks = {'allRmvpeVoiced': voiced['rmvpe'], 'newVsFcpePreEnergy': newly_fcpe, 'newVsFcpePreEnergyAudible': newly_fcpe & audible, 'newVsBothPreEnergyAudible': newly_both & audible, 'rmvpeInPriorLowEnergy': voiced['rmvpe'] & ~audible, 'rmvpeOnLiteralFcpeZero': voiced['rmvpe'] & (fcpe_f0 == 0), 'rmvpeOnLiteralFcpeZeroAudible': voiced['rmvpe'] & (fcpe_f0 == 0) & audible}
    target = OUTPUT / job / split
    target.mkdir(parents=True, exist_ok=True)
    sf.write(target / 'lead-source-slice.wav', y, SR, subtype='FLOAT')
    np.savez_compressed(target / 'contours.npz', sourceTime=times, rmvpeF0=f0, fcpeF0=fcpe_f0, activation=activation, crepeF0=crepe_f0, periodicity=periodicity, priorAudible=audible, rms=rms, acfAtRmvpePeriod=acf, harmonicEnergyFraction=concentration)
    assert all(sha(ROOT / path) == digest for path, digest in hashes.items())
    assert len(f0) == round((end - start) / HOP) and np.isfinite(f0).all()
    row = {'song': name, 'job': job, 'split': split, 'sourceRangeSeconds': [start, end], 'contextRangeSeconds': [left, right], 'frames': len(times), 'literalFcpeZeroFrames': int(np.sum(fcpe_f0 == 0)), 'literalNonzeroSeconds': {key: round(float(np.sum(value > 0) * HOP), 3) for key, value in candidates.items()}, 'preEnergyVoicedSeconds': {key: round(float(value.sum() * HOP), 3) for key, value in voiced.items()}, 'priorAudibleSeconds': round(float(audible.sum() * HOP), 3), 'lostFcpeAudibleSeconds': round(float(np.sum(voiced['fcpe'] & ~voiced['rmvpe'] & audible) * HOP), 3), 'audibleVoicedSeconds': {key: round(float(np.sum(value & audible) * HOP), 3) for key, value in voiced.items()}, 'modelDisagreementNotAccuracy': comparisons, 'waveformDiagnosticsNotTruth': {key: summarize_support(mask, rms, acf, concentration) for key, mask in masks.items()}, 'inputHashes': hashes, 'inputsUnchangedAfterProbe': True, 'details': str(target.relative_to(ROOT) / 'contours.npz'), 'detailsSha256': sha(target / 'contours.npz'), 'sourceSliceSha256': sha(target / 'lead-source-slice.wav'), 'runtimeSeconds': round(time.monotonic() - started, 3)}
    print(json.dumps({key: row[key] for key in ('song', 'split', 'preEnergyVoicedSeconds', 'audibleVoicedSeconds', 'runtimeSeconds')}, ensure_ascii=False), flush=True)
    return row


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    definitions, fixture_truth = fixtures()  # Truth frozen before neural model loading.
    weight = REFS / 'rmvpe.pt'
    assert weight.stat().st_size == 181184272
    weight_hash = sha(weight)
    assert weight_hash == '6d62215f4306e3ca278246188607209f09af3dc77ed4232efdd069798c4ec193'
    review = json.loads((REFS / 'review-metadata.json').read_text())
    for name, actual in [('rmvpe.py', REFS / 'rvc/infer/rmvpe.py'), ('cuda_graph.py', REFS / 'rvc/tools/cuda_graph.py')]:
        assert sha(actual) == review['publicReferenceFiles'][name]
    assert tuple(map(int, torch.__version__.split('+')[0].split('.')[:2])) >= (2, 10)
    torch.set_num_threads(4)
    sys.path.insert(0, str(REFS / 'rvc'))
    from infer.rmvpe import RMVPE
    started = time.monotonic()
    model = RMVPE(str(weight), is_half=False, device='cpu')
    report = {'method': 'Optional RMVPE CPU fixed threshold .03; no score or default changes', 'groundTruthAvailableForSongs': False, 'maskMeaning': {'literalNonzero': 'F0 > 0, no activation/periodicity gate; CREPE may emit frequency on unvoiced audio', 'preEnergy': 'RMVPE F0>0 after fixed .03 decoder; FCPE F0>55 and activation>=.03; CREPE F0>55 and periodicity>=.3', 'audible': 'Nearest saved full-song dense-audit energy mask, independent of model-specific voicing gates', 'newVsFcpePreEnergy': 'RMVPE voiced and FCPE preEnergy gate false; includes nonzero FCPE with low activation', 'rmvpeOnLiteralFcpeZero': 'RMVPE voiced where saved FCPE frequency is exactly zero, independent of activation'}, 'threshold': THRESHOLD, 'thresholdSweep': False, 'torch': torch.__version__, 'torchThreads': 4, 'weightStrictStateDictLoadSucceeded': True, 'defaultsOrOriginalProjectsModified': False, 'weightsOnlyForced': True, 'weightSha256': weight_hash, 'weightBytes': weight.stat().st_size, 'sourceRevision': review['rvcRevision'], 'codeSha256': sha(Path(__file__)), 'fixtureTruthManifestSha256': sha(OUTPUT / 'fixtures/truth.json'), 'fixtures': run_fixtures(model, definitions), 'real': [], 'scope': 'Constructed waveform truth supports fixture accuracy only. Real-song comparisons measure saved-model coverage/disagreement, not correctness. ACF/harmonic support can be fooled by octave or accompaniment leakage and cannot establish main-singer identity.'}
    cases = [(JOBS[1][0], JOBS[1][1], 'focus-missing-f0', 130., 135.), (JOBS[1][0], JOBS[1][1], 'low-energy-negative', 20., 25.)]
    cases += [(name, job, split, start, end) for name, job in JOBS for split, start, end in [('development', 0., 32.), ('temporal-heldout', 110., 140.)]]
    for args in cases:
        report['real'].append(run_real(model, *args))
        report['runtimeSeconds'] = round(time.monotonic() - started, 3)
        save_json(REPORT, report)
    report['complete'] = True
    save_json(REPORT, report)


if __name__ == '__main__':
    main()

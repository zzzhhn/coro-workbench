"""Remove a corroborated piano partial from an anonymous string candidate."""
from collections import defaultdict

import numpy as np

from .string_sustain import STRINGS


VERSION = 'piano-harmonic-ownership-1'
_STRING_PROOF = {'sustained_harmonics', 'independent_accompaniment_tail'}


def _by_pitch(notes):
    grouped = defaultdict(list)
    for note in notes:
        grouped[note['midi']].append(note)
    return grouped


def _overlap(a, b):
    return min(a['end'], b['end']) - max(a['start'], b['start'])


def measure_piano_partial(paths, mixture_path, note, multiple):
    """Keep channels separate while comparing phase and residual energy."""
    import soundfile as sf
    from scipy.signal.windows import hann

    start, end = note['start'], note['end']
    duration = end - start
    if not .14 <= duration <= 2.9 or multiple not in (2, 4):
        return None
    frequency = 440 * 2 ** ((note['midi'] - 69) / 12)
    # Require six cycles of the proposed lower fundamental per Hann window.
    rate, size = 44100, 4096
    if (frequency / multiple) * size / rate < 6 or frequency >= rate / 2:
        return None
    first = round(max(0, start - .11) * rate)
    frames = round((end + .11) * rate) - first
    offsets = np.arange(.035, duration + .05, .01)
    times = np.round((start + offsets) * rate).astype(int) - first
    samples = np.arange(size) - size // 2
    indices = times[:, None] + samples
    if indices.min() < 0 or indices.max() >= frames:
        return None
    carrier = np.exp(-2j * np.pi * frequency / multiple / rate * samples)
    window = hann(size, sym=False)
    kernels = np.stack([window * carrier, window * carrier ** multiple]) / window.sum()
    features = {}
    geometry = None
    for name, path in [('mix', mixture_path), ('piano', paths['piano']), ('other', paths['other'])]:
        with sf.SoundFile(path) as stream:
            actual = (stream.samplerate, stream.channels, stream.frames)
            if actual[:2] != (rate, 2) or first + frames > stream.frames:
                return None
            if geometry is not None and geometry != actual:
                return None
            geometry = actual
            stream.seek(first)
            audio = stream.read(frames, dtype='float32', always_2d=True)
        if len(audio) != frames or not np.isfinite(audio).all():
            return None
        features[name] = np.einsum('ntc,ht->hnc', audio[indices], kernels)
    phase = {}
    for name in ('mix', 'piano'):
        lower, target = features[name]
        product = target * np.conj(lower) ** multiple
        phase[name] = abs(product.sum(axis=0)) / (abs(product).sum(axis=0) + 1e-12)
    piano = features['piano'][1]
    residual = features['mix'][1] - piano
    other = features['other'][1]
    piano_peak = float(np.linalg.norm(piano, axis=1).max())
    if piano_peak < .001:
        return None
    return {
        'sharedPhaseLock': float(np.minimum(phase['mix'], phase['piano']).max()),
        'mixturePhaseByChannel': phase['mix'].tolist(),
        'pianoPhaseByChannel': phase['piano'].tolist(),
        'pianoTargetPeak': piano_peak,
        'residualToPianoRms': float(np.linalg.norm(residual) / np.linalg.norm(piano)),
        'residualToPianoPeak': float(np.linalg.norm(residual, axis=1).max() / piano_peak),
        'otherToPianoPeak': float(np.linalg.norm(other, axis=1).max() / piano_peak),
    }


def reconcile_piano_harmonic_leaks(events, native_events, piano_stem, piano_mixture,
                                  instrumental_events, paths, mixture_path, *, measure=measure_piano_partial):
    """Suppress only an existing lower piano note's coherent upper partial."""
    roots = _by_pitch(n for n in native_events if n['program'] in (0, 2) and not n['isDrum'])
    retained_piano = _by_pitch(n for n in events if n['program'] in (0, 2) and not n['isDrum'])
    stem = _by_pitch(n for n in piano_stem if n.get('activation', 0.) >= .8)
    mixture = _by_pitch(n for n in piano_mixture if n.get('activation', 0.) >= .8)
    strings = _by_pitch(n for n in instrumental_events if n['program'] in STRINGS and not n['isDrum'])
    kept, decisions = [], []
    measured_candidates = 0
    for note in events:
        start, end, pitch = note['start'], note['end'], note['midi']
        if (note['program'] not in STRINGS or note['isDrum'] or note.get('sourceId')
                or not .14 <= end - start <= 2.9 or _STRING_PROOF.intersection(note.get('evidenceOrigins', []))
                or any(abs(n['start'] - start) <= .12 and _overlap(n, note) >= .65 * (end - start)
                       for n in strings[pitch])):
            kept.append(note)
            continue
        for shift, multiple in ((12, 2), (24, 4)):
            lower_pitch = pitch - shift
            supports = [min((n for n in model[lower_pitch] if abs(n['start'] - start) <= .08),
                            key=lambda n: abs(n['start'] - start), default=None) for model in (stem, mixture)]
            if not all(supports):
                continue
            root = next((n for n in roots[lower_pitch] if abs(n['start'] - start) <= .05
                         and _overlap(n, note) > 0
                         and all(abs(s['start'] - n['start']) <= .08 for s in supports)
                         and any(abs(p['start'] - n['start']) <= .05 and _overlap(p, note) > 0
                                 for p in retained_piano[lower_pitch])), None)
            if root is None:
                continue
            measured_candidates += 1
            acoustics = measure(paths, mixture_path, note, multiple)
            if (acoustics and all(np.isfinite(acoustics[k]) for k in
                                 ('sharedPhaseLock', 'residualToPianoRms', 'residualToPianoPeak', 'otherToPianoPeak'))
                    and acoustics['sharedPhaseLock'] >= .90 and acoustics['residualToPianoRms'] <= .25
                    and acoustics['residualToPianoPeak'] <= .25 and acoustics['otherToPianoPeak'] <= .25):
                decisions.append({'action': 'remove_piano_harmonic_label', 'before': note, 'pianoRoot': root,
                                  'pianoViews': supports, 'harmonic': multiple, 'acoustics': acoustics})
                break
        else:
            kept.append(note)
    return kept, {'version': VERSION, 'removedHarmonicAliases': len(decisions),
                  'examinedCandidates': measured_candidates, 'decisions': decisions,
                  'claimsWholeSongInstrumentTruth': False}

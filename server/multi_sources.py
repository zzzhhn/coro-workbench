"""Source-aware note proposals. Native evidence and ambiguous notes stay intact.

Separation labels are broad acoustic targets, not performer identities. The
human score is never an input. Harmonic source shares are leakage checks, not
calibrated confidence or proof that an instrument exists.
"""
from __future__ import annotations

from collections import Counter
import copy
import hashlib
import json
from pathlib import Path

import numpy as np

VERSION = 'multiscore-sources-1'
ONSET_TOLERANCE = .12


def notation_key(events: list[dict], fallback: str) -> tuple[str, dict]:
    """Check a global signature against fundamentals, not waveform harmonics.

    A limited duration weight keeps pedal tails from dominating. Ambiguous or
    short excerpts retain the audio estimate; pitches are never transposed.
    """
    pitched = [n for n in events if not n['isDrum']]
    if len(pitched) < 32:
        return fallback, {'accepted': False, 'reason': 'insufficient_notes'}
    histogram = np.zeros(12)
    for n in pitched:
        histogram[n['midi'] % 12] += min(.8, max(.08, n['end'] - n['start']))
    major = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
    minor = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
    names = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
    if np.std(histogram) < 1e-9:
        return fallback, {'accepted': False, 'reason': 'flat_pitch_classes'}
    candidates = sorted([{'key': names[root] + suffix,
        'correlation': float(np.corrcoef(histogram, np.roll(profile, root))[0, 1])}
        for profile, suffix in ((major, ''), (minor, 'm')) for root in range(12)],
        key=lambda item: item['correlation'], reverse=True)
    accepted = candidates[0]['correlation'] >= .75 and candidates[0]['correlation'] - candidates[1]['correlation'] >= .08
    return candidates[0]['key'] if accepted else fallback, {
        'accepted': accepted, 'audioEstimate': fallback, 'candidates': candidates[:3],
        'method': 'Duration-capped decoded fundamental pitch-class profile; no transposition or modulation claim'}


def harmonic_source_evidence(paths: dict[str, Path], output: Path) -> dict:
    """Measure equal-time/equal-pitch energy in all six separation outputs.

Process one mono stem at a time, retaining only 128 pitch-band envelopes.
The cache is keyed by waveform content, not by the existence of models.json.
"""
    import librosa
    import soundfile as sf
    manifest = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in paths.items()}
    signature = {'version': VERSION, 'sha256': manifest, 'sampleRate': 16000, 'hop': 160, 'fft': 4096}
    metadata = output.with_suffix('.json')
    if output.is_file() and metadata.is_file() and json.loads(metadata.read_text()) == signature:
        with np.load(output, allow_pickle=False) as archive:
            return {key: archive[key] for key in archive.files}
    result = {}
    frequencies = np.fft.rfftfreq(4096, 1 / 16000)
    bands = []
    for pitch in range(128):
        f0 = 440 * 2 ** ((pitch - 69) / 12)
        bands.append([(np.flatnonzero(abs(frequencies - f0 * h) <= max(4., f0 * h * .018)), 1 / h)
                      for h in range(1, 6) if f0 * h < 7900])
    lengths = set()
    for name, path in paths.items():
        audio, sr = sf.read(path, dtype='float32', always_2d=True)
        audio = librosa.resample(audio.mean(axis=1), orig_sr=sr, target_sr=16000)
        spectrum = abs(librosa.stft(audio, n_fft=4096, hop_length=160)) ** 2
        envelopes = np.zeros((128, spectrum.shape[1]), dtype=np.float32)
        for pitch, harmonics in enumerate(bands):
            for indices, weight in harmonics:
                if len(indices):
                    envelopes[pitch] += spectrum[indices].mean(axis=0) * weight
        result[name] = envelopes
        lengths.add(envelopes.shape[1])
    if len(lengths) != 1:
        raise ValueError('Separated sources must share the same complete timebase')
    output.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(output, **result)
    metadata.write_text(json.dumps(signature, indent=2))
    return result


def source_share(envelopes: dict, source: str, event: dict) -> float:
    if source not in envelopes:
        return 0.
    # Avoid the release/reverb tail; compare a short pitched attack window.
    a = max(0, round((event['start'] + .025) * 100))
    b = max(a + 1, round(min(event['end'], event['start'] + .20) * 100))
    pitch = int(event['midi'])
    energy = {name: float(np.mean(values[pitch, a:b])) if a < values.shape[1] else 0.
              for name, values in envelopes.items()}
    return energy[source] / max(sum(energy.values()), 1e-12)


def _same_attack(a: dict, b: dict) -> bool:
    return a['midi'] == b['midi'] and abs(a['start'] - b['start']) <= ONSET_TOLERANCE


def _same_sustain(a: dict, b: dict) -> bool:
    overlap = min(a['end'], b['end']) - max(a['start'], b['start'])
    return a['midi'] == b['midi'] and overlap >= .5 * min(a['end'] - a['start'], b['end'] - b['start'])


def piano_finger_durations(events: list[dict], pedals: list[dict]) -> tuple[list[dict], list[dict]]:
    """Separate a regular keyboard run's written gate from pedal resonance.

    Require three consecutive single attacks in the same register and a
    measured pedal interval. Rolled chords and independent sustained voices
    are not blanket-cut at every subsequent note.
    """
    identities = {(n['program'], n.get('sourceId')) for n in events}
    if len(identities) > 1:
        output, edits = [], []
        for identity in sorted(identities, key=str):
            subset = [n for n in events if (n['program'], n.get('sourceId')) == identity]
            result, changes = piano_finger_durations(subset, pedals)
            output.extend(result)
            edits.extend(changes)
        return sorted(output, key=lambda n: (n['start'], n['program'], n['midi'])), edits
    result = [dict(n) for n in events]
    changes = []
    # Also follow a single arpeggio that passes between the hands.
    for hand in (None, 0, 1):
        notes = sorted([n for n in result if n['program'] in (0, 2)
                        and not n['isDrum'] and (hand is None or (n['midi'] >= 60) == bool(hand))], key=lambda n: n['start'])
        groups = []
        for note in notes:
            if groups and note['start'] - groups[-1][-1]['start'] <= .10 and note['start'] - groups[-1][0]['start'] <= .26:
                groups[-1].append(note)
            else:
                groups.append([note])
        eligible = set()
        for i in range(len(groups) - 2):
            a, b, c = groups[i:i + 3]
            gaps = [b[0]['start'] - a[0]['start'], c[0]['start'] - b[0]['start']]
            if all(len(g) == 1 for g in (a, b, c)) and .18 <= min(gaps) <= max(gaps) <= 1.1 and max(gaps) / min(gaps) <= 1.2:
                eligible.update((i, i + 1))
                # Last attack can lead into the next harmony at the same pace.
                if i + 3 < len(groups) and abs(groups[i + 3][0]['start'] - c[0]['start'] - sum(gaps) / 2) <= .15:
                    eligible.add(i + 2)
        for i in sorted(eligible):
            note, next_start = groups[i][0], groups[i + 1][0]['start']
            if note['end'] - next_start < .15 or not any(p['onset_time'] - .35 <= note['start'] <= p['offset_time'] for p in pedals):
                continue
            before = note['end']
            note['acousticEnd'] = before
            note['end'] = next_start
            changes.append({'start': note['start'], 'midi': note['midi'], 'acousticEnd': before,
                            'scoreEnd': next_start, 'reason': 'regular_run_under_measured_pedal'})
    return result, changes


def fuse_sources(native: list[dict], piano: list[dict], vocals: list[dict], envelopes: dict) -> dict:
    """Keep unilateral native notes; admit source-supported complementary notes.

    Reclassify only with a matching independent attack and a dominant target
    source. If both piano and voice have source support, preserve the unison.
    No reference pitches, score density target, or expected instrument count.
    """
    events = [dict(event, evidenceOrigins=['yourmt3_mix']) for event in native]
    decisions, review = [], []
    strong_piano = []
    for index, note in enumerate(piano):
        share = source_share(envelopes, 'piano', note)
        accepted = note['end'] - note['start'] >= .09 and note.get('activation', 0) >= .65 and share >= .55
        (strong_piano if accepted else review).append(note if accepted else {
            'model': 'piano_crnn', 'index': index, 'event': note, 'sourceShare': share,
            'reason': 'insufficient_source_or_attack_support'})
    strong_vocals = []
    for index, note in enumerate(vocals):
        share = source_share(envelopes, 'vocals', note)
        accepted = note['end'] - note['start'] >= .09 and share >= .65
        (strong_vocals if accepted else review).append(note if accepted else {
            'model': 'phoneme_fcpe', 'index': index, 'event': note, 'sourceShare': share,
            'reason': 'insufficient_vocal_source_support'})
    for source, candidates, programs, target, model, competing in [
        ('piano', strong_piano, (0, 2), 0, 'piano_crnn', strong_vocals),
        ('vocals', strong_vocals, (100, 101), 100, 'phoneme_fcpe', strong_piano),
    ]:
        for note in sorted(candidates, key=lambda n: (n['start'], n['midi'])):
            matches = [e for e in events if not e['isDrum'] and _same_attack(note, e)
                       and e.get('sourceId') in (None, source)]
            own = [e for e in matches if e['program'] in programs]
            if own:
                nearest = min(own, key=lambda e: abs(e['start'] - note['start']))
                if model not in nearest['evidenceOrigins']:
                    nearest['evidenceOrigins'].append(model)
                continue
            # The monophonic vocal model can split a sustained native note at
            # a phoneme boundary. This is not evidence for a second instrument.
            if source == 'vocals' and any(e['program'] in programs and e.get('sourceId') in (None, source)
                                          and _same_sustain(note, e) for e in events):
                review.append({'model': model, 'event': note, 'reason': 'overlapping_same_pitch_native_vocal'})
                continue
            if source == 'vocals' and any(e['program'] in programs
                    and min(e['end'], note['end']) - max(e['start'], note['start']) > .08 for e in events):
                review.append({'model': model, 'event': note, 'reason': 'conflicting_vocal_line_requires_identity_check'})
                continue
            if source == 'piano' and any(e['program'] in programs
                    and abs(e['start'] - note['start']) <= ONSET_TOLERANCE
                    and abs(e['midi'] - note['midi']) in (12, 19, 24, 28, 31, 36) for e in events):
                # A dedicated piano model also detects harmonics/subharmonics.
                # Source dominance alone cannot establish an octave doubling.
                review.append({'model': model, 'event': note, 'reason': 'possible_harmonic_doubling'})
                continue
            competing_support = any(_same_attack(note, other) for other in competing)
            transferable = [e for e in matches if not competing_support
                            and min(source_share(envelopes, source, e), source_share(envelopes, source, note)) >= .75]
            if transferable:
                event = min(transferable, key=lambda e: abs(e['start'] - note['start']))
                before = copy.deepcopy(event)
                event['program'] = target
                event['evidenceOrigins'].append(model)
                decisions.append({'action': 'reclassify', 'before': before, 'after': copy.deepcopy(event),
                                  'source': source, 'sourceShare': source_share(envelopes, source, note)})
            else:
                event = {k: note[k] for k in ('start', 'end', 'midi')}
                event.update(program=target, isDrum=False, evidenceOrigins=[model],
                             velocity=note.get('velocity', .75))
                events.append(event)
                decisions.append({'action': 'add', 'after': dict(event), 'source': source,
                                  'sourceShare': source_share(envelopes, source, note),
                                  'unisonPreserved': bool(matches)})
    # Identity belongs to a separation target, never to a model/channel. All
    # estimates of that target stay in one part, with polyphonic rhythms intact.
    for event in events:
        if event.get('sourceId'):
            continue
        if event['program'] in (0, 2):
            event.update(sourceId='piano', sourceLabel='钢琴分离轨')
        elif event['program'] in (100, 101):
            event.update(sourceId='vocals', sourceLabel='人声分离轨')
    return {'events': sorted(events, key=lambda e: (e['start'], e['program'], e['midi'])),
            'sourceRefinement': {'version': VERSION, 'nativeEvents': len(native),
                'outputEvents': len(events), 'actions': dict(Counter(d['action'] for d in decisions)),
                'decisions': decisions, 'reviewCandidates': review,
                'independentCandidates': {'piano': len(piano), 'vocals': len(vocals)},
                'sourceSupportedCandidates': {'piano': len(strong_piano), 'vocals': len(strong_vocals)},
                'thresholds': {'onsetSeconds': ONSET_TOLERANCE, 'pianoOnsetActivation': .65,
                               'pianoSourceShare': .55, 'vocalSourceShare': .65, 'reclassifySourceShare': .75},
                'claimsIndividualPerformerIdentity': False, 'groundTruthAvailable': False}}

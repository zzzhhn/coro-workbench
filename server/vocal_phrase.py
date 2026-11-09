"""Notate short sung syllables using measured articulation, retaining raw F0 ends."""
from pathlib import Path
import numpy as np

from .lead_note_proposal import runs

VERSION = 'vocal-articulation-gaps-1'


def recover_articulation_gaps(events, times, frequency, activation, rms):
    times, frequency, activation, rms = map(np.asarray, (times, frequency, activation, rms))
    if (times.ndim != 1 or len(times) < 2 or any(a.shape != times.shape for a in (frequency, activation, rms))
            or not np.all(np.isfinite(times)) or np.any(np.diff(times) <= 0)
            or not np.all(np.isfinite(rms)) or np.any(rms < 0)):
        raise ValueError('Invalid articulation evidence')
    hop = float(np.median(np.diff(times)))
    voiced = np.isfinite(frequency) & (frequency > 0) & (activation >= .03)
    midi = 69 + 12 * np.log2(np.where(voiced, frequency, np.nan) / 440)
    output = [dict(n) for n in events]
    audit = dict(version=VERSION, edits=[], claimsPitchTruth=False,
                 minimumQuietBreathSeconds=.18, preservesAcousticBoundaries=True)
    for index, (note, following) in enumerate(zip(events, events[1:])):
        start, end, next_start = note['source_start_seconds'], note['source_end_seconds'], following['source_start_seconds']
        if (not .09 <= end - start <= .22 or not .10 <= next_start - end <= .55
                or next_start - start > .75 or note['midi_pitch'] == following['midi_pitch']):
            continue
        mask = (times >= start) & (times < next_start)
        local_times = times[mask]
        if (len(local_times) < 2 or local_times[0] - start > .025 or next_start - local_times[-1] > .025
                or np.any(np.diff(local_times) > .031)):
            continue
        own = (times >= start) & (times < end) & (activation >= .5) & (np.abs(midi - note['midi_pitch']) <= .65)
        target = ((times >= next_start) & (times < min(following['source_end_seconds'], next_start + .4))
                  & (activation >= .5) & (np.abs(midi - following['midi_pitch']) <= .65))
        if own.sum() * hop < .06 - 1e-7 or target.sum() * hop < .08 - 1e-7:
            continue
        reference = float(np.quantile(rms[own], .75))
        if reference < .002:
            continue
        # Missing F0 alone cannot establish a breath. Quiet AND unvoiced is
        # the same evidence used by the upstream phoneme breath splitter.
        quiet = (~voiced[mask]) & (rms[mask] <= max(.001, reference * .15))
        longest_quiet = max(((right - left) * hop for left, right, flag in runs(quiet) if flag), default=0.)
        if longest_quiet >= .18 - 1e-7:
            continue
        gap = (times >= end) & (times < next_start)
        foreign = ((activation[gap] >= .5) & (np.abs(midi[gap] - note['midi_pitch']) > .8)
                   & (np.abs(midi[gap] - following['midi_pitch']) > .8))
        if any((right - left) * hop >= .12 - 1e-7 for left, right, flag in runs(foreign) if flag):
            continue
        output[index]['notation_end_seconds'] = next_start
        audit['edits'].append(dict(sourceEvent=dict(note), notationEndSeconds=next_start,
                                  maximumQuietUnvoicedSeconds=round(longest_quiet, 6),
                                  reason='short_voiced_body_with_measured_articulation_to_next_syllable'))
    return output, audit


def recover_articulation_from_files(events, audio, contour, *, duration):
    """Read only candidate neighborhoods, not another whole-song model pass."""
    import soundfile as sf
    from .phoneme import _load_contour, _validate_events
    _validate_events(events, duration)
    times, frequency, activation = _load_contour(Path(contour), duration)
    rms = np.zeros(len(times))
    with sf.SoundFile(audio) as waveform:
        if abs(waveform.frames / waveform.samplerate - duration) > 1 / waveform.samplerate:
            raise ValueError('Articulation waveform duration mismatch')
        sr = waveform.samplerate
        for note, following in zip(events, events[1:]):
            start, end, next_start = note['source_start_seconds'], note['source_end_seconds'], following['source_start_seconds']
            if not (.09 <= end - start <= .22 and .10 <= next_start - end <= .55 and next_start - start <= .75):
                continue
            left = max(0, int((start - .03) * sr))
            right = min(waveform.frames, int((following['source_start_seconds'] + .43) * sr))
            waveform.seek(left)
            y = waveform.read(right - left, dtype='float32', always_2d=True).mean(axis=1)
            indices = np.flatnonzero((times >= start) & (times < following['source_start_seconds'] + .4))
            centers = np.clip(np.rint(times[indices] * sr).astype(int) - left, 0, len(y) - 1)
            half = max(1, round(.015 * sr))
            a, b = np.maximum(0, centers - half), np.minimum(len(y), centers + half + 1)
            prefix = np.r_[0., np.cumsum(np.square(y, dtype=np.float64))]
            rms[indices] = np.sqrt((prefix[b] - prefix[a]) / np.maximum(1, b - a))
    return recover_articulation_gaps(events, times, frequency, activation, rms)

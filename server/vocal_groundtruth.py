"""Independent human-reference vocal metrics; no model or app dependencies.

F0 metrics follow binary melody conventions on explicitly aligned arrays. The
resampler is deliberately gap-safe: reference zeros and missing-time gaps never
become interpolated pitch. Note matches use maximum-cardinality one-to-one
bipartite matching. Both human note versions must be reported separately.
"""
from __future__ import annotations

import numpy as np


def _vector(value, name):
    result = np.asarray(value, dtype=float)
    if result.ndim != 1:
        raise ValueError(f"{name} must be a vector")
    return result


def _binary(value, name):
    result = _vector(value, name)
    if not np.all(np.isfinite(result)) or not np.all((result == 0) | (result == 1)):
        raise ValueError(f"{name} must contain binary values")
    return result.astype(bool)


def _ratio(numerator, denominator):
    return float(numerator / denominator) if denominator else None


def f0_metrics(reference_f0, estimated_f0, *, reference_voicing=None, estimated_voicing=None, cents_tolerance=50.):
    """Score equal-time arrays; negative estimatedHz means unvoiced pitch prior.

    Raw pitch/chroma ignore estimated voicing while overall accuracy requires it.
    Undefined denominators returnNone. Counts allow exact micro aggregation and
    an external checker to independently recompute every score.
    """
    ref, est = _vector(reference_f0, "reference_f0"), _vector(estimated_f0, "estimated_f0")
    if ref.shape != est.shape or not len(ref):
        raise ValueError("Reference and estimate must have equal nonempty shapes")
    if not np.all(np.isfinite(ref)) or np.any(ref < 0) or np.any(np.isinf(est)):
        raise ValueError("ReferenceHz must be finite/nonnegative; estimatedHz may beNaN but not infinite")
    if not np.isfinite(cents_tolerance) or cents_tolerance <= 0:
        raise ValueError("Pitch tolerance must be positive")
    est = np.nan_to_num(est, nan=0.)
    ref_voiced = ref > 0 if reference_voicing is None else _binary(reference_voicing, "reference_voicing") & (ref > 0)
    est_voiced = est > 0 if estimated_voicing is None else _binary(estimated_voicing, "estimated_voicing") & (est != 0)
    if ref_voiced.shape != ref.shape or est_voiced.shape != ref.shape:
        raise ValueError("Voicing arrays differ from pitch arrays")
    estimate_pitch = abs(est)
    common_pitch = (ref > 0) & (estimate_pitch > 0)
    distance = np.full(len(ref), np.inf)
    distance[common_pitch] = abs(1200 * np.log2(estimate_pitch[common_pitch] / ref[common_pitch]))
    pitch_correct = ref_voiced & (distance < cents_tolerance)
    chroma_distance = np.full(len(ref), np.inf)
    chroma_distance[common_pitch] = abs((distance[common_pitch] + 600) % 1200 - 600)
    chroma_correct = ref_voiced & (chroma_distance < cents_tolerance)
    counts = {
        "frames": len(ref), "referenceVoiced": int(ref_voiced.sum()), "referenceUnvoiced": int((~ref_voiced).sum()),
        "estimatedVoiced": int(est_voiced.sum()), "voicingTruePositive": int((ref_voiced & est_voiced).sum()),
        "voicingFalsePositive": int((~ref_voiced & est_voiced).sum()),
        "rawPitchCorrect": int(pitch_correct.sum()), "rawChromaCorrect": int(chroma_correct.sum()),
        "overallCorrect": int(((pitch_correct & est_voiced) | (~ref_voiced & ~est_voiced)).sum()),
    }
    return {"overallAccuracy": _ratio(counts["overallCorrect"], counts["frames"]), "voicingRecall": _ratio(counts["voicingTruePositive"], counts["referenceVoiced"]), "voicingFalseAlarm": _ratio(counts["voicingFalsePositive"], counts["referenceUnvoiced"]), "rawPitchAccuracy": _ratio(counts["rawPitchCorrect"], counts["referenceVoiced"]), "rawChromaAccuracy": _ratio(counts["rawChromaCorrect"], counts["referenceVoiced"]), "counts": counts}


def resample_f0_track(times, frequencies, query_times, *, voicing=None):
    """LogHz interpolation confined to positive-pitch runs and owned sample cells.

    Positive runs split at explicit zero/NaN pitch and gaps>1.5median source hop.
    End samples hold only inside their half-sample cells, never across a zero.
    Estimated negativeHz retains a raw pitch hypothesis but has false voicing.
    """
    times, source, query = _vector(times, "times"), _vector(frequencies, "frequencies"), _vector(query_times, "query_times")
    if times.shape != source.shape or not len(times) or not np.all(np.isfinite(times)) or np.any(np.diff(times) <= 0):
        raise ValueError("Track times must be finite, strictly increasing and match frequencies")
    if not np.all(np.isfinite(query)) or np.any(np.diff(query) < 0) or np.any(np.isinf(source)):
        raise ValueError("Query times must be finite/ordered; frequencies cannot be infinite")
    source = np.nan_to_num(source, nan=0.)
    source_voicing = source > 0 if voicing is None else _binary(voicing, "voicing") & (source != 0)
    if source_voicing.shape != source.shape:
        raise ValueError("Voicing shape differs from track")
    pitch = abs(source)
    hop = float(np.median(np.diff(times))) if len(times) > 1 else .01
    result = np.zeros(len(query))
    active = pitch > 0
    start = 0
    while start < len(times):
        if not active[start]:
            start += 1
            continue
        stop = start + 1
        while stop < len(times) and active[stop] and times[stop] - times[stop - 1] <= 1.5 * hop + 1e-12:
            stop += 1
        before = times[start] - times[start - 1] if start else hop
        after = times[stop] - times[stop - 1] if stop < len(times) else hop
        left = times[start] - (before / 2 if before <= 1.5 * hop + 1e-12 else hop / 2)
        right = times[stop - 1] + (after / 2 if after <= 1.5 * hop + 1e-12 else hop / 2)
        selected = (query >= round(left, 12)) & (query < round(right, 12))
        if selected.any():
            result[selected] = np.exp(np.interp(query[selected], times[start:stop], np.log(pitch[start:stop])))
        start = stop
    if len(times) == 1:
        index = np.zeros(len(query), dtype=int)
    else:
        midpoints = np.round((times[:-1] + times[1:]) / 2, 12)
        index = np.searchsorted(midpoints, query, side="right")
    resampled_voicing = source_voicing[index] & (result > 0)
    return result, resampled_voicing


def align_f0_tracks(reference_times, reference_f0, estimated_times, estimated_f0, *, duration_seconds, hop_seconds=.01, estimated_voicing=None):
    if not np.isfinite(duration_seconds) or duration_seconds <= 0 or not np.isfinite(hop_seconds) or hop_seconds <= 0:
        raise ValueError("Duration and grid hop must be positive")
    query = np.arange(int(np.ceil(duration_seconds / hop_seconds))) * hop_seconds
    query = np.round(query[query < duration_seconds], 12)
    ref, ref_voice = resample_f0_track(reference_times, reference_f0, query)
    est, est_voice = resample_f0_track(estimated_times, estimated_f0, query, voicing=estimated_voicing)
    return query, ref, ref_voice, est, est_voice


def evaluate_f0_track(reference_times, reference_f0, estimated_times, estimated_f0, *, duration_seconds, hop_seconds=.01, estimated_voicing=None):
    grid, ref, ref_voice, est, est_voice = align_f0_tracks(reference_times, reference_f0, estimated_times, estimated_f0, duration_seconds=duration_seconds, hop_seconds=hop_seconds, estimated_voicing=estimated_voicing)
    return {**f0_metrics(ref, est, reference_voicing=ref_voice, estimated_voicing=est_voice), "gridHopSeconds": hop_seconds, "gridFrames": len(grid), "timingAdjustmentSeconds": 0., "octaveAdjustment": False}


def validate_notes(notes):
    """Normalized note rows are onsetSeconds,offsetSeconds,frequencyHz."""
    notes = np.asarray(notes, dtype=float)
    if notes.size == 0:
        return np.empty((0, 3))
    if notes.ndim != 2 or notes.shape[1] != 3 or not np.all(np.isfinite(notes)):
        raise ValueError("Notes must be finite Nx3 onset/offset/Hz rows")
    if np.any(notes[:, 0] < 0) or np.any(notes[:, 1] <= notes[:, 0]) or np.any(notes[:, 2] <= 0):
        raise ValueError("Notes need nonnegative onset, later offset and positiveHz")
    return notes


def match_notes(reference_notes, estimated_notes, *, require_offset=True, onset_tolerance=.05, pitch_tolerance_cents=50., offset_ratio=.2, minimum_offset_tolerance=.05):
    """Independent deterministic augmenting-path maximum-cardinality matching."""
    ref, est = validate_notes(reference_notes), validate_notes(estimated_notes)
    if min(onset_tolerance, pitch_tolerance_cents, offset_ratio, minimum_offset_tolerance) < 0:
        raise ValueError("Note matching tolerances must be nonnegative")
    adjacency = []
    for onset, offset, pitch in ref:
        neighbors = []
        for index, (predicted_onset, predicted_offset, predicted_pitch) in enumerate(est):
            pitch_close = abs(1200 * np.log2(predicted_pitch / pitch)) <= pitch_tolerance_cents + 1e-8
            onset_close = round(abs(predicted_onset - onset), 4) <= onset_tolerance
            offset_close = round(abs(predicted_offset - offset), 4) <= max(minimum_offset_tolerance, offset_ratio * (offset - onset))
            if pitch_close and onset_close and (offset_close or not require_offset):
                neighbors.append(index)
        adjacency.append(neighbors)
    owner = {}

    def augment(reference_index, visited):
        for estimated_index in adjacency[reference_index]:
            if estimated_index in visited:
                continue
            visited.add(estimated_index)
            if estimated_index not in owner or augment(owner[estimated_index], visited):
                owner[estimated_index] = reference_index
                return True
        return False

    for index in range(len(ref)):
        augment(index, set())
    return sorted((reference_index, estimated_index) for estimated_index, reference_index in owner.items())


def note_metrics(reference_notes, estimated_notes, *, require_offset=True):
    ref, est = validate_notes(reference_notes), validate_notes(estimated_notes)
    matches = match_notes(ref, est, require_offset=require_offset)
    matched = len(matches)
    return {"referenceNotes": len(ref), "estimatedNotes": len(est), "matchedNotes": matched, "precision": _ratio(matched, len(est)), "recall": _ratio(matched, len(ref)), "f1": _ratio(2 * matched, len(ref) + len(est)), "matchedPairs": matches}


def evaluate_note_annotators(notes_a1, notes_a2, estimated_notes):
    return {annotator: {"onsetPitch": note_metrics(reference, estimated_notes, require_offset=False), "onsetOffsetPitch": note_metrics(reference, estimated_notes, require_offset=True)} for annotator, reference in (("A1", notes_a1), ("A2", notes_a2))}


def load_reference_f0(path):
    data = np.atleast_2d(np.loadtxt(path, delimiter=","))
    if data.shape[1] != 2 or not np.all(np.isfinite(data)) or np.any(data[:, 1] < 0) or np.any(np.diff(data[:, 0]) <= 0):
        raise ValueError("Invalid human F0 CSV")
    return data[:, 0], data[:, 1]


def load_reference_notes(path):
    data = np.atleast_2d(np.loadtxt(path, delimiter=","))
    if data.shape[1] != 3:
        raise ValueError("Invalid human note CSV")
    return validate_notes(np.column_stack((data[:, 0], data[:, 0] + data[:, 2], data[:, 1])))

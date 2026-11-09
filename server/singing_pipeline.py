"""The same singing-score inference used in review and production imports."""
from .lyric_score import interpret, infer_shared_vowel_words
from .singing_score import (VERSION, abstract_syllables, infer_score_rhythm,
    resolve_pitch_edges, restore_contour_tails, recover_short_syllable_anchors,
    mark_legato_transitions, resolve_chunk_seams, abstract_unworded_approaches,
    estimate_vocal_phase)


def build_singing_notes(events, words, grid, key, signals, nucleus_support=None):
    events, seams = resolve_chunk_seams(events)
    words, short_audit = recover_short_syllable_anchors(events, words)
    initial, initial_audit = interpret(events, words, signals['attack'])
    initial, tail_audit = restore_contour_tails(initial, pitch_runs=signals['pitch_runs'])
    for previous, following in zip(words, words[1:]):
        if previous['end']-previous['vowelStart'] < .025 and following['vowelStart']-previous['vowelStart'] < .30:
            for event in initial:
                if event.get('wordId') == following['id']:
                    event['uncertainWord'] = True
    abstracted, perception = abstract_syllables(initial, seconds_per_beat=60/grid['bpm'],
        attack_at=signals['attack'], pitch_support=signals['pitch_support'],
        onset_pitch_spread=signals['onset_pitch_spread'], legato_attack_at=signals['structural_attack'])
    unworded = []
    if not words:
        abstracted, unworded = abstract_unworded_approaches(abstracted, seconds_per_beat=60/grid['bpm'],
            attack_at=signals['attack'], structural_attack=signals['structural_attack'],
            pitch_support=signals['pitch_support'], onset_pitch_spread=signals['onset_pitch_spread'])
    repaired, alignment = infer_shared_vowel_words(events, words, grid,
        nucleus_support=nucleus_support or (lambda *args: None))
    interpreted, audit = interpret(abstracted, repaired, signals['attack'])
    tonic = key.get('tonic') if isinstance(key, dict) else key
    pcs = {'C':0,'C#':1,'Db':1,'D':2,'Eb':3,'E':4,'F':5,'F#':6,'Gb':6,'G':7,'Ab':8,'A':9,'Bb':10,'B':11}
    # An uncertain/unsupported key cannot justify changing a chromatic pitch.
    scale = {(pcs[tonic]+x)%12 for x in (0,2,4,5,7,9,11)} if tonic in pcs else set(range(12))
    resolved, pitches = resolve_pitch_edges(interpreted, scale=scale, contour_pitch=signals['contour_pitch'])
    resolved, transitions = mark_legato_transitions(resolved, seconds_per_beat=60/grid['bpm'],
        attack_at=signals['attack'], contour_support=signals['short_contour_support'])
    # Lyric timing already supplies syllable anchors; use the audio-only phase
    # estimate only when that independent timing evidence is unavailable.
    phase, phase_audit = (0., {'applied': False, 'reason': 'lyric-timing-present'}) if words else estimate_vocal_phase(events, grid)
    timed = [dict(e, start=e['start']-phase, end=e['end']-phase) for e in resolved]
    notes, timing = infer_score_rhythm(timed, grid, repaired)
    for row, event in zip(timing, resolved):
        row.update(sourceStartSeconds=event['start'], sourceEndSeconds=event['end'],
                   scoreStartSeconds=row['scoreStartSeconds']+phase, scoreEndSeconds=row['scoreEndSeconds']+phase,
                   vocalPhaseCorrectionSeconds=phase)
    return notes, {'version':VERSION, 'interpretation':audit, 'initialInterpretation':initial_audit,
        'perception':perception+unworded, 'contourRecovery':tail_audit, 'alignmentRepair':short_audit+alignment,
        'pitchInference':pitches, 'transitionTiming':transitions, 'alignedWords':repaired,
        'chunkSeams':seams, 'vocalPhase':phase_audit, 'timing':timing}

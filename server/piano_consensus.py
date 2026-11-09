"""Reconcile keyboard attacks across the mixture and its separated piano view.

Two views of the same model are corroboration, not independent ground truth.
The original predictions and every suppressed duplicate stay in the audit.
"""
from __future__ import annotations

import copy

from .multi_sources import source_share

VERSION = 'piano-two-view-consensus-2'


def recover_piano_reattacks(events, stem_notes, mixture_notes):
    """Recover a repeated key corroborated by chord or running-voice context.

    Two piano views alone can retrigger on resonance. Require two other native
    pitches to repeat with the held key, or a regular four-note running voice.
    Changing harmony under a held voice is insufficient.
    No attack is removed; the previous same key ends at the measured reattack.
    """
    result, audit = copy.deepcopy(events), []
    native = [n for n in events if not n['isDrum'] and n['program'] in (0, 2)
              and n.get('sourceId') == 'piano']
    for a in sorted(stem_notes, key=lambda n: n['start']):
        if a.get('activation', 0) < .65 or a['end']-a['start'] < .12:
            continue
        matching = [b for b in mixture_notes if b['midi']==a['midi']
                    and abs(b['start']-a['start']) <= .04 and b.get('activation', 0) >= .65
                    and b['end']-b['start'] >= .12]
        if not matching:
            continue
        b = min(matching, key=lambda n: abs(n['start']-a['start']))
        at = (a['start']+b['start'])/2
        if any(n['midi']==a['midi'] and abs(n['start']-at) <= .12 for n in native):
            continue
        held = [n for n in result if not n['isDrum'] and n['program'] in (0, 2)
                and n.get('sourceId')=='piano' and n['midi']==a['midi']
                and n['start']+.16 < at < n['end']-.06]
        if len(held) != 1:
            continue
        previous = held[0]
        chord = lambda t: {n['midi'] for n in native if n['program']==previous['program']
                          and n['midi']!=a['midi'] and abs(n['start']-t) <= .06}
        repeated = chord(previous['start']) & chord(at)
        # A strong two-view attack can also complete a four-note, regular,
        # monotonic run. Use only native neighbors, never recovered notes as
        # new evidence. A chord, a reversal or irregular timing cannot qualify.
        neighbors = sorted([n for n in native if n['program']==previous['program']],
                           key=lambda n:n['start'])
        left = [n for n in neighbors if n['start'] < at-.08]
        right = [n for n in neighbors if n['start'] > at+.08]
        run = False
        if min(a['activation'], b['activation']) >= .8 and left and right:
            for line in (left[-2:]+[dict(start=at,midi=a['midi'])]+right[:1],
                         left[-1:]+[dict(start=at,midi=a['midi'])]+right[:2]):
                if len(line)!=4:
                    continue
                gaps = [y['start']-x['start'] for x,y in zip(line,line[1:])]
                pitches = [y['midi']-x['midi'] for x,y in zip(line,line[1:])]
                single = all(sum(abs(n['start']-x['start'])<=.06 for n in neighbors)==1
                             for x in line if abs(x['start']-at)>.001)
                if (single and .12 <= min(gaps) <= max(gaps) <= 1.1
                        and max(gaps)/min(gaps) <= 1.2
                        and (all(0 < p <= 7 for p in pitches) or all(-7 <= p < 0 for p in pitches))):
                    run = True
                    break
        if len(repeated) < 2 and not run:
            continue
        end = min(previous['end'], a['end'], b['end'])
        if end-at < .12:
            continue
        before = previous.copy()
        previous['acousticEnd'] = max(previous.get('acousticEnd', previous['end']), previous['end'])
        previous['end'] = at
        new = dict(start=at, end=end, midi=a['midi'], program=previous['program'],
                   isDrum=False, sourceId='piano', sourceLabel='钢琴分离轨',
                   velocity=a.get('velocity', previous.get('velocity', .75)),
                   evidenceOrigins=['piano_crnn_stem', 'piano_crnn_mix', 'native_voice_context'])
        result.append(new)
        audit.append({'action':'recover_piano_reattack', 'before':before, 'after':previous.copy(),
                      'added':new.copy(), 'repeatedNativePitches':sorted(repeated),
                      'viewOnsets':[a['start'], b['start']],
                      'viewConfidence':[a['activation'], b['activation']],
                      'context':'regular_run' if run else 'repeated_chord'})
    return result, audit


def reconcile_piano(events, stem_notes, mixture_notes, envelopes):
    result = copy.deepcopy(events)
    decisions, pending = [], []

    def matches(a, b, tolerance=.08):
        return a['midi'] == b['midi'] and abs(a['start'] - b['start']) <= tolerance

    def strong(note):
        return note.get('activation', 0) >= .8 and note['end'] - note['start'] >= .09

    pairs = []
    for note in stem_notes:
        choices = [n for n in mixture_notes if strong(n) and matches(n, note)]
        if strong(note) and choices:
            other = min(choices, key=lambda n: abs(n['start'] - note['start']))
            pairs.append((note, other))

    # A shared separation label does not establish a performer. Only collapse
    # duplicate acoustic/electric *classifications of the same measured attack*.
    electric = [n for n in result if n['program']==2 and not n['isDrum'] and n.get('sourceId')=='piano']
    acoustic = [n for n in result if n['program']==0 and not n['isDrum'] and n.get('sourceId')=='piano']
    duplicate_fingerprint = [n for n in electric if any(matches(n,a,.022) for a in acoustic)]
    corroborated = [n for n in duplicate_fingerprint if source_share(envelopes,'piano',n)>=.55
                    and any(matches(n,a) and matches(n,b) for a,b in pairs)]
    # A short electric phrase with a few unisons is not an alias. Near-complete
    # attack containment across an extended passage, plus measured piano
    # corroboration, distinguishes the decoder's duplicate class stream.
    class_alias = (len(electric)>=6 and len(duplicate_fingerprint)>=len(electric)*.95
                   and max(n['start'] for n in electric)-min(n['start'] for n in electric)>=8
                   and len(corroborated)>=max(2,len(electric)*.1))
    removed = set()
    for i, note in enumerate(result):
        if note['program'] != 2 or note['isDrum'] or note.get('sourceId') not in (None, 'piano'):
            continue
        own = [n for n in result if n['program'] == 0 and not n['isDrum']
               and n.get('sourceId') == note.get('sourceId') and matches(n, note, .022)
               and min(n['end'], note['end']) - max(n['start'], note['start'])
               >= .8 * min(n['end'] - n['start'], note['end'] - note['start'])]
        support = any(matches(note, a) and matches(note, b) for a, b in pairs)
        if own and ((support and source_share(envelopes, 'piano', note) >= .55)
                    or (class_alias and note.get('sourceId')=='piano')):
            target = min(own, key=lambda n: abs(n['start'] - note['start']))
            removed.add(i)
            target['evidenceOrigins'] = sorted(set(target.get('evidenceOrigins', ['yourmt3_mix']))
                                               | {'piano_crnn_stem', 'piano_crnn_mix'})
            decisions.append({'action': 'duplicate_class', 'before': note.copy(), 'after': target.copy(),
                              'reason': 'Extended duplicate class fingerprint' if class_alias else
                              'Same attack and source, acoustic and electric decoder aliases, corroborated in both audio views'})
    result = [n for i, n in enumerate(result) if i not in removed]
    result, reattacks = recover_piano_reattacks(result, stem_notes, mixture_notes)
    decisions.extend(reattacks)
    shortened = 0
    for event in result:
        if event['isDrum'] or event['program'] not in (0,2) or event.get('sourceId') not in (None,'piano'):
            continue
        support=[(a,b) for a,b in pairs if matches(event,a) and matches(event,b)
                 and abs(a['end']-b['end'])<=.08]
        if not support:
            continue
        a,b=min(support,key=lambda pair:abs(pair[0]['start']-event['start']))
        end=(a['end']+b['end'])/2
        if event['end']-end>.15 and end-event['start']>=.09:
            before=event.copy()
            event['acousticEnd']=event['end']
            event['end']=end
            shortened+=1
            decisions.append({'action':'corroborated_release','before':before,'after':event.copy(),
                              'reason':'Both piano views agree on an earlier release; native tail retained as acousticEnd'})
    added = 0
    for note, mixture in pairs:
        if any(not n['isDrum'] and n['program'] in (0, 2) and matches(n, note, .12) for n in result):
            continue
        reason = None
        share = min(source_share(envelopes, 'piano', n) for n in (note, mixture))
        if share < .55:
            reason = 'competing_source'
        elif any(n['program'] in (0, 2) and not n['isDrum']
                 and n['midi'] == note['midi'] and n['start'] < note['start'] < n['end']
                 for n in result):
            reason = 'possible_retrigger_of_sustain'
        elif any(n['program'] in (0, 2) and not n['isDrum']
                 and abs(n['start'] - note['start']) <= .12
                 and abs(n['midi'] - note['midi']) in (12, 19, 24, 28, 31, 36) for n in result):
            reason = 'unresolved_harmonic_doubling'
        if reason:
            pending.append({'event': note.copy(), 'sourceShare': share, 'reason': reason})
            continue
        candidate = dict(note, sourceId='piano', sourceLabel='钢琴分离轨',
                         evidenceOrigins=['piano_crnn_stem', 'piano_crnn_mix'])
        result.append(candidate)
        added += 1
        decisions.append({'action': 'add_consensus', 'after': candidate.copy(), 'sourceShare': share,
                          'reason': 'Strong matching attack in mixture and piano stem, without an existing piano attack or sustain'})
    return sorted(result, key=lambda n: (n['start'], n['program'], n['midi'])), {
        'version': VERSION, 'removedDuplicateClasses': len(removed), 'addedConsensusNotes': added,
        'duplicateClassFingerprint': class_alias,
        'corroboratedReleases': shortened,
        'recoveredPianoReattacks': len(reattacks),
        'decisions': decisions, 'pendingCandidates': pending, 'claimsIndependentModels': False,
    }

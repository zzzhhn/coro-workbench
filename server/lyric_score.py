"""Experimental syllable-aware interpretation of frozen monophonic events.

No song-specific note edits. Words can contain several pitches; distinct words
can rearticulate the same pitch. Uncertain alignments retain acoustic events.
"""
from __future__ import annotations

import copy
import math
from collections import Counter
import numpy as np
from .vocal_notation import value_cost

VERSION = 'lyrics-readable-onsets-2'


def abstract_onset_scoops(events, *, seconds_per_beat, attack_at, pitch_support, onset_pitch_spread):
    """Make a reversible singing-score abstraction, not a new acoustic claim.

    A short rising approach can belong to the onset of a sung syllable rather
    than its own score note. Limit this to a two-event syllable, connected audio,
    supported sustained destination and no independent second attack. A stable
    first-pitch plateau is protected even during legato. Longer figures, falling
    inflections, separate syllables and unvoiced gaps survive.
    """
    counts = Counter(e.get('wordId') for e in events)
    output, changes = [], []
    i = 0
    while i < len(events):
        a = events[i]
        b = events[i+1] if i+1 < len(events) else None
        if (b and a.get('lyric') and a.get('wordId') and counts[a['wordId']] == 2
                and a['wordId'] == b.get('wordId')
                and abs(a['end']-b['start']) <= .025
                and 0 < b['midi']-a['midi'] <= 3
                and a['end']-a['start'] <= min(.22, seconds_per_beat*.25)
                and b['end']-b['start'] >= .18
                and (a['end']-a['start'])/(b['end']-a['start']) < .45
                and not attack_at(b['start'])):
            support = float(pitch_support(b['start']+.04, b['end'], b['midi']))
            spread = onset_pitch_spread(a['start'], a['end'])
            # Central 80% within half a semitone is stable enough to retain.
            # Missing/weak contour evidence also abstains from abstraction.
            if support >= .8 and spread is not None and math.isfinite(spread) and spread > .5:
                row = dict(copy.deepcopy(a), id=a['id']+'~'+b['id'], end=b['end'],
                           midi=b['midi'], midiFloat=b.get('midiFloat', b['midi']),
                           sourceIds=list(dict.fromkeys(a.get('sourceIds',[a['id']])+b.get('sourceIds',[b['id']]))))
                output.append(row)
                changes.append({'action':'abstract-rising-syllable-onset','wordId':a['wordId'],
                    'sourceIds':row['sourceIds'], 'startSeconds':a['start'], 'endSeconds':b['end'],
                    'sourcePitches':[a['midi'],b['midi']], 'scorePitch':b['midi'],
                    'destinationPitchSupport':support, 'onsetPitchSpreadSemitones':spread,
                    'independentAttack':False})
                i += 2
                continue
        output.append(copy.deepcopy(a))
        i += 1
    return output, changes


def infer_shared_vowel_words(events, words, grid, *, nucleus_support):
    """Recover a collapsed onsetless nasal vowel as a provisional syllable.

    SOFA can label only the nasal coda of an /a/+/an/ sequence. Raw acoustic
    phones stay intact. Recovery requires one unused continuous note interval,
    shared-nucleus acoustic support and independently located neighboring words.
    Only the validated a/an/ang family is enabled; spelling is never consulted.
    """
    output, changes = copy.deepcopy(words), []
    spb, origin = 60/grid['bpm'], grid['offsetSeconds']
    for i in range(1, len(words)-1):
        previous, word, following = words[i-1:i+2]
        phones, before = word.get('phones',[]), previous.get('phones',[])
        if not (word['end']-word['vowelStart'] < .025 and len(phones)==1
                and phones[0]['phone'] in ('an','ang') and before and before[-1]['phone']=='a'
                and previous['end']-previous['vowelStart'] >= .35
                and following['end']-following['vowelStart'] >= .10):
            continue
        candidates = [e for e in events if previous['vowelStart']+.10 < e['start'] < word['vowelStart']-.10]
        if len(candidates) != 1:
            continue
        event = candidates[0]
        if event['end'] < word['start']-.08:
            continue
        support = nucleus_support(word, previous, event['start'], min(event['end'], word['start']-.04))
        if not support or support['familyMean'] < .10 or support['relativeNasal'] < 1.25:
            continue
        # A weak inferred boundary can use the existing rhythmic grid; it must
        # stay inside the supported event and may move no more than 90 ms.
        at = event['start']
        snapped = origin + round((at-origin)/spb*4)/4*spb
        if abs(snapped-at) <= .09 and event['start'] <= snapped <= event['end']-.10:
            at = snapped
        if not previous['vowelStart']+.10 < at < min(word['end']-.08, following['vowelStart']-.10):
            continue
        output[i].update(start=at, vowelStart=at, boundarySource='shared-vowel-inference',
                         originalStartSeconds=word['start'], originalVowelStartSeconds=word['vowelStart'])
        output[i-1]['end'] = min(output[i-1]['end'], at)
        changes.append({'wordId':word['id'],'action':'recover-shared-vowel-syllable',
            'originalVowelStartSeconds':word['vowelStart'],'inferredVowelStartSeconds':at,
            'candidateEventId':event['id'],'support':support,'provisional':True})
    return output, changes


def interpret(events, words, attack_at=lambda _: True):
    """Return a provenance-preserving event hypothesis and alignment decisions.

    attack_at defaults conservatively to True: without waveform evidence no
    same-syllable reattack is merged. Splits reuse the measured source pitch.
    """
    rows = [dict(e, sourceIds=e.get('sourceIds',[e['id']])) for e in copy.deepcopy(events)]
    for row in rows:
        for field in ('lyric', 'wordId', 'wordText'):
            row.pop(field, None)
    if any(a['end'] > b['start']+1e-6 for a,b in zip(rows, rows[1:])):
        raise ValueError('Ordered non-overlapping raw events required')
    decisions, anchors = [], []
    used_starts = set()
    for word in sorted(words, key=lambda w:w['vowelStart']):
        at = word['vowelStart']
        if word['end']-word['start'] < .04 or word['end']-at < .025:
            decisions.append({'wordId':word['id'],'action':'uncertain-short-alignment'})
            continue
        near = [(abs(e['start']-at), i) for i,e in enumerate(rows)
                if abs(e['start']-at)<=.095 and round(e['start'],6) not in used_starts]
        if near:
            _, index = min(near)
            boundary = rows[index]['start']
            if anchors and boundary <= anchors[-1]['at']:
                decisions.append({'wordId':word['id'],'action':'uncertain-order'})
                continue
            action = 'associate-existing-attack'
        else:
            containing = next((i for i,e in enumerate(rows) if e['start']+.07<at<e['end']-.07),None)
            if containing is None:
                decisions.append({'wordId':word['id'],'action':'no-supported-pitched-interval'})
                continue
            e = rows[containing]
            left = dict(e,end=at,id=e['id']+'-a')
            right = dict(e,start=at,id=e['id']+'-b')
            rows[containing:containing+1] = [left,right]
            boundary = at
            action = 'split-same-pitch-at-syllable'
        anchors.append({'at':boundary,'word':word})
        used_starts.add(round(boundary,6))
        decisions.append({'wordId':word['id'],'action':action,'at':boundary,'vowelStart':at})
    for e in rows:
        prior = [a for a in anchors if a['at'] <= e['start']+1e-6]
        word = prior[-1]['word'] if prior else None
        if word and e['start'] <= word['end']+.12:
            e['wordId'] = word['id']
            e['wordText'] = word['text']
    merged = []
    for e in rows:
        before = merged[-1] if merged else None
        if (before and before['midi']==e['midi'] and before.get('wordId')
                and before.get('wordId')==e.get('wordId')
                and abs(before['end']-e['start'])<=.025
                and min(before['end']-before['start'],e['end']-e['start'])<.18
                and not attack_at(e['start'])):
            decisions.append({'action':'merge-same-syllable-continuation','at':e['start'],
                              'sourceIds':before['sourceIds']+e['sourceIds'],'wordId':e['wordId']})
            before['end'] = e['end']
            before['sourceIds'] = list(dict.fromkeys(before['sourceIds']+e['sourceIds']))
            before['id'] += '+'+e['id']
        else:
            merged.append(dict(e))
    seen = set()
    for e in merged:
        word = e.get('wordId')
        if word and word not in seen:
            e['lyric'] = e['wordText']; seen.add(word)
    return merged, {'version':VERSION,'decisions':decisions,'sourceEvents':len(events),
                    'outputEvents':len(merged),'words':len(words),'assignedWords':len(seen),
                    'pitchEdits':0,'referenceNotesUsed':False}


def notate(events, grid, duration):
    """Bounded joint rhythm, with relative duration fidelity and real rests.

    Lyrics determine the event interpretation upstream. This duration safeguard
    is also evaluated WITHOUT lyrics as an ablation, to avoid attributing its
    effect to the aligner. It cannot fix pitch, add unheard notes, or remove them.
    """
    spb, origin, ticks = 60/grid['bpm'],grid['offsetSeconds'],32
    if not events:return [],[]
    options = []
    def metric(t):
        for q,c in ((32,0),(16,.08),(8,.24),(4,1.05),(2,3),(1,5)):
            if t%q==0:return c
    for e in events:
        start,end=e['start'],e['end'];length=end-start
        tolerance=min(.115,.45*length)
        def points(s):
            b=(s-origin)/spb*ticks
            return range(max(0,math.ceil(b-tolerance/spb*ticks-1e-7)),math.floor(b+tolerance/spb*ticks+1e-7)+1)
        candidates=[]
        for a in points(start):
            for b in points(end):
                if b<=a:continue
                length_error=((b-a)/ticks*spb-length)/length
                if abs(length_error)>.45:continue
                err_a=(origin+a/ticks*spb-start)/max(.04,tolerance)
                err_b=(origin+b/ticks*spb-end)/max(.04,tolerance)
                cost=metric(a)+.65*metric(b)+.6*value_cost(b-a)+err_a**2+.65*err_b**2+8*length_error**2
                candidates.append((a,b,cost))
        if not candidates:
            # Exact event fallback, not event deletion or forced lengthening.
            a=(start-origin)/spb*ticks;b=(end-origin)/spb*ticks
            candidates=[(a,b,50.)]
        options.append(np.asarray(candidates))
    costs=options[0][:,2];backpointers=[]
    for i in range(1,len(events)):
        previous,current=options[i-1],options[i]
        gaps=current[:,0,None]-previous[None,:,1]
        raw_gap=events[i]['start']-events[i-1]['end']
        allowed=gaps>=-1e-6
        if raw_gap<=1e-6:allowed &= abs(gaps)<1e-6
        elif raw_gap>=.18:allowed &= gaps/ticks*spb>=max(.10,raw_gap-.10)
        gap_cost=np.where(gaps>1e-6,.3,0.)
        totals=np.where(allowed,costs[None,:]+gap_cost,np.inf)
        back=np.argmin(totals,axis=1)
        costs=totals[np.arange(len(current)),back]+current[:,2]
        backpointers.append(back)
    index=int(np.argmin(costs))
    if not math.isfinite(costs[index]):
        # A disconnected lattice keeps the whole acoustic phrase, visibly.
        selected=[((e['start']-origin)/spb*ticks,(e['end']-origin)/spb*ticks,50) for e in events]
    else:
        selected=[None]*len(events)
        for i in range(len(events)-1,-1,-1):
            selected[i]=options[i][index]
            if i:index=int(backpointers[i-1][index])
    notes,audit=[],[]
    for e,(a,b,_) in zip(events,selected):
        note={'id':e['id'],'midi':e['midi'],'start':a/ticks,'duration':(b-a)/ticks,'velocity':.7,'origin':'transcribed'}
        if e.get('lyric'):note['lyric']=e['lyric']
        notes.append(note)
        audit.append({'noteId':note['id'],'sourceIds':e.get('sourceIds',[e['id']]),'wordId':e.get('wordId'),
            'sourceStartSeconds':e['start'],'sourceEndSeconds':e['end'],
            'scoreStartSeconds':origin+note['start']*spb,'scoreEndSeconds':origin+b/ticks*spb})
    return notes,audit

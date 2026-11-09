"""Opt-in perceptual singing score over frozen acoustic events.

This is score inference, not acoustic ground truth. Every abstraction preserves
source IDs and records its reason. No lyrics, pitches or song times are fixtures.
"""
from __future__ import annotations

import copy
import math
from collections import Counter

import numpy as np
from .vocal_notation import value_cost

VERSION = 'syllable-phrasing-4'


def resolve_chunk_seams(events):
    """Make overlapping chunk-owned GAME events monophonic without dropping attacks.

    Context windows can let one chunk's sustained event cross the next chunk's
    owned onset. Keep both attacks and end the earlier event at the later
    measured boundary. Raw model output remains unchanged elsewhere.
    """
    rows, audit = [], []
    for event in sorted(copy.deepcopy(events), key=lambda e: (e['start'], e['end'])):
        if rows and rows[-1]['end'] > event['start'] + 1e-6:
            previous = rows[-1]
            if event['start'] <= previous['start'] + 1e-6:
                raise ValueError('Colliding vocal attacks cannot be made monophonic without deleting an event')
            audit.append({'action': 'resolve-chunk-seam-overlap', 'eventId': previous['id'],
                          'nextEventId': event['id'], 'originalEndSeconds': previous['end'],
                          'scoreEndSeconds': event['start'], 'overlapSeconds': previous['end'] - event['start']})
            previous['end'] = event['start']
        rows.append(event)
    return rows, audit


def abstract_unworded_approaches(events, *, seconds_per_beat, attack_at, structural_attack,
                                 pitch_support, onset_pitch_spread):
    """Notate audio-only scoops as their sung destination, while keeping runs.

    This mirrors the existing lyric-syllable approach rule for events without
    lyric timing. It requires connected audio, no fresh attack, a supported
    destination and evidence that the first pitch is an approach. A step inside
    a chain of short notes is retained as a possible melisma.
    """
    rows, audit = [], []
    i = 0
    while i < len(events):
        a = events[i]
        b = events[i+1] if i+1 < len(events) else None
        previous = events[i-1] if i else None
        following = events[i+2] if i+2 < len(events) else None
        if b and not a.get('wordId') and not b.get('wordId'):
            da, db = a['end']-a['start'], b['end']-b['start']
            spread = onset_pitch_spread(a['start'], a['end'])
            support = pitch_support(b['start']+.03, b['end']-.01, b['midi'])
            approach = ((spread is not None and spread > .5)
                        or (da <= .1875*seconds_per_beat and db >= 1.5*da)
                        or (da/(da+db) <= 1/3 and db >= .35))
            inside_run = (previous is not None and following is not None
                          and abs(previous['end']-a['start']) <= .025 and previous['end']-previous['start'] < .30
                          and abs(b['end']-following['start']) <= .025 and following['end']-following['start'] < .30)
            if (abs(a['end']-b['start']) <= .025 and 0 < b['midi']-a['midi'] <= 3
                    and .06 <= da <= min(.24, seconds_per_beat/3) and db >= .18 and da/(da+db) < .45
                    and approach and support >= .8 and not inside_run
                    and not attack_at(b['start']) and not structural_attack(b['start'])):
                row = copy.deepcopy(b)
                row.update(id=a['id']+'~'+b['id'], start=a['start'],
                           sourceIds=list(dict.fromkeys(a.get('sourceIds', [a['id']])+b.get('sourceIds', [b['id']]))))
                rows.append(row)
                audit.append({'action': 'unworded-onset-approach', 'sourceIds': row['sourceIds'],
                              'startSeconds': a['start'], 'endSeconds': b['end'],
                              'sourcePitches': [a['midi'], b['midi']], 'scorePitch': b['midi'],
                              'destinationPitchSupport': float(support), 'onsetPitchSpreadSemitones': spread,
                              'independentAttack': False})
                i += 2
                continue
        rows.append(copy.deepcopy(a))
        i += 1
    return rows, audit


def estimate_vocal_phase(events, grid):
    """Estimate a shared singing-onset delay from the song's own events.

    The search is bounded to a small positive delay and never uses reference
    notes. Pitched vocal entries usually lag a percussive beat estimate; an
    early correction is not inferred from weak evidence.
    """
    if len(events) < 24:
        return 0., {'applied': False, 'reason': 'too-few-events', 'events': len(events)}
    spb, origin = 60/grid['bpm'], grid['offsetSeconds']
    step = spb/4
    starts = np.asarray([e['start'] for e in events], float)
    def fit(lag):
        position = (starts-lag-origin)/step
        distance = np.abs(position-np.rint(position))*step
        return float(np.mean(np.exp(-(distance/.025)**2)))
    baseline = fit(0.)
    candidates = [(fit(float(lag)), float(lag)) for lag in np.arange(0., min(.08, .35*step)+1e-9, .005)]
    score, lag = max(candidates)
    applied = score-baseline >= .05 and lag >= .01
    return (round(lag, 3) if applied else 0.), {'applied': applied, 'phaseSeconds': round(lag, 3),
        'baselineFit': round(baseline, 4), 'selectedFit': round(score, 4), 'events': len(events),
        'searchSeconds': [0., round(min(.08, .35*step), 4)], 'referenceUsed': False}


def recover_short_syllable_anchors(events, words):
    """Use an existing measured attack to anchor a truncated aligned vowel.

    A nonzero vowel plus a supported consonant can survive the aligner's short
    duration guard. Never invent an attack for a zero-width forced alignment.
    Raw phone intervals remain unchanged for inspection.
    """
    output, audit = copy.deepcopy(words), []
    for i, word in enumerate(words):
        phones = word.get('phones', [])
        if not (len(phones) >= 2 and .01 <= word['end']-word['vowelStart'] < .025
                and word['vowelStart']-word['start'] >= .08
                and phones[0].get('posterior', 0) >= .10):
            continue
        candidates = [e for e in events if abs(e['start']-word['vowelStart']) <= .04
                      and word['start'] <= e['start'] <= word['end']-.025
                      and e['end']-e['start'] >= .10]
        if len(candidates) != 1:
            continue
        at = candidates[0]['start']
        if any(abs(w['vowelStart']-at) <= .06 for j,w in enumerate(words) if j != i):
            continue
        output[i].update(vowelStart=at, boundarySource='existing-attack-short-vowel',
                         originalVowelStartSeconds=word['vowelStart'])
        audit.append({'action':'recover-short-syllable-anchor','wordId':word['id'],
            'eventId':candidates[0]['id'],'originalVowelStartSeconds':word['vowelStart'],
            'inferredVowelStartSeconds':at,'provisional':True})
    return output, audit


def abstract_syllables(events, *, seconds_per_beat, attack_at, pitch_support, onset_pitch_spread, legato_attack_at=None):
    legato_attack_at=legato_attack_at or attack_at
    counts = Counter(e.get('wordId') for e in events)
    groups=[]
    for e in events:
        if e.get('wordId') and groups and groups[-1][0]==e['wordId']:groups[-1][1].append(e)
        else:groups.append((e.get('wordId'),[e]))
    repeated=set()
    for (wa,ga),(wb,gb) in zip(groups,groups[1:]):
        if not wa or not wb or wa==wb or len(ga)!=2 or len(gb)<2:continue
        a,b=ga[:2];c,d=gb[:2]
        if (not a.get('uncertainWord') and not c.get('uncertainWord')
                and a['midi']==c['midi'] and b['midi']==d['midi'] and 0<b['midi']-a['midi']<=2
                and abs(b['end']-c['start'])<=.025 and d['end']-d['start']>=.35
                and all(.10<=x['end']-x['start']<=min(.30,seconds_per_beat/3)
                        and y['end']-y['start']>=.18 and abs(x['end']-y['start'])<=.025
                        and not legato_attack_at(y['start']) and pitch_support(y['start']+.03,y['end']-.01,y['midi'])>=.8
                        for x,y in ((a,b),(c,d)))):
            repeated.update((wa,wb))
    rows, audit = [], []
    i = 0
    while i < len(events):
        a = events[i]
        b = events[i+1] if i+1 < len(events) else None
        c = events[i+2] if i+2 < len(events) else None
        action, target = None, None
        support, spread = 0., None
        if (b and a.get('lyric') and a.get('wordId') and (counts[a['wordId']] == 2 or a['wordId'] in repeated)
                and a['wordId'] == b.get('wordId') and abs(a['end']-b['start']) <= .025
                and not a.get('uncertainWord') and (not attack_at(b['start']) or a['wordId'] in repeated)):
            da, db = a['end']-a['start'], b['end']-b['start']
            support = pitch_support(b['start']+.03, b['end']-.01, b['midi'])
            spread = onset_pitch_spread(a['start'], a['end'])
            # A stable structural sixteenth is protected. A sub-sixteenth
            # approach or a small prefix of a much longer body may be optional
            # ornamentation even when its instantaneous pitch is measurable.
            approach = (spread is not None and (spread > .5
                or (da <= .1875*seconds_per_beat and db >= 1.5*da)
                or (da/(da+db) <= 1/3 and db >= .35)))
            if a['wordId'] in repeated:
                action,target='repeated-syllable-approach',b
            elif (0 < b['midi']-a['midi'] <= 3 and da <= min(.30,seconds_per_beat/3)
                    and db >= .18 and da/(da+db) < .45 and approach and support >= .8):
                action, target = 'syllable-approach', b
            # A weak step at a syllable's tail can anticipate the next word.
            # Keep that next word's attack; never merge across a lyric boundary.
            elif (c and c.get('wordId') and c['wordId'] != a['wordId'] and c.get('lyric')
                    and abs(b['end']-c['start']) <= .025 and b['midi'] == c['midi']
                    and 0 < a['midi']-b['midi'] <= 2 and .10 <= da <= .24
                    and da+db <= .65*seconds_per_beat and da/(da+db) >= .28
                    and support >= .8 and pitch_support(a['start']+.02,a['end']-.01,a['midi']) >= .8):
                action, target = 'syllable-tail-anticipation', a
        if action:
            row = copy.deepcopy(a)
            row.update(id=a['id']+'~'+b['id'],end=b['end'],midi=target['midi'],
                midiFloat=target.get('midiFloat',target['midi']),
                sourceIds=list(dict.fromkeys(a.get('sourceIds',[a['id']])+b.get('sourceIds',[b['id']]))))
            rows.append(row)
            audit.append({'action':action,'wordId':a['wordId'],'startSeconds':a['start'],
                'endSeconds':b['end'],'sourceIds':row['sourceIds'],'sourcePitches':[a['midi'],b['midi']],
                'scorePitch':row['midi'],'destinationPitchSupport':float(support),
                'onsetPitchSpreadSemitones':spread,'independentAttack':False})
            i += 2
        else:
            rows.append(copy.deepcopy(a)); i += 1
    return rows, audit


def restore_contour_tails(events, *, pitch_runs):
    """Recover one measured stepwise passing tone hidden in a long GAME gate."""
    rows,audit=[],[]
    for i,a in enumerate(events):
        b=events[i+1] if i+1<len(events) else None
        candidates=[]
        if b and abs(a['end']-b['start'])<=.025 and 2<=abs(a['midi']-b['midi'])<=5:
            candidates=[r for r in pitch_runs(max(a['start']+.25,a['end']-.35),a['end'],a['midi'])
                if r['end']-r['start']>=.08-1e-6 and r['end']>=a['end']-.04
                and a['end']-r['start']<=.28 and r['support']>=.85
                and min(a['midi'],b['midi'])<r['midi']<max(a['midi'],b['midi'])]
        if len(candidates)==1:
            r=candidates[0];rows.append(dict(copy.deepcopy(a),end=r['start']))
            tail=dict(copy.deepcopy(a),id=a['id']+'-contour-tail',start=r['start'],midi=r['midi'],midiFloat=r['midi'],
                      inferredPassingTone=True)
            tail.pop('lyric',None);rows.append(tail)
            audit.append({'action':'restore-stable-passing-tone','sourceIds':a.get('sourceIds',[a['id']]),
                'startSeconds':r['start'],'endSeconds':a['end'],'scorePitch':r['midi'],'support':r['support']})
        else:rows.append(copy.deepcopy(a))
    return rows,audit


def resolve_pitch_edges(events, *, scale, contour_pitch):
    """A weak semitone rounding decision can use an established key prior.

    Both GAME's continuous estimate and a separate contour must lean toward the
    same neighboring scale pitch. Clear chromatic pitches and long notes remain.
    This is a score hypothesis, explicitly not a new F0 estimate.
    """
    rows, audit = copy.deepcopy(events), []
    for row in rows:
        p, estimate = row['midi'], row.get('midiFloat')
        if p % 12 in scale or estimate is None or row['end']-row['start'] > .30:
            continue
        contour = contour_pitch(row['start'],row['end'])
        if contour is None or not math.isfinite(contour):continue
        for target in (p-1,p+1):
            direction = target-p
            if (target % 12 in scale and .20 <= (estimate-p)*direction <= .50
                    and .20 <= (contour-p)*direction <= .65):
                row['midi'] = target
                audit.append({'action':'resolve-ambiguous-semitone','eventId':row['id'],
                    'startSeconds':row['start'],'sourcePitch':p,'scorePitch':target,
                    'gameContinuousPitch':estimate,'contourPitch':contour,'provisional':True})
                break
    return rows,audit


def mark_legato_transitions(events, *, seconds_per_beat, attack_at, contour_support):
    """Keep measured passing tones while allowing phrase-level rhythmic fit.

    A continuous step through a pitch is not a precise reattack timestamp.
    Stable contour evidence keeps the pitch; consonants and direction reversals
    retain the tight acoustic timing bound instead.
    """
    rows,audit=copy.deepcopy(events),[]
    for i in range(1,len(events)-1):
        a,b,c=events[i-1:i+2]
        if (b.get('lyric') or c.get('lyric') or b.get('wordId')!=c.get('wordId')
                or b.get('wordId')!=a.get('wordId') or b.get('inferredPassingTone')
                or not .04<=b['end']-b['start']<=.12*seconds_per_beat
                or a['end']-a['start']<.25*seconds_per_beat
                or c['end']-c['start']<.25*seconds_per_beat
                or abs(a['end']-b['start'])>.025 or abs(b['end']-c['start'])>.025
                or not min(a['midi'],c['midi'])<b['midi']<max(a['midi'],c['midi'])
                or max(abs(a['midi']-b['midi']),abs(b['midi']-c['midi']))>3
                or attack_at(b['start']) or attack_at(c['start'])):
            continue
        support=contour_support(b['start'],b['end'],b['midi'])
        if support<.8:continue
        rows[i]['flexibleTransition']=True
        audit.append({'action':'retain-passing-tone-with-flexible-boundary','eventId':b['id'],
            'startSeconds':b['start'],'endSeconds':b['end'],'contourSupport':support})
    return rows,audit


def infer_score_rhythm(events, grid, words):
    """Joint note/rest spelling, separating vocal articulation from score gate.

    All semantic attacks/pitches survive. Short consonant gaps can be included
    in written duration when lyric boundaries support them; breathing rests
    remain. Tight attack-spacing bounds keep genuine fast runs available.
    """
    if not events:return [],[]
    spb,origin,ticks = 60/grid['bpm'],grid['offsetSeconds'],32
    word_map={w['id']:w for w in words}
    def metric(t):
        for unit,cost in ((32,0.),(16,.06),(8,.25),(4,1.5),(2,4.),(1,7.)):
            if t%unit==0:return cost
    def value(t):
        if t in (8,16,32,64,128):return 0.
        if t in (12,24,48,96):return 1.
        return 2*value_cost(int(t))+.7
    options=[]
    for i,e in enumerate(events):
        following=events[i+1] if i+1<len(events) else None
        next_word=word_map.get(following.get('wordId')) if following else None
        consonant_release=bool(following and next_word and e.get('wordId')
            and 0 < following['start']-e['end'] <= .32 and next_word['start']<=e['end']+.15)
        anchor=e['start'];word=word_map.get(e.get('wordId'))
        if word and e.get('lyric') and abs(e['start']-word.get('vowelStart',e['start']))<=.10:
            # A written syllable begins during its consonant-to-vowel onset,
            # rather than inheriting every singer's delayed stable F0 attack.
            anchor-=min(.10,max(0,word.get('vowelStart',e['start'])-word['start'])/2)
        if (i and word and e['midi']==events[i-1]['midi'] and e.get('wordId')!=events[i-1].get('wordId')
                and set(e.get('sourceIds',[])) & set(events[i-1].get('sourceIds',[]))
                and 0<=e['start']-word['start']<=.15):
            anchor=word['start']
        # A contour-derived transition is not an independently measured attack;
        # it must not tighten both neighbors' onset bounds as if it were one.
        weak_boundary=lambda n: n.get('inferredPassingTone') or n.get('flexibleTransition')
        native_before=next((n for n in reversed(events[:i]) if not weak_boundary(n)),None)
        native_after=next((n for n in events[i+1:] if not weak_boundary(n)),None)
        spacing=min(([e['start']-native_before['start']] if native_before else [])+
                    ([native_after['start']-e['start']] if native_after else []),default=math.inf)
        onset_limit=.28 if weak_boundary(e) else min(.18,.45*spacing)
        def points(at,limit):
            position=(at-origin)/spb*ticks
            return range(max(0,math.ceil(position-limit/spb*ticks-1e-7)),math.floor(position+limit/spb*ticks+1e-7)+1)
        # Only rescue a lattice that excludes every ordinary 32nd-note onset.
        # Avoid broadly moving already viable attacks. Ordering and minimum
        # durations still protect the count and sequence of fast articulations.
        onset_points=list(points(anchor,onset_limit))
        if not weak_boundary(e) and not any(t%4==0 for t in onset_points):
            onset_points=sorted(set(onset_points) | {t for t in points(anchor,max(onset_limit,.075)) if t%4==0})
        choices=[]
        for a in onset_points:
            release_limit=.32 if consonant_release else .28 if following and weak_boundary(following) else .24
            for b in points(e['end'],release_limit):
                if b<=a:continue
                length=(b-a)/ticks*spb
                if length < min(.06,.45*(e['end']-e['start'])):continue
                onset=(origin+a/ticks*spb-anchor)/.10
                release=(origin+b/ticks*spb-e['end'])/.12
                structural=(e['end']-e['start']>=.75*spb)
                metrical=metric(a)*(12 if structural and a%16 else 1)
                cost=(.05 if weak_boundary(e) else .65)*onset**2+.15*release**2+metrical+.25*metric(b)+value(b-a)
                choices.append((a,b,cost))
        if not choices:
            choices=[((e['start']-origin)/spb*ticks,(e['end']-origin)/spb*ticks,50.)]
        options.append(np.asarray(choices))
    costs=options[0][:,2];backs=[];bridged=[]
    for i in range(1,len(events)):
        a,b=events[i-1],events[i]
        gap=b['start']-a['end'];following=word_map.get(b.get('wordId'))
        articulation=(0<gap<=.32 and a.get('wordId') and following
                      and following['start']<=a['end']+.15)
        bridged.append(bool(articulation))
        gaps=options[i][:,0,None]-options[i-1][None,:,1]
        allowed=gaps>=-1e-6
        if gap<=.025:allowed &= abs(gaps)<1e-6
        elif gap>=.40:
            previous=word_map.get(a.get('wordId'))
            breath=(following['start']-previous['end']-.10) if previous and following else gap-.20
            allowed &= gaps/ticks*spb >= max(.125*spb,breath)-1e-7
        elif not articulation:allowed &= gaps/ticks*spb >= min(.10,gap)-1e-7
        rest_cost=np.zeros(gaps.shape)
        for g in np.unique(gaps[gaps>1e-6]):
            rest_cost[gaps==g]=value(int(g))+(1.5 if articulation else .35)
        totals=np.where(allowed,costs[None,:]+rest_cost,np.inf)
        back=np.argmin(totals,axis=1)
        costs=totals[np.arange(len(options[i])),back]+options[i][:,2];backs.append(back)
    index=int(np.argmin(costs));fallback=not math.isfinite(costs[index])
    if fallback:selected=[((e['start']-origin)/spb*ticks,(e['end']-origin)/spb*ticks,50.) for e in events]
    else:
        selected=[None]*len(events)
        for i in range(len(events)-1,-1,-1):
            selected[i]=options[i][index]
            if i:index=int(backs[i-1][index])
    notes,audit=[],[]
    for i,(e,(a,b,_)) in enumerate(zip(events,selected)):
        note={'id':e['id'],'midi':e['midi'],'start':a/ticks,'duration':(b-a)/ticks,'velocity':.7,'origin':'transcribed'}
        if e.get('lyric'):note['lyric']=e['lyric']
        notes.append(note)
        audit.append({'noteId':e['id'],'sourceIds':e.get('sourceIds',[e['id']]),'wordId':e.get('wordId'),
            'sourceStartSeconds':e['start'],'sourceEndSeconds':e['end'],
            'scoreStartSeconds':origin+a/ticks*spb,'scoreEndSeconds':origin+b/ticks*spb,
            'consonantGapCandidate':bool(i and bridged[i-1]),'fallback':fallback})
    return notes,audit

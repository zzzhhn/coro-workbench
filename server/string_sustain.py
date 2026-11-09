"""Recover sustained string candidates without conflating piano attacks.

Instrumental MT3 only proposes a family. Basic Pitch supplies sustained pitch
regions, and the separated waveform must independently support those regions.
No expected instrument count, reference pitches or reference timings are used.
"""
import numpy as np

VERSION = 'string-sustain-consensus-3'
STRINGS = (40,41,42,43,48,50)


def _overlap(a, b):
    return min(a['end'],b['end'])-max(a['start'],b['start'])


def _shares(envelopes, note):
    a=max(0,round(note['start']*100));b=max(a+1,round(note['end']*100))
    values={k:v[note['midi'],a:b] for k,v in envelopes.items()}
    total=sum(values.values())+1e-12
    return {k:v/total for k,v in values.items()}


def waveform_measure(paths, note):
    """Bounded harmonic amplitude and attack evidence, not a timbre classifier."""
    import soundfile as sf
    from scipy.signal import stft,resample_poly
    start,end=note['start'],note['end']
    # A few seconds of an exceptionally long estimate suffice for this check.
    end=min(end,start+12.)
    left=max(0.,start-.16);right=end+.12
    f0=440*2**((note['midi']-69)/12)
    curves={}
    for source in ('other','piano','vocals'):
        with sf.SoundFile(paths[source]) as f:
            f.seek(min(f.frames,round(left*f.samplerate)))
            y=f.read(round((right-left)*f.samplerate),dtype='float32',always_2d=True).mean(1)
            if len(y)<2:return {'independent':False,'attackRise':0.}
            y=resample_poly(y,22050,f.samplerate)
        size=min(8192,len(y))
        bins,times,z=stft(y,22050,nperseg=size,noverlap=max(0,size-220),boundary='zeros')
        mag=abs(z);bands=[]
        for h in range(1,4):
            selected=abs(bins-h*f0)<=max(4.5,h*f0*.012)
            bands.append(mag[selected].max(0) if selected.any() else np.zeros(len(times)))
        curves[source]=np.asarray(bands)
    times=times+left;span=(times>=start)&(times<end)
    if span.sum()<4:return {'independent':False,'attackRise':0.}
    other=curves['other'][:,span];fundamental=other[0]
    total=sum(np.sum(curves[k][:,span]**2,axis=0) for k in curves)+1e-15
    share=np.sum(other**2,axis=0)/total
    # Use the energetic body, excluding low-level release noise.
    active=fundamental>=max(.0001,.18*np.quantile(fundamental,.8))
    corrs={}
    for source in ('piano','vocals'):
        a,b=fundamental[active],curves[source][0,span][active]
        corrs[source]=float(np.corrcoef(a,b)[0,1]) if len(a)>3 and min(np.std(a),np.std(b))>1e-9 else 0.
    median_share=float(np.median(share[active])) if active.any() else 0.
    fundamental_present=bool(active.any() and np.median(fundamental[active]/(other.max(0)[active]+1e-12))>=.13)
    independent=fundamental_present and float(fundamental.max())>=.0005 and (
        median_share>=.5 or (median_share>=.08 and max(corrs.values())<.75))
    before=curves['other'][0,(times>=start-.12)&(times<start-.02)]
    after=curves['other'][0,(times>=start+.01)&(times<start+.10)]
    rise=float(np.median(after)/max(float(np.median(before)),1e-8)) if len(before) and len(after) else 0.
    return dict(independent=independent,attackRise=rise,medianSourceShare=median_share,
                fundamentalPresent=fundamental_present,correlations=corrs)


def measure_unison_tail(paths, mixture_path, note, limit):
    """Check a pitched accompaniment body before and after a vocal release."""
    import soundfile as sf
    from scipy.ndimage import median_filter
    from scipy.signal import resample_poly, stft

    start, end = note['start'], note['end']
    left, right = max(0., start - .48), min(limit + .18, end + 1.22)
    samples = {}
    geometry = None
    for source, path in {'mix': mixture_path, **{k: paths[k] for k in ('other', 'piano', 'vocals')}}.items():
        with sf.SoundFile(path) as stream:
            if geometry is None:
                geometry = stream.samplerate, stream.frames
            if geometry != (stream.samplerate, stream.frames):
                return None
            stream.seek(min(stream.frames, round(left * stream.samplerate)))
            samples[source] = resample_poly(
                stream.read(round((right - left) * stream.samplerate), dtype='float32', always_2d=True).mean(1),
                22050, stream.samplerate)
    if len(samples['mix']) < 8192:
        return None
    samples['residual'] = samples.pop('mix') - samples['vocals'] - samples['piano']
    f0 = 440 * 2 ** ((note['midi'] - 69) / 12)
    targets = (f0, 2 * f0, 3 * f0, f0 / 2, f0 / 4)
    bands = {}
    for source, audio in samples.items():
        bins, times, z = stft(audio, 22050, nperseg=8192, noverlap=7972)
        magnitude = abs(z)
        bands[source] = np.asarray([
            magnitude[abs(bins - f) <= max(4.5, f * .012)].max(0) for f in targets])
    times += left
    other, piano, vocal, residual = (bands[k][0] for k in ('other', 'piano', 'vocals', 'residual'))
    tail = (times >= end + .10) & (times < min(end + .65, limit))
    before = (times >= start - .30) & (times < start - .12)
    entry = (times >= start - .10) & (times <= start + .24)
    if min(tail.sum(), before.sum(), entry.sum()) < 12:
        return None
    median = lambda values: float(np.median(values))
    floor = max(median(residual[before]), 1e-8)
    tail_level = median(other[tail])
    share = other[tail] ** 2 / (other[tail] ** 2 + piano[tail] ** 2 + vocal[tail] ** 2 + 1e-12)
    lower = np.maximum(bands['other'][3, tail], bands['other'][4, tail])
    evidence = {
        'otherTailAmplitude': tail_level,
        'medianOtherShare': median(share),
        'lowerOctaveRatio': median(other[tail] / (lower + 1e-12)),
        'secondHarmonicRatio': median(bands['other'][1, tail] / (other[tail] + 1e-12)),
        'thirdHarmonicRatio': median(bands['other'][2, tail] / (other[tail] + 1e-12)),
        'otherAttackRise': median(other[entry]) / max(median(other[before]), 1e-8),
        'residualAttackRise': median(residual[entry]) / floor,
    }
    if (tail_level < .001 or evidence['medianOtherShare'] < .72 or evidence['lowerOctaveRatio'] < 1.5
            or evidence['secondHarmonicRatio'] < .08 or evidence['thirdHarmonicRatio'] < .06
            or evidence['otherAttackRise'] < 3. or evidence['residualAttackRise'] < 1.8
            or np.mean((share >= .60) & (other[tail] >= .55 * tail_level)) < .80):
        return {'acoustics': evidence}
    onset_frames = times[entry & (median_filter(residual, size=11) >= 1.8 * floor)]
    # Measure the end of the supported body before the low-level release.
    tail_frames = np.flatnonzero((times >= end + .10) & (times < limit))
    release = tail_frames[median_filter(other, size=11)[tail_frames] < .55 * tail_level]
    last = times[release[0]] if len(release) else min(times[tail_frames[-1]], limit)
    if not len(onset_frames) or last < end + .55:
        return {'acoustics': evidence}
    return {'start': float(onset_frames[0]), 'end': float(last), 'acoustics': evidence}


def recover_string_unisons(events, vocal_notes, paths, mixture_path, *, measure=measure_unison_tail):
    """Recover an obscured second pitch in an independently anchored string phrase."""
    result = list(events)
    audit = {'addedUnisons': 0, 'decisions': [], 'claimsMusicalCorrectness': False}
    anchors = [n for n in events if n['program'] in STRINGS and
               'sustained_harmonics' in n.get('evidenceOrigins', [])]
    for note in vocal_notes:
        start, end, pitch = note['start'], note['end'], note['midi']
        if not 48 <= pitch <= 90 or not .35 <= end - start <= 4.:
            continue
        nearby = [n for n in anchors if n['start'] <= start and n['end'] >= end + .65
                  and 0 < abs(n['midi'] - pitch) <= 12]
        if not nearby or any(n['program'] in STRINGS and n['midi'] == pitch and _overlap(n, note) > .08
                             for n in result):
            continue
        anchor = min(nearby, key=lambda n: (abs(n['midi'] - pitch), -n['end']))
        measured = measure(paths, mixture_path, note, anchor['end'])
        if not measured or 'start' not in measured:
            continue
        addition = dict(start=measured['start'], end=measured['end'], midi=pitch,
                        program=anchor['program'], isDrum=False, velocity=.55,
                        evidenceOrigins=['vocal_pitch_seed', 'independent_accompaniment_tail', 'string_phrase_anchor'])
        result.append(addition)
        audit['decisions'].append(dict(action='recover_hidden_unison', after=addition, vocal=note,
                                       anchor=anchor, acoustics=measured['acoustics']))
    audit['addedUnisons'] = len(audit['decisions'])
    return sorted(result, key=lambda n: (n['start'], n['program'], n['midi'])), audit


def merge_string_program_duplicates(events):
    """One anonymous timed event can carry several unresolved GM labels."""
    groups = {}
    for note in events:
        if note['program'] in STRINGS and not note['isDrum'] and not note.get('sourceId'):
            groups.setdefault((note['start'], note['end'], note['midi']), []).append(note)
    merged = {}
    omitted = set()
    decisions = []
    for group in groups.values():
        programs = sorted({note['program'] for note in group})
        if len(programs) < 2:
            continue
        candidate = dict(group[0], program=48, candidatePrograms=programs,
                         evidenceOrigins=sorted({origin for note in group for origin in note.get('evidenceOrigins', [])}))
        merged[id(group[0])] = candidate
        omitted.update(id(note) for note in group[1:])
        decisions.append(dict(action='merge_unresolved_string_labels', before=group, after=candidate))
    result = [merged.get(id(note), note) for note in events if id(note) not in omitted]
    return sorted(result, key=lambda n: (n['start'], n['program'], n['midi'])), {
        'mergedLabelEvents': len(decisions), 'removedLabelDuplicates': len(omitted),
        'decisions': decisions, 'claimsIndividualPerformerIdentity': False}


def reconcile_string_sustains(events, basic_notes, instrumental, envelopes, measure, *, piano_notes=()):
    audit={'version':VERSION,'addedSustains':0,'replacedFragments':0,'removedPianoDuplicates':0,
           'decisions':[],'pending':[],'claimsMusicalCorrectness':False}
    candidates=[]
    # Stitch a model's retriggers only when the waveform lacks a fresh attack.
    for note in sorted(basic_notes,key=lambda n:(n['midi'],n['start'])):
        if not 35<=note['midi']<=95 or note.get('activation',0)<.40:continue
        if (candidates and candidates[-1]['midi']==note['midi']
                and -.01<=note['start']-candidates[-1]['end']<=.06
                and measure(note)['attackRise']<2.5):
            previous=candidates[-1];d=previous['end']-previous['start'];n=note['end']-note['start']
            previous.update(end=max(previous['end'],note['end']),activation=(d*previous['activation']+n*note['activation'])/(d+n))
        else:candidates.append(dict(note))
    accepted=[]
    for note in candidates:
        if note['end']-note['start']<.8 or note['activation']<.55:continue
        supports=[n for n in instrumental if n['program'] in STRINGS and not n['isDrum']
                  and n['midi']==note['midi'] and _overlap(n,note)>=.10]
        if not supports:continue
        evidence=measure(note)
        if not evidence['independent']:
            audit['pending'].append({'event':note,'reason':'no_independent_sustain','acoustics':evidence});continue
        # These models still share octave aliases and short piano/guitar
        # releases. This pass recovers long missing bodies, not arbitrary
        # pitches from the residual. Leave unresolved candidates untouched.
        if note['end']-note['start']<2.:
            audit['pending'].append({'event':note,'reason':'insufficient_sustain_span'});continue
        if any(abs(other['midi']-note['midi'])==12 and other['activation']>=.55
               and _overlap(other,note)>=.5*min(other['end']-other['start'],note['end']-note['start'])
               and other['end']-other['start']>=.8 for other in candidates):
            audit['pending'].append({'event':note,'reason':'octave_identity_ambiguous'});continue
        accepted.append((note,evidence,supports))
    result=[dict(n) for n in events]
    for note,evidence,supports in accepted:
        own=[n for n in result if n['program'] in STRINGS and not n['isDrum']
             and n['midi']==note['midi'] and _overlap(n,note)>.10]
        if any(n.get('sourceId') for n in own):continue
        # Keep separately supported, deliberate reattacks. A continuous
        # same-pitch model span must not erase them.
        if any(n['start']>note['start']+.15 and measure(n)['attackRise']>=2.5 for n in own):continue
        if len(own)==1 and own[0]['start']<=note['start']+.08 and own[0]['end']>=note['end']-.10:continue
        # A late model onset must not erase the native attack or a release
        # already supported beyond its span. Restrict this pass to recovery.
        if own and max(n['end'] for n in own)>note['end']+.1:continue
        programs={n['program'] for n in own}
        # The mixture can retain the bow's soft attack before separation and
        # frame activation cross their thresholds. Use that measured attack
        # only when it overlaps this continuous body and is at most 1s early.
        attacks=[n['start'] for n in supports if 0<=note['start']-n['start']<=1.]
        replacement=dict(start=min([note['start']]+[n['start'] for n in own]+attacks),end=note['end'],midi=note['midi'],
            program=next(iter(programs)) if len(programs)==1 else 48,isDrum=False,velocity=.65,
            evidenceOrigins=['basic_pitch_other','yourmt3_instrumental','sustained_harmonics'])
        result=[n for n in result if not any(n is old for old in own)]
        result.append(replacement)
        audit['addedSustains']+=int(not own);audit['replacedFragments']+=len(own)
        audit['decisions'].append(dict(action='sustain',before=own,after=replacement,acoustics=evidence,
                                       instrumentalSupport=supports))
    kept=[]
    for note in result:
        if note['program'] not in STRINGS or note.get('sourceId') or 'sustained_harmonics' in note.get('evidenceOrigins',[]):
            kept.append(note);continue
        piano=[n for n in result if n['program'] in (0,2) and not n['isDrum'] and n['midi']==note['midi']
               and abs(n['start']-note['start'])<=.10 and _overlap(n,note)>=.75*(note['end']-note['start'])]
        strong=any(n['midi']==note['midi'] and abs(n['start']-note['start'])<=.10 and n.get('activation',0)>=.8 for n in piano_notes)
        shares=_shares(envelopes,note)
        independent=any(n['midi']==note['midi'] and _overlap(n,note)>.1 for n,_,_ in accepted)
        if (piano and strong and not independent and len(shares['piano'])
                and np.quantile(shares['piano'],.2)>=.90 and np.quantile(shares['other'],.9)<=.04):
            audit['removedPianoDuplicates']+=1
            audit['decisions'].append(dict(action='remove_piano_leak',before=note,pianoSupport=piano))
        else:kept.append(note)
    return sorted(kept,key=lambda n:(n['start'],n['program'],n['midi'])),audit

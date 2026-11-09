"""Optional local source checks for whole-song multi-instrument transcription."""
from __future__ import annotations

import hashlib
import numpy as np
import logging
from pathlib import Path
import subprocess
import time

from . import config
from .storage import Cancelled, atomic_json, read_json
from .multi_sources import VERSION, fuse_sources, harmonic_source_evidence, piano_finger_durations

RUNTIME_VERSION = 'multiscore-sources-8'


def _check_vocal_disagreements(models, native, vocal, waveform, status):
    """Measure at most 60 seconds of automatically selected pitch disputes."""
    import numpy as np
    from .multi_vocal import adjudicate_vocal_consensus
    output = models / ('vocal-consensus-' + str(time.time_ns()))
    output.mkdir()
    lead = [n for n in native['events'] if n['program']==100 and not n['isDrum']
            and n.get('sourceId') in (None,'vocals')]
    atomic_json(output/'native.json', {'events':lead})
    atomic_json(output/'learned.json', vocal)
    command = [str(config.MODELS_DIR/'audio-quality/.venv/bin/python'), '-m', 'server.vocal_consensus_runner',
               '--audio',str(waveform),'--fcpe',str(models/'vocals-fcpe.npz'),
               '--native',str(output/'native.json'),'--learned',str(output/'learned.json'),'--output',str(output)]
    status.update(94,'source-check','正在复核主唱模型分歧处的音高和漏掉的短乐句。')
    with (output/'runner.log').open('w') as log:
        process=subprocess.Popen(command,cwd=config.ROOT,stdout=log,stderr=log)
        try:
            deadline=time.monotonic()+720
            while process.poll() is None:
                status.check_cancelled()
                if time.monotonic()>deadline:
                    raise TimeoutError('Bounded vocal pitch verification timed out')
                time.sleep(.2)
            if process.returncode:
                raise RuntimeError('Local vocal pitch verification failed')
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
    with np.load(output/'contours.npz',allow_pickle=False) as contour:
        events,audit=adjudicate_vocal_consensus(vocal['events'],lead,contour)
    audit['artifact']=str(output/'report.json')
    return {**vocal,'events':events,'localPitchConsensus':audit}


def build_source_proposal(directory: Path, native: dict, paths: dict[str, Path],
                          models: Path, vocal_events: list[dict], *, include_additions: bool = False,
                          learned_vocal: dict | None = None, duration: float | None = None,
                          mixture_path: Path | None = None) -> dict:
    piano, pedals = [], []
    engines = read_json(models / 'models.json')
    if 'piano' in engines.get('engines', {}) and (models / 'piano.json').is_file():
        measured = read_json(models / 'piano.json')
        rows, pedals = measured['notes'], measured.get('pedals', [])
        piano = [dict(start=n[0], end=n[1], midi=n[2], velocity=n[3], activation=n[4],
                      program=0, isDrum=False) for n in rows]
    envelopes = harmonic_source_evidence(paths, models / 'source-energy.npz')
    result = fuse_sources(native['events'], piano, vocal_events, envelopes)
    result['candidateEvents'] = result['events']
    if not include_additions:
        # Whole-song score inspection rejected a blind union: source leakage
        # can produce convincing isolated onsets. Keep these in an explicit
        # candidate score instead of silently increasing the default density.
        result['events'] = [n for n in result['events'] if 'yourmt3_mix' in n['evidenceOrigins']]
    for edit in result['sourceRefinement']['decisions']:
        edit['applied'] = edit['action'] != 'add' or include_additions
    result['sourceRefinement']['pendingAdditionalNotes'] = 0 if include_additions else sum(
        d['action'] == 'add' for d in result['sourceRefinement']['decisions'])
    result['sourceRefinement']['includesAdditionalCandidates'] = include_additions
    from .piano_consensus import reconcile_piano
    from .multi_vocal import replace_vocal_lead
    mixture = models / 'piano-mixture' / 'piano.json'
    mixture_notes = []
    if mixture.is_file():
        mixture_notes = [dict(start=n[0],end=n[1],midi=n[2],velocity=n[3],activation=n[4],program=0,isDrum=False)
                         for n in read_json(mixture)['notes']]
    result['events'], piano_audit = reconcile_piano(result['events'], piano, mixture_notes, envelopes)
    result['sourceRefinement']['pianoConsensus'] = piano_audit
    if mixture_path:
        from .string_support import cached_support
        from .string_sustain import reconcile_string_sustains, waveform_measure
        support = cached_support(models / 'string-support', mixture_path, paths)
        if support is not None:
            basic, instrumental = support
            try:
                result['events'], sustain_audit = reconcile_string_sustains(
                    result['events'], basic, instrumental, envelopes,
                    lambda note: waveform_measure(paths,note), piano_notes=piano)
            except (OSError, ValueError, KeyError, TypeError):
                logging.exception('Sustained-string evidence unavailable; existing events retained')
                sustain_audit = {'status':'unavailable','claimsMusicalCorrectness':False}
            result['sourceRefinement']['stringSustain'] = sustain_audit
        from .string_sustain import recover_string_unisons
        try:
            result['events'], unison_audit = recover_string_unisons(
                result['events'], vocal_events, paths, mixture_path)
            result['sourceRefinement']['stringUnisons'] = unison_audit
        except (OSError, ValueError):
            logging.exception('Hidden string unison evidence unavailable; existing notes retained')
        if support is not None:
            from .piano_harmonics import reconcile_piano_harmonic_leaks
            try:
                result['events'], harmonic_audit = reconcile_piano_harmonic_leaks(
                    result['events'], native['events'], piano, mixture_notes,
                    instrumental, paths, mixture_path)
                result['sourceRefinement']['pianoHarmonicLeaks'] = harmonic_audit
            except (OSError, ValueError, KeyError, TypeError):
                logging.exception('Piano harmonic ownership unavailable; existing string candidates retained')
    from .string_sustain import merge_string_program_duplicates
    result['events'], string_labels = merge_string_program_duplicates(result['events'])
    result['sourceRefinement']['stringLabels'] = string_labels
    if learned_vocal and learned_vocal.get('success') and mixture_path:
        from .vocal_phrase import recover_articulation_from_files
        try:
            phrased, phrase_audit = recover_articulation_from_files(
                learned_vocal['events'], paths['vocals'], models/'vocals-fcpe.npz', duration=duration)
            learned_vocal = {**learned_vocal, 'events': phrased, 'vocalArticulation': phrase_audit}
            result['sourceRefinement']['vocalArticulation'] = phrase_audit
        except (OSError, ValueError):
            logging.exception('Vocal articulation evidence unavailable; original boundaries retained')
        from .vocal_octave import adjudicate_vocal_octaves
        lead = [n for n in native['events'] if n['program'] == 100 and not n['isDrum']
                and n.get('sourceId') in (None, 'vocals')]
        try:
            checked, octave_audit = adjudicate_vocal_octaves(
                learned_vocal['events'], lead, vocal_path=paths['vocals'], mixture_path=mixture_path)
        except (OSError, ValueError):
            logging.exception('Vocal octave evidence unavailable; learned lead retained')
            checked = learned_vocal['events']
            octave_audit = {'status':'unavailable','edits':[],'claimsPitchTruth':False}
        learned_vocal = {**learned_vocal, 'events': checked, 'vocalOctaveConsensus': octave_audit,
                         'source_artifact_path':learned_vocal.get('artifact_path'),
                         'artifact_path':str(directory/'vocal-octave-events.json')}
        atomic_json(directory / 'vocal-octave-events.json', learned_vocal)
        result['sourceRefinement']['vocalOctaveConsensus'] = octave_audit
    result['events'], vocal_audit = replace_vocal_lead(
        result['events'], learned_vocal, source_id='vocals', source_label='人声分离轨',
        duration=duration or 0., voice_verification=engines.get('engines', {}).get('voiceVerification'))
    result['sourceRefinement']['vocalLead'] = vocal_audit
    if learned_vocal:
        for key in ('voicedIslandRecovery','localPitchConsensus'):
            if key in learned_vocal:
                result['sourceRefinement'][key]=learned_vocal[key]
    result['sourceRefinement']['version'] = RUNTIME_VERSION
    result['events'], finger = piano_finger_durations(result['events'], pedals)
    # Measured sustain-pedal intervals feed keyboard notation (written holds
    # under the pedal); they never change note events.
    result['sourceRefinement']['pianoPedals'] = [
        {'onset_time': float(p['onset_time']), 'offset_time': float(p['offset_time'])} for p in pedals]
    stem_frames = models / 'piano-activations.npz'
    if stem_frames.is_file() and 'bass' in paths and 'piano' in paths:
        # Recognition-layer audit of long low piano notes for a missed lower
        # octave. Candidates are recorded; the default score is unchanged.
        from .piano_low_octave import audit_low_octaves
        import soundfile as sf
        try:
            mix_path = models / 'piano-mixture' / 'piano-activations.npz'
            with np.load(stem_frames) as stem:
                stem_frame = stem['frame_output']
            mix_frame = None
            if mix_path.is_file():
                with np.load(mix_path) as mix:
                    mix_frame = mix['frame_output']
            bass, rate = sf.read(paths['bass'], always_2d=True)
            piano_audio, piano_rate = sf.read(paths['piano'], always_2d=True)
            if piano_rate == rate:
                result['events'], octave_audit = audit_low_octaves(
                    result['events'], stem_frame, mix_frame, bass.mean(1), piano_audio.mean(1), rate)
                result['sourceRefinement']['pianoLowOctave'] = octave_audit
        except (OSError, ValueError, KeyError):
            logging.exception('Piano low-octave audit unavailable; events unchanged')
    result['sourceRefinement']['outputEvents'] = len(result['events'])
    result['sourceRefinement']['fingerDurationProposals'] = finger
    result['sourceRefinement']['engines'] = engines
    result['sourceRefinement']['separatedSources'] = {key: path.name for key, path in paths.items()}
    # Never replace multi-events.json, which is the original inference result.
    atomic_json(directory / 'multi-source-events.json', result)
    return {**native, **result}


def refine_multi_sources(directory: Path, native: dict, status) -> dict:
    """One bounded sequential pass; failures leave the whole native score usable."""
    from .pipeline import separate_sources
    from .phoneme import infer_phoneme, runtime_health, MAX_SECONDS
    import soundfile as sf

    health = config.engine_health()
    if not health['demucs']['ready'] or not health['quality']['ready']:
        return {**native, 'sourceRefinementUnavailable': '本机未安装声源分离或独立音符模型。'}
    audio = directory / 'analysis.wav'
    identity = {'audioSha256': hashlib.sha256(audio.read_bytes()).hexdigest(), 'version': RUNTIME_VERSION}
    output = directory / 'multi-source-events.json'
    cache = directory / 'multi-source-cache.json'
    # A cached proposal also belongs to this exact native inference, not merely
    # to a filename or a previously successful model run.
    import json
    identity['nativeSha256'] = hashlib.sha256(json.dumps(native['events'], sort_keys=True).encode()).hexdigest()
    if output.is_file() and cache.is_file() and read_json(cache) == identity:
        return {**native, **read_json(output)}
    paths = separate_sources(audio, directory, status)
    status.update(92, 'source-check', '正在独立检查钢琴起音和人声音高，记录补音候选并核对乐器归属。')
    models = directory / 'multi-source-models'
    models.mkdir(exist_ok=True)
    inputs = {key: str(paths[key].resolve()) for key in ('vocals', 'piano')}
    atomic_json(models / 'inputs.json', inputs)
    command = [str(config.MODELS_DIR / 'audio-quality/.venv/bin/python'),
               str(config.ROOT / 'server/quality_runner.py'), '--input', str(models / 'inputs.json'),
               '--models', str(config.MODELS_DIR / 'audio-quality'), '--output', str(models)]
    with (models / 'runner.log').open('w') as log:
        process = subprocess.Popen(command, cwd=config.ROOT, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + max(1200, sf.info(audio).duration * 8)
            while process.poll() is None:
                status.check_cancelled()
                if time.monotonic() > deadline:
                    raise TimeoutError('Independent source checks timed out')
                time.sleep(.2)
            if process.returncode:
                raise RuntimeError('Independent source models failed')
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
    # A separated piano track can lose an exposed ornament. Inspect the same
    # waveform mixture too; only corroborated candidates enter the default score.
    mixture_dir = models / 'piano-mixture'
    mixture_dir.mkdir(exist_ok=True)
    atomic_json(mixture_dir / 'inputs.json', {'piano': str(audio.resolve())})
    mixture_command = [str(config.MODELS_DIR / 'audio-quality/.venv/bin/python'),
                       str(config.ROOT / 'server/quality_runner.py'), '--input', str(mixture_dir / 'inputs.json'),
                       '--models', str(config.MODELS_DIR / 'audio-quality'), '--output', str(mixture_dir)]
    with (mixture_dir / 'runner.log').open('w') as log:
        process = subprocess.Popen(mixture_command, cwd=config.ROOT, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + max(1200, sf.info(audio).duration * 8)
            while process.poll() is None:
                status.check_cancelled()
                if time.monotonic() > deadline:
                    logging.warning('Optional mixture piano check timed out; keep source-only evidence')
                    break
                time.sleep(.2)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
        if process.returncode != 0:
            # Never reuse a partial or prior success after this attempt failed.
            (mixture_dir / 'piano.json').unlink(missing_ok=True)
    vocal_events, learned_vocal = [], None
    if runtime_health()['ready'] and sf.info(paths['vocals']).duration <= MAX_SECONDS:
        phoneme_dir = models / ('phoneme-' + str(time.time_ns()))
        try:
            vocal = infer_phoneme(paths['vocals'], phoneme_dir,
                                  contour_path=models / 'vocals-fcpe.npz',
                                  cancel_check=lambda: status.cancel_path.exists())
            from .multi_vocal import recover_voiced_islands
            recovered, island_audit = recover_voiced_islands(
                vocal['events'], models / 'vocals-fcpe.npz', duration=sf.info(paths['vocals']).duration)
            vocal = {**vocal, 'events': recovered, 'voicedIslandRecovery': island_audit}
            try:
                vocal=_check_vocal_disagreements(models,native,vocal,paths['vocals'],status)
            except Cancelled:
                raise
            except Exception:
                logging.exception('Local vocal disagreements remain unresolved')
                vocal['localPitchConsensus']={'status':'unavailable','claimsPitchTruth':False}
            atomic_json(phoneme_dir/'lead-proposal.json',vocal)
            learned_vocal = {**vocal, 'artifact_path': str(phoneme_dir / 'lead-proposal.json')}
            vocal_events = [dict(start=n['source_start_seconds'], end=n['source_end_seconds'],
                                 midi=n['midi_pitch'], program=100, isDrum=False) for n in vocal['events']]
        except InterruptedError:
            raise Cancelled()
        except Exception:
            learned_vocal = {'success': False}
            logging.exception('Optional vocal boundaries failed; native vocal notes retained')
    status.check_cancelled()
    if any(n['program'] in (40,41,42,43,48,50) and not n['isDrum'] for n in native['events']):
        from .string_support import ensure_support
        try:
            ensure_support(models/'string-support',audio,paths,status)
        except Cancelled:
            raise
        except Exception:
            logging.exception('Optional sustained-string support unavailable; native strings retained')
    result = build_source_proposal(directory, native, paths, models, vocal_events,
                                   learned_vocal=learned_vocal, duration=sf.info(audio).duration,
                                   mixture_path=audio)
    if learned_vocal and learned_vocal.get('voicedIslandRecovery'):
        result['sourceRefinement']['voicedIslandRecovery'] = learned_vocal['voicedIslandRecovery']
        atomic_json(directory / 'multi-source-events.json', result)
    atomic_json(cache, identity)
    return result

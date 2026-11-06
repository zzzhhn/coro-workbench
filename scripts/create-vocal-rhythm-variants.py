"""Publish separate full-song lead-rhythm results from actual ROSVOT inference."""
from pathlib import Path
import argparse
import copy
import hashlib
import json
import math
import shutil
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server.audio_quality import note_quality
from server.pitch_evidence import read_pitch_window
from server.storage import atomic_json, utc_now
from server.vocal_score import VERSION, quantize_vocal_rhythm


def sha(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def rhythm_stats(notes):
    notes = [n for n in notes if n['midi'] is not None]
    gaps = [right['start'] - left['start'] - left['duration'] for left, right in zip(notes, notes[1:])]
    return {'notes': len(notes), 'atMost32nd': sum(n['duration'] <= .125 + 1e-7 for n in notes),
            'below32nd': sum(n['duration'] < .125 - 1e-7 for n in notes),
            'sub16thRests': sum(1e-7 < gap < .25 - 1e-7 for gap in gaps),
            'subEighthRests': sum(1e-7 < gap < .5 - 1e-7 for gap in gaps)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--align', action='store_true', help='Create new acoustic-boundary-aligned versions of the saved learned-note results')
    args = parser.parse_args()
    target = ROOT / ('evidence/phase7/four-aligned-vocal-songs.json' if args.align else 'evidence/phase6/four-vocal-rhythm-songs.json')
    if target.exists():
        raise RuntimeError('Existing delivery retained; no duplicate projects created')
    prior = json.loads((ROOT / ('evidence/phase6/four-vocal-rhythm-songs.json' if args.align else 'evidence/phase5/four-audio-harmony-songs.json')).read_text())
    keys = ['bye', 'attention', 'out_of_time', 'kong_er']
    result = {'inputs': prior['inputs'], 'scope': 'Real learned vocal notes + joint rhythmic score. Other parts, harmony, audio and all old projects unchanged. Counts are readability evidence, not accuracy.', 'results': []}
    for entry, name in zip(prior['results'], keys):
        parent = ROOT / 'data' / entry['jobId']
        source = json.loads((parent / 'project.json').read_text())
        evidence = json.loads((parent / 'quality-evidence.json').read_text())
        report_path = ROOT / f'data/phase6/rosvot/full-suite/{name}.json'
        report = json.loads(report_path.read_text())
        audio = Path(report['audio_path'])
        protected = [parent / value for value in ('project.json', 'raw-project.json', 'quality-evidence.json', 'status.json')]
        protected += [report_path, audio]
        hashes = {str(path.relative_to(ROOT)): sha(path) for path in protected}
        alignment = None
        candidate_events = report['events']
        if args.align:
            import numpy as np
            import soundfile as sf
            from server.lead_note_proposal import frame_acoustic_evidence
            from server.vocal_alignment import align_vocal_notes
            contour = audio.parent / 'lead-identity/lead-models/vocals-fcpe.npz'
            hashes[str(contour.relative_to(ROOT))] = sha(contour)
            with np.load(contour, allow_pickle=False) as track:
                samples, sr = sf.read(audio, dtype='float32', always_2d=True)
                features = frame_acoustic_evidence(track['time'], samples.mean(axis=1), sr)
                candidate_events, alignment = align_vocal_notes(report['events'], track['time'], track['f0'], track['activation'], features)
        events = [[event['source_start_seconds'], event['source_end_seconds'], event['midi_pitch'], .75]
                  for event in candidate_events if event['midi_pitch'] is not None]
        notes, rhythm = quantize_vocal_rhythm(events, evidence['grid'], source['originalAudio']['duration'], preserve_confidence=False)
        assert len(notes) == len(events) and all('confidence' not in note for note in notes)
        project = copy.deepcopy(source)
        project['id'] = uuid.uuid4().hex
        project['title'] = source['title'].split(' · ')[0] + (' · 词音对齐' if args.align else ' · 词音节奏')
        project['createdAt'] = project['updatedAt'] = utc_now()
        lead = next(part for part in project['parts'] if part['id'] == 'vocals')
        old_notes = copy.deepcopy(lead['notes'])
        lead['notes'], lead['name'] = notes, '主唱 · 词音节奏'
        end = max((n['start'] + n['duration'] for part in project['parts'] for n in part['notes']), default=0.)
        project['measures'] = max(project['measures'], math.ceil(end / (project['timeSignature'][0] * 4 / project['timeSignature'][1])))
        analysis = project['source']['analysis']
        analysis['transforms'] = ['前序版本记录：' + text if any(key in text for key in ('主唱旋律提案', 'FCPE重新做声学', '单旋律解码的主唱/低音')) else text for text in analysis['transforms']]
        analysis['transforms'].append('本版主唱重新使用ROSVOT/RWBD词音边界模型，并联合整理相邻起止。未统一删短音，全部模型有音高事件一对一进入谱面；原FCPE主唱谱与完整模型输出保留。其它声部、和弦、速度与原始音频不变。')
        if alignment:
            analysis['transforms'].append('使用实际FCPE音高进入/退出与音频再起音逐处校正词音边界，不统一延后整曲；保持模型事件与音高序列不变，保留充分换气间隙。')
        analysis['quality'].update({'decoderRequested': 'rosvot', 'decoderProfile': 'rosvot', 'decoderVersion': 'rosvot-rwbd-joint-score-1',
                                    'vocalRhythmVersion': VERSION, 'vocalRhythmMaxOnsetShiftSeconds': rhythm['maximumOnsetShiftSeconds'],
                                    'derivedFromJob': entry['jobId'], 'groundTruthAvailable': False,
                                    'modelEvidenceUrl': f"/api/projects/{project['id']}/evidence"})
        analysis['quality'].update(note_quality(project['parts']))
        if alignment:
            analysis['quality'].update({'decoderVersion': 'rosvot-rwbd-acoustic-alignment-score-2', 'vocalAlignmentVersion': alignment['version'], 'vocalAlignedBoundaries': len(alignment['boundaryEdits'])})
        analysis['rawProjectUrl'] = f"/api/projects/{project['id']}/raw"
        project['source']['warnings'] = [text for text in project['source']['warnings'] if not text.startswith(('声学起止为独立备选', '音符吸附到十六分音符'))]
        project['source']['warnings'].append('主唱为词音边界模型与节奏整理结果。FCPE/CREPE曲线及独立检查仍是原声的另外两条模型证据，不是在验证ROSVOT音符正确。歌词未识别；节奏整理不保证所有自由节奏和装饰音完全还原。')
        destination = ROOT / 'data' / project['id']
        destination.mkdir()
        audit = destination / 'dense-voice-audit/contours.npz'
        audit.parent.mkdir()
        old_audit = Path(evidence['denseVoiceAudit']['contourFile'])
        shutil.copyfile(old_audit, audit)
        assert sha(old_audit) == sha(audit)
        atomic_json(audit.parent / 'cache.json', {'contourSha256': sha(audit), 'copiedFromJob': entry['jobId']})
        evidence['denseVoiceAudit']['contourFile'] = str(audit)
        evidence['previousVocalScore'] = old_notes
        evidence['learnedVocalNotes'] = report
        evidence['scoreRhythm'] = rhythm
        if alignment:
            evidence['vocalBoundaryAlignment'] = alignment
            evidence['alignedVocalEvents'] = candidate_events
        evidence['vocalRhythmRevision'] = {'sourceJob': entry['jobId'], 'inputHashes': hashes, 'otherPartsAndChordsUnchanged': True, 'inference': str(report_path.relative_to(ROOT)), 'actualNeuralInference': True}
        evidence['revisionMetrics'] = note_quality(project['parts'])
        atomic_json(destination / 'quality-evidence.json', evidence)
        shutil.copyfile(parent / 'raw-project.json', destination / 'raw-project.json')
        request = json.loads((parent / 'request.json').read_text())
        request.update(id=project['id'], decoder='rosvot', derivedFromJob=entry['jobId'])
        atomic_json(destination / 'request.json', request)
        atomic_json(destination / 'project.json', project)
        atomic_json(destination / 'status.json', {'id': project['id'], 'createdAt': utc_now(), 'updatedAt': utc_now(), 'status': 'complete', 'stage': 'complete', 'progress': 100, 'message': '词音节奏重建已另存；原谱保留。', 'project': project})
        assert source['parts'][1:] == project['parts'][1:] and source['chords'] == project['chords'] and source['originalAudio'] == project['originalAudio']
        assert all(sha(ROOT / path) == value for path, value in hashes.items())
        assert read_pitch_window(destination, 0, 8)['integrity'] == 'sha256_checked'
        row = {'filename': entry['filename'], 'jobId': project['id'], 'sourceJobId': entry['jobId'],
               'projectPath': str(destination / 'project.json'), 'rawProjectPath': str(destination / 'raw-project.json'),
               'before': rhythm_stats(old_notes), 'after': rhythm_stats(notes), 'modelVoicedNotes': len(events),
               'allModelAttacksRetained': len(notes) == len(events), 'inputHashes': hashes,
               'maximumOnsetShiftSeconds': rhythm['maximumOnsetShiftSeconds'], 'maximumOffsetShiftSeconds': rhythm['maximumOffsetShiftSeconds']}
        if alignment:
            row['alignment'] = {key: value for key, value in alignment.items() if key != 'boundaryEdits'}
            row['alignment']['adjustedBoundaries'] = len(alignment['boundaryEdits'])
        result['results'].append(row)
        print(json.dumps({key: val for key, val in row.items() if key != 'inputHashes'}, ensure_ascii=False), flush=True)
    atomic_json(target, result)


if __name__ == '__main__':
    main()

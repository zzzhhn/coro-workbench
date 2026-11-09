#!/usr/bin/env python3
"""Frozen, complete BabySlakh regression: audio -> pipeline -> labels -> score.

Synthetic music, likely training overlap. Never a real-recording generalization
claim. Download only selected ZIP members; no archive-wide fallback.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import struct
import sys
import urllib.request
import urllib.error
import zlib

for key in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMBA_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS'):
    os.environ[key] = '1'
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
DATA = ROOT / 'data/p0-multiscore/full-songs'
URL = 'https://zenodo.org/api/records/4603844/files/babyslakh_16k.zip/content'
ARCHIVE_BYTES, MEMBER_PREFIX = 882883087, 'babyslakh_16k'
DATASET, LABEL_CLASSES = 'babyslakh', {}
# Official ZIP central directory checked before prediction or label access.
# member: local header offset, compressed bytes, uncompressed bytes, CRC32
MEMBERS = {
    'Track00009': {
        'mix.wav': (168947648, 4645741, 5140014, '97c87dce'),
        'MIDI/S00.mid': (168940852, 3512, 10123, 'fe6ec7b9'),
        'MIDI/S01.mid': (168944463, 2228, 6140, '795585f3'),
        'MIDI/S02.mid': (168938654, 2099, 5745, '5f5691f2'),
        'MIDI/S03.mid': (168936353, 2202, 6105, 'b151829c'),
        'MIDI/S04.mid': (168926779, 2093, 5786, '88c49924'),
        'MIDI/S05.mid': (168919589, 2618, 6607, '1ccc80d9'),
        'MIDI/S06.mid': (168931614, 2456, 6754, 'b6b47e0b'),
        'MIDI/S07.mid': (168934169, 2085, 6130, 'a66f4a25'),
        'MIDI/S10.mid': (168924825, 1855, 5318, '6c84da00'),
        'MIDI/S11.mid': (168922306, 2420, 7270, '8f048955'),
        'MIDI/S12.mid': (168928971, 2544, 7520, '09e70d17'),
    },
    'Track00010': {
        'mix.wav': (641092945, 5291317, 5820638, 'de0e0425'),
        'MIDI/S00.mid': (641090690, 598, 2255, '6f23b893'),
        'MIDI/S01.mid': (641091387, 818, 7777, 'ed22898a'),
        'MIDI/S02.mid': (641090262, 329, 1136, '247467ab'),
        'MIDI/S03.mid': (641089845, 318, 1135, '7a1c666b'),
        'MIDI/S04.mid': (641087943, 1071, 1378, '9c81cb51'),
        'MIDI/S05.mid': (641087047, 797, 2817, '4ee98e13'),
        'MIDI/S06.mid': (641089113, 633, 9413, 'f695edb4'),
    },
}
CLASSES = {
    0: [0, 1, 3, 6, 7], 2: [2, 4, 5], 8: list(range(8, 16)),
    16: list(range(16, 24)), 24: [24, 25], 26: [26, 27, 28], 29: [29, 30, 31],
    32: [32, 35], 33: [33, 34, 36, 37, 38, 39],
    40: [40], 41: [41], 42: [42], 43: [43], 46: [46], 47: [47],
    48: [48, 49, 44, 45], 50: [50, 51], 52: [52, 53, 54], 55: [55],
    56: [56, 59], 57: [57], 58: [58], 60: [60], 61: [61, 62, 63],
    64: [64, 65], 66: [66], 67: [67], 68: [68], 69: [69], 70: [70], 71: [71],
    73: [73, 72, 74, 75, 76, 77, 78, 79], 80: list(range(80, 88)), 88: list(range(88, 96)),
}
PROGRAM_CLASS = {program: group for group, programs in CLASSES.items() for program in programs}


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def save_once(path, value):
    text = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + '\n'
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_text() != text:
            raise ValueError(f'Frozen evidence differs: {path}')
    else:
        with path.open('x') as stream:
            stream.write(text)


def read(path):
    return json.loads(path.read_text())


def protocol():
    result = {'version': 1, 'dataset': URL, 'license': 'CC-BY-4.0', 'members': MEMBERS,
            'selection': 'Two smallest compressed complete mixes, chosen before predictions and MIDI access',
            'scope': 'Synthetic full-song development regression; likely Slakh training overlap',
            'classes': CLASSES, 'onsetToleranceSeconds': .05, 'offsetRatio': .2,
            'minimumOffsetToleranceSeconds': .05, 'pitchToleranceCents': 50,
            'labelTimeShiftSeconds': 0, 'octaveRepair': False,
            'drums': 'exact GM pitch and onset, reported separately; no offset metric',
            'identity': 'aggregate by trained instrument class, not by individual performer',
            'variants': ['native', 'legacy_notation', 'bounded_notation'],
            'legacy': 'family aggregation and quarter-beat quantize_notes from prior multi.py; before optional second quality pass'}
    if DATASET == 'trios':
        result.update(license='CC-BY-NC-SA-2.0-UK',
                      selection='Smallest supplied real-performance mix, chosen before predictions or MIDI access',
                      scope='18-second controlled real-performance trio excerpt; not a whole song or a proven unseen benchmark',
                      labelClasses=LABEL_CLASSES,
                      alignment='Author manually aligned per-part MIDI; no measured 50ms annotation-error guarantee')
    return result


def configure_dataset(name):
    if name == 'babyslakh':
        return
    global DATA, URL, ARCHIVE_BYTES, MEMBER_PREFIX, MEMBERS, DATASET, LABEL_CLASSES
    DATASET = 'trios'
    DATA = ROOT / 'data/p0-multiscore/real-trio'
    URL = 'https://zenodo.org/api/records/6797837/files/TRIOS%20Dataset.zip/content'
    ARCHIVE_BYTES, MEMBER_PREFIX = 92820286, 'TRIOS Dataset'
    MEMBERS = {'lussier': {
        'mix.wav': (22365240, 1385397, 1587644, '53b0f7be'),
        'bassoon.mid': (19788342, 520, 665, '95698eee'),
        'piano.mid': (23750744, 692, 935, 'a1384ff6'),
        'trumpet.mid': (26237584, 285, 312, 'e821622a'),
    }}
    LABEL_CLASSES = {'bassoon.mid': 70, 'piano.mid': 0, 'trumpet.mid': 56}


class RangeReader:
    def __init__(self):
        self.bytes = 0

    def get(self, start, length):
        if length > 512_000:
            return b''.join(self.get(start + at, min(512_000, length - at)) for at in range(0, length, 512_000))
        request = urllib.request.Request(URL, headers={'Range': f'bytes={start}-{start + length - 1}'})
        for attempt in range(3):
            if self.bytes + length > 20_000_000:
                raise ValueError('20 MB per-command budget including retries exceeded')
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    expected = f'bytes {start}-{start + length - 1}/{ARCHIVE_BYTES}'
                    if response.status != 206 or response.headers.get('Content-Range') != expected:
                        raise ValueError('Range not honored; refusing full ZIP')
                    data = response.read(length + 1)
                self.bytes += len(data)
                if len(data) == length:
                    return data
                if attempt == 2:
                    raise ValueError(f'Truncated range {start}: {len(data)} of {length} bytes')
            except urllib.error.URLError:
                if attempt == 2:
                    raise

    def extract(self, track, member):
        offset, compressed, size, crc = MEMBERS[track][member]
        target = DATA / track / member
        if target.exists():
            data = target.read_bytes()
        else:
            header = self.get(offset, 30)
            fields = struct.unpack('<4s5H3I2H', header)
            if fields[0] != b'PK\x03\x04' or fields[3] != 8 or fields[2] & 1:
                raise ValueError('Unexpected ZIP method or encrypted member')
            name_length, extra_length = fields[-2:]
            name = self.get(offset + 30, name_length)
            if name.decode() != f'{MEMBER_PREFIX}/{track}/{member}':
                raise ValueError('ZIP member mismatch')
            data = zlib.decompress(self.get(offset + 30 + name_length + extra_length, compressed), -15)
        if len(data) != size or f'{zlib.crc32(data):08x}' != crc:
            raise ValueError('ZIP member checksum mismatch')
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as stream:
                stream.write(data)
        return digest(target)


def prepare():
    save_once(DATA / 'protocol.json', protocol())
    reader = RangeReader()
    for track in MEMBERS:
        print(track, reader.extract(track, 'mix.wav'), flush=True)
    print('Network bytes:', reader.bytes, flush=True)


def infer():
    from server.pipeline import analyze_audio
    from server.storage import JobStatus, atomic_json
    if read(DATA / 'protocol.json') != json.loads(json.dumps(protocol())):
        raise ValueError('Protocol changed')
    for track in MEMBERS:
        directory = DATA / track
        frozen = directory / 'frozen-prediction.json'
        if frozen.exists():
            verify_frozen(directory)
            continue
        if any(directory.rglob('*.mid')):
            raise ValueError('Labels already present before prediction freeze')
        job_id = '000000000000000000000000000000' + track[-4:] if DATASET == 'babyslakh' else hashlib.sha256(track.encode()).hexdigest()[:32]
        request = {'id': job_id, 'filename': track + '.wav',
                   'input': 'mix.wav', 'mode': 'multi', 'tempo': None, 'max_seconds': 600,
                   'quality': 'auto', 'decoder': 'standard', 'verification': 'full'}
        atomic_json(directory / 'request.json', request)
        atomic_json(directory / 'status.json', {'id': request['id'], 'status': 'queued'})
        print('Starting complete pipeline:', track, flush=True)
        result = analyze_audio(directory, request, JobStatus(directory))
        quality = result['source'].get('analysis', {}).get('quality', {})
        if quality.get('stage') not in ('multitrack_bounded_score', 'multitrack_musical_score'):
            raise ValueError('Quality pass failed; cannot freeze successful pipeline')
        JobStatus(directory).finish(result)
        files = ['mix.wav', 'multi-events.json', 'project.json', 'raw-project.json', 'quality-evidence.json', 'analysis-evidence.json']
        files += [name for name in ('multi-source-events.json', 'multi-source-cache.json') if (directory / name).is_file()]
        code = ['server/multi.py', 'server/polyphonic_score.py', 'server/score_rhythm.py',
                'server/multi_decode.py', 'server/multi_sources.py', 'server/multi_source_runtime.py',
                'server/yourmt3_runner.py', 'server/audio_quality.py', 'server/pipeline.py']
        checkpoint = next((ROOT / 'models/yourmt3/amt/logs').rglob('last.ckpt'))
        save_once(frozen, {'files': {name: digest(directory / name) for name in files},
                           'code': {name: digest(ROOT / name) for name in code}, 'quality': quality,
                           'checkpointSha256': digest(checkpoint), 'protocolSha256': digest(DATA / 'protocol.json')})
        print('Frozen:', track, sum(len(p['notes']) for p in result['parts']), 'notes', flush=True)


def verify_frozen(directory):
    frozen = read(directory / 'frozen-prediction.json')
    for name, expected in frozen['files'].items():
        if digest(directory / name) != expected:
            raise ValueError('Frozen artifact changed: ' + name)
    if digest(DATA / 'protocol.json') != frozen['protocolSha256']:
        raise ValueError('Frozen protocol changed')


def metrics(ref, pred, *, offsets=False, class_aware=False):
    import numpy as np
    from mir_eval.transcription import match_notes
    groups = sorted({n['program'] for n in ref + pred}) if class_aware else [None]
    counts = []
    for group in groups:
        r = [n for n in ref if group is None or n['program'] == group]
        p = [n for n in pred if group is None or n['program'] == group]
        matches = match_notes(np.array([[n['start'], n['end']] for n in r]).reshape(-1, 2),
                              np.array([440 * 2 ** ((n['midi'] - 69) / 12) for n in r]),
                              np.array([[n['start'], n['end']] for n in p]).reshape(-1, 2),
                              np.array([440 * 2 ** ((n['midi'] - 69) / 12) for n in p]),
                              onset_tolerance=.05, pitch_tolerance=50, offset_ratio=.2 if offsets else None,
                              offset_min_tolerance=.05) if r and p else []
        counts.append({'class': group, 'reference': len(r), 'predicted': len(p), 'matches': len(matches),
                       'f1': 2 * len(matches) / max(1, len(r) + len(p))})
    nr, npred, nm = (sum(c[k] for c in counts) for k in ('reference', 'predicted', 'matches'))
    return {'reference': nr, 'predicted': npred, 'matches': nm, 'precision': nm / max(1, npred),
            'recall': nm / max(1, nr), 'f1': 2 * nm / max(1, nr + npred),
            'macroF1': sum(c['f1'] for c in counts) / max(1, len(counts)), 'classes': counts}


def legacy_events(native, tempo, duration):
    from server.multi import family_for_program
    from server.pipeline import quantize_notes
    grouped = {}
    for event in native:
        family, _, role, _, program = family_for_program(event['program'], event['isDrum'])
        grouped.setdefault((family, role == 'percussion', program), []).append(event)
    result = []
    for (family, drum, program), events in grouped.items():
        if drum:
            unique = {(round(e['start'] * tempo / 60 * 4) / 4, e['midi']) for e in events if 0 <= e['start'] < duration}
            notes = [{'start': start, 'duration': .25, 'midi': pitch} for start, pitch in unique]
        else:
            notes = quantize_notes([[e['start'], e['end'], e['midi'], .75] for e in events], tempo, duration, family)
        result += [{'start': n['start'] * 60 / tempo, 'end': (n['start'] + n['duration']) * 60 / tempo,
                    'midi': n['midi'], 'program': program, 'isDrum': drum} for n in notes]
    return result


def score():
    import pretty_midi
    if read(DATA / 'protocol.json') != json.loads(json.dumps(protocol())):
        raise ValueError('Scoring configuration differs from the frozen protocol')
    reader, results = RangeReader(), []
    # All recordings must have frozen predictions before any MIDI is acquired.
    for track in MEMBERS:
        verify_frozen(DATA / track)
    for track, members in MEMBERS.items():
        directory = DATA / track
        refs, label_hashes = [], {}
        for member in members:
            if not member.endswith('.mid'):
                continue
            label_hashes[member] = reader.extract(track, member)
            for instrument in pretty_midi.PrettyMIDI(str(directory / member)).instruments:
                group = LABEL_CLASSES[member] if member in LABEL_CLASSES else 128 if instrument.is_drum else PROGRAM_CLASS[instrument.program]
                refs += [{'start': n.start, 'end': n.end, 'midi': n.pitch, 'program': group,
                          'isDrum': instrument.is_drum, 'source': member} for n in instrument.notes]
        save_once(directory / 'frozen-labels.json', label_hashes)
        project, raw = read(directory / 'project.json'), read(directory / 'raw-project.json')
        native = read(directory / 'multi-events.json')
        audit = read(directory / 'quality-evidence.json')['multiInstrument']['scoreConversion']
        bounded = [{'start': n['start'] * 60 / project['tempo'] + project['originalAudio']['offsetSeconds'],
                    'end': (n['start'] + n['duration']) * 60 / project['tempo'] + project['originalAudio']['offsetSeconds'],
                    'midi': n['midi'], 'program': audit['parts'][p['id']]['program'],
                    'isDrum': p['role'] == 'percussion'} for p in project['parts'] for n in p['notes']]
        duration = read(directory / 'analysis-evidence.json')['analyzedDurationSeconds']
        variants = {'native': [n for n in native['events'] if n['start'] < duration],
                    'legacy_notation': legacy_events(native['events'], raw['tempo'], duration), 'bounded_notation': bounded}
        row = {'track': track, 'durationSeconds': duration, 'sourceTracks': len(label_hashes),
               'predictedParts': len(project['parts']), 'nativeEvents': len(native['events']),
               'segments': native['numSegments'], 'runtimeSeconds': native['runtimeSeconds'],
               'decodeErrors': native['decodeErrors'], 'variants': {}}
        for name, predicted in variants.items():
            r, p = ([n for n in events if not n['isDrum']] for events in (refs, predicted))
            rd, pd = ([n for n in events if n['isDrum']] for events in (refs, predicted))
            result = {'pitchedOnset': metrics(r, p), 'pitchedFullNote': metrics(r, p, offsets=True),
                      'drumOnset': metrics(rd, pd)}
            if name != 'legacy_notation':
                result.update(classOnset=metrics(r, p, class_aware=True),
                              classFullNote=metrics(r, p, offsets=True, class_aware=True))
            row['variants'][name] = result
        results.append(row)
        print(track, {name: round(value['pitchedFullNote']['f1'], 4) for name, value in row['variants'].items()}, flush=True)
    save_once(DATA / 'metrics.json', {'protocol': protocol(), 'results': results})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'infer', 'score'))
    parser.add_argument('--dataset', choices=('babyslakh', 'trios'), default='babyslakh')
    arguments = parser.parse_args()
    configure_dataset(arguments.dataset)
    globals()[arguments.action]()

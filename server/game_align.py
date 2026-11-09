"""Raw vocal evidence saved beside a GAME upload; never read by notation.

- ``game/align.json``: official GAME align over SOFA word regions, only when
  the user supplied LRC (known lyrics). Without lyrics no word boundaries
  exist, so align is recorded as skipped rather than guessed from ASR.
- ``game/syllable-boundary.npz``: SOFA's text-free phone-boundary posterior
  over the GAME silence-sliced chunks (audio only).

Both are recognition-layer evidence for later fusion experiments. Failures
are recorded and do not change the score.
"""
from __future__ import annotations

VERSION = 'game-align-evidence-1'


def align_regions(alignment: dict) -> list[dict]:
    """Contiguous word regions for GAME align from SOFA phones.

    Silence/breath (SP) phones become unvoiced regions and each syllable one
    voiced region. LRC sentence windows overlap by design, so touching
    sentences are clipped at their midpoint: no audio span is aligned twice.
    """
    segments = []
    for segment in alignment['segments']:
        words = []
        for phone in segment['phones']:
            key = ('sp', len(words)) if phone['wordIndex'] < 0 else ('w', phone['wordIndex'])
            if words and words[-1]['key'] == key and key[0] == 'w':
                words[-1]['end'] = phone['end']
            else:
                words.append({'key': key, 'start': phone['start'], 'end': phone['end'], 'voiced': key[0] == 'w'})
        for a, b in zip(words, words[1:]):
            b['start'] = a['end']
        rows = [{'start': w['start'], 'end': w['end'], 'voiced': w['voiced'],
                 **({'wordIndex': w['key'][1]} if w['voiced'] else {})}
                for w in words if w['end'] > w['start'] + 1e-6]
        if rows:
            segments.append({'id': segment['id'], 'text': segment['text'], 'words': rows})
    for previous, following in zip(segments, segments[1:]):
        a, b = previous['words'], following['words']
        if a and b and a[-1]['end'] > b[0]['start']:
            cut = (a[-1]['end'] + b[0]['start']) / 2
            previous['words'] = [dict(w, end=min(w['end'], cut)) for w in a if w['start'] < cut - 1e-6]
            following['words'] = [dict(w, start=max(w['start'], cut)) for w in b if w['end'] > cut + 1e-6]
    return [s for s in segments if s['words']]


def chunk_windows(raw: dict) -> list[list[float]]:
    """GAME's own inference windows (silence-sliced chunks) in seconds."""
    return [[s['offsetSeconds'], s['offsetSeconds']+s['durationSeconds']] for s in raw.get('segments', [])]

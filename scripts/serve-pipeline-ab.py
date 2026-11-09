"""Loopback-only allowlisted assets for private pipeline experiments."""
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
import uvicorn

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'evidence/pipeline-ab-20261108'
SONG = ROOT / 'data/p0-multiscore/private-konger'
allowed = {name: OUT / name for name in ('review.json', 'baseline-score.wav', 'candidate-score.wav')}
allowed.update({'original.wav': SONG / 'baseline/analysis.wav',
                'raw.wav': ROOT / 'evidence/vocal-ab-20261107/playback/game-medium-phrases-raw.wav',
                'vocals.wav': SONG / 'separated/stem-vocals.wav',
                'other.wav': SONG / 'separated/stem-other.wav'})
allowed.update({f'reference/{i:02}.png': ROOT / f'evidence/konger/reference/score-{i:02}.png' for i in range(1, 20)})
LYRICS = ROOT / 'evidence/lyrics-assisted-20261108'
allowed['lyrics-v1-review.json'] = LYRICS / 'review.json'
allowed.update({f'lyrics/{key}.wav': LYRICS / f'{key}.wav' for key in ('raw', 'current', 'lyrics')})
READABLE = ROOT / 'evidence/lyrics-readable-20261108'
allowed['lyrics-v2-review.json'] = READABLE / 'review.json'
allowed.update({f'lyrics-v2/{key}.wav': READABLE / f'{key}.wav' for key in ('raw', 'current', 'lyrics')})
PHRASING = ROOT / 'evidence/lyrics-phrasing-20261108'
allowed['lyrics-review.json'] = PHRASING / 'review.json'
allowed.update({f'lyrics-v3/{key}.wav': PHRASING / f'{key}.wav' for key in ('raw', 'current', 'lyrics')})
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(CORSMiddleware, allow_origins=['http://127.0.0.1:5173'], allow_methods=['GET'])


@app.get('/{name:path}')
def asset(name: str):
    path = allowed.get(name)
    if path is None or not path.is_file():
        raise HTTPException(404)
    return FileResponse(path, headers={'Cache-Control': 'no-cache'})


if __name__ == '__main__':
    uvicorn.run(app, host='127.0.0.1', port=8788, log_level='warning')

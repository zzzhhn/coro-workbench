"""Register already-downloaded official GAME Medium assets without copying weights.

Usage: .venv/bin/python scripts/setup-game.py --model /path/to/medium-onnx --source /path/to/GAME-1.0.3
"""
import argparse
import hashlib
import json
from pathlib import Path


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--model', type=Path, required=True)
    p.add_argument('--source', type=Path, required=True)
    args = p.parse_args()
    model, source = args.model.resolve(), args.source.resolve()
    cfg = json.loads((model/'config.json').read_text())
    if cfg.get('embedding_dim') != 256 or cfg.get('samplerate') != 44100:
        p.error('Expected GAME 1.0.3 Medium ONNX configuration.')
    paths = [model/f'{n}.onnx' for n in ('encoder','segmenter','estimator','dur2bd','bd2dur')]
    paths += [model/'config.json', source/'inference/slicer2.py']
    if not all(q.is_file() for q in paths):
        p.error('Missing GAME weights, config or official slicer source.')
    destination = Path(__file__).resolve().parents[1]/'models/game'
    destination.mkdir(exist_ok=True)
    for name, target in [('medium',model),('source',source)]:
        link = destination/name
        if link.exists() and link.resolve() != target:
            p.error(f'{link} already points elsewhere; no installation was replaced.')
        if not link.exists():
            link.symlink_to(target,target_is_directory=True)
    hashes = {str(q):hashlib.file_digest(q.open('rb'),'sha256').hexdigest() for q in paths}
    (destination/'installation.json').write_text(json.dumps({'model':'GAME 1.0.3 Medium','hashes':hashes},indent=2))
    print('GAME Medium registered locally. Restart Coro when no analysis job is active.')


if __name__ == '__main__':
    main()

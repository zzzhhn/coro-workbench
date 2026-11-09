"""Startup identity and installation inspection; never loads model weights."""
from __future__ import annotations

import hashlib
import json
import platform
import subprocess
from pathlib import Path


def runtime_identity(root: Path) -> dict:
    root = root.resolve()
    digest = hashlib.sha256()
    for path in sorted((root / 'server').glob('*.py')):
        digest.update(path.relative_to(root).as_posix().encode() + b'\0')
        digest.update(path.read_bytes() + b'\0')
    try:
        revision = subprocess.run(['git', 'rev-parse', '--short=12', 'HEAD'], cwd=root,
                                  capture_output=True, text=True, timeout=2, check=True).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        revision = None
    return {'workspaceId': hashlib.sha256(str(root).encode()).hexdigest()[:16],
            'codeHash': digest.hexdigest(), 'revision': revision, 'python': platform.python_version()}


def inspect_environment() -> dict:
    from . import config
    engines = config.engine_health()
    for name, module in [('vocalNotes', 'rosvot'), ('phonemeNotes', 'phoneme'), ('enhancedVocals', 'melband'), ('harmony', 'chordino')]:
        try:
            from importlib import import_module
            engines[name] = import_module(f'server.{module}').runtime_health()
        except (ImportError, OSError, ValueError) as error:
            engines[name] = {'ready': False, 'note': str(error)}
    from .omr import omr_health
    engines['omr'] = omr_health()
    return {'runtime': runtime_identity(config.ROOT), 'engines': engines}


if __name__ == '__main__':
    print(json.dumps(inspect_environment()))

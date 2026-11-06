#!/usr/bin/env python3
"""Install pinned official Chordino artifacts locally on macOS, without a GUI.

Python3.11+ standard library only. Downloads official verified assets, statically
extracts the reviewed Qt resource payload, and verifies a short silence run.
No sudo, installer execution, global plugin writes or neural model downloads.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = {
    'sonic-annotator-1.7.0-macos.tar.gz': {
        'url': 'https://github.com/sonic-visualiser/sonic-annotator/releases/download/sonic-annotator-1.7/sonic-annotator-1.7.0-macos.tar.gz',
        'bytes': 10638233, 'sha256': 'cb54f46af0f6c16b8274998d025019021b3b6c50410b8a8e2024d0aa7e65b040'},
    'Vamp.Plugin.Pack.Installer-2.0.dmg': {
        'url': 'https://github.com/vamp-plugins/vamp-plugin-pack/releases/download/v2.0/Vamp.Plugin.Pack.Installer-2.0.dmg',
        'bytes': 48745081, 'sha256': '60e2569ab064dbaf9ca8a4c3cf8465298b91ea3be1b34c5395d45c1ca4c53f10'},
}
PINNED = {'sonic-annotator': 'c34425592722fbe4727d3d79cd84272d5e398c418ccb46586cd8ef7780aaa4fb',
          'chordino-harte.n3': '11e8b7e12530b574c2fec6fa913feea56c9ee81437d59ba4f6d2b20dbd115523'}
# Pinned, uncompressed Qt resource records: u32-big-endian length + file bytes.
# We never execute the installer or infer resource paths from untrusted names.
PLUGIN_FILES = {
 'nnls-chroma.dylib': (662528, '22b001129db5beec65abb8ac6952be6ed2cd2d809aec3d8ebb50d2495afc2dd6', 'cafebabe000000020100000700000003'),
 'nnls-chroma.n3': (15701, '71f6229c997058ea302e207241059e0753e4b42be9f97429f34cebd796421de6', '4070726566697820726466733a202020'),
 'nnls-chroma.cat': (122, '10e53533341c68c372ecef69fa542fe8530bad1ee49c38295cc3e12721a64a17', '76616d703a6e6e6c732d6368726f6d61'),
 'nnls-chroma_CITATION.txt': (309, '0914fce97c1eb347dd64dc5e082d30d5cce8981a45964c30a8a13c23f3734ed0', '40696e70726f63656564696e67737b6d'),
 'nnls-chroma_README.txt': (10172, 'd0b25c9ec533a2159e865b43ee1dccac7141fce93efdffea58e043cac39c2ade', '232323204e4e4c53204368726f6d6120'),
 'nnls-chroma_COPYING.txt': (15131, '67f82e045cf7acfef853ea0f426575a8359161a0a325e19f02b529a87c4b6c34', '090920202020474e552047454e455241'),
}
PINNED['nnls-chroma.dylib'] = PLUGIN_FILES['nnls-chroma.dylib'][1]
REVISIONS = {'host': '7465f2b7838964f42103ac254709532e9b6624e6', 'plugin': '4c5f214a75cb354f8d8c933e161377c5b4d83713', 'pack': 'bffe09248cf7630a34637b675fddd7038cbf2399'}


def sha(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def require_hash(path: Path, expected: str) -> None:
    if not path.is_file() or sha(path) != expected:
        raise RuntimeError(f'Unreviewed or corrupted artifact: {path.name}')


def fetch(name: str, cache: Path) -> Path:
    spec = ARTIFACTS[name]
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / name
    if target.is_file() and target.stat().st_size == spec['bytes'] and sha(target) == spec['sha256']:
        print(f'Using verified archive: {name}', flush=True)
        return target
    temporary = cache / (name + '.part')
    print(f'Downloading official archive: {name}', flush=True)
    try:
        with urllib.request.urlopen(spec['url'], timeout=90) as response, temporary.open('wb') as output:
            count = 0
            while block := response.read(1024 * 1024):
                count += len(block)
                if count > spec['bytes']:
                    raise RuntimeError(f'Archive exceeds pinned size: {name}')
                output.write(block)
        if temporary.stat().st_size != spec['bytes']:
            raise RuntimeError(f'Archive size mismatch: {name}')
        require_hash(temporary, spec['sha256'])
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return target


def extract_host(archive: Path, destination: Path) -> None:
    # Extract an explicit allowlist, never archive paths, links, devices or scripts.
    prefix = 'sonic-annotator-1.7.0-macos/'
    with tarfile.open(archive, 'r:gz') as source:
        for name in ('sonic-annotator', 'COPYING', 'README.md', 'CITATION', 'CHANGELOG'):
            member = source.getmember(prefix + name)
            if not member.isfile():
                raise RuntimeError('Unexpected host archive member')
            path = destination / name if name == 'sonic-annotator' else destination / 'host-license' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(source.extractfile(member).read())
    require_hash(destination / 'sonic-annotator', PINNED['sonic-annotator'])
    (destination / 'sonic-annotator').chmod(0o755)


def extract_qt_resource(binary: bytes, size: int, expected_sha256: str, prefix_hex: str) -> bytes:
    pattern = size.to_bytes(4, 'big') + bytes.fromhex(prefix_hex)
    offset = 0
    while (offset := binary.find(pattern, offset)) >= 0:
        data = binary[offset + 4:offset + 4 + size]
        if len(data) == size and hashlib.sha256(data).hexdigest() == expected_sha256:
            return data
        offset += 1
    raise RuntimeError('Pinned Qt resource missing/corrupted; no heuristic fallback')


def check_macos_signature(path: Path) -> None:
    subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(path)], check=True, capture_output=True, timeout=30)
    info = subprocess.run(['/usr/bin/codesign', '-dv', '--verbose=4', str(path)], check=True, capture_output=True, text=True, timeout=30)
    if 'TeamIdentifier=73F996B92S' not in info.stderr:
        raise RuntimeError('Unexpected official binary signing team')


def extract_plugins(image: Path, destination: Path, mount: Path) -> None:
    mount.mkdir()
    attached = False
    try:
        subprocess.run(['/usr/bin/hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', str(mount), str(image)], check=True, capture_output=True, timeout=90)
        attached = True
        app_binary = mount / 'Vamp Plugin Pack Installer.app/Contents/MacOS/Vamp Plugin Pack Installer'
        check_macos_signature(app_binary)
        binary = app_binary.read_bytes()
        plugins = destination / 'vamp'
        plugins.mkdir(parents=True, exist_ok=True)
        for name, (size, digest, prefix) in PLUGIN_FILES.items():
            path = plugins / name
            path.write_bytes(extract_qt_resource(binary, size, digest, prefix))
            if name.endswith('.dylib'):
                path.chmod(0o755)
    finally:
        if attached:
            subprocess.run(['/usr/bin/hdiutil', 'detach', str(mount)], check=True, capture_output=True, timeout=60)


def has_arm64(path: Path) -> bool:
    data = path.read_bytes()
    if data[:4] != bytes.fromhex('cafebabe'):
        return False
    count = int.from_bytes(data[4:8], 'big')
    return any(struct.unpack_from('>I', data, 8 + i * 20)[0] == 0x0100000c for i in range(min(count, 10)))


def make_transform(destination: Path) -> None:
    env = dict(os.environ, VAMP_PATH=str(destination / 'vamp'))
    result = subprocess.run([str(destination / 'sonic-annotator'), '-s', 'vamp:nnls-chroma:chordino:simplechord'], env=env, capture_output=True, text=True, check=True, timeout=30)
    pattern = r'(vamp:identifier "usehartesyntax" \] ;\s*vamp:value ")0("\^\^xsd:float)'
    transform, count = re.subn(pattern, r'\g<1>1\2', result.stdout)
    if count != 1:
        raise RuntimeError('Unexpected default transform format')
    path = destination / 'chordino-harte.n3'
    path.write_text(transform)
    require_hash(path, PINNED[path.name])


def silence_smoke(destination: Path, directory: Path) -> dict:
    import wave
    audio = directory / 'silence.wav'
    with wave.open(str(audio), 'wb') as output:
        output.setnchannels(1); output.setsampwidth(2); output.setframerate(44100)
        output.writeframes(bytes(44100 * 2 * 2))
    command = [str(destination / 'sonic-annotator'), '-q', '-t', str(destination / 'chordino-harte.n3'), str(audio), '-w', 'csv', '--csv-stdout', '--csv-omit-filename']
    result = subprocess.run(command, env=dict(os.environ, VAMP_PATH=str(destination / 'vamp')), capture_output=True, text=True, check=True, timeout=30)
    rows = list(csv.reader(io.StringIO(result.stdout)))
    if not rows or not all(len(row) == 2 and row[1] == 'N' for row in rows):
        raise RuntimeError('Native silence smoke test failed')
    return {'input': '2s mono44100Hz PCM16 exact silence, generated temporarily', 'labels': sorted({row[1] for row in rows}), 'events': len(rows), 'passed': True}


def install(destination: Path, cache: Path, source: Path | None = None) -> dict:
    if sys.platform != 'darwin' or platform.machine() not in ('arm64', 'x86_64'):
        raise RuntimeError('This pinned installer supports macOS arm64/x86_64 only; Linux/Windows are not claimed or modified')
    destination = destination.resolve()
    if destination.exists() and any(destination.iterdir()):
        for name, relative in [('sonic-annotator', 'sonic-annotator'), ('nnls-chroma.dylib', 'vamp/nnls-chroma.dylib'), ('chordino-harte.n3', 'chordino-harte.n3')]:
            require_hash(destination / relative, PINNED[name])
        return {'installed': str(destination), 'status': 'already verified; unchanged'}
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.chordino-install-', dir=destination.parent) as temporary:
        work = Path(temporary); staging = work / 'runtime'; staging.mkdir()
        if source is None:
            host = fetch('sonic-annotator-1.7.0-macos.tar.gz', cache.resolve())
            image = fetch('Vamp.Plugin.Pack.Installer-2.0.dmg', cache.resolve())
            extract_host(host, staging)
            extract_plugins(image, staging, work / 'mount')
        else:
            source = source.resolve()
            host_source = source / 'sonic-annotator-1.7.0-macos'
            require_hash(host_source / 'sonic-annotator', PINNED['sonic-annotator'])
            shutil.copy2(host_source / 'sonic-annotator', staging / 'sonic-annotator')
            for name in ('COPYING', 'README.md', 'CITATION', 'CHANGELOG'):
                (staging / 'host-license').mkdir(exist_ok=True)
                shutil.copy2(host_source / name, staging / 'host-license' / name)
            for name, (_, digest, _) in PLUGIN_FILES.items():
                path = source / 'chordino-vamp' / name
                require_hash(path, digest)
                (staging / 'vamp').mkdir(exist_ok=True)
                shutil.copy2(path, staging / 'vamp' / name)
        for path in (staging / 'sonic-annotator', staging / 'vamp/nnls-chroma.dylib'):
            if not has_arm64(path):
                raise RuntimeError('Pinned native artifact lacks arm64')
            check_macos_signature(path)
        make_transform(staging)
        smoke = silence_smoke(staging, work)
        manifest = {'source': 'Official sonic-annotator1.7 + Vamp Plugin Pack2.0; static resource extraction, installer never executed', 'sourceRevisions': REVISIONS, 'archives': ARTIFACTS, 'artifacts': {str(path.relative_to(staging)): sha(path) for path in staging.rglob('*') if path.is_file()}, 'platform': 'macOS arm64/x86_64 universal; Linux/Windows unsupported by this script', 'globalPluginDirectoryChanged': False, 'neuralWeights': False, 'signatureTeam': '73F996B92S', 'smoke': smoke}
        (staging / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        os.rename(staging, destination)
    return {'installed': str(destination), 'status': 'verified installation complete', 'smoke': smoke}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dest', type=Path, default=ROOT / 'models/chordino')
    parser.add_argument('--cache-dir', type=Path, default=ROOT / 'models/.downloads/chordino')
    parser.add_argument('--source', type=Path, help='Optional verified extracted source tree; default downloads official archives')
    args = parser.parse_args()
    print(json.dumps(install(args.dest, args.cache_dir, args.source), indent=2), flush=True)

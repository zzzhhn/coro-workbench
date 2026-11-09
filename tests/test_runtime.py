import hashlib
import json
import subprocess
from pathlib import Path

from server.runtime import runtime_identity


def test_runtime_identity_captures_code_not_weights(tmp_path):
    (tmp_path / 'server').mkdir()
    source = tmp_path / 'server' / 'app.py'
    source.write_text('first')
    first = runtime_identity(tmp_path)
    assert first['workspaceId'] == hashlib.sha256(str(tmp_path.resolve()).encode()).hexdigest()[:16]
    (tmp_path / 'server' / 'cache.bin').write_bytes(b'ignored')
    assert runtime_identity(tmp_path)['codeHash'] == first['codeHash']
    source.write_text('second')
    assert runtime_identity(tmp_path)['codeHash'] != first['codeHash']


def test_node_and_python_use_identical_source_fingerprints(tmp_path):
    (tmp_path / 'server').mkdir()
    (tmp_path / 'server' / 'app.py').write_text('print("合声")\n')
    script = (Path(__file__).resolve().parents[1] / 'scripts/runtime.mjs').as_uri()
    result = subprocess.run(['node', '--input-type=module', '-e',
                             f'import {{runtimeIdentity}} from {json.dumps(script)}; console.log(JSON.stringify(runtimeIdentity(process.argv[1])))', str(tmp_path)],
                            capture_output=True, text=True, check=True)
    node = json.loads(result.stdout)
    python = runtime_identity(tmp_path)
    assert node == {key: python[key] for key in ('workspaceId', 'codeHash')}

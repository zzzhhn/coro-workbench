"""Offline installer boundaries; no network or native program execution here."""
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile

import pytest

SCRIPT=Path(__file__).resolve().parents[1]/'scripts/setup-chordino.py'
spec=importlib.util.spec_from_file_location('setup_chordino',SCRIPT)
setup=importlib.util.module_from_spec(spec);spec.loader.exec_module(setup)


def test_resource_extraction_checks_full_hash_after_prefix_match():
    payload=b'pinned chordino resource';digest=hashlib.sha256(payload).hexdigest();prefix=payload[:4].hex()
    wrong=b'pinn'+b'X'*(len(payload)-4)
    record=lambda value:len(value).to_bytes(4,'big')+value
    assert setup.extract_qt_resource(b'header'+record(wrong)+record(payload),len(payload),digest,prefix)==payload
    with pytest.raises(RuntimeError,match='missing/corrupted'):
        setup.extract_qt_resource(record(wrong),len(payload),digest,prefix)


def test_host_allowlist_cannot_extract_archive_traversal(tmp_path,monkeypatch):
    target=tmp_path/'runtime';target.mkdir();archive=tmp_path/'host.tar.gz';host=b'test host'
    monkeypatch.setitem(setup.PINNED,'sonic-annotator',hashlib.sha256(host).hexdigest())
    with tarfile.open(archive,'w:gz') as output:
        entries={'sonic-annotator':host,'COPYING':b'license','README.md':b'docs','CITATION':b'credit','CHANGELOG':b'history'}
        for name,value in entries.items():
            member=tarfile.TarInfo('sonic-annotator-1.7.0-macos/'+name);member.size=len(value);output.addfile(member,io.BytesIO(value))
        member=tarfile.TarInfo('../../outside');member.size=1;output.addfile(member,io.BytesIO(b'x'))
    setup.extract_host(archive,target)
    assert (target/'sonic-annotator').read_bytes()==host
    assert not (tmp_path/'outside').exists()
    assert len(list(target.rglob('*')))==6


def test_unsupported_system_fails_before_network_or_writes(tmp_path,monkeypatch):
    monkeypatch.setattr(setup.sys,'platform','linux')
    monkeypatch.setattr(setup,'fetch',lambda *args:pytest.fail('network used on unsupported system'))
    with pytest.raises(RuntimeError,match='macOS'):
        setup.install(tmp_path/'runtime',tmp_path/'cache')
    assert not (tmp_path/'runtime').exists() and not (tmp_path/'cache').exists()


def test_pinned_corrupt_existing_runtime_is_not_overwritten(tmp_path,monkeypatch):
    monkeypatch.setattr(setup.sys,'platform','darwin');monkeypatch.setattr(setup.platform,'machine',lambda:'arm64')
    target=tmp_path/'runtime';target.mkdir();(target/'sonic-annotator').write_bytes(b'keep original')
    with pytest.raises(RuntimeError,match='corrupted'):
        setup.install(target,tmp_path/'cache')
    assert (target/'sonic-annotator').read_bytes()==b'keep original'
    assert not (tmp_path/'cache').exists()

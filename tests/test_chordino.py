from pathlib import Path
import numpy as np
import pytest
import soundfile as sf
from server.chordino import chord_identity, infer_chordino, parse_chordino_csv, runtime_health


def test_no_chord_never_becomes_an_invented_triad():
    assert chord_identity('N')['pitches']==[]
    assert parse_chordino_csv('0,N\n',110,1,bpm=120)[0]['root'] is None


def test_inversion_and_extension_preserve_actual_chord_membership_and_source_time():
    segments=parse_chordino_csv('0,C/3\n0.4,G:7\n0.9,N\n',110,1,bpm=120,offset_seconds=-.2)
    first,seventh,last=segments
    assert first['symbol']=='C/E' and first['bassPitchClass']==4
    assert first['pitchClasses']==[0,4,7]
    assert first['pitches']==[48,52,55]
    assert seventh['pitchClasses']==[2,5,7,11] and seventh['pitches']==[55,59,62,65]
    for s in segments:
        assert -.2+s['start']*.5==pytest.approx(s['sourceStartSeconds'])
        assert s['duration']*.5==pytest.approx(s['sourceEndSeconds']-s['sourceStartSeconds'])
    assert last['terminalNoChordSentinel'] is True


@pytest.mark.parametrize('data',['nan,C\n','0,C\n-1,D\n','0,C,wrong\n','0.5,C\n0.2,D\n'])
def test_invalid_runtime_output_fails_instead_of_fabricating_chords(data):
    with pytest.raises((ValueError,RuntimeError)):parse_chordino_csv(data,0,1)


@pytest.mark.skipif(not runtime_health()['ready'],reason='Optional native runtime absent')
def test_real_native_silence_and_cancellation_preserve_source(tmp_path):
    path=tmp_path/'silent.wav';sf.write(path,np.zeros(44100*2),44100,subtype='FLOAT')
    before=path.read_bytes()
    result=infer_chordino(path,tmp_path/'result',start_seconds=.25,end_seconds=1.75,bpm=120)
    assert result['segments'] and all(s['symbol']=='N' and s['pitches']==[] for s in result['segments'])
    with pytest.raises(InterruptedError):infer_chordino(path,tmp_path/'cancel',cancel_check=lambda:True)
    with pytest.raises(TimeoutError):infer_chordino(path,tmp_path/'timeout',timeout_seconds=1e-12)
    assert path.read_bytes()==before


def test_non_chord_slash_bass_is_preserved_separately_for_arranger():
    identity=chord_identity('Bb:maj/b7')
    assert identity['root']==10 and identity['bassPitchClass']==8
    assert identity['pitchClasses']==[2,5,8,10]
    assert identity['symbol']=='Bb/Ab'


@pytest.mark.parametrize('timeout',[0,-1,float('nan'),float('inf')])
def test_invalid_timeout_is_rejected_before_source_read(tmp_path,timeout):
    with pytest.raises(ValueError,match='timeout'):
        infer_chordino(tmp_path/'missing.wav',tmp_path/'out',timeout_seconds=timeout)
    assert not (tmp_path/'out').exists()


def test_analysis_output_cannot_overwrite_source(tmp_path):
    source=tmp_path/'analysis-mono.wav';source.write_bytes(b'original bytes')
    with pytest.raises(ValueError,match='Input must not'):
        infer_chordino(source,tmp_path)
    assert source.read_bytes()==b'original bytes'


def test_unreviewed_transform_does_not_pass_pinned_runtime_health(tmp_path,monkeypatch):
    import server.chordino as backend
    path=tmp_path/'wrong-transform.n3';path.write_text('altered transform')
    monkeypatch.setattr(backend,'TRANSFORM',path)
    assert backend.runtime_health()['ready'] is False

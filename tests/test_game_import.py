"""The public upload route must actually select the tested singing model."""
import json
from unittest.mock import patch

from fastapi.testclient import TestClient

from server.app import create_app
from server.game import parse_lrc, replace_lead
import pytest


def test_public_multi_upload_accepts_game_and_preserves_selection(tmp_path):
    app = create_app(tmp_path)
    engines = {k: {'ready': True} for k in ('basicPitch', 'ffmpeg', 'yourMT3', 'demucs', 'quality', 'game')}
    with patch('server.config.engine_health', return_value=engines), patch.object(app.state.manager, 'submit'):
        with TestClient(app) as client:
            result = client.post('/api/analyze', files={'file': ('new-song.wav', b'RIFF'+b'0'*80)},
                                 data={'mode': 'multi', 'decoder': 'game', 'max_seconds': '600'})
        assert result.status_code == 202, result.text
        request = json.loads((tmp_path/result.json()['id']/'request.json').read_text())
        assert request['decoder'] == 'game'
        assert request['mode'] == 'multi'


def test_missing_game_never_queues_a_silent_legacy_fallback(tmp_path):
    app = create_app(tmp_path)
    engines = {k: {'ready': True} for k in ('basicPitch', 'ffmpeg', 'yourMT3', 'demucs', 'quality')}
    engines['game'] = {'ready': False}
    with patch('server.config.engine_health', return_value=engines), patch.object(app.state.manager, 'submit') as submit:
        with TestClient(app) as client:
            result = client.post('/api/analyze', files={'file': ('song.wav', b'RIFF'+b'0'*80)},
                                 data={'mode': 'multi', 'decoder': 'game'})
        assert result.status_code == 503
        assert 'GAME' in result.json()['detail']
        submit.assert_not_called()
        assert not list(tmp_path.glob('*/request.json'))


def test_lrc_only_uses_text_and_line_times_and_clips_to_requested_audio():
    segments = parse_lrc('[00:02.50]你，好\n[00:07.00]后来\n[01:00.00]不在片段', 10)
    assert [s['text'] for s in segments] == ['你好','后来']
    assert segments[0]['start'] == 2.15
    assert segments[-1]['end'] == 10
    for bad in ('无时间的歌词', '[00:70]错', '[00:04]前\n[00:02]后', '[00:00]词\n[01:00]词', '[offset:500]\n[00:02]偏移'):
        with pytest.raises(ValueError):
            parse_lrc(bad,100)


def test_game_replaces_all_old_leads_without_erasing_choir_or_instruments():
    project = {'parts':[{'id':'legacy','role':'lead','notes':[{'midi':40}]},
        {'id':'leak','role':'lead','notes':[]}, {'id':'piano','role':'instrument','notes':[{'midi':60}]},
        {'id':'choir','role':'harmony','notes':[{'midi':72}]}],
        'source':{'engine':'YourMT3+','warnings':[]},'measures':1}
    notes = [{'id':'g1','midi':64,'start':0,'duration':2}]
    result = replace_lead(project,notes,{'lyricsProvided':False},'fresh-upload')
    assert [p['id'] for p in result['parts']] == ['game-vocals','piano','choir']
    assert result['parts'][0]['notes'] == notes
    assert result['parts'][1:] == project['parts'][2:]
    assert project['parts'][0]['id'] == 'legacy'
    raw = replace_lead(result,notes,{'lyricsProvided':False},'fresh-upload',raw=True)
    assert 'rawProjectUrl' not in raw['source']['analysis']


@pytest.mark.parametrize('fail_game', [False, True])
def test_real_multi_orchestration_calls_game_after_instruments_and_propagates_failure(tmp_path, monkeypatch, fail_game):
    import numpy as np
    import soundfile as sf
    from server import pipeline, config, multi, game, audio_quality
    sf.write(tmp_path/'analysis.wav',np.sin(np.arange(22050)/10)*.1,22050)
    monkeypatch.setattr(pipeline,'decode_audio',lambda *a:(1.,1.))
    monkeypatch.setattr(pipeline,'detect_tempo_and_key',lambda *a:(120.,'C',[]))
    monkeypatch.setattr(config,'engine_health',lambda:{'instrumentClassifier':{'ready':False}})
    monkeypatch.setattr(audio_quality,'quality_engine_ready',lambda:True)
    piano={'id':'piano','role':'instrument','notes':[{'id':'p1','midi':60,'start':0,'duration':1,'velocity':.8}]}
    monkeypatch.setattr(multi,'transcribe_multi',lambda *a:([piano],{'events':[]}))
    def improve(directory, project, request, *args):
        assert request['decoder']=='standard', 'GAME must not be passed to the legacy bass/FCPE contour decoder'
        return project
    monkeypatch.setattr(audio_quality,'improve_project',improve)
    called=[]
    def singing(directory,project,request,status):
        called.append(request['decoder'])
        assert project['parts'] == [piano]
        if fail_game:raise ValueError('GAME failed explicitly')
        return replace_lead(project,[{'id':'g1','midi':65,'start':0,'duration':1}],{'lyricsProvided':False},request['id'])
    monkeypatch.setattr(game,'transcribe_lead',singing)
    class Status:
        def update(self,*a):pass
        def check_cancelled(self):pass
    request={'id':'a'*32,'filename':'fresh.wav','tempo':None,'mode':'multi','decoder':'game','verification':'sampled'}
    if fail_game:
        with pytest.raises(ValueError,match='GAME failed'):
            pipeline.analyze_audio(tmp_path,request,Status())
        assert not (tmp_path/'project.json').exists()
    else:
        result=pipeline.analyze_audio(tmp_path,request,Status())
        assert result['parts'][0]['id']=='game-vocals'
        assert json.loads((tmp_path/'analysis-evidence.json').read_text())['decoderRequested']=='game'
    assert called==['game']
    assert (tmp_path/'raw-project.json').is_file()

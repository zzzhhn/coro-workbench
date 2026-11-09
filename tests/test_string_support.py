import json
from server.string_support import cached_support, signature


def test_support_cache_is_bound_to_audio_contents(tmp_path):
    mix=tmp_path/'mix.wav';voice=tmp_path/'voice.wav';other=tmp_path/'other.wav'
    for path,data in [(mix,b'mix'),(voice,b'voice'),(other,b'other')]:path.write_bytes(data)
    paths={'vocals':voice,'other':other}
    (tmp_path/'manifest.json').write_text(json.dumps(signature(mix,paths)))
    for name in ('basic-pitch.json','instrumental-events.json'):
        (tmp_path/name).write_text(json.dumps({'events':[{'midi':66}]}))
    assert cached_support(tmp_path,mix,paths)==([{'midi':66}],[{'midi':66}])
    other.write_bytes(b'different separated output')
    assert cached_support(tmp_path,mix,paths) is None


def test_interrupted_support_write_is_not_used(tmp_path):
    mix=tmp_path/'mix.wav';voice=tmp_path/'voice.wav';other=tmp_path/'other.wav'
    for path in (mix,voice,other):path.write_bytes(b'wave')
    paths={'vocals':voice,'other':other}
    (tmp_path/'manifest.json').write_text(json.dumps(signature(mix,paths)))
    (tmp_path/'basic-pitch.json').write_text('{"events":')
    (tmp_path/'instrumental-events.json').write_text('{"events": []}')
    assert cached_support(tmp_path,mix,paths) is None

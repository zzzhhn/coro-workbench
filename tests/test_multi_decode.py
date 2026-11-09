from pathlib import Path
import sys

import pytest

from server.multi_decode import decoder_segment_starts, source_key


def test_segment_clock_uses_the_tokenizers_rounding():
    starts = decoder_segment_starts(132, 32767, 16000, 100)
    assert starts[3] == 6.14
    assert all(abs(v * 100 - round(v * 100)) < 1e-8 for v in starts)


def test_missing_tie_at_a_segment_boundary_does_not_close_the_new_attack():
    source = Path('models/yourmt3/amt/src').resolve()
    if not (source / 'utils/event2note.py').exists():
        pytest.skip('Optional YourMT3 source not installed')
    sys.path.insert(0, str(source))
    try:
        from utils.note_event_dataclasses import NoteEvent
        from utils.event2note import merge_zipped_note_events_and_ties_to_notes
        def n(t, v):
            return NoteEvent(is_drum=False, program=0, time=t, velocity=v, pitch=60)
        def decode(boundary):
            return merge_zipped_note_events_and_ties_to_notes([
                ([n(5.80, 1)], [], [(0, 60)], 2 * 32767 / 16000),
                ([n(6.14, 1), n(6.40, 0)], [], [], boundary)])
        before, errors = decode(3 * 32767 / 16000)
        assert before[1].offset == pytest.approx(6.15)
        assert errors['Err/onset not found'] == 1
        after, errors = decode(decoder_segment_starts(4, 32767, 16000, 100)[3])
        assert [(n.onset, n.offset) for n in after] == [(5.80, 6.14), (6.14, 6.40)]
        assert not errors.get('Err/onset not found')
    finally:
        sys.path.remove(str(source))


def test_decoder_channel_is_not_an_independent_source_identity():
    assert source_key({'decodedChannel': 3}) is None
    assert source_key({'sourceId': 'piano-left'}) == 'piano-left'
    with pytest.raises(ValueError):
        source_key({'sourceId': '../piano'})


def test_token_budget_retry_keeps_completed_channels_and_does_not_accept_truncation():
    import numpy as np
    from server.multi_decode import extend_capped_channels
    before = np.array([[[7, 1, 0], [8, 9, 10], [11, 12, 13]]])
    longer = np.array([[[99, 1, 0, 0, 0], [8, 9, 10, 14, 1], [11, 12, 13, 14, 15]]])
    result, audit = extend_capped_channels(before, longer, eos_id=1, pad_id=0)
    assert result.tolist() == [[[7, 1, 0, 0, 0], [8, 9, 10, 14, 1], [11, 12, 13, 0, 0]]]
    assert audit == {'recoveredChannels': [[0, 1]], 'stillCappedChannels': [[0, 2]]}


def test_independent_same_class_sources_keep_their_unisons_and_overlaps():
    from server.multi import parts_from_multi_events
    events = [dict(program=40, isDrum=False, midi=60, start=0, end=1,
                   sourceId=source, sourceLabel=label)
              for source, label in [('violin-a', '第一小提琴'), ('violin-b', '第二小提琴')]]
    parts, audit = parts_from_multi_events(events, {'bpm': 120, 'offsetSeconds': 0}, 2, readable=True)
    assert len(parts) == 2 and audit['outputNotes'] == 2
    assert {p['sourceId'] for p in parts} == {'violin-a', 'violin-b'}
    assert all(p['notes'][0]['duration'] == 2 for p in parts)
    assert audit['claimsIndividualPerformerIdentity'] is False
    # Model channels alone do not establish two players.
    for i, e in enumerate(events):
        del e['sourceId']
        e['decodedChannel'] = i
    parts, _ = parts_from_multi_events(events, {'bpm': 120, 'offsetSeconds': 0}, 2)
    assert len(parts) == 1 and len(parts[0]['notes']) == 2

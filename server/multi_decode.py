"""Small, model-independent helpers for auditable multi-track decoding."""
from __future__ import annotations


def decoder_segment_starts(count: int, frames: int, sample_rate: int, ticks_per_second: int) -> list[float]:
    if count < 0 or min(frames, sample_rate, ticks_per_second) <= 0:
        raise ValueError('Invalid decoder clock')
    # event2note_event uses round(start_time * tps). Missing-tie note-offs
    # must use that SAME clock or they can close the next segment's reattack.
    return [round(index * frames / sample_rate * ticks_per_second) / ticks_per_second
            for index in range(count)]


def decoded_note(note, channel: int) -> dict:
    return {'midi': int(note.pitch), 'start': float(note.onset), 'end': float(note.offset),
            'program': int(note.program), 'isDrum': bool(note.is_drum), 'decodedChannel': channel}


def extend_capped_channels(initial, extended, eos_id: int, pad_id: int):
    """Keep completed channels identical; accept a retry only when it reaches EOS."""
    import numpy as np
    if initial.ndim != 3 or extended.ndim != 3 or initial.shape[:2] != extended.shape[:2]:
        raise ValueError('Incompatible decoder retry')
    length = max(initial.shape[-1], extended.shape[-1])
    result = np.full((*initial.shape[:2], length), pad_id, dtype=initial.dtype)
    result[..., :initial.shape[-1]] = initial
    recovered, unresolved = [], []
    for batch in range(initial.shape[0]):
        for channel in range(initial.shape[1]):
            if np.any(initial[batch, channel] == eos_id):
                continue
            if np.any(extended[batch, channel] == eos_id):
                result[batch, channel] = pad_id
                result[batch, channel, :extended.shape[-1]] = extended[batch, channel]
                recovered.append([batch, channel])
            else:
                unresolved.append([batch, channel])
    return result, {'recoveredChannels': recovered, 'stillCappedChannels': unresolved}


def source_key(event: dict) -> str | None:
    """An independent audio source is identity evidence; a decoder channel is not."""
    value = event.get('sourceId')
    if value is None:
        return None
    if (not isinstance(value, str) or not 1 <= len(value) <= 64
            or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in value)):
        raise ValueError('Invalid transcription source identity')
    return value

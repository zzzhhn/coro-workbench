import numpy as np
import pytest

from server.vocal import decode_vocal_contour
from server.vocal_decode import decode_selected_contour


def signal():
    sr = 16000
    time = np.arange(200) * .01
    audio = (.08 * np.sin(2 * np.pi * 220 * np.arange(2 * sr) / sr)).astype(np.float32)
    return time, np.full(200, 220.), np.full(200, .8), audio, sr


def test_default_adapter_is_exact_existing_standard_and_bass_is_unchanged():
    data = signal()
    assert decode_selected_contour(*data) == decode_vocal_contour(*data)
    assert decode_selected_contour(*data, role="bass", profile="acoustic") == decode_vocal_contour(*data, role="bass")


def test_acoustic_adapter_uses_frozen_core_without_overwriting_inputs():
    from server.lead_note_proposal import decode_lead_note_proposal
    data = signal()
    copies = [value.copy() if isinstance(value, np.ndarray) else value for value in data]
    notes, details = decode_selected_contour(*data, profile="acoustic")
    expected, _ = decode_lead_note_proposal(*data, profile="acoustic_segments")
    assert notes == expected and len(notes) > 0
    for actual, before in zip(data[:-1], copies[:-1]):
        np.testing.assert_array_equal(actual, before)


def test_unknown_profile_rejected_instead_of_silent_fallback():
    with pytest.raises(ValueError, match="Unknown"):
        decode_selected_contour(*signal(), profile="unknown")

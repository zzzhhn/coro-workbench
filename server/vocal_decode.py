"""Explicit adapter for existing note decoders; baseline and bass stay unchanged."""
from .vocal import decode_vocal_contour

DECODER_VERSIONS = {
    "standard": "fcpe-hysteresis-1.0",
    "legato": "duration-viterbi-1.0-min100ms-penalty2",
    "acoustic": "acoustic-segments-frozen-phase3-v1",
}


def decode_selected_contour(times, f0, activation, audio, sr, role="vocals", profile="standard"):
    if profile not in DECODER_VERSIONS:
        raise ValueError("Unknown vocal decoder profile")
    if role != "vocals" or profile == "standard":
        return decode_vocal_contour(times, f0, activation, audio, sr, role)
    if profile == "legato":
        from .vocal_dp import decode_duration_contour
        return decode_duration_contour(times, f0, activation, audio, sr, "legato")
    # Keep the benchmarked phase3 core byte-identical; integration is opt-in here.
    from .lead_note_proposal import decode_lead_note_proposal
    return decode_lead_note_proposal(times, f0, activation, audio, sr, profile="acoustic_segments")

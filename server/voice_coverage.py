"""Read-only listening priorities, not missed-note truth or automatic repairs."""
from __future__ import annotations

import numpy as np

MIN_SUPPORT_SECONDS = .24
MAX_GAP_SECONDS = .06
MIN_SUPPORT_FRACTION = .6
MAX_INTERVALS = 400


def summarize_coverage(arrays: dict, duration: float, periodicity: float = .3, activation: float = .03) -> dict:
    times = arrays["time"]
    step = float(np.median(np.diff(times)))
    # Clamp each frame to the analyzed recording, including its final partial hop.
    widths = np.maximum(0, np.minimum(np.r_[np.diff(times), step], duration - times))
    audible = arrays["audible"].astype(bool) & (times >= 0) & (times < duration)
    raw = np.isfinite(arrays["fcpeF0"]) & (arrays["fcpeF0"] > 55)
    fcpe = raw & np.isfinite(arrays["activation"]) & (arrays["activation"] >= activation) & audible
    crepe = (np.isfinite(arrays["crepeF0"]) & (arrays["crepeF0"] > 0)
             & np.isfinite(arrays["periodicity"]) & (arrays["periodicity"] >= periodicity) & audible)
    difference = np.zeros_like(times)
    joint = fcpe & crepe
    difference[joint] = np.abs(12 * np.log2(arrays["fcpeF0"][joint] / arrays["crepeF0"][joint]))
    masks = {
        "fcpe_missing": crepe & ~raw,
        "fcpe_gated": crepe & raw & ~fcpe,
        "pitch_disagreement": joint & (difference > 6),
    }
    intervals = []
    for kind, mask in masks.items():
        indices = np.flatnonzero(mask)
        if not len(indices):
            continue
        breaks = np.flatnonzero(times[indices[1:]] - (times[indices[:-1]] + widths[indices[:-1]]) > MAX_GAP_SECONDS + 1e-8) + 1
        for run in np.split(indices, breaks):
            start = float(times[run[0]])
            end = min(duration, float(times[run[-1]] + widths[run[-1]]))
            support = float(widths[run].sum())
            if support + 1e-8 < MIN_SUPPORT_SECONDS or support / (end - start) < MIN_SUPPORT_FRACTION:
                continue
            intervals.append({
                "kind": kind,
                "startSeconds": round(start, 4),
                "endSeconds": round(end, 4),
                "supportSeconds": round(support, 4),
                "supportFraction": round(support / (end - start), 4),
            })
    intervals.sort(key=lambda item: (item["startSeconds"], item["kind"]))
    return {
        "durationSeconds": duration,
        "frameStepSeconds": round(step, 6),
        "totalsSeconds": {kind: round(float(widths[mask].sum()), 4) for kind, mask in masks.items()},
        "totalIntervals": len(intervals),
        "intervals": intervals[:MAX_INTERVALS],
        "truncated": len(intervals) > MAX_INTERVALS,
        "thresholds": {"minimumSupportSeconds": MIN_SUPPORT_SECONDS, "maximumGapSeconds": MAX_GAP_SECONDS,
                       "minimumSupportFraction": MIN_SUPPORT_FRACTION, "severeSemitones": 6,
                       "periodicity": periodicity, "fcpeActivation": activation},
        "groundTruthAvailable": False,
        "note": "这些是原始模型证据的待听检查点，不是确认的漏音或错音。只有CREPE发声不代表一定有人声；分离泄漏也会触发。检查点不随手工修谱消失，不自动补音。",
    }

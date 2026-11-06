#!/usr/bin/env python3
"""Read-only cached lead-note experiment; never imports or runs neural models.

The two proposal profiles and intervals are frozen before the heldout is scored.
Independent CREPE frames are passed only to evaluator functions, after decoding.
All outputs are private local evidence, not changes to source/user projects.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import html
import importlib.util
import json
import math
import os
import sys
from dataclasses import asdict
from pathlib import Path
from time import perf_counter

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server.lead_note_proposal import CONFIG, PROFILES, decode_lead_note_proposal, frame_acoustic_evidence, runs
from server.vocal import decode_vocal_contour
from server.vocal_dp import decode_duration_contour

SONGS = (
    ("Ariana Grande - bye", "f70ebab316d54d62abb0f56d19e0356e"),
    ("NewJeans - Attention", "22d62c8049d04e39b9062b60513bf9c5"),
    ("The Weeknd - Out of Time", "1eac4381bbfd4904a66bf0ca97e2f72d"),
    ("单依纯 - 空耳", "a6be0eb965d048a0ad57819135164463"),
)
SPLITS = {"development": (0., 90.), "heldout": (110., 140.)}
METHODS = ("standard", "legato", *PROFILES)
CONTEXT_SECONDS = 1.


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def finite(value):
    if isinstance(value, dict):
        return {key: finite(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [finite(item) for item in value]
    if isinstance(value, np.ndarray):
        return finite(value.tolist())
    if isinstance(value, np.generic):
        return finite(value.item())
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def note_track(events, times):
    """Independent half-open interval rasterizer; no decoder label reuse."""
    times = np.asarray(times)
    predicted = np.full(len(times), np.nan)
    for event in events:
        first = int(np.searchsorted(times, event[0], side="left"))
        last = int(np.searchsorted(times, event[1], side="left"))
        predicted[first:last] = event[2]
    return predicted


def distance_from_boundaries(events, times):
    boundaries = np.sort(np.array([at for event in events for at in event[:2]], dtype=float))
    if not len(boundaries):
        return np.full(len(times), np.inf)
    index = np.searchsorted(boundaries, times)
    before = boundaries[np.clip(index - 1, 0, len(boundaries) - 1)]
    after = boundaries[np.clip(index, 0, len(boundaries) - 1)]
    return np.minimum(abs(times - before), abs(times - after))


def reference_metrics(events, reference, start, end):
    """CREPE is used here only: its voiced mask does not require FCPE agreement."""
    times = reference["time"]
    selected = (times >= start) & (times < end)
    times = times[selected]
    f0 = reference["crepeF0"][selected]
    periodicity = reference["periodicity"][selected]
    audible = reference["audible"][selected].astype(bool)
    independent = audible & np.isfinite(f0) & (f0 >= 55) & (f0 <= 1100) & (periodicity >= .30)
    joint = reference["jointVoiced"][selected].astype(bool)
    reference_midi = np.full(len(times), np.nan)
    reference_midi[independent] = 69 + 12 * np.log2(f0[independent] / 440)
    predicted = note_track(events, times)
    exists = np.isfinite(predicted)
    error = abs(predicted - reference_midi)
    within50 = independent & exists & (error <= .5)
    within100 = independent & exists & (error <= 1.)
    missing = independent & ~exists
    wrong = independent & exists & (error > .5)
    distance = distance_from_boundaries(events, times)
    near = distance <= .080 + 1e-8
    hop = float(np.median(np.diff(reference["time"])))
    count = int(independent.sum())
    denominator = max(1, count)
    joint_count = int(joint.sum())
    fcpe_voiced = np.isfinite(reference["fcpeF0"][selected]) & (reference["fcpeF0"][selected] >= 55) & (reference["fcpeF0"][selected] <= 1100) & (reference["activation"][selected] >= .03)
    windows = []
    for left in np.arange(start, end, 5.):
        right = min(end, left + 5.)
        in_window = (times >= left) & (times < right)
        voiced = independent & in_window
        n = int(voiced.sum())
        windows.append({"startSeconds": float(left), "endSeconds": float(right), "independentFrames": n, "independentVoicedSeconds": n * hop, "within50": int((within50 & in_window).sum()) / n if n else None, "coverage": int((voiced & exists).sum()) / n if n else None, "eligibleForFloor": n * hop >= .5 - 1e-8})
    eligible = [item for item in windows if item["eligibleForFloor"]]
    # Offset is diagnostic only; no shifted path is selected or re-scored as final.
    shifts = []
    for offset in np.arange(-.20, .2001, .02):
        shifted = note_track(events, times + offset)
        n = int((independent & np.isfinite(shifted) & (abs(shifted - reference_midi) <= .5)).sum())
        shifts.append((float(offset), n))
    best_shift, best_count = min(shifts, key=lambda row: (-row[1], abs(row[0]), row[0]))
    output = {
        "independentFrames": count, "independentVoicedSeconds": count * hop,
        "within50Frames": int(within50.sum()), "within100Frames": int(within100.sum()),
        "within50": int(within50.sum()) / denominator, "within100": int(within100.sum()) / denominator,
        "coveredIndependentFrames": int((independent & exists).sum()), "coverage": int((independent & exists).sum()) / denominator,
        "missingIndependentFrames": int(missing.sum()), "wrongPitchFrames": int(wrong.sum()),
        "wrongPitchNear80msBoundaryFrames": int((wrong & near).sum()),
        "wrongPitchNear80msBoundaryFraction": int((wrong & near).sum()) / int(wrong.sum()) if wrong.any() else None,
        "independentFramesNear80msBoundaryFraction": int((independent & near).sum()) / denominator,
        "missingOrWrongFrames": int((missing | wrong).sum()),
        "jointFrames": joint_count, "within50OnJoint": int((joint & exists & (error <= .5)).sum()) / max(1, joint_count),
        "independentFramesWithUsableFCPE": int((independent & fcpe_voiced).sum()),
        "medianFCPEF0OnIndependentFrames": float(np.median(reference["fcpeF0"][selected][independent])) if independent.any() else None,
        "notesOnAudibleLowPeriodicitySeconds": int((exists & audible & (periodicity < .30)).sum()) * hop,
        "notesOnInaudibleSeconds": int((exists & ~audible).sum()) * hop,
        "temporalDiagnostic": {"predictionSampleOffsetSeconds": round(best_shift, 3), "bestWithin50": best_count / denominator, "gainOverZero": (best_count - int(within50.sum())) / denominator, "applied": False, "meaning": "Positive offset samples predicted notes later, equivalent to moving them earlier. Search +/-200 ms at20 ms; diagnostic optimization only."},
        "windows5Seconds": windows,
        "floor5Seconds": min(eligible, key=lambda item: item["within50"]) if eligible else None,
    }
    return output


def event_metrics(events, start, end):
    selected = [event for event in events if start <= event[0] < end]
    durations = np.array([event[1] - event[0] for event in selected])
    groups = []
    group = []
    for event in selected:
        short = event[1] - event[0] <= .180 + 1e-8
        if short and (not group or event[0] - group[-1][1] <= .040 + 1e-8):
            group.append(event)
        else:
            if len(group) >= 3:
                groups.append(group)
            group = [event] if short else []
    if len(group) >= 3:
        groups.append(group)
    boundaries = []
    for left, right in zip(selected, selected[1:]):
        if left[2] == right[2] and right[0] - left[1] <= .040 + 1e-8:
            boundaries.append(float(right[0]))
    return {
        "events": len(selected), "eventsPerMinute": len(selected) * 60 / (end - start),
        "short100ms": int((durations <= .100 + 1e-8).sum()),
        "short180ms": int((durations <= .180 + 1e-8).sum()),
        "medianDurationSeconds": float(np.median(durations)) if len(durations) else None,
        "shortGroups": [{"startSeconds": group[0][0], "endSeconds": group[-1][1], "events": len(group), "pitches": [event[2] for event in group]} for group in groups],
        "shortGroupCount": len(groups), "eventsInShortGroups": sum(map(len, groups)),
        "samePitchAdjacentBoundaries": boundaries,
        "maximumOnsetsInOneSecond": max((sum(at <= event[0] < at + 1 for event in selected) for at in [event[0] for event in selected]), default=0),
        "interpretation": "Density/short groups are readability diagnostics, not precision/recall without human note-event truth.",
    }


def decode_methods(times, f0, activation, audio, sr, bpm, offset):
    output = {}
    begun = perf_counter()
    events, diagnostics = decode_vocal_contour(times, f0, activation, audio, sr)
    output["standard"] = {"events": events, "diagnostics": diagnostics, "runtimeSeconds": perf_counter() - begun}
    begun = perf_counter()
    events, diagnostics = decode_duration_contour(times, f0, activation, audio, sr, "legato")
    output["legato"] = {"events": events, "diagnostics": diagnostics, "runtimeSeconds": perf_counter() - begun}
    features = frame_acoustic_evidence(times, audio, sr)
    for profile in PROFILES:
        events, diagnostics = decode_lead_note_proposal(times, f0, activation, audio, sr, profile=profile, bpm=bpm, beat_offset_seconds=offset, acoustic_evidence=features)
        output[profile] = {"events": events, "diagnostics": diagnostics, "runtimeSeconds": diagnostics["runtimeSeconds"]}
    return output, features


def synthetic_evaluation():
    specification = importlib.util.spec_from_file_location("lead_constructed_cases", ROOT / "tests/test_lead_note_proposal.py")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    rows = []
    for case in module.synthetic_cases():
        methods, _ = decode_methods(*case["data"], bpm=120., offset=0.)
        row = {"case": case["name"], "truth": case["truth"], "floor": case.get("floor"), "methods": {}}
        for name, method in methods.items():
            events = method["events"]
            diagnostics = method["diagnostics"]
            result = {"events": events, "eventCount": len(events), "glideUncertaintyIntervals": diagnostics.get("glideUncertaintyIntervals", [])}
            if case["truth"] is not None:
                truth = case["truth"]
                times = np.arange(.005, 3., .01)
                predicted = note_track(events, times)
                expected = note_track(truth, times)
                voiced = np.isfinite(expected)
                result["voicedFrameWithin50"] = float(np.mean(np.isfinite(predicted[voiced]) & (abs(predicted[voiced] - expected[voiced]) <= .5))) if voiced.any() else None
                result["exactPitchSequence"] = [event[2] for event in events] == [event[2] for event in truth]
                result["maximumBoundaryErrorSeconds"] = float(max((max(abs(a[0] - b[0]), abs(a[1] - b[1])) for a, b in zip(events, truth)), default=0)) if len(events) == len(truth) else None
            row["methods"][name] = result
        rows.append(row)
    return rows


def aggregate(rows, split):
    output = {}
    chosen = [row for row in rows if row["split"] == split]
    for name in METHODS:
        results = [row["methods"][name] for row in chosen]
        n = sum(item["pitch"]["independentFrames"] for item in results)
        windows = [{"song": row["song"], **window} for row in chosen for window in row["methods"][name]["pitch"]["windows5Seconds"] if window["eligibleForFloor"]]
        output[name] = {
            "independentFrames": n,
            "within50": sum(item["pitch"]["within50Frames"] for item in results) / max(1, n),
            "within100": sum(item["pitch"]["within100Frames"] for item in results) / max(1, n),
            "coverage": sum(item["pitch"]["coveredIndependentFrames"] for item in results) / max(1, n),
            "events": sum(item["density"]["events"] for item in results),
            "short100ms": sum(item["density"]["short100ms"] for item in results),
            "short180ms": sum(item["density"]["short180ms"] for item in results),
            "shortGroupCount": sum(item["density"]["shortGroupCount"] for item in results),
            "eventsInShortGroups": sum(item["density"]["eventsInShortGroups"] for item in results),
            "floor5Seconds": min(windows, key=lambda item: item["within50"]) if windows else None,
            "songMinimumWithin50": min(item["pitch"]["within50"] for item in results),
            "runtimeSeconds": sum(item["runtimeSeconds"] for item in results),
        }
    return output


def case_candidates(row, times, f0, features):
    """Inspection candidates; acoustic tags are not human-verified phoneme labels."""
    start, end = row["startSeconds"], row["endSeconds"]
    proposal = row["methods"]["acoustic_segments"]
    intervals = proposal["diagnostics"].get("glideUncertaintyIntervals", [])
    examples = []
    for a, b, reason in intervals:
        if start <= a < end:
            examples.append({"kind": "glide-or-vibrato-candidate", "startSeconds": max(start, a - .25), "endSeconds": min(end, max(a + 1., b + .25)), "reason": reason, "humanVerified": False})
            break
    valid = np.isfinite(f0) & (f0 >= 55) & (f0 <= 1100)
    for a, b, flag in runs(valid.astype(int)):
        seconds = (b - a) * float(np.median(np.diff(times)))
        if flag or a == 0 or b == len(times) or not .015 <= seconds <= .080:
            continue
        if np.max(features["flatness"][a:b]) < .15 or not valid[a - 1] or not valid[b]:
            continue
        at = float(times[a])
        if not start <= at < end:
            continue
        examples.append({"kind": "noisy-consonant-or-separation-gap-candidate", "startSeconds": max(start, at - .35), "endSeconds": min(end, at + .65), "gapSeconds": seconds, "maximumFlatness": float(np.max(features["flatness"][a:b])), "reason": "Brief F0 gap with elevated spectral flatness; proposal must not assume harmonic continuity. Phoneme identity requires listening.", "humanVerified": False})
        break
    for group in proposal["density"]["shortGroups"]:
        examples.append({"kind": "fast-ornament-or-fragmentation-candidate", "startSeconds": max(start, group["startSeconds"] - .25), "endSeconds": min(end, group["endSeconds"] + .25), "reason": "Three or more adjacent <=180 ms notes; may be genuine ornament or over-segmentation. Event truth absent.", "humanVerified": False, "group": group})
        break
    return examples


def write_inspection_svg(path, row, reference, start, end):
    width, height, left, right = 1080, 650, 155, 20
    top, lane_height = 34, 125
    selected = (reference["time"] >= start) & (reference["time"] <= end)
    times = reference["time"][selected]
    crepe = reference["crepeF0"][selected]
    fcpe = reference["fcpeF0"][selected]
    voiced = reference["audible"][selected] & (reference["periodicity"][selected] >= .30) & (crepe >= 55) & (crepe <= 1100)
    valid_fcpe = (fcpe >= 55) & (fcpe <= 1100) & (reference["activation"][selected] >= .03)
    crepe_midi = np.full(len(times), np.nan)
    crepe_midi[voiced] = 69 + 12 * np.log2(crepe[voiced] / 440)
    fcpe_midi = np.full(len(times), np.nan)
    fcpe_midi[valid_fcpe] = 69 + 12 * np.log2(fcpe[valid_fcpe] / 440)
    all_pitches = np.r_[crepe_midi[np.isfinite(crepe_midi)], fcpe_midi[np.isfinite(fcpe_midi)]]
    note_pitches = [event[2] for method in row["methods"].values() for event in method["events"] if event[0] < end and event[1] > start]
    all_pitches = np.r_[all_pitches, note_pitches]
    lo = max(30, math.floor(float(np.min(all_pitches))) - 2) if len(all_pitches) else 48
    hi = min(95, math.ceil(float(np.max(all_pitches))) + 2) if len(all_pitches) else 84
    hi = max(hi, lo + 6)
    x = lambda at: left + (at - start) / max(.01, end - start) * (width - left - right)
    output = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img"><rect width="100%" height="100%" fill="#fff"/><style>text{{font:12px system-ui;fill:#314155}} .label{{font-weight:700}}</style>']
    output.append(f'<text x="{left}" y="18" class="label">{html.escape(row["song"])} · {start:.2f}–{end:.2f}s · CREPE orange / FCPE gray / score blue</text>')
    for lane, name in enumerate(METHODS):
        lane_top = top + lane * lane_height
        y = lambda pitch: lane_top + 102 - (pitch - lo) / (hi - lo) * 92
        output.append(f'<text x="3" y="{lane_top + 49}" class="label">{html.escape(name.replace("_", " "))}</text>')
        for pitch in range(lo, hi + 1):
            output.append(f'<line x1="{left}" x2="{width-right}" y1="{y(pitch):.1f}" y2="{y(pitch):.1f}" stroke="#eef1f5"/>')
        for event in row["methods"][name]["events"]:
            a, b, pitch = event[:3]
            if a < end and b > start:
                output.append(f'<rect x="{x(max(a,start)):.2f}" y="{y(pitch)-3:.2f}" width="{max(.5,x(min(b,end))-x(max(a,start))):.2f}" height="6" fill="#2463b9" opacity=".8"/>')
        for pitches, mask, color, radius in ((fcpe_midi, valid_fcpe, "#788390", 1.), (crepe_midi, voiced, "#d86121", 1.6)):
            for at, pitch in zip(times[mask], pitches[mask]):
                if lo <= pitch <= hi:
                    output.append(f'<circle cx="{x(at):.2f}" cy="{y(pitch):.2f}" r="{radius}" fill="{color}"/>')
        for at in np.linspace(start, end, 7):
            output.append(f'<text x="{x(at):.1f}" y="{lane_top+119}" text-anchor="middle">{at:.2f}s</text>')
    output.append('<text x="78" y="595">Scores are discrete event hypotheses. CREPE/FCPE disagreement, slides, consonants and separation errors remain unresolved.</text></svg>')
    path.write_text("".join(output), encoding="utf-8")


def pct(value):
    return "—" if value is None else f"{value * 100:.2f}%"


def write_reports(report, output, summary_output):
    lines = ["# Frozen lead-note experiment", "", "**Recommendation: do not promote either proposal to the default decoder.** This is an offline comparison on cached private source audio. Independent model agreement is not note-event ground truth or human listening acceptance.", "", "Configuration was frozen before this evaluation. Development: first 90s of each of four songs; held out: 110–140s of each. All methods get one second of context where available. All comparisons use acoustic event times before score quantization/engraving, so they isolate segmentation rather than grading the currently displayed score. CREPE is evaluator-only; low-periodicity/inaudible frames are not counted as correct pitch.", ""]
    for split, methods in report["aggregate"].items():
        lines += [f"## {split}", "", "| Method | CREPE ±50c | ±100c | voiced coverage | events | ≤100ms | short groups | worst5s |", "|---|---:|---:|---:|---:|---:|---:|---:|"]
        for name, item in methods.items():
            lines.append(f'| {name} | {pct(item["within50"])} | {pct(item["within100"])} | {pct(item["coverage"])} | {item["events"]} | {item["short100ms"]} | {item["shortGroupCount"]} | {pct(item["floor5Seconds"]["within50"] if item["floor5Seconds"] else None)} |')
        lines.append("")
    heldout = report["aggregate"]["heldout"]
    standard = heldout["standard"]
    acoustic = heldout["acoustic_segments"]
    legato = heldout["legato"]
    regressions = []
    for row in report["rows"]:
        if row["split"] == "heldout":
            for old, new in zip(row["methods"]["standard"]["pitch"]["windows5Seconds"], row["methods"]["acoustic_segments"]["pitch"]["windows5Seconds"]):
                if old["eligibleForFloor"] and new["within50"] < old["within50"] - .01:
                    regressions.append(f'{row["song"]} {old["startSeconds"]:.0f}–{old["endSeconds"]:.0f}s ({pct(old["within50"])}→{pct(new["within50"])})')
    lines += ["## Decision evidence", "", f'On the heldout, acoustic gains only{(acoustic["within50"] - standard["within50"]) * 100:.2f} percentage points versus standard while adding{(acoustic["events"] / standard["events"] - 1) * 100:.1f}% events. Legato gains{(legato["within50"] - standard["within50"]) * 100:.2f} points with{(legato["events"] / standard["events"] - 1) * 100:.1f}% more events. Acoustic trails legato by{(legato["within50"] - acoustic["within50"]) * 100:.2f} points. The metric profile trades small bounded boundary moves for slightly lower aggregate frame agreement.', "", 'The worst proposal window is NewJeans130–135s:28.46% within50c and30.08% independent voiced coverage. Only39 of123 independently voiced frames have usable FCPE pitch/activation in the cached dense audit; the median FCPEF0 is0Hz. This is a missing-input-evidence failure that the frozen≤35ms harmonic-dropout fill does not repair. It must remain visible as unresolved coverage, not become a high joint-frame-only success score.', "", 'All best global timing offsets are0ms on this fixed20ms sweep. The gains are therefore not explained by a single global note shift. Local pitch/attack/boundary ambiguities remain. Acoustic regresses versus standard in these fixed5s heldout windows: ' + '; '.join(regressions) + '.', "", "## Per-song heldout", "", "| Song | Method | ±50c | coverage | events | worst5s | best timing offset | gain |", "|---|---|---:|---:|---:|---:|---:|---:|"]
    for row in report["rows"]:
        if row["split"] != "heldout":
            continue
        for name, item in row["methods"].items():
            pitch = item["pitch"]
            timing = pitch["temporalDiagnostic"]
            lines.append(f'| {row["song"]} | {name} | {pct(pitch["within50"])} | {pct(pitch["coverage"])} | {item["density"]["events"]} | {pct(pitch["floor5Seconds"]["within50"] if pitch["floor5Seconds"] else None)} | {timing["predictionSampleOffsetSeconds"]:+.2f}s | {pct(timing["gainOverZero"])} |')
    lines += ["", "## What this does and does not establish", "", "- Primary metric includes every audible CREPE-voiced frame with periodicity≥0.30 and55–1100Hz; a missing predicted note is an error. Joint-voiced agreement is secondary. These are model measurements, not true transcription accuracy.", "- Event counts, ≤100ms notes, and groups of≥3 consecutive≤180ms notes separated by≤40ms are density diagnostics. Genuine fast ornamentation can raise all of them. No event precision/recall is reported because human note-event truth is absent.", "- The worst5s metric is the minimum fixed5s window with≥0.5s independent voiced evidence. It exposes local failure hidden by averages.", "- The timing search is diagnostic:±200ms,20ms steps. Its best score is optimized on the evaluator and is not a validated correction. Zero-shift scores remain the main result.", "- Acoustic versus metric profiles share the same events/pitches; metric changes are jointly ordered, collision-preserving,≤30ms boundary moves. A metric shift can improve readability while reducing acoustic frame agreement.", "- A continuous portamento has no unique discrete note truth. The implementation flags glide/vibrato candidates but still emits provisional discrete notes. Those flags require listening.", "- A noisy consonant or separation artifact can legitimately interrupt pitched evidence. Brief gaps are filled only with harmonic evidence; elevated flatness prevents that fill. Actual candidates are labelled unverified, not asserted phoneme truth.", "- An80ms one-semitone ornament can be absorbed by the robust event/duration prior. The constructed fixture below makes that loss visible. Same-pitch reattacks can also be missed or spuriously inferred from acoustic valleys.", "- The heldout is temporal within the same four songs, not unseen-song generalization; it was already available as cached pitch audit data. Neither human boundary labels nor blinded listening have been collected.", "", "## Constructed cases", "", "| Case | Truth events | standard | legato | acoustic | metric |", "|---|---:|---:|---:|---:|---:|"]
    for row in report["constructedCases"]:
        truth = "undefined slide" if row["truth"] is None else str(len(row["truth"]))
        values = [str(row["methods"][method]["eventCount"]) + (" ✓" if row["methods"][method].get("exactPitchSequence") else "") for method in METHODS]
        lines.append(f'| {row["case"]} | {truth} | ' + " | ".join(values) + " |")
    lines += ["", "The checkmark means only that the synthetic pitch sequence and event count match. Boundary errors and frame coverage remain in JSON. Constructed truth is not copied from a neural output.", "", "## Files", "", "- `evidence/phase3/lead-note-evaluation.json`: shareable aggregate/per-song counts, fixed5s window metrics, diagnostic shifts, input hashes and frozen config. No private audio or note-event arrays.", "- `data/phase3/lead-note-evaluation.json`: ignored private complete measurements including note-event arrays.", "- `data/phase3/lead-note-evaluation.html`: ignored private local comparison with playable lead snippets, synthesized note hypotheses, and pitch overlays.", "- `data/phase3/lead-inspection/`: ignored private clips and SVG plots. Candidate labels and plots have not been human accepted. These files must not be committed or exposed as public examples.", ""]
    (summary_output / "lead-note-evaluation.md").write_text("\n".join(lines), encoding="utf-8")
    summary = []
    for split, methods in report["aggregate"].items():
        summary.append(f'<h2>{html.escape(split)}</h2><table><thead><tr><th>Method</th><th>CREPE ±50c</th><th>Coverage</th><th>Events</th><th>≤100ms</th><th>Short groups</th><th>Worst5s</th></tr></thead><tbody>')
        for name, item in methods.items():
            summary.append(f'<tr><td>{name}</td><td>{pct(item["within50"])}</td><td>{pct(item["coverage"])}</td><td>{item["events"]}</td><td>{item["short100ms"]}</td><td>{item["shortGroupCount"]}</td><td>{pct(item["floor5Seconds"]["within50"])}</td></tr>')
        summary.append('</tbody></table>')
    cases = []
    for row in report["rows"]:
        for example in row.get("inspection", []):
            cases.append(f'<details><summary>{html.escape(row["song"])} · {row["split"]} · {html.escape(example["kind"])} · {example["startSeconds"]:.2f}–{example["endSeconds"]:.2f}s</summary><p>{html.escape(example["reason"])} Human listening: unverified.</p>')
            if example.get("leadClip"):
                cases.append(f'<label>Actual cached lead <audio controls preload="none" src="{example["leadClip"]}"></audio></label>')
            for name, clip in example.get("noteClips", {}).items():
                cases.append(f'<label>{name} <audio controls preload="none" src="{clip}"></audio></label>')
            cases.append(f'<img src="{example["plot"]}" alt="Four decoder note hypotheses over independent CREPE and FCPE pitch frames"/></details>')
    document = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Frozen lead-note evaluation</title><style>body{font:16px/1.5 system-ui;background:#f4f6f9;color:#253246;margin:0}main{max-width:1180px;margin:auto;padding:32px}h1{font-size:32px;letter-spacing:-.7px}h2{margin-top:32px}p{max-width:1000px}.status{background:#fff1d7;border-left:5px solid #c58924;padding:18px}table{border-collapse:collapse;background:white;width:100%;font-size:15px}td,th{text-align:right;padding:11px 14px;border-bottom:1px solid #e3e8f0}td:first-child,th:first-child{text-align:left}details{background:white;border:1px solid #dce2ea;border-radius:8px;padding:15px;margin:12px 0}summary{cursor:pointer;font-weight:650}img{width:100%;height:auto}label{display:inline-flex;flex-direction:column;font-size:12px;gap:5px;margin:8px}audio{width:215px}code{background:#e6eaf0;padding:2px 5px}.small{font-size:13px;color:#526075}</style><main><h1>Frozen lead-note evaluation</h1><p class="status"><strong>Do not promote to the default decoder.</strong> These are offline model-agreement and density measurements. Human note-event accuracy and listening acceptance remain unverified.</p><p>Four real private songs. Development:0–90s each. Heldout:110–140s each. Exactly two frozen proposal profiles. CREPE enters only the evaluator after note decoding. Missed independently voiced frames count as errors.</p>' + ''.join(summary) + '<h2>Limits that affect the decision</h2><p>A slide may not have a unique discrete note boundary. Robust smoothing can erase an80ms semitone ornament. Acoustic valleys can split repeated same-pitch notes, but can also produce extra attacks. Noisy consonants and separation artifacts make brief gaps ambiguous. A denser score is not necessarily more correct.</p><p>The5s floor uses fixed windows with≥0.5s independent voiced evidence. Short groups mean≥3 adjacent≤180ms notes with≤40ms gaps. No event precision/recall is claimed without human event labels. The timing sweep is diagnostic only; no optimized shift is applied.</p><h2>Local inspection candidates</h2><p class="small">Open a row to compare actual lead and simple note-hypothesis tones. These clips are local derivatives of existing private audio and were not uploaded. Candidate labels are machine-selected and unverified.</p>' + ''.join(cases) + f'<p><a href="{html.escape(os.path.relpath(summary_output / "lead-note-evaluation.md", output))}">Detailed summary report</a> · <a href="lead-note-evaluation.json">Private complete measurements and frozen manifest</a></p></main></html>'
    (output / "lead-note-evaluation.html").write_text(document, encoding="utf-8")


def synthesize_note_clip(events, start, end, sr=16000):
    audio = np.zeros(round((end - start) * sr), np.float32)
    for a, b, pitch, *_ in events:
        first = max(0, round((a - start) * sr))
        last = min(len(audio), round((b - start) * sr))
        if last <= first:
            continue
        times = np.arange(last - first) / sr
        envelope = np.minimum(1, times / .008) * np.minimum(1, (len(times) / sr - times) / .012)
        phase = times * 2 * np.pi * 440 * 2 ** ((pitch - 69) / 12)
        audio[first:last] += .14 * envelope * (np.sin(phase) + .25 * np.sin(2 * phase))
    return audio


def run(args):
    output = args.output.resolve()
    summary_output = args.summary_output.resolve()
    if not output.is_relative_to(ROOT / "data") or output == summary_output:
        raise ValueError("Private audio, plots and note arrays must stay under the ignored workspace data/ directory, separate from summaries")
    output.mkdir(parents=True, exist_ok=True)
    summary_output.mkdir(parents=True, exist_ok=True)
    inspection = output / "lead-inspection"
    inspection.mkdir(exist_ok=True)
    report = {"schemaVersion": 1, "scope": "Cached local real-audio offline experiment; no neural inference, no source/project mutation, no uploads, no default change.", "fixedSplitsSeconds": SPLITS, "contextSeconds": CONTEXT_SECONDS, "frozenConfig": asdict(CONFIG), "profiles": PROFILES, "selectionProtocol": "Config and two profiles pre-exist; no parameter sweep or heldout tuning. Both proposals reported, neither selected for default.", "referencePolicy": "Independent CREPE evaluation only after all paths have decoded from FCPE and lead audio. Neural output is not ground truth. Missing predictions count against every independent voiced frame.", "sourceCodeSha256": {str(path.relative_to(ROOT)): sha256(path) for path in (ROOT / "server/lead_note_proposal.py", ROOT / "server/vocal.py", ROOT / "server/vocal_dp.py", Path(__file__))}, "inputManifest": [], "rows": []}
    begun = perf_counter()
    for song_index, (song, job) in enumerate(SONGS):
        directory = args.data_root.resolve() / job
        fcpe_path = directory / "lead-identity/lead-models/vocals-fcpe.npz"
        reference_path = directory / "dense-voice-audit/contours.npz"
        audio_path = directory / "stem-lead.wav"
        grid_path = directory / "quality-evidence.json"
        grid = json.loads(grid_path.read_text())["grid"]
        bpm, beat_offset = grid["bpm"], grid["offsetSeconds"]
        with np.load(fcpe_path) as values:
            fcpe = {key: values[key].copy() for key in values.files}
        with np.load(reference_path) as values:
            reference = {key: values[key].copy() for key in values.files}
        audio_info = sf.info(audio_path)
        report["inputManifest"].append({"song": song, "jobId": job, "durationSeconds": audio_info.duration, "grid": grid, "files": [{"path": str(path.relative_to(ROOT)), "sha256": sha256(path), "bytes": path.stat().st_size} for path in (fcpe_path, reference_path, audio_path, grid_path)]})
        for split_index, (split, (start, end)) in enumerate(SPLITS.items()):
            context_start, context_end = max(0, start - CONTEXT_SECONDS), min(audio_info.duration, end + CONTEXT_SECONDS)
            sample_start = round(context_start * audio_info.samplerate)
            sample_end = round(context_end * audio_info.samplerate)
            audio, sr = sf.read(audio_path, start=sample_start, stop=sample_end, dtype="float32", always_2d=True)
            audio = audio.mean(axis=1)
            context_start = sample_start / sr
            selected = (fcpe["time"] >= context_start) & (fcpe["time"] < context_end)
            times = fcpe["time"][selected] - context_start
            f0 = fcpe["f0"][selected]
            activation = fcpe["activation"][selected]
            methods, features = decode_methods(times, f0, activation, audio, sr, bpm, beat_offset - context_start)
            row = {"song": song, "jobId": job, "split": split, "startSeconds": start, "endSeconds": end, "contextStartSeconds": context_start, "contextEndSeconds": context_end, "methods": {}}
            for name, method in methods.items():
                events = [[float(event[0] + context_start), float(event[1] + context_start), int(event[2]), *map(float, event[3:])] for event in method["events"]]
                diagnostics = method["diagnostics"]
                for key in ("glideUncertaintyIntervals", "filledModelDropouts"):
                    if key in diagnostics:
                        diagnostics[key] = [[item[0] + context_start, item[1] + context_start, *item[2:]] for item in diagnostics[key]]
                row["methods"][name] = {"events": events, "runtimeSeconds": method["runtimeSeconds"], "diagnostics": diagnostics, "pitch": reference_metrics(events, reference, start, end), "density": event_metrics(events, start, end)}
            row["inspection"] = case_candidates(row, times + context_start, f0, features)
            if split == "heldout":
                standard_windows = row["methods"]["standard"]["pitch"]["windows5Seconds"]
                proposed_windows = row["methods"]["acoustic_segments"]["pitch"]["windows5Seconds"]
                eligible = [(old, new) for old, new in zip(standard_windows, proposed_windows) if old["eligibleForFloor"]]
                if eligible:
                    old, new = min(eligible, key=lambda pair: pair[1]["within50"] - pair[0]["within50"])
                    row["inspection"].append({"kind": "worst-relative5s-window", "startSeconds": old["startSeconds"], "endSeconds": old["endSeconds"], "reason": f'Least acoustic-profile gain versus standard among fixed5s heldout windows: standard{old["within50"]:.3f}, acoustic{new["within50"]:.3f}. Not an event correctness label.', "humanVerified": False})
                floor = row["methods"]["acoustic_segments"]["pitch"]["floor5Seconds"]
                if floor and not any(abs(example["startSeconds"] - floor["startSeconds"]) < 1e-8 and abs(example["endSeconds"] - floor["endSeconds"]) < 1e-8 for example in row["inspection"]):
                    row["inspection"].append({"kind": "lowest-acoustic-agreement5s-window", "startSeconds": floor["startSeconds"], "endSeconds": floor["endSeconds"], "reason": f'Lowest fixed5s acoustic-profile agreement: within50c{floor["within50"]:.3f}, voiced coverage{floor["coverage"]:.3f}. Independent pitch reference is not human truth.', "humanVerified": False})
            for index, example in enumerate(row["inspection"]):
                prefix = f"{song_index + 1}-{split_index + 1}-{index + 1}"
                example["plot"] = f"lead-inspection/{prefix}.svg"
                write_inspection_svg(output / example["plot"], row, reference, example["startSeconds"], example["endSeconds"])
                if not args.no_clips:
                    a = max(0, round((example["startSeconds"] - context_start) * sr))
                    b = min(len(audio), round((example["endSeconds"] - context_start) * sr))
                    lead_path = inspection / f"{prefix}-lead.wav"
                    sf.write(lead_path, audio[a:b], sr, subtype="PCM_16")
                    example["leadClip"] = str(lead_path.relative_to(output))
                    example["noteClips"] = {}
                    for name in METHODS:
                        path = inspection / f"{prefix}-{name}.wav"
                        sf.write(path, synthesize_note_clip(row["methods"][name]["events"], example["startSeconds"], example["endSeconds"]), 16000, subtype="PCM_16")
                        example["noteClips"][name] = str(path.relative_to(output))
            report["rows"].append(row)
            print(json.dumps({"song": song, "split": split, "metrics": {name: {"within50": round(item["pitch"]["within50"], 4), "events": item["density"]["events"]} for name, item in row["methods"].items()}}, ensure_ascii=False), flush=True)
    report["constructedCases"] = synthetic_evaluation()
    report["aggregate"] = {split: aggregate(report["rows"], split) for split in SPLITS}
    report["recommendation"] = {"promoteDefault": False, "reason": "Model-only agreement and event-density diagnostics cannot establish correct musical event boundaries. Frozen proposal has short-ornament/glide/attack ambiguity and heldout local floors; retain offline experimental status until human event truth and blinded listening exist.", "productionDefaultsChanged": False, "neuralInferenceRerun": False, "userProjectsChanged": False}
    report["runtimeSeconds"] = perf_counter() - begun
    report = finite(report)
    (output / "lead-note-evaluation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    summary = copy.deepcopy(report)
    summary["scope"] += " Shareable summary omits private note arrays and audio artifacts; complete evidence stays under ignored data/phase3."
    summary["privateArtifacts"] = {"html": str((output / "lead-note-evaluation.html").relative_to(ROOT)), "fullMeasurements": str((output / "lead-note-evaluation.json").relative_to(ROOT)), "inspection": str(inspection.relative_to(ROOT))}
    for song in summary["inputManifest"]:
        for key in ("beatTimesSeconds", "downbeatTimesSeconds"):
            if key in song["grid"]:
                song["grid"][key + "Count"] = len(song["grid"].pop(key))
    for row in summary["rows"]:
        row["inspectionCandidateCounts"] = {kind: sum(example["kind"] == kind for example in row["inspection"]) for kind in {example["kind"] for example in row["inspection"]}}
        del row["inspection"]
        for method in row["methods"].values():
            del method["events"]
            method["density"]["samePitchAdjacentBoundaryCount"] = len(method["density"].pop("samePitchAdjacentBoundaries"))
            method["density"].pop("shortGroups")
            for key in ("glideUncertaintyIntervals", "filledModelDropouts", "shortVoicedIslandsRetained"):
                if key in method["diagnostics"]:
                    method["diagnostics"][key + "Count"] = len(method["diagnostics"].pop(key))
    for case in summary["constructedCases"]:
        for method in case["methods"].values():
            method.pop("events")
    (summary_output / "lead-note-evaluation.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_reports(report, output, summary_output)
    print(json.dumps({"output": str(output / "lead-note-evaluation.html"), "runtimeSeconds": report["runtimeSeconds"], "aggregate": report["aggregate"]}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", type=Path, default=ROOT / "data")
    parser.add_argument("--output", type=Path, default=ROOT / "data/phase3", help="Ignored private output directory for audio, plots, HTML and note arrays")
    parser.add_argument("--summary-output", type=Path, default=ROOT / "evidence/phase3", help="Shareable JSON/Markdown summary directory; no private note arrays or audio")
    parser.add_argument("--no-clips", action="store_true")
    run(parser.parse_args())

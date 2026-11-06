#!/usr/bin/env python3
"""Frozen local missing-F0 rescue audit; classical inference only, no uploads."""
from __future__ import annotations

import argparse
import copy
import hashlib
import html
import importlib.util
import json
import math
import sys
from dataclasses import asdict
from pathlib import Path
from time import perf_counter

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server.voice_rescue import CONFIG, VERSION, estimate_classical_pitch, fcpe_gate_diagnostics, frame_rms, merge_rescue_into_missing, rescue_missing_voice_pitch, rms_floor
from server.voice_rescue import _nearest, _raw_pitch_support
from scipy.signal import resample_poly

SONGS = (("Ariana Grande - bye", "f70ebab316d54d62abb0f56d19e0356e"), ("NewJeans - Attention", "22d62c8049d04e39b9062b60513bf9c5"), ("The Weeknd - Out of Time", "1eac4381bbfd4904a66bf0ca97e2f72d"), ("单依纯 - 空耳", "a6be0eb965d048a0ad57819135164463"))
SPLITS = {"development": (0., 32.), "heldout": (110., 140.)}


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def clean(value):
    if isinstance(value, dict):
        return {key: clean(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(item) for item in value]
    if isinstance(value, np.ndarray):
        return clean(value.tolist())
    if isinstance(value, np.generic):
        return clean(value.item())
    return None if isinstance(value, float) and not math.isfinite(value) else value


def cache_classical(audio, sr, offset, directory, signature):
    directory.mkdir(parents=True, exist_ok=True)
    cache_path, meta_path = directory / "pyin.npz", directory / "pyin-cache.json"
    if cache_path.exists() and meta_path.exists():
        metadata = json.loads(meta_path.read_text())
        if metadata.get("signature") == signature and metadata.get("sha256") == digest(cache_path):
            with np.load(cache_path) as source:
                return {key: source[key].copy() for key in source.files}, True
    evidence = estimate_classical_pitch(audio, sr, audio_offset_seconds=offset)
    np.savez_compressed(cache_path, **{key: evidence[key] for key in ("time", "f0", "probability", "voiced")})
    meta_path.write_text(json.dumps({"signature": signature, "sha256": digest(cache_path), "runtimeSeconds": evidence["runtimeSeconds"]}, indent=2) + "\n")
    return evidence, False


def fixtures():
    spec = importlib.util.spec_from_file_location("rescue_analytic_truth", ROOT / "tests/test_voice_rescue.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    output = []
    for case in module.fixture_cases():
        proposal, detail = module.run_fixture(case)
        raw_missing = ~np.isfinite(case["fcpe"]) | (case["fcpe"] <= 0)
        truth_voiced = case["truth"] > 0
        target = raw_missing & truth_voiced
        accepted = proposal > 0
        error = np.full(len(proposal), np.inf)
        common = accepted & truth_voiced
        error[common] = abs(1200 * np.log2(proposal[common] / case["truth"][common]))
        correct = target & accepted & (error <= 35.)
        output.append({"case": case["name"], "truthSource": "Analytic synthesized waveform; CREPE arrays are declared correct/incorrect verifier stubs, not neural truth", "missingTruthVoicedFrames": int(target.sum()), "accepted": int(accepted.sum()), "correctMissingPitchFramesWithin35c": int(correct.sum()), "missingPitchRecall": int(correct.sum()) / int(target.sum()) if target.any() else None, "proposedOnUnvoicedTruthFrames": int((accepted & ~truth_voiced).sum()), "wrongPitchProposals": int((common & (error > 35.)).sum()), "existingNonzeroFCPEProposals": int((accepted & ~raw_missing).sum()), "counts": detail["counts"]})
    return output


def abstention_diagnostics(times, f0, source_rms, floor, classical, crepe, *, focus_audio=None, sr=None, audio_offset=0.):
    """Distributions only. Never creates an alternative proposal/configuration."""
    missing = ~np.isfinite(f0) | (f0 <= 0)
    pyin = _nearest(times, classical["time"], classical["f0"], .011)
    probability = _nearest(times, classical["time"], classical["probability"], .011)
    verifier = _nearest(times, crepe["time"], crepe["crepeF0"], .011)
    periodicity = _nearest(times, crepe["time"], crepe["periodicity"], .011)
    common = np.isfinite(pyin) & np.isfinite(verifier) & (pyin >= 55) & (verifier >= 55)
    agreement = np.zeros(len(times), dtype=bool)
    agreement[common] = abs(1200 * np.log2(pyin[common] / verifier[common])) <= CONFIG.agreement_cents
    high_confidence = agreement & (probability >= CONFIG.pyin_probability) & (periodicity >= CONFIG.crepe_periodicity)
    quantile = lambda mask: np.quantile(probability[mask & np.isfinite(probability)], [.5, .9, .99, 1.]).tolist() if np.any(mask & np.isfinite(probability)) else []
    result = {"rawMissingAboveExistingRMS": int((missing & (source_rms >= floor)).sum()), "missingPyinProbabilityQuantiles": quantile(missing), "missingHighConfidenceModelAgreementFrames": int((missing & high_confidence).sum()), "missingHighConfidenceAgreementAboveRMS": int((missing & high_confidence & (source_rms >= floor)).sum())}
    if focus_audio is not None:
        focus = missing & (times >= 130) & (times < 135)
        result["focus130to135"] = {"rawMissingFrames": int(focus.sum()), "aboveRMS": int((focus & (source_rms >= floor)).sum()), "pyinProbabilityQuantiles": quantile(focus), "pyinFiniteF0": int((focus & np.isfinite(pyin)).sum()), "crepePeriodicityAtLeastPoint7": int((focus & (periodicity >= CONFIG.crepe_periodicity)).sum()), "highConfidenceModelAgreement": int((focus & high_confidence).sum())}
        divisor = np.gcd(sr, CONFIG.sample_rate)
        signal = resample_poly(focus_audio, CONFIG.sample_rate // divisor, sr // divisor) if sr != CONFIG.sample_rate else focus_audio
        raw_features = np.zeros((len(times), 5))
        valid = focus & np.isfinite(pyin) & (pyin >= CONFIG.minimum_f0) & (pyin <= CONFIG.maximum_f0)
        for index in np.flatnonzero(valid):
            raw_features[index] = _raw_pitch_support(signal, CONFIG.sample_rate, times[index] - audio_offset, pyin[index])
        raw_support = valid & (raw_features[:, 0] >= CONFIG.minimum_autocorrelation) & (raw_features[:, 1] >= CONFIG.minimum_harmonic_fraction) & (raw_features[:, 2] >= CONFIG.minimum_supported_harmonics) & raw_features[:, 3].astype(bool) & ~raw_features[:, 4].astype(bool)
        result["focusSignal"] = {"scope": "Diagnostic evidence distributions only; no alternative config, accepted proposal or accuracy claim. Frozen rule still abstains; low confidence does not establish absent singing.", "rawMissingFrames": int(focus.sum()), "finitePyinFrames": int(valid.sum()), "rawHarmonicSupportAtPyinEstimate": int(raw_support.sum()), "rawHarmonicSupportAndFullSourceRMS": int((raw_support & (source_rms >= floor)).sum()), "modelPitchAgreementIgnoringConfidence": int((focus & agreement).sum()), "modelPitchAgreementPlusRawHarmonicsIgnoringConfidence": int((raw_support & agreement).sum()), "acceptedByFrozenRule": 0, "pyinProbabilityMaximumOnMissing": float(np.nanmax(probability[focus]))}
    return result


def inspection_plot(path, title, times, fcpe, proposal, crepe_time, crepe, start, end):
    width, height, left = 1100, 310, 55
    selected = (times >= start) & (times <= end)
    c_selected = (crepe_time >= start) & (crepe_time <= end)
    values = np.r_[fcpe[selected], proposal[selected], crepe[c_selected]]
    values = values[np.isfinite(values) & (values >= 55) & (values <= 1100)]
    midi = 69 + 12 * np.log2(values / 440) if len(values) else np.array([48., 84.])
    lo, hi = math.floor(midi.min()) - 2, math.ceil(midi.max()) + 2
    x = lambda t: left + (t - start) / max(.01, end - start) * (width - left - 15)
    y = lambda p: 245 - (p - lo) / max(6, hi - lo) * 205
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}"><rect width="100%" height="100%" fill="white"/><style>text{{font:12px system-ui;fill:#334155}}</style><text x="55" y="20">{html.escape(title)} · Existing FCPE blue / rescue green / consumed CREPE gray (no truth claim)</text>']
    for pitch in range(lo, hi + 1):
        svg.append(f'<line x1="{left}" x2="1085" y1="{y(pitch):.1f}" y2="{y(pitch):.1f}" stroke="#edf0f4"/>')
    for t, f, color, radius in ((crepe_time[c_selected], crepe[c_selected], "#9aa2ac", 1.8), (times[selected], fcpe[selected], "#2463c5", 2.), (times[selected], proposal[selected], "#087e57", 3.)):
        for at, pitch in zip(t, f):
            if np.isfinite(pitch) and 55 <= pitch <= 1100:
                svg.append(f'<circle cx="{x(at):.2f}" cy="{y(69+12*np.log2(pitch/440)):.2f}" r="{radius}" fill="{color}"/>')
    for at in np.linspace(start, end, 7):
        svg.append(f'<text x="{x(at):.2f}" y="275" text-anchor="middle">{at:.2f}s</text>')
    svg.append('</svg>')
    path.write_text("".join(svg))


def write_reports(report, private, summary):
    lines = ["# Missing-pitch rescue: frozen local experiment", "", "**Recommendation: do not integrate: the frozen rule recovered zero real-song frames.** Passing constructed fixtures did not demonstrate a useful real-audio rescue MVP. The isolated rule is restricted to raw FCPE zeros/nonfinite frames. It does not recover all score omissions, edit notes, repair octaves, or prove singer identity.", "", "One configuration was frozen on constructed waveform fixtures before classical pYIN ran on the real-song intervals. No neural inference, installs or cloud calls occurred. Development: 0–32s of each song; temporal heldout: 110–140s. CREPE and pYIN are consumed by rescue, so their agreement is not used as an accuracy score. No threshold was loosened after the real zero-gain result.", "", "| Song | Split | Raw missing seconds | Existing FCPE passes both gates | Proposed extra seconds | Proposal islands | Remaining raw missing seconds |", "|---|---|---:|---:|---:|---:|---:|"]
    for row in report["rows"]:
        gate, rescue = row["gates"], row["rescue"]
        lines.append(f'| {row["song"]} | {row["split"]} | {gate["rawF0Missing"] * .01:.2f} | {gate["passBoth"] * .01:.2f}s | {row["acceptedSeconds"]:.2f} | {row["acceptedIntervalCount"]} | {gate["rawF0Missing"] * .01 - row["acceptedSeconds"]:.2f} |')
    lines += ["", "## NewJeans 130–135s diagnosis", ""]
    focus = report["focusNewJeans130to135"]
    lines += [f'Of {focus["gates"]["frames"]} FCPE frames, {focus["gates"]["rawF0Exists"]} have raw pitch; {focus["gates"]["f0AndActivation"]} pass activation, {focus["gates"]["f0AndRMS"]} pass RMS, and {focus["gates"]["passBoth"]} pass both. Thus {focus["gates"]["rawF0Missing"]} frames lack raw pitch, while {focus["gates"]["rawF0Exists"] - focus["gates"]["passBoth"]} existing estimates are rejected by one or both gates. The rescue proposes {focus["acceptedFrames"]} missing frames ({focus["acceptedFrames"] * .01:.2f}s); it does not override the latter gate failures.', "", "## Constructed truth", "", "| Fixture | Missing voiced truth frames | Accepted | Correct within35c | Recall | Proposed on unvoiced truth | Wrong pitch |", "|---|---:|---:|---:|---:|---:|---:|"]
    for row in report["fixtures"]:
        recall = "—" if row["missingPitchRecall"] is None else f'{row["missingPitchRecall"]*100:.1f}%'
        lines.append(f'| {row["case"]} | {row["missingTruthVoicedFrames"]} | {row["accepted"]} | {row["correctMissingPitchFramesWithin35c"]} | {recall} | {row["proposedOnUnvoicedTruthFrames"]} | {row["wrongPitchProposals"]} |')
    lines += ["", "The fixture truth comes from analytic waveform generation. CREPE inputs in these fixtures are declared verifier stubs, including intentionally false confident pitch/octave hypotheses. Actual pYIN and raw waveform checks run on the generated audio. This tests the rescue rule under controlled inputs; it does not test neural verifier accuracy.", "", "## Conservative rule and limitations", "", "- Only raw FCPE zeros/nonfinite values may receive a proposal. Every finite positive FCPE value is preserved, including quiet/low-activation estimates and octave conflicts.", "- Require saved CREPE periodicity≥0.70, pYIN voiced probability≥0.70, agreement≤35c, source RMS above the existing full-song gate, raw autocorrelation≥0.70, harmonic energy≥0.62, at least two individually supported harmonics including an odd harmonic, no better octave-lower competitor, and at least100ms sustained support.", "- pYIN and CREPE are both consumed evidence. Real-song counts are additional signal-supported coverage, not accuracy, precision/recall, or an independent correctness check. All accepted waveform criteria are selection criteria, not separate validation scores.", "- The synthetic single-sine case deliberately abstains. Missing-fundamental recovery requires a harmonic pattern that resolves the fundamental. Both estimators can agree on an instrumental/backing-vocal residual or the same wrong octave; a raw harmonic check reduces but cannot eliminate this risk.", "- Breath/noise/silence tests cover particular constructed signals; real unvoiced intervals and source-separation artifacts remain possible false positives. Human listening and event labels are absent for this rescue experiment.", "- Sustained-support requirements leave short dropouts, fast ornamentation, glides, low-SNR singing and unsupported boundaries unfilled. No gap is filled solely because surrounding notes have the same pitch.", "- These four heldout temporal intervals were already inspected in prior work; they are not unseen songs or a blinded benchmark. The known NewJeans hole was diagnostic, not a parameter-tuning target.", "", "## Outputs", "", "- `server/voice_rescue.py`: isolated proposal and explicit missing-only merge helpers; no app/default imports.", "- `scripts/analyze-voice-rescue.py`: reproducible frozen audit with cached classical pYIN only.", "- `evidence/phase4/voice-rescue-summary.json`: counts, hashes, rule and fixture results; no private pitch or audio arrays.", "- `data/phase4/voice-rescue-full.json`, per-job `*.npz` and local HTML/clips: ignored private review artifacts. Do not commit or publish them.", ""]
    (summary / "voice-rescue-summary.md").write_text("\n".join(lines), encoding="utf-8")
    cards = []
    for row in report["rows"]:
        for example in row["inspection"]:
            cards.append(f'<details><summary>{html.escape(row["song"])} · {row["split"]} · {example["startSeconds"]:.2f}–{example["endSeconds"]:.2f}s</summary><p>Raw FCPE missing-only proposal. All pitch models shown are consumed evidence; this is not correctness validation. Human listening unverified.</p><audio controls preload="metadata" src="{example["audio"]}"></audio><img src="{example["plot"]}" alt="Existing and newly proposed pitch frames"/></details>')
    table = '<table><tr><th>Song / split</th><th>Raw missing</th><th>Proposed extra</th><th>Islands</th></tr>' + ''.join(f'<tr><td>{html.escape(r["song"])} / {r["split"]}</td><td>{r["gates"]["rawF0Missing"]*.01:.2f}s</td><td>{r["acceptedSeconds"]:.2f}s</td><td>{r["acceptedIntervalCount"]}</td></tr>' for r in report["rows"]) + '</table>'
    document = '<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Missing-pitch rescue candidates</title><style>body{font:16px/1.55 system-ui;background:#f5f7fa;color:#263347;margin:0}main{max-width:1150px;margin:auto;padding:30px}h1{letter-spacing:-.6px}table{border-collapse:collapse;background:white;width:100%}td,th{padding:12px;text-align:left;border-bottom:1px solid #dde3ec}.notice{background:#fff1d7;padding:20px;border-left:5px solid #b77d14}details{background:white;padding:15px;border:1px solid #dce3eb;margin:12px 0;border-radius:7px}summary{cursor:pointer;font-weight:650}img{width:100%;height:auto}audio{width:330px}</style><main><h1>Missing-pitch rescue candidates</h1><p class="notice"><strong>No integration: the frozen rule recovered zero real-song frames.</strong> Saved CREPE + local pYIN + raw harmonic evidence can propose only raw FCPE-missing frames. The measurements below are extra supported coverage, not accuracy.</p>' + table + '<h2>Private local inspection</h2><p>The underlying user audio remains on this machine. Candidate pitch can still belong to source-separation residuals or the wrong singer. Strict abstention does not establish that the source lacks singing. No automatic edit was applied.</p>' + ''.join(cards) + '</main></html>'
    (private / "voice-rescue-review.html").write_text(document, encoding="utf-8")


def run(args):
    private, summary = args.private.resolve(), args.summary.resolve()
    if not private.is_relative_to(ROOT / "data") or private == summary:
        raise ValueError("Private waveform and pitch outputs must stay under ignored data/, separate from summaries")
    private.mkdir(parents=True, exist_ok=True)
    summary.mkdir(parents=True, exist_ok=True)
    frozen = json.loads((summary / "voice-rescue-frozen.json").read_text())
    if frozen["config"] != asdict(CONFIG):
        raise ValueError("Configuration differs from the single frozen rescue configuration")
    for path, expected in frozen["sourceSha256"].items():
        if digest(ROOT / path) != expected:
            raise ValueError(f"Frozen implementation/fixture source changed: {path}")
    begun = perf_counter()
    report = {"version": VERSION, "config": asdict(CONFIG), "fixedSplitsSeconds": SPLITS, "scope": "Real signal consistency/extra supported coverage only, not accuracy; CREPE and pYIN are both consumed evidence", "frozenManifest": frozen, "sourceHashes": {str(path.relative_to(ROOT)): digest(path) for path in (ROOT / "server/voice_rescue.py", ROOT / "tests/test_voice_rescue.py", Path(__file__))}, "inputManifest": [], "rows": [], "fixtures": fixtures()}
    for song_index, (song, job) in enumerate(SONGS):
        directory = ROOT / "data" / job
        paths = [directory / "lead-identity/lead-models/vocals-fcpe.npz", directory / "dense-voice-audit/contours.npz", directory / "stem-lead.wav"]
        manifest = [{"path": str(path.relative_to(ROOT)), "sha256": digest(path), "bytes": path.stat().st_size} for path in paths]
        report["inputManifest"].append({"song": song, "jobId": job, "files": manifest})
        with np.load(paths[0]) as source:
            fcpe = {key: source[key].copy() for key in source.files}
        with np.load(paths[1]) as source:
            crepe = {key: source[key].copy() for key in source.files}
        full_audio, sr = sf.read(paths[2], dtype="float32", always_2d=True)
        full_audio = full_audio.mean(axis=1)
        rms = frame_rms(fcpe["time"], full_audio, sr)
        floor = rms_floor(rms)
        for split_index, (split, (start, end)) in enumerate(SPLITS.items()):
            first, last = max(0, round((start - .20) * sr)), min(len(full_audio), round((end + .20) * sr))
            audio, offset = full_audio[first:last], first / sr
            selected = (fcpe["time"] >= start) & (fcpe["time"] < end)
            times, f0 = fcpe["time"][selected], fcpe["f0"][selected]
            destination = private / job / split
            signature = {"leadSha256": manifest[2]["sha256"], "audioStartSample": first, "audioEndSample": last, "sourceRate": sr, "config": asdict(CONFIG), "classicalMethod": "librosa-pyin-local-no-neural"}
            classical, hit = cache_classical(audio, sr, offset, destination, signature)
            proposal, detail = rescue_missing_voice_pitch(times, f0, crepe["time"], crepe["crepeF0"], crepe["periodicity"], audio, sr, audio_offset_seconds=offset, classical_evidence=classical, minimum_rms=floor)
            merged = merge_rescue_into_missing(f0, proposal)
            existing = np.isfinite(f0) & (f0 > 0)
            assert np.array_equal(merged[existing], f0[existing])
            assert np.all(proposal[existing] == 0)
            row = {"song": song, "jobId": job, "split": split, "startSeconds": start, "endSeconds": end, "gates": fcpe_gate_diagnostics(fcpe["time"], fcpe["f0"], fcpe["activation"], rms, floor, start, end), "acceptedFrames": int((proposal > 0).sum()), "acceptedSeconds": float((proposal > 0).sum() * .01), "acceptedIntervalCount": len(detail["intervals"]), "rescue": detail, "classicalCacheHit": hit, "existingPositiveF0Preserved": True, "inspection": []}
            row["abstention"] = abstention_diagnostics(times, f0, rms[selected], floor, classical, crepe, focus_audio=audio if song_index == 1 and split == "heldout" else None, sr=sr, audio_offset=offset)
            row["windows5Seconds"] = []
            for left in np.arange(start, end, 5.):
                right = min(end, left + 5)
                mask = (times >= left) & (times < right)
                row["windows5Seconds"].append({"startSeconds": float(left), "endSeconds": float(right), "gates": fcpe_gate_diagnostics(fcpe["time"], fcpe["f0"], fcpe["activation"], rms, floor, left, right), "acceptedFrames": int(np.sum(mask & (proposal > 0)))})
            if song_index == 1 and split == "heldout":
                focus = (times >= 130) & (times < 135)
                row_focus = {"gates": fcpe_gate_diagnostics(fcpe["time"], fcpe["f0"], fcpe["activation"], rms, floor, 130, 135), "acceptedFrames": int(np.sum(focus & (proposal > 0)))}
                report["focusNewJeans130to135"] = row_focus
            np.savez_compressed(destination / "rescue-proposal.npz", time=times, fcpeF0=f0, proposalF0=proposal, mergedF0=merged, fcpeActivation=fcpe["activation"][selected], sourceRMS=rms[selected])
            for example_index, interval in enumerate(sorted(detail["intervals"], key=lambda item: -item["frames"])[:2]):
                a, b = max(start, interval["startSeconds"] - .30), min(end, interval["endSeconds"] + .30)
                prefix = f"{song_index + 1}-{split_index + 1}-{example_index + 1}"
                plot_path, audio_path = private / f"rescue-{prefix}.svg", private / f"rescue-{prefix}.wav"
                inspection_plot(plot_path, song, times, f0, proposal, crepe["time"], crepe["crepeF0"], a, b)
                sf.write(audio_path, full_audio[round(a * sr):round(b * sr)], sr, subtype="PCM_16")
                row["inspection"].append({"startSeconds": a, "endSeconds": b, "plot": plot_path.name, "audio": audio_path.name, "humanListeningVerified": False})
            if song_index == 1 and split == "heldout":
                plot_path, audio_path = private / "newjeans-130-135-abstention.svg", private / "newjeans-130-135-abstention.wav"
                inspection_plot(plot_path, song + " · frozen rescue abstains", times, f0, proposal, crepe["time"], crepe["crepeF0"], 130., 135.)
                sf.write(audio_path, full_audio[round(130 * sr):round(135 * sr)], sr, subtype="PCM_16")
                row["inspection"].append({"startSeconds": 130., "endSeconds": 135., "plot": plot_path.name, "audio": audio_path.name, "humanListeningVerified": False})
            report["rows"].append(row)
            print(json.dumps({"song": song, "split": split, "rawMissing": row["gates"]["rawF0Missing"], "accepted": row["acceptedFrames"], "islands": row["acceptedIntervalCount"], "counts": detail["counts"]}, ensure_ascii=False), flush=True)
    report["aggregate"] = {split: {"rawMissingFrames": sum(row["gates"]["rawF0Missing"] for row in report["rows"] if row["split"] == split), "acceptedFrames": sum(row["acceptedFrames"] for row in report["rows"] if row["split"] == split), "acceptedIntervals": sum(row["acceptedIntervalCount"] for row in report["rows"] if row["split"] == split)} for split in SPLITS}
    report["runtimeSeconds"] = perf_counter() - begun
    report["recommendation"] = {"usableRealRescueDemonstrated": any(row["acceptedFrames"] for row in report["rows"]), "integrateCandidate": False, "changeDefault": False, "retainOfflineOnly": True, "reason": "No real frames pass the frozen conservative rule; useful rescue MVP not demonstrated. Abstention does not prove absence of singing. No thresholds were loosened against known heldout. Existing notes/positive FCPE values untouched.", "neuralRuns": 0, "configurations": 1}
    report = clean(report)
    (private / "voice-rescue-full.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    public = copy.deepcopy(report)
    for row in public["rows"]:
        row.pop("inspection")
        row["rescue"].pop("intervals")
    public["privateArtifacts"] = {"fullReport": str((private / "voice-rescue-full.json").relative_to(ROOT)), "review": str((private / "voice-rescue-review.html").relative_to(ROOT)), "arrays": "Ignored per-job data/phase4/*/{development,heldout}/*.npz only"}
    (summary / "voice-rescue-summary.json").write_text(json.dumps(public, ensure_ascii=False, indent=2) + "\n")
    gate_rows = [{"song": row["song"], "split": row["split"], **row["gates"]} for row in report["rows"]]
    gate_rows.append({"song": "NewJeans - Attention", "split": "focus130to135", **report["focusNewJeans130to135"]["gates"]})
    (summary / "voice-rescue-gates.json").write_text(json.dumps(gate_rows, ensure_ascii=False, indent=2) + "\n")
    abstentions = [{"song": row["song"], "split": row["split"], **row["abstention"]} for row in report["rows"]]
    (summary / "voice-rescue-abstention.json").write_text(json.dumps(abstentions, ensure_ascii=False, indent=2) + "\n")
    focus_signal = next(row["abstention"]["focusSignal"] for row in report["rows"] if "focusSignal" in row["abstention"])
    (summary / "voice-rescue-focus-signal.json").write_text(json.dumps(focus_signal, indent=2) + "\n")
    write_reports(report, private, summary)
    print(json.dumps({"aggregate": report["aggregate"], "focus": report["focusNewJeans130to135"], "runtimeSeconds": report["runtimeSeconds"]}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--private", type=Path, default=ROOT / "data/phase4")
    parser.add_argument("--summary", type=Path, default=ROOT / "evidence/phase4")
    run(parser.parse_args())

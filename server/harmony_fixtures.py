"""Independent known harmony recordings; no production chord templates are imported."""
from __future__ import annotations

import base64
import json
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf

from .config import ROOT, binary

DEVELOPMENT = [
    ("C", [48, 55, 60, 64, 67], 36),
    ("C", [52, 55, 60, 64, 67], 40),
    ("Am", [45, 52, 57, 60, 64], 33),
    ("G7", [43, 53, 59, 62, 67], 31),
    ("Dmaj7", [50, 57, 61, 66, 69], 38),
    ("Em7", [47, 52, 55, 62, 67], 40),
    ("Fsus2", [48, 53, 55, 60, 65], 41),
    ("Dsus4", [50, 55, 57, 62, 67], 38),
    ("Bdim", [47, 53, 62, 65, 71], 35),
    ("Bdim7", [47, 53, 56, 62, 65], 35),
    ("Dm7b5", [50, 56, 60, 65, 68], 38),
    ("Caug", [48, 56, 60, 64, 68], 36),
    ("C6", [48, 55, 60, 64, 69], 36),
    ("Am6", [45, 52, 57, 60, 66], 33),
    ("N", [], None),
    ("N", [], "noise"),
]

HELD_OUT = [
    ("Ebmaj7", [43, 50, 55, 58, 63], 39),
    ("F#m7", [45, 52, 57, 61, 66], 42),
    ("Bb7", [44, 50, 53, 58, 62], 34),
    ("Absus4", [44, 49, 51, 56, 61], 32),
    ("Ebsus2", [46, 51, 53, 58, 63], 39),
    ("Fdim", [41, 47, 56, 59, 65], 41),
    ("Gm7b5", [43, 49, 53, 58, 61], 31),
    ("B", [42, 47, 54, 59, 63], 35),
    ("N", [], None),
]


def build_fixture(directory: Path, held_out: bool = False, sampled: bool = False, conflicting_melody: bool = False) -> dict:
    directory.mkdir(parents=True, exist_ok=True)
    cases = HELD_OUT if held_out else DEVELOPMENT
    sr = 22050
    bpm = 100 if not held_out else 112
    beats_per_chord = 4
    seconds = beats_per_chord * 60 / bpm
    duration = len(cases) * seconds
    accompaniment = np.zeros(round(duration * sr), dtype=np.float32)
    bass = np.zeros_like(accompaniment)
    melody = np.zeros_like(accompaniment)
    cache = {}
    rng = np.random.default_rng(4117 if held_out else 916)
    notes = []

    def tone(pitch: int, samples: int, bass_note: bool = False) -> np.ndarray:
        if sampled and not bass_note:
            key = pitch
            if key not in cache:
                path = ROOT / "public/soundfonts/acoustic_guitar_nylon.json" if held_out else ROOT / "public/soundfonts/acoustic_grand_piano.json"
                bank = json.loads(path.read_text())
                names = ("C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B")
                name = names[pitch % 12] + str(pitch // 12 - 1)
                audio = base64.b64decode(bank[name].split(",", 1)[1])
                result = subprocess.run([binary("ffmpeg"), "-v", "error", "-i", "pipe:0", "-f", "f32le", "-ac", "1", "-ar", str(sr), "pipe:1"], input=audio, capture_output=True, check=True)
                cache[key] = np.frombuffer(result.stdout, dtype="<f4").copy()
            waveform = np.zeros(samples)
            waveform[:min(samples, len(cache[key]))] = cache[key][:samples]
        else:
            t = np.arange(samples) / sr
            frequency = 440 * 2 ** ((pitch - 69) / 12)
            # Unlike the inference dictionary, these profiles have strongly different spectra.
            harmonics = [(1, 1), (2, .18), (3, .08), (5, .025)] if not held_out else [(1, 1), (3, .25), (5, .08), (7, .015)]
            waveform = sum(gain * np.sin(2 * np.pi * frequency * h * t + .07 * h) for h, gain in harmonics)
        envelope = np.ones(samples)
        attack = min(samples // 4, round(.015 * sr))
        release = min(samples // 4, round(.07 * sr))
        envelope[:attack] = np.linspace(0, 1, attack)
        envelope[-release:] = np.linspace(1, 0, release)
        return waveform * envelope

    for index, (label, chord, bass_pitch) in enumerate(cases):
        start = round(index * seconds * sr)
        end = round((index + 1) * seconds * sr)
        count = end - start
        for pitch in chord:
            accompaniment[start:end] += tone(pitch, count) * .12
        if isinstance(bass_pitch, int):
            bass[start:end] += tone(bass_pitch, count, bass_note=True) * .18
        if bass_pitch == "noise":
            accompaniment[start:end] = rng.normal(0, .045, count)
        if conflicting_melody and label != "N":
            # Loud non-chord melody is a distinct forbidden stem, never part of acoustic harmony input.
            melody[start:end] += tone(70 if index % 2 else 66, count) * .65
        notes.append({"startBeat": index * beats_per_chord, "endBeat": (index + 1) * beats_per_chord, "startSeconds": index * seconds, "endSeconds": (index + 1) * seconds, "expectedSymbol": label, "expectedPitchClasses": sorted({p % 12 for p in chord}), "playedPitches": chord, "bassMidi": bass_pitch})
    for name, audio in (("piano", accompaniment), ("bass", bass), ("vocals", melody)):
        sf.write(directory / f"{name}.wav", audio, sr, subtype="FLOAT")
    sf.write(directory / "mix-with-excluded-melody.wav", accompaniment + bass + melody, sr, subtype="FLOAT")
    truth = {"fixture": "heldout-chromatic-guitar" if held_out and sampled else "heldout-chromatic-synthetic" if held_out else "development-piano" if sampled else "development-synthetic", "bpm": bpm, "offsetSeconds": 0, "durationSeconds": duration, "usesProductionChordTemplates": False, "hasConflictingExcludedMelody": conflicting_melody, "notes": notes, "license": "Newly composed test progression; sampledbanks credited in public/soundfonts/README.md"}
    (directory / "truth.json").write_text(json.dumps(truth, indent=2) + "\n", encoding="utf-8")
    return truth

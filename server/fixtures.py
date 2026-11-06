"""Deterministic, newly composed audio fixtures; no recorded song or copyrighted lyrics."""
from __future__ import annotations

import json
import base64
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf

from .config import ROOT, binary


def create_fixture(directory: Path, seconds: float = 10.0) -> tuple[Path, list[dict]]:
    directory.mkdir(parents=True, exist_ok=True)
    sample_rate = 44100
    audio = np.zeros(int(seconds * sample_rate), dtype=np.float32)
    truth = []
    sequence = [60, 64, 67, 72, 71, 67, 65, 64, 62, 60, 67, 72]
    for index, pitch in enumerate(sequence):
        start = 0.5 + index * 0.65
        duration = 0.48
        if start + duration >= seconds:
            break
        t = np.arange(int(sample_rate * duration)) / sample_rate
        frequency = 440 * 2 ** ((pitch - 69) / 12)
        envelope = np.minimum(t / 0.015, 1) * np.minimum((duration - t) / 0.065, 1)
        tone = sum(weight * np.sin(2 * np.pi * frequency * harmonic * t) for harmonic, weight in [(1, 0.8), (2, 0.20), (3, 0.07)])
        begin = int(start * sample_rate)
        audio[begin:begin + len(tone)] += (tone * envelope * 0.48).astype(np.float32)
        truth.append({"start": start, "end": start + duration, "midi": pitch})
    path = directory / "original-melody.wav"
    sf.write(path, np.column_stack([audio, audio]), sample_rate, subtype="PCM_16")
    (directory / "original-melody.truth.json").write_text(json.dumps({"description": "Newly composed deterministic additive-synthesis melody, not a benchmark of real recorded music.", "sampleRate": sample_rate, "duration": seconds, "notes": truth}, indent=2), encoding="utf-8")
    return path, truth


def create_multitrack_fixture(directory: Path, orchestra: bool = False, orchestra_drums: bool = False) -> tuple[Path, list[dict]]:
    """A short original score rendered using licensed, bundled sampled instruments."""
    directory.mkdir(parents=True, exist_ok=True)
    sr = 44100
    tempo = 120
    duration = 10.5
    count = int(duration * sr)
    names = ("violin", "cello", "flute", "drums") if orchestra and orchestra_drums else (("violin", "cello", "flute") if orchestra else ("piano", "bass", "drums"))
    stems = {name: np.zeros(count, dtype=np.float32) for name in names}
    truth = []
    cache = {}
    pitch_names = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]

    def sample(instrument: str, midi: int) -> np.ndarray:
        key = (instrument, midi)
        if key not in cache:
            bank = json.loads((ROOT / "public" / "soundfonts" / f"{instrument}.json").read_text())
            name = pitch_names[midi % 12] + str(midi // 12 - 1)
            encoded = base64.b64decode(bank[name].split(",", 1)[1])
            result = subprocess.run([binary("ffmpeg"), "-v", "error", "-i", "pipe:0", "-f", "f32le", "-ac", "1", "-ar", str(sr), "pipe:1"], input=encoded, capture_output=True, check=True)
            cache[key] = np.frombuffer(result.stdout, dtype="<f4").copy()
        return cache[key]

    def add(name: str, instrument: str, midi: int, start: float, length: float, gain: float):
        source = sample(instrument, midi)
        n = min(len(source), int(sr * length), count - int(sr * start))
        note = source[:n].copy() * gain
        fade = min(n, int(0.06 * sr))
        note[-fade:] *= np.linspace(1, 0, fade)
        offset = int(sr * start)
        stems[name][offset:offset + n] += note
        truth.append({"part": name, "midi": midi, "start": start, "end": start + n / sr})

    if orchestra:
        # Held-out melodic contour, key, articulation and timbre, not the trio's notes.
        flute = [74, 78, 81, 79, 78, 76, 74, 73, 71, 74, 78, 76, 73, 76, 74, 74]
        violin = [66, 69, 71, 69, 67, 66, 64, 66]
        cello = [50, 54, 55, 57]
        for i, pitch in enumerate(flute):
            add("flute", "flute", pitch, 0.6 + i * .5, .43, .5)
        for i, pitch in enumerate(violin):
            add("violin", "violin", pitch, 0.6 + i, .86, .48)
        for i, pitch in enumerate(cello):
            add("cello", "cello", pitch, 0.6 + i * 2, 1.7, .65)
        if orchestra_drums:
            rng = np.random.default_rng(411)
            for beat in range(16):
                start = .6 + beat * .5
                t = np.arange(int(.14 * sr)) / sr
                if beat % 2 == 0:
                    drum = .18 * np.sin(2 * np.pi * (45 * t + 45 * (1 - np.exp(-t * 38)) / 38)) * np.exp(-t * 27)
                    pitch = 36
                else:
                    drum = .07 * rng.normal(0, 1, len(t)) * np.exp(-t * 28)
                    pitch = 38
                offset = int(start * sr)
                stems["drums"][offset:offset + len(t)] += drum
                truth.append({"part": "drums", "midi": pitch, "start": start, "end": start + .14})
        mix = sum(stems.values())
        scale = 0.88 / max(float(np.max(np.abs(mix))), .88)
        for name, y in stems.items():
            sf.write(directory / f"truth-{name}.wav", np.column_stack([y * scale, y * scale]), sr, subtype="PCM_16")
        stem = "heldout-chamber-drums" if orchestra_drums else "heldout-chamber"
        target = directory / f"{stem}.wav"
        sf.write(target, np.column_stack([mix * scale, mix * scale]), sr, subtype="PCM_16")
        (directory / f"{stem}.truth.json").write_text(json.dumps({"description": "Held-out original D-major flute/violin/cello chamber excerpt, optional synthesized percussion. Separate from piano/bass/drum development fixture.", "tempo": tempo, "duration": duration, "notes": truth}, indent=2) + "\n", encoding="utf-8")
        return target, truth

    progression = [(60, 64, 67), (57, 60, 64), (53, 57, 60), (55, 59, 62)]
    melody = [72, 76, 79, 76, 69, 72, 76, 72, 69, 65, 72, 69, 67, 71, 74, 72]
    for bar, chord in enumerate(progression):
        start = 0.5 + bar * 2
        for pitch in chord:
            add("piano", "acoustic_grand_piano", pitch, start, 1.65, 0.38)
        for beat in range(4):
            add("piano", "acoustic_grand_piano", melody[bar * 4 + beat], start + beat * 0.5, 0.38, 0.65)
            add("bass", "acoustic_bass", chord[0] - 24, start + beat * 0.5, 0.38, 0.7)
    rng = np.random.default_rng(732)
    for step in range(32):
        start = 0.5 + step * 0.25
        length = 0.12
        t = np.arange(int(sr * length)) / sr
        hihat = rng.normal(0, 1, len(t))
        hihat -= np.roll(hihat, 1)
        sound = 0.025 * hihat * np.exp(-t * 65)
        pitches = [42]
        if step % 8 in (0, 4):
            sound += 0.40 * np.sin(2 * np.pi * (48 * t + 45 * (1 - np.exp(-t * 35)) / 35)) * np.exp(-t * 30)
            pitches.append(36)
        if step % 8 in (2, 6):
            sound += 0.12 * rng.normal(0, 1, len(t)) * np.exp(-t * 30)
            pitches.append(38)
        offset = int(start * sr)
        stems["drums"][offset:offset + len(sound)] += sound.astype(np.float32)
        for pitch in pitches:
            truth.append({"part": "drums", "midi": pitch, "start": start, "end": start + length})
    mix = sum(stems.values())
    scale = 0.88 / max(float(np.max(np.abs(mix))), 0.88)
    for name, y in stems.items():
        sf.write(directory / f"truth-{name}.wav", np.column_stack([y * scale, y * scale]), sr, subtype="PCM_16")
    target = directory / "original-trio.wav"
    sf.write(target, np.column_stack([mix * scale, mix * scale]), sr, subtype="PCM_16")
    (directory / "original-trio.truth.json").write_text(json.dumps({"description": "Original four-bar sampled piano and acoustic bass with synthesized percussion. Tests source separation mechanics, not commercial-song accuracy.", "tempo": tempo, "duration": duration, "notes": truth}, indent=2) + "\n", encoding="utf-8")
    return target, truth


if __name__ == "__main__":
    import sys
    destination = Path(sys.argv[1] if len(sys.argv) > 1 else "data/fixtures")
    output, notes = create_multitrack_fixture(destination) if "--trio" in sys.argv else create_fixture(destination)
    print(output, len(notes))

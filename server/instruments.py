from __future__ import annotations

import numpy as np

from .config import MODELS_DIR, engine_health


INSTRUMENT_LABELS = {
    "Piano": "钢琴", "Electric piano": "电钢琴", "Guitar": "吉他", "Acoustic guitar": "原声吉他",
    "Electric guitar": "电吉他", "Bass guitar": "贝斯", "Violin, fiddle": "小提琴", "Cello": "大提琴",
    "Double bass": "低音提琴", "Harp": "竖琴", "String section": "弦乐组", "Bowed string instrument": "弓弦乐器",
    "Flute": "长笛", "Clarinet": "单簧管", "Oboe": "双簧管", "Bassoon": "巴松", "Saxophone": "萨克斯",
    "Trumpet": "小号", "Trombone": "长号", "French horn": "圆号", "Brass instrument": "铜管乐器",
    "Wind instrument, woodwind instrument": "木管乐器", "Organ": "管风琴", "Synthesizer": "合成器",
    "Drum kit": "架子鼓", "Drum": "鼓", "Percussion": "打击乐", "Cymbal": "镲", "Snare drum": "军鼓",
    "Singing": "歌声", "Choir": "合唱", "Humming": "哼唱", "Vocal music": "人声音乐",
    "Accordion": "手风琴", "Banjo": "班卓琴", "Ukulele": "尤克里里", "Marimba, xylophone": "马林巴 / 木琴",
    "Glockenspiel": "钟琴", "Timpani": "定音鼓", "Orchestra": "管弦乐合奏",
}


def classify_instruments(y: np.ndarray, sample_rate: int) -> list[dict]:
    if not engine_health()["instrumentClassifier"]["ready"]:
        return []
    import librosa
    import torch
    from transformers import ASTFeatureExtractor, ASTForAudioClassification

    torch.set_num_threads(4)
    model_path = MODELS_DIR / "ast"
    extractor = ASTFeatureExtractor.from_pretrained(str(model_path), local_files_only=True)
    model = ASTForAudioClassification.from_pretrained(str(model_path), local_files_only=True, use_safetensors=True)
    model.eval()
    mono = librosa.resample(y, orig_sr=sample_rate, target_sr=16000)
    window = 16000 * 10
    # Sample up to three windows across the analyzed interval; this is not a whole-song inventory.
    offsets = sorted(set(int(v) for v in np.linspace(0, max(0, len(mono) - window), min(3, max(1, int(np.ceil(len(mono) / window)))))))
    scores = []
    for start in offsets:
        excerpt = mono[start:start + window]
        values = extractor(excerpt, sampling_rate=16000, return_tensors="pt")
        with torch.inference_mode():
            scores.append(model(**values).logits.sigmoid()[0].cpu().numpy())
    mean_scores = np.max(np.stack(scores), axis=0)
    candidates = []
    for index, score in enumerate(mean_scores):
        label = model.config.id2label[index]
        if label in INSTRUMENT_LABELS and score >= 0.045:
            candidates.append({"name": INSTRUMENT_LABELS[label], "confidence": round(float(score), 4), "method": f"AST AudioSet / {label}; sigmoid activation (not calibrated); up to 3 x 10s windows"})
    return sorted(candidates, key=lambda item: item["confidence"], reverse=True)[:10]

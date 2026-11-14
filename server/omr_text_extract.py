"""Text boxes for one page image, run with homr's Python (it ships RapidOCR and pypdfium2).

usage: python omr_text_extract.py <page.png> [<source.pdf> <page-number>]

Prints JSON {"source", "boxes": [{"text", "box": [x0, y0, x1, y1], "conf"}], "crop"} in
page-image pixels. "crop" is homr's own autocrop of the page ([left, top, width,
height]); homr's --write-staff-positions file is relative to that crop. With a vector PDF whose page has a text layer, its own
characters are used; otherwise the page image is read by RapidOCR (PP-OCRv6
small, bundled, offline). Standard library + the two packages only, so it can
run in homr's venv without importing Coro.
"""
from __future__ import annotations

import json
import re
import sys
import unicodedata

CJK = re.compile(r"[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]")
MIN_PDF_CHARS = 5


def pdf_boxes(pdf_path: str, page_number: int, size: tuple[int, int]) -> list[dict]:
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(pdf_path)
    try:
        page = document[page_number - 1]
        width, height = page.get_size()
        textpage = page.get_textpage()
        sx, sy = size[0] / width, size[1] / height
        chars = []
        for index in range(textpage.count_chars()):
            char = unicodedata.normalize("NFKC", textpage.get_text_range(index, 1))
            if not char.strip():
                chars.append(None)
                continue
            left, bottom, right, top = textpage.get_charbox(index)
            chars.append((char, [left * sx, (height - top) * sy, right * sx, (height - bottom) * sy]))
    finally:
        document.close()
    boxes, current = [], None
    # Latin characters on one baseline with a small gap form a word; CJK stays per character.
    for item in chars + [None]:
        if item is not None and current is not None:
            char, (x0, y0, x1, y1) = item
            h = max(1.0, y1 - y0)
            if abs(current["box"][3] - y1) < 0.3 * h and -0.1 * h <= x0 - current["box"][2] < 0.4 * h and not CJK.match(char) and not CJK.match(current["text"][-1]):
                current["text"] += char
                current["box"] = [min(current["box"][0], x0), min(current["box"][1], y0), x1, max(current["box"][3], y1)]
                continue
        if current is not None:
            boxes.append(current)
        current = None if item is None else {"text": item[0], "box": item[1], "conf": 1.0}
    return boxes


def _box(points) -> list[float] | None:
    try:
        xs, ys = [float(p[0]) for p in points], [float(p[1]) for p in points]
    except (TypeError, ValueError, IndexError):
        return None
    return [min(xs), min(ys), max(xs), max(ys)] if xs and ys else None


def ocr_boxes(image_path: str) -> list[dict]:
    """Word boxes from RapidOCR; a line without usable word boxes falls back to its line box.

    RapidOCR sometimes returns an empty word list for a detected line (seen on a real
    SLUB scan, 2026-11-15); that used to crash the whole page.
    """
    import numpy as np
    from PIL import Image
    from rapidocr import RapidOCR

    # Keep RapidOCR's default max_side_len: 4000 crashed on some pages (2026-11-14).
    engine = RapidOCR(params={"Global.log_level": "error"})
    result = engine(np.asarray(Image.open(image_path).convert("RGB")), return_word_box=True)
    return parse_ocr_result(result.boxes, result.txts, result.scores, getattr(result, "word_results", None))


def parse_ocr_result(line_boxes, line_texts, line_scores, word_results) -> list[dict]:
    """Pure parser for RapidOCR output (testable without the model)."""
    lines = list(zip(line_boxes, line_texts or (), line_scores or ())) if line_boxes is not None else []
    words = list(word_results or [])
    boxes = []
    for index, (points, text, score) in enumerate(lines):
        line_words = words[index] if index < len(words) else ()
        added = 0
        for word in line_words or ():
            if not isinstance(word, (list, tuple)) or len(word) != 3:
                continue
            word_text, word_score, word_points = word
            box = _box(word_points)
            if box is None or not str(word_text).strip():
                continue
            boxes.append({"text": str(word_text), "box": box, "conf": float(word_score)})
            added += 1
        if not added:
            box = _box(points)
            if box is not None and str(text).strip():
                boxes.append({"text": str(text), "box": box, "conf": float(score)})
    return boxes


def homr_crop(image_path: str) -> list[int]:
    import cv2
    from homr.autocrop import autocrop_with_offset

    cropped, (left, top) = autocrop_with_offset(cv2.imread(image_path))
    return [int(left), int(top), int(cropped.shape[1]), int(cropped.shape[0])]


def main() -> None:
    from PIL import Image

    if sys.argv[1] == "--crops":
        # homr's own autocrop for each page; its staff files are relative to it.
        print(json.dumps([homr_crop(path) for path in sys.argv[2:]]))
        return
    image = sys.argv[1]
    with Image.open(image) as page:
        size = page.size
    crop = homr_crop(image)
    if len(sys.argv) == 4:
        boxes = pdf_boxes(sys.argv[2], int(sys.argv[3]), size)
        if sum(len(b["text"]) for b in boxes) >= MIN_PDF_CHARS:
            print(json.dumps({"source": "pdf-text", "boxes": boxes, "crop": crop}, ensure_ascii=False))
            return
    print(json.dumps({"source": "rapidocr", "boxes": ocr_boxes(image), "crop": crop}, ensure_ascii=False))


if __name__ == "__main__":
    main()

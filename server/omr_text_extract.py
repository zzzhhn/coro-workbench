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


def ocr_boxes(image_path: str) -> list[dict]:
    import numpy as np
    from PIL import Image
    from rapidocr import RapidOCR

    # Keep RapidOCR's default max_side_len: 4000 crashed on some pages (2026-11-14).
    engine = RapidOCR(params={"Global.log_level": "error"})
    result = engine(np.asarray(Image.open(image_path).convert("RGB")), return_word_box=True)
    boxes = []
    for line in getattr(result, "word_results", None) or []:
        for text, score, points in line:
            xs, ys = [p[0] for p in points], [p[1] for p in points]
            boxes.append({"text": text, "box": [float(min(xs)), float(min(ys)), float(max(xs)), float(max(ys))], "conf": float(score)})
    if not boxes and result.boxes is not None:
        for points, text, score in zip(result.boxes, result.txts, result.scores):
            xs, ys = [p[0] for p in points], [p[1] for p in points]
            boxes.append({"text": text, "box": [float(min(xs)), float(min(ys)), float(max(xs)), float(max(ys))], "conf": float(score)})
    return boxes


def homr_crop(image_path: str) -> list[int]:
    import cv2
    from homr.autocrop import autocrop_with_offset

    cropped, (left, top) = autocrop_with_offset(cv2.imread(image_path))
    return [int(left), int(top), int(cropped.shape[1]), int(cropped.shape[0])]


def main() -> None:
    from PIL import Image

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

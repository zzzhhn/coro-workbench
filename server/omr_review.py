"""OMR review data: where recognized music sits on the original pages.

Interface decision 2026-11-15 (root). Produces `OmrJob.review` and writes the
stable note ids `omr-{page}-{k}` onto each recognized page before pages are merged.
Positions are approximate (homr attention centres). Nothing here is a confidence
score; issues only state facts that can be checked on the page.
"""
from __future__ import annotations

from fractions import Fraction
from pathlib import Path
from xml.etree import ElementTree as ET

from .omr_text import build_groups, interline, note_position, parse_keep_comments, read_staff_positions

MAX_NOTES = 100_000
MAX_ISSUES = 20_000


def _meter(measure: ET.Element, current: Fraction) -> Fraction:
    time = measure.find("attributes/time")
    if time is not None and time.findtext("beats") and time.findtext("beat-type"):
        try:
            return Fraction(int(time.findtext("beats")) * 4, int(time.findtext("beat-type")))
        except (ValueError, ZeroDivisionError):
            return current
    return current


def _staff_coverage(ink, box) -> "object":
    """Per-column share of dark pixels over the staff-line rows of one staff box."""
    import numpy as np

    x0, y0, x1, y1, grand = box
    height = y1 - y0
    if grand:
        # Two staves: test each staff's rows, not the gap between them.
        bands = [(y0 + 0.05 * height, y0 + 0.35 * height), (y0 + 0.65 * height, y0 + 0.95 * height)]
    else:
        bands = [(y0 + 0.1 * height, y1 - 0.1 * height)]
    rows = np.concatenate([np.arange(int(max(0, a)), int(min(ink.shape[0] - 1, b)) + 1) for a, b in bands])
    coverage = ink[rows].mean(axis=0) if rows.size else np.zeros(ink.shape[1])
    # Thin barlines are 1-3 px wide; take the best of a 3-px window.
    return np.maximum.reduce([np.roll(coverage, -1), coverage, np.roll(coverage, 1)])


def _barline_columns(ink, system_boxes) -> list[int]:
    """Columns dark across the staff lines of most staves of a system.

    A barline crosses every staff of a system at the same x; a stem or a slur does
    not. Single-staff systems fall back to the one staff.
    """
    import numpy as np

    covers = [_staff_coverage(ink, box) >= 0.9 for box in system_boxes]
    if not covers:
        return []
    needed = 1 if len(covers) == 1 else max(2, -(-2 * len(covers) // 3))
    votes = np.sum(covers, axis=0)
    left = int(min(box[0] for box in system_boxes)) - 3
    right = int(max(box[2] for box in system_boxes)) + 3
    return [int(c) for c in np.flatnonzero(votes >= needed) if left <= c <= right]


def _snap_barline(columns: list[int] | None, x: float, reach: float) -> tuple[float, str]:
    """Nearest barline column within reach of the estimate, else the estimate itself."""
    near = [c for c in columns or [] if abs(c - x) <= reach]
    if not near:
        return x, "estimated"
    return float(min(near, key=lambda c: abs(c - x))), "barline"


def label_page(xml: str, page: int) -> tuple[str, int]:
    """Write id="omr-{page}-{k}" on every <note> in document order; keep homr's comments."""
    root = parse_keep_comments(xml)
    count = 0
    for note in root.iter("note"):
        note.set("id", f"omr-{page}-{count}")
        count += 1
    return ET.tostring(root, encoding="unicode"), count


def page_review(xml: str, page: int, staves_text: str, size: tuple[int, int], crop: tuple[int, int, int, int] | None,
                image_path: Path | None, first_measure: int) -> dict:
    """Review data for one recognized page; `xml` must already carry note ids."""
    root = parse_keep_comments(xml)
    width, height = size
    staves = read_staff_positions(staves_text, width, height, crop=crop) if staves_text else []
    groups, _ = build_groups(root, staves) if staves else (None, "")
    groups = groups or []
    space = interline(staves) if staves else 10.0
    ink = None
    if image_path is not None:
        try:
            import numpy as np
            from PIL import Image

            with Image.open(image_path) as image:
                ink = np.asarray(image.convert("L")) < 128
        except Exception:  # noqa: BLE001 - geometry still works without barline snapping
            ink = None
    group_of = {}
    for group in groups:
        for x, y, measure, note, staff in group.notes:
            group_of[id(note)] = group
    notes, issues = [], []
    by_group: dict[tuple[int, int], dict[int, list[float]]] = {}
    parts = root.findall("part")
    measure_count = max((len(part.findall("measure")) for part in parts), default=0)
    for part_index, part in enumerate(parts):
        divisions, meter = 1, Fraction(4)
        for index, measure in enumerate(part.findall("measure")):
            number = first_measure + index
            text = measure.findtext("attributes/divisions")
            if text and text.strip().isdigit() and int(text) > 0:
                divisions = int(text)
            meter = _meter(measure, meter)
            cursor = last = extent = Fraction(0)
            for element in measure:
                if element.tag == "backup":
                    cursor -= Fraction(int(element.findtext("duration") or 0), divisions)
                elif element.tag == "forward":
                    cursor += Fraction(int(element.findtext("duration") or 0), divisions)
                    extent = max(extent, cursor)
                elif element.tag == "note":
                    duration = Fraction(int(element.findtext("duration") or 0), divisions)
                    chord = element.find("chord") is not None
                    grace = element.find("grace") is not None
                    onset = last if chord else cursor
                    position = note_position(element)
                    staff = int((element.findtext("staff") or "1").strip() or 1)
                    ref = element.get("id") or ""
                    notes.append({"ref": ref, "partIndex": part_index, "measure": number, "onsetBeats": float(onset), "staff": staff,
                                  "page": page, "point": [round(position[0]), round(position[1])] if position else None, "precision": "approximate"})
                    group = group_of.get(id(element))
                    if position and group is not None:
                        by_group.setdefault((part_index, group.system), {}).setdefault(number, []).append(position[0])
                    if not position:
                        issues.append({"kind": "no-anchor", "severity": "check", "page": page, "partIndex": part_index, "measure": number, "noteRef": ref,
                                       "message": "识谱引擎没有给出这个音在原图上的位置。"})
                    if not chord and not grace:
                        last = cursor
                        cursor += duration
                        extent = max(extent, cursor)
            if extent != meter and (extent > 0 or measure.find("note") is not None):
                over = extent > meter
                issues.append({"kind": "measure-overfull" if over else "measure-underfull", "severity": "check", "page": page, "partIndex": part_index, "measure": number,
                               "message": (f"第 {number} 小节读出 {float(extent):g} 拍，拍号要求 {float(meter):g} 拍；可能多读了音或时值读错。" if over else
                                           f"第 {number} 小节读出 {float(extent):g} 拍，拍号要求 {float(meter):g} 拍；可能是弱起或反复处的分割小节，也可能漏读了音符或休止。")})
    measures = []
    system_columns: dict[int, list[int]] = {}
    if ink is not None:
        for system in {g.system for g in groups}:
            boxes = [(g.staff.x0, g.staff.y0, g.staff.x1, g.staff.y1, g.staff.grand) for g in groups if g.system == system]
            system_columns[system] = _barline_columns(ink, boxes)
    for (part_index, system), columns in by_group.items():
        group = next(g for g in groups if g.part_index == part_index and g.system == system)
        bars = system_columns.get(system)
        order = sorted(columns)
        for position, number in enumerate(order):
            left, left_edge = group.staff.x0, "estimated"
            right, right_edge = group.staff.x1, "estimated"
            if position > 0:
                # Whole-bar rests leave the estimate far from the barline, so allow
                # up to half the gap between the neighbouring anchors.
                gap = min(columns[number]) - max(columns[order[position - 1]])
                left, left_edge = _snap_barline(bars, (max(columns[order[position - 1]]) + min(columns[number])) / 2, max(2.5 * space, 0.5 * gap))
            if position < len(order) - 1:
                gap = min(columns[order[position + 1]]) - max(columns[number])
                right, right_edge = _snap_barline(bars, (max(columns[number]) + min(columns[order[position + 1]])) / 2, max(2.5 * space, 0.5 * gap))
            measures.append({"partIndex": part_index, "measure": number, "page": page, "system": system,
                             "box": [round(left), round(group.staff.y0), round(max(left, right)), round(group.staff.y1)], "edges": [left_edge, right_edge]})
    for issue in issues:
        box = next((m["box"] for m in measures if m["partIndex"] == issue.get("partIndex") and m["measure"] == issue.get("measure")), None)
        if box and issue["kind"] != "no-anchor":
            issue["box"] = box
    return {
        "page": {"page": page, "width": width, "height": height, "firstMeasure": first_measure, "measureCount": measure_count},
        "staves": [{"page": page, "system": g.system, "partIndex": g.part_index, "box": [round(g.staff.x0), round(g.staff.y0), round(g.staff.x1), round(g.staff.y1)], "grand": g.staff.grand} for g in groups],
        "measures": sorted(measures, key=lambda m: (m["partIndex"], m["measure"])),
        "notes": notes,
        "issues": issues,
    }


def text_issues(text_evidence: dict, page: int) -> list[dict]:
    """Structured issues from the text layer's per-page evidence (only when the layer ran)."""
    out = []
    for box in text_evidence.get("boxes", []):
        coordinates = [round(v) for v in box.get("box", [])] if len(box.get("box", [])) == 4 else None
        if box.get("kind") == "discarded":
            out.append({"kind": "text-discarded", "severity": "check", "page": page, "box": coordinates,
                        "message": f"文字“{box.get('text', '')[:40]}”未贴到乐谱：{box.get('reason', '')}", "evidence": box.get("text", "")[:200]})
        elif box.get("kind") in ("lyric", "chord", "section", "part-name") and box.get("attached"):
            out.append({"kind": "text-attached", "severity": "info", "page": page, "box": coordinates,
                        "message": f"文字“{box.get('text', '')[:40]}”作为{ {'lyric': '歌词', 'chord': '和弦', 'section': '段落记号', 'part-name': '声部名'}[box['kind']] }贴入。",
                        "evidence": box.get("text", "")[:200]})
    return [{k: v for k, v in issue.items() if v is not None} for issue in out]


def assemble(pages: list[dict], engine: str, extra_issues: list[dict]) -> dict:
    review = {"version": 1, "engine": engine, "pages": [], "staves": [], "measures": [], "notes": [], "issues": []}
    for item in pages:
        review["pages"].append(item["page"])
        for key in ("staves", "measures", "notes", "issues"):
            review[key].extend(item[key])
    review["issues"].extend(extra_issues)
    if len(review["notes"]) > MAX_NOTES:
        review["notes"] = review["notes"][:MAX_NOTES]
    if len(review["issues"]) > MAX_ISSUES:
        review["issues"] = review["issues"][:MAX_ISSUES]
    return review

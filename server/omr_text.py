"""Text and structure layer for homr MusicXML (PROTOCOL-text v1).

Adds lyrics, chord symbols, part names and section words next to homr's notes.
Never changes a note's pitch, duration, voice, staff or order: it only appends
<lyric>, <harmony>, <direction> elements and rewrites <part-name>. Every text
box ends up in the evidence list, either attached or with a discard reason.

Geometry comes from homr itself: staff boxes from --write-staff-positions,
note anchors from the `imgpos` comments and system breaks from new-system.
Text boxes come from a PDF text layer or a local OCR engine.
"""
from __future__ import annotations

import copy
import re
import statistics
import unicodedata
from dataclasses import dataclass, field
from xml.etree import ElementTree as ET

DYNAMICS = re.compile(r"^(p{1,4}|f{1,4}|mp|mf|sfz?|sf|fp|rfz?|cresc\.?|dim\.?|decresc\.?|rit\.?|ritard\.?|rall\.?|a tempo|accel\.?|tr)$", re.I)
# Performance terms printed in the lyric zone of instrumental or song pages.
TERMS = re.compile(
    r"^(pizz|arco|molto|poco|più|piu|meno|lento|tempo|dolce|espress|espressivo|legato|stacc|staccato|tenuto|sost|sostenuto|"
    r"sempre|simile|div|unis|sffz|sfp|morendo|smorz|calando|string|stringendo|allarg|allargando|cresc|dim|rit|rall|accel)\.?$",
    re.I,
)
CHORD = re.compile(
    r"^(N\.?C\.?|[A-G][#b]?(m|min|maj|M|dim|aug|sus2|sus4|sus|°|ø|\+)?\d{0,2}(\(?[#b]?\d{1,2}\)?)*(/[A-G][#b]?)?)$"
)
SECTION = re.compile(r"^(Intro|Verse|Chorus|Bridge|Outro|Pre-?Chorus|Interlude|Coda|Fine|D\.C\.|D\.S\.|前奏|主歌|副歌|间奏|尾奏|桥段)", re.I)
CJK = re.compile(r"[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]")
IMGPOS = re.compile(r"imgpos:\s*(-?\d+),\s*(-?\d+)")


@dataclass
class TextBox:
    text: str
    box: tuple[float, float, float, float]
    conf: float = 1.0
    source: str = "ocr"

    @property
    def cx(self) -> float:
        return (self.box[0] + self.box[2]) / 2

    @property
    def cy(self) -> float:
        return (self.box[1] + self.box[3]) / 2


@dataclass
class StaffBox:
    x0: float
    y0: float
    x1: float
    y1: float
    grand: bool


@dataclass
class Group:
    """One part's staff (or grand staff) inside one system."""
    part_index: int
    system: int
    staff: StaffBox
    notes: list = field(default_factory=list)  # (x, y, measure_index, note_element, staff_number)


def normalize(text: str) -> str:
    return unicodedata.normalize("NFKC", text).strip()


def chord_text(text: str) -> str:
    return normalize(text).replace("♭", "b").replace("♯", "#").replace("&", "b").replace(" ", "")


def read_staff_positions(text: str, width: int, height: int, crop: tuple[int, int, int, int] | None = None) -> list[StaffBox]:
    """homr's staff file is normalized to its autocropped page; map it back with crop=(left, top, w, h)."""
    left, top, width, height = crop if crop else (0, 0, width, height)
    staves = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) != 5:
            continue
        kind, cx, cy, w, h = parts[0], *map(float, parts[1:])
        staves.append(StaffBox(left + (cx - w / 2) * width, top + (cy - h / 2) * height, left + (cx + w / 2) * width, top + (cy + h / 2) * height, kind != "0"))
    return sorted(staves, key=lambda s: s.y0)


def interline(staves: list[StaffBox]) -> float:
    single = [s.y1 - s.y0 for s in staves if not s.grand]
    if single:
        return statistics.median(single) / 4
    return statistics.median(s.y1 - s.y0 for s in staves) / 12


def _systems(root: ET.Element) -> tuple[list[int], int]:
    """Measure index -> system index, from the first part's new-system prints."""
    first = root.find("part")
    systems, current = [], 0
    for index, measure in enumerate(first.findall("measure")):
        printed = measure.find("print")
        if index and printed is not None and printed.get("new-system") == "yes":
            current += 1
        systems.append(current)
    return systems, current + 1


def note_position(note: ET.Element) -> tuple[float, float] | None:
    for child in note.iter():
        if child.tag is ET.Comment:
            hit = IMGPOS.search(child.text or "")
            if hit:
                return float(hit.group(1)), float(hit.group(2))
    return None


def build_groups(root: ET.Element, staves: list[StaffBox]) -> tuple[list[Group] | None, str]:
    """(system, part) groups, each tied to the staff box that holds most of its notes.

    Counting boxes per system fails on real songs whose first system is a piano
    intro without the voice staff, so homr's own note positions decide.
    """
    parts = root.findall("part")
    if not parts or not staves:
        return None, "没有声部或谱表坐标"
    measure_system, system_count = _systems(root)
    notes: dict[tuple[int, int], list] = {}
    for p, part in enumerate(parts):
        for m, measure in enumerate(part.findall("measure")):
            system = measure_system[m] if m < len(measure_system) else measure_system[-1]
            for note in measure.findall("note"):
                position = note_position(note)
                if position is None:
                    continue
                staff_number = int((note.findtext("staff") or "1").strip() or 1)
                notes.setdefault((system, p), []).append((position[0], position[1], m, note, staff_number))
    votes = []
    for key, items in notes.items():
        for index, staff in enumerate(staves):
            pad = (staff.y1 - staff.y0) * 0.25
            count = sum(1 for x, y, *_ in items if staff.x0 <= x <= staff.x1 and staff.y0 - pad <= y <= staff.y1 + pad)
            if count:
                votes.append((count, key, index))
    groups, used_keys, used_staves = [], set(), set()
    for count, key, index in sorted(votes, key=lambda v: -v[0]):
        if key in used_keys or index in used_staves:
            continue
        used_keys.add(key)
        used_staves.add(index)
        groups.append(Group(part_index=key[1], system=key[0], staff=staves[index], notes=notes[key]))
    if not groups:
        return None, "homr 音符坐标没有落在任何谱表框内"
    return groups, ""


def _zones(groups: list[Group], space: float) -> list[tuple[str, Group, tuple[float, float, float, float]]]:
    """(kind, group, rectangle) for the below / above / left text zones."""
    zones = []
    by_system: dict[int, list[Group]] = {}
    for group in groups:
        by_system.setdefault(group.system, []).append(group)
    system_ids = sorted(by_system)
    for s_index, system in enumerate(system_ids):
        ordered = sorted(by_system[system], key=lambda g: g.staff.y0)
        next_top = min(g.staff.y0 for g in by_system[system_ids[s_index + 1]]) if s_index + 1 < len(system_ids) else None
        previous_bottom = max(g.staff.y1 for g in by_system[system_ids[s_index - 1]]) if s_index else None
        for i, group in enumerate(ordered):
            st = group.staff
            left, right = st.x0 - 2 * space, st.x1 + 2 * space
            # The whole gap to the next staff (same or next system) is shared: chord and
            # section text there belongs to the staff below, everything else is a lyric
            # of the staff above. Only the last system gets a fixed 8-space margin.
            if i + 1 < len(ordered):
                below_bottom = ordered[i + 1].staff.y0
            elif next_top is not None:
                below_bottom = next_top
            else:
                below_bottom = st.y1 + 8 * space
            zones.append(("below", group, (left, st.y1, right, below_bottom)))
            if i == 0:
                above_top = st.y0 - 6 * space
                if previous_bottom is not None:
                    above_top = max(above_top, previous_bottom)
            else:
                above_top = ordered[i - 1].staff.y1
            zones.append(("above", group, (left, above_top, right, st.y0)))
            zones.append(("left", group, (0, st.y0 - space, st.x0, st.y1 + space)))
    return zones


def classify(boxes: list[TextBox], groups: list[Group], space: float) -> list[dict]:
    zones = _zones(groups, space)
    result = []
    for box in boxes:
        text = normalize(box.text)
        if not text:
            continue
        item = {"text": text, "box": [round(v, 1) for v in box.box], "conf": round(box.conf, 3), "source": box.source}
        if any(g.staff.x0 <= box.cx <= g.staff.x1 and g.staff.y0 <= box.cy <= g.staff.y1 for g in groups):
            result.append({**item, "kind": "discarded", "reason": "inside staff"})
            continue
        candidates = [
            (kind, group)
            for kind, group, (x0, y0, x1, y1) in zones
            if (box.box[2] <= x1 if kind == "left" else x0 <= box.cx <= x1) and y0 <= box.cy <= y1
        ]
        kinds = {kind for kind, _ in candidates}
        chordish = bool(CHORD.match(chord_text(text)))
        sectionish = bool(SECTION.match(text))
        pick = lambda wanted: next(g for k, g in candidates if k == wanted)  # noqa: E731
        if "left" in kinds:
            kind, group = "part-name", pick("left")
        elif "above" in kinds and (chordish or sectionish):
            kind, group = ("chord" if chordish else "section"), pick("above")
        elif "below" in kinds:
            if re.fullmatch(r"[-–—_]+", text):
                kind, group = "lyric", pick("below")
                result.append({**item, "kind": kind, "_group": group, "_box": box, "_attached": [{"hyphen": True}]})
                continue
            if DYNAMICS.match(text) or re.fullmatch(r"[\d\s.,:;()]+", text):
                result.append({**item, "kind": "discarded", "reason": "dynamic or number below staff"})
                continue
            if chordish:
                result.append({**item, "kind": "discarded", "reason": "chord text below staff is not sung"})
                continue
            kind, group = "lyric", pick("below")
        elif "above" in kinds:
            result.append({**item, "kind": "discarded", "reason": "text above staff that is neither chord nor section"})
            continue
        else:
            result.append({**item, "kind": "discarded", "reason": "outside every staff zone"})
            continue
        result.append({**item, "kind": kind, "_group": group, "_box": box})
    return result


def syllables_of(box: TextBox) -> list[tuple[str, float, str]]:
    """(text, x, syllabic) for each sung syllable inside one text box."""
    text = normalize(box.text)
    x0, x1 = box.box[0], box.box[2]
    total = len(text)
    out = []
    for match in re.finditer(r"\S+", text):
        word = match.group(0)
        if CJK.search(word):
            for offset, char in enumerate(word):
                if CJK.match(char):
                    out.append((char, x0 + (match.start() + offset + 0.5) / total * (x1 - x0), "single"))
            continue
        pieces = [p for p in re.finditer(r"[^-–—_]+", word) if re.search(r"\w", p.group(0))]
        for n, piece in enumerate(pieces):
            centre = match.start() + piece.start() + len(piece.group(0)) / 2
            syllabic = "single" if len(pieces) == 1 else "begin" if n == 0 else "end" if n == len(pieces) - 1 else "middle"
            cleaned = piece.group(0).strip(",.;:!?\"'")
            if cleaned:
                out.append((cleaned, x0 + centre / total * (x1 - x0), syllabic))
    return out


def singable(group: Group) -> list[tuple[float, int, ET.Element]]:
    notes = []
    for x, _, m, note, staff in sorted(group.notes, key=lambda n: (n[2], n[0])):
        if staff != 1 or note.find("pitch") is None or note.find("chord") is not None:
            continue
        if any(t.get("type") == "stop" for t in note.findall("tie")):
            continue
        notes.append((x, m, note))
    return notes


def align(syllables: list, notes: list, space: float) -> list[tuple[int, int]]:
    """Monotone alignment of syllables to notes by x; skipping a syllable costs 3 spaces."""
    skip = 3.0
    n, k = len(syllables), len(notes)
    cost = [[0.0] * (k + 1) for _ in range(n + 1)]
    back = [[""] * (k + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        cost[i][0] = cost[i - 1][0] + skip
        back[i][0] = "s"
    for i in range(1, n + 1):
        for j in range(1, k + 1):
            options = (
                (cost[i - 1][j - 1] + abs(syllables[i - 1][1] - notes[j - 1][0]) / space, "m"),
                (cost[i][j - 1], "n"),
                (cost[i - 1][j] + skip, "s"),
            )
            cost[i][j], back[i][j] = min(options)
    pairs, i, j = [], n, k
    while i > 0:
        step = back[i][j]
        if step == "m":
            pairs.append((i - 1, j - 1))
            i, j = i - 1, j - 1
        elif step == "n":
            j -= 1
        else:
            i -= 1
    return pairs[::-1]


def lines_of(items: list[dict], space: float) -> list[list[dict]]:
    rows: list[list[dict]] = []
    for item in sorted(items, key=lambda it: it["_box"].cy):
        if rows and abs(item["_box"].cy - statistics.mean(r["_box"].cy for r in rows[-1])) < 1.2 * space:
            rows[-1].append(item)
        else:
            rows.append([item])
    return [sorted(row, key=lambda it: it["_box"].box[0]) for row in rows]




CHORD_KIND = [
    ("m7b5", "half-diminished"), ("ø", "half-diminished"), ("dim7", "diminished-seventh"), ("maj7", "major-seventh"),
    ("M7", "major-seventh"), ("min7", "minor-seventh"), ("m7", "minor-seventh"), ("m6", "minor-sixth"), ("dim", "diminished"),
    ("°", "diminished"), ("aug", "augmented"), ("+", "augmented"), ("sus2", "suspended-second"), ("sus4", "suspended-fourth"),
    ("sus", "suspended-fourth"), ("min", "minor"), ("maj", "major"), ("m", "minor"), ("9", "dominant-ninth"), ("7", "dominant"),
    ("6", "major-sixth"),
]


def harmony_element(symbol: str) -> ET.Element | None:
    text = chord_text(symbol)
    harmony = ET.Element("harmony")
    if re.match(r"^N\.?C\.?$", text):
        ET.SubElement(harmony, "kind", text="N.C.").text = "none"
        return harmony
    match = re.match(r"^([A-G])([#b]?)(.*?)(?:/([A-G])([#b]?))?$", text)
    if not match:
        return None
    step, accidental, suffix, bass, bass_accidental = match.groups()
    root = ET.SubElement(harmony, "root")
    ET.SubElement(root, "root-step").text = step
    if accidental:
        ET.SubElement(root, "root-alter").text = "1" if accidental == "#" else "-1"
    kind = next((name for prefix, name in CHORD_KIND if suffix.startswith(prefix)), "major")
    ET.SubElement(harmony, "kind", text=suffix).text = kind
    if bass:
        bass_node = ET.SubElement(harmony, "bass")
        ET.SubElement(bass_node, "bass-step").text = bass
        if bass_accidental:
            ET.SubElement(bass_node, "bass-alter").text = "1" if bass_accidental == "#" else "-1"
    return harmony


def parse_keep_comments(xml: str) -> ET.Element:
    # homr writes note positions as comments; the default parser drops them.
    return ET.fromstring(xml, parser=ET.XMLParser(target=ET.TreeBuilder(insert_comments=True)))


def join_hyphens(syllables: list, hyphens: list[float]) -> list:
    """OCR often returns a sung hyphen as its own box; join the syllables on both sides."""
    out = [list(s) for s in syllables]
    for i in range(len(out) - 1):
        if any(out[i][1] < x < out[i + 1][1] for x in hyphens):
            out[i][2] = "begin" if out[i][2] in ("single", "begin") else "middle"
            out[i + 1][2] = "end" if out[i + 1][2] in ("single", "end") else "middle"
    return [tuple(s) for s in out]


def apply_text_layer(xml: str, staves_text: str, size: tuple[int, int], boxes: list[TextBox], crop: tuple[int, int, int, int] | None = None) -> tuple[str, dict]:
    """Return (new MusicXML, evidence). Notes are only ever appended to, never edited."""
    root = parse_keep_comments(xml)
    staves = read_staff_positions(staves_text, *size, crop=crop)
    evidence: dict = {"applied": False, "lyrics": 0, "chords": 0, "sections": 0, "partNames": {}, "boxes": []}
    if not staves:
        evidence["skipped"] = "没有谱表坐标"
        return xml, evidence
    groups, reason = build_groups(root, staves)
    if groups is None:
        evidence["skipped"] = reason
        return xml, evidence
    space = interline(staves)
    classified = classify(boxes, groups, space)
    parts = root.findall("part")
    measures = [part.findall("measure") for part in parts]

    by_group: dict[int, list[dict]] = {}
    for item in classified:
        if item.get("kind") == "lyric":
            by_group.setdefault(id(item["_group"]), []).append(item)
    group_by_id = {id(g): g for g in groups}
    for gid, items in by_group.items():
        notes = singable(group_by_id[gid])
        # Verse packing: engravers drop single syllables below low notes, so a row is
        # not a verse. Each row joins the lowest verse it does not overlap in x; a real
        # second verse sits under the same notes as the first and so overlaps it.
        # (A page-wide distance rule was rejected: photo perspective moves a verse.)
        verse_xs: list[list[float]] = []
        for row in lines_of(items, space):
            words = [w for item in row for w in re.split(r"\s+", item["text"]) if w and not re.fullmatch(r"[-–—_]+", w)]
            if words and sum(bool(TERMS.match(w) or DYNAMICS.match(w)) for w in words) * 2 >= len(words):
                for item in row:
                    item["kind"], item["reason"] = "discarded", "performance terms, not sung text"
                continue
            syllables = [(text, x, syllabic, item) for item in row for text, x, syllabic in syllables_of(item["_box"])]
            xs = [x for _, x, _, _ in syllables]
            verse = next((v for v, taken in enumerate(verse_xs, 1) if all(abs(a - b) > 0.5 * space for a in xs for b in taken)), None)
            if verse is None:
                verse_xs.append([])
                verse = len(verse_xs)
            verse_xs[verse - 1].extend(xs)
            syllables = join_hyphens(syllables, [it["_box"].cx for it in row if re.fullmatch(r"[-–—_]+", it["text"])])
            for s_index, n_index in align(syllables, notes, space):
                text, _, syllabic, item = syllables[s_index]
                lyric = ET.SubElement(notes[n_index][2], "lyric", number=str(verse))
                ET.SubElement(lyric, "syllabic").text = syllabic
                ET.SubElement(lyric, "text").text = text
                evidence["lyrics"] += 1
                item.setdefault("_attached", []).append({"syllable": text, "measure": notes[n_index][1] + 1, "verse": verse})

    for item in classified:
        if item.get("kind") not in ("chord", "section"):
            continue
        group = item["_group"]
        if not group.notes:
            item["kind"], item["reason"] = "discarded", "no note anchor in this staff"
            continue
        _, _, m, note, _ = min(group.notes, key=lambda n: abs(n[0] - item["_box"].cx))
        measure = measures[group.part_index][m]
        children = list(measure)
        position = children.index(note)
        # A chord member shares its onset with the note before it.
        while position > 0 and children[position].find("chord") is not None:
            position -= 1
        if item["kind"] == "chord":
            element = harmony_element(item["text"])
            if element is None:
                item["kind"], item["reason"] = "discarded", "chord text not parseable"
                continue
            evidence["chords"] += 1
        else:
            element = ET.Element("direction", placement="above")
            ET.SubElement(ET.SubElement(element, "direction-type"), "words").text = item["text"]
            evidence["sections"] += 1
        measure.insert(position, element)
        item["_attached"] = [{"measure": m + 1}]

    # A name is all left-margin boxes of one staff group in one system, joined by x;
    # then the most frequent name across systems wins.
    per_group: dict[int, list[dict]] = {}
    for item in classified:
        if item.get("kind") == "part-name" and not re.fullmatch(r"[\d\s.]+", item["text"]):
            per_group.setdefault(id(item["_group"]), []).append(item)
            item["_attached"] = [{"partName": True}]
    names: dict[int, list[str]] = {}
    for gid, items in per_group.items():
        text = ""
        for item in sorted(items, key=lambda it: it["_box"].box[0]):
            joiner = "" if not text or CJK.search(text[-1]) or CJK.search(item["text"][0]) else " "
            text += joiner + item["text"]
        names.setdefault(group_by_id[gid].part_index, []).append(text)
    score_parts = root.findall("part-list/score-part")
    for index, values in names.items():
        best = max(values, key=lambda v: (values.count(v), -values.index(v)))
        if index < len(score_parts) and score_parts[index].find("part-name") is not None:
            score_parts[index].find("part-name").text = best
            evidence["partNames"][parts[index].get("id")] = best

    for item in classified:
        public = {k: v for k, v in item.items() if not k.startswith("_")}
        if "_attached" in item:
            public["attached"] = item["_attached"]
        elif item.get("kind") == "lyric":
            public["kind"], public["reason"] = "discarded", "no singable note aligned"
        evidence["boxes"].append(public)
    evidence["applied"] = True
    evidence["interline"] = round(space, 2)
    return ET.tostring(root, encoding="unicode"), evidence


def note_signature(xml: str) -> list[tuple]:
    """Everything the text layer must not change, for a before/after check."""
    root = parse_keep_comments(xml)
    out = []
    for p, part in enumerate(root.findall("part")):
        for m, measure in enumerate(part.findall("measure")):
            for note in measure.findall("note"):
                clone = copy.deepcopy(note)
                for lyric in clone.findall("lyric"):
                    clone.remove(lyric)
                out.append((p, m, ET.tostring(clone)))
    return out


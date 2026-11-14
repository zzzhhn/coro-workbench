"""Text layer rules (PROTOCOL-text v6) on hand-made geometry; no OCR or homr run."""
from xml.etree import ElementTree as ET

from server.omr_text import TextBox, apply_text_layer, harmony_element, note_signature


def note(step, x, y=110, duration=1, chord=False, rest=False):
    pitch = "<rest/>" if rest else f"<pitch><step>{step}</step><octave>4</octave></pitch>"
    return f"<note>{'<chord/>' if chord else ''}{pitch}<duration>{duration}</duration><voice>1</voice><staff>1</staff><!-- imgpos: {x}, {y} --></note>"


def score(measures):
    body = "".join(f'<measure number="{i + 1}">{"<attributes><divisions>1</divisions></attributes>" if i == 0 else ""}{m}</measure>' for i, m in enumerate(measures))
    return f'<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list><part id="P1">{body}</part></score-partwise>'


# One staff from y=100 to 120 (interline 5), x 100..900, page 1000 x 1000.
STAFF = "0 0.5 0.11 0.8 0.02\n"
XML = score([note("C", 200) + note("D", 300) + note("E", 400) + note("F", 500), note("G", 600) + note("A", 700) + note("B", 800) + note("C", 850)])


def lyrics(xml):
    root = ET.fromstring(xml)
    return [(n.find("pitch/step").text, ly.get("number"), ly.findtext("syllabic"), ly.findtext("text")) for n in root.iter("note") for ly in n.findall("lyric")]


def test_lyrics_attach_by_x_with_hyphenation_and_notes_unchanged():
    boxes = [TextBox("Hel-lo", (170, 125, 330, 133)), TextBox("world", (390, 125, 410, 133))]
    new, evidence = apply_text_layer(XML, STAFF, (1000, 1000), boxes)
    assert lyrics(new) == [("C", "1", "begin", "Hel"), ("D", "1", "end", "lo"), ("E", "1", "single", "world")]
    assert note_signature(XML) == note_signature(new)
    assert evidence["applied"] and evidence["lyrics"] == 3


def test_second_verse_needs_overlap_and_a_dropped_syllable_stays_in_verse_one():
    boxes = [
        TextBox("one", (190, 125, 210, 132)), TextBox("two", (290, 125, 310, 132)),
        TextBox("three", (390, 134, 410, 141)),  # printed lower, but under a note no verse-1 syllable uses
        TextBox("uno", (190, 143, 210, 150)), TextBox("dos", (290, 143, 310, 150)),
    ]
    new, _ = apply_text_layer(XML, STAFF, (1000, 1000), boxes)
    got = lyrics(new)
    assert ("E", "1", "single", "three") in got
    assert ("C", "2", "single", "uno") in got and ("D", "2", "single", "dos") in got


def test_chords_go_above_and_performance_terms_and_chord_text_below_are_not_lyrics():
    boxes = [TextBox("Bb7", (590, 90, 610, 97)), TextBox("N.C.", (190, 125, 210, 132)), TextBox("a tempo", (380, 125, 420, 132)), TextBox("pizz.", (690, 125, 710, 132))]
    new, evidence = apply_text_layer(XML, STAFF, (1000, 1000), boxes)
    assert lyrics(new) == []
    harmony = ET.fromstring(new).findall("part/measure")[1].find("harmony")
    assert harmony.findtext("root/root-step") == "B" and harmony.findtext("root/root-alter") == "-1" and harmony.findtext("kind") == "dominant"
    reasons = {b["text"]: b.get("reason") for b in evidence["boxes"]}
    assert reasons["N.C."] == "chord text below staff is not sung"
    assert reasons["pizz."] == "performance terms, not sung text"


def test_part_name_from_left_margin_and_cjk_split_per_character():
    boxes = [TextBox("人", (40, 104, 55, 116)), TextBox("声", (56, 104, 71, 116)), TextBox("你沉默", (150, 125, 450, 133))]
    new, evidence = apply_text_layer(XML, STAFF, (1000, 1000), boxes)
    assert ET.fromstring(new).findtext("part-list/score-part/part-name") == "人声"
    assert ET.fromstring(new).findtext("part-list/score-part/part-abbreviation") == "人声"
    assert [t for *_, t in lyrics(new)] == ["你", "沉", "默"]


def test_staff_file_is_mapped_back_from_homr_autocrop():
    # Same staff, but homr wrote it relative to a crop at (100, 50) of size 800 x 900.
    cropped = "0 0.5 0.0555556 1.0 0.0222222\n"
    new, evidence = apply_text_layer(XML, cropped, (1000, 1000), [TextBox("la", (190, 125, 210, 132))], crop=(100, 50, 800, 900))
    assert evidence["applied"] and lyrics(new) == [("C", "1", "single", "la")]


def test_groups_follow_note_positions_not_staff_counts():
    # A piano-only intro system above: an extra staff box with no Voice notes in it.
    staves = "0 0.5 0.05 0.8 0.02\n" + STAFF
    new, evidence = apply_text_layer(XML, staves, (1000, 1000), [TextBox("la", (190, 125, 210, 132))])
    assert evidence["applied"] and lyrics(new) == [("C", "1", "single", "la")]


def test_harmony_parsing_slash_and_minor_seventh():
    element = harmony_element("F#m7/C#")
    assert element.findtext("root/root-step") == "F" and element.findtext("kind") == "minor-seventh"
    assert element.findtext("bass/bass-step") == "C" and element.findtext("bass/bass-alter") == "1"
    assert harmony_element("N.C.").findtext("kind") == "none"

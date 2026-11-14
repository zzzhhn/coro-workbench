# OMR review fixtures (public)

Small, redistributable fixtures for the OMR review data (`OmrJob.review` →
`project.source.omrReview`). No private scores.

Each folder has:

- `page-001.png` — the page image homr read (pixel coordinates in `review.json` refer to it).
- `homr.musicxml` — homr's MusicXML for that page (homr 72fdfa8), with the server's stable
  note ids `id="omr-{page}-{k}"` added in document order. Notes are otherwise as recognized.
- `review.json` — the review data: page size, staff boxes, measure boxes (edges marked
  `barline` when a full-height ink column was found near the estimate, else `estimated`),
  approximate note anchors (homr's attention centres, not glyph boxes) and review issues.
  No confidence scores.

## twinkle

*Twinkle, Twinkle, Little Star*: traditional melody, words by Jane Taylor (1806), both public
domain. `source.musicxml` was typed for this fixture and rendered with Verovio 6.4; the
rendering is released with Coro. homr reads all 28 notes exactly (strict F1 1.0), so the
review has no issues: it is the clean case.

## airds-air

"The Ranting Highlandman" (traditional), page image `13-airds-air--clean.png` from the
Sheetly OMR benchmark page set (https://github.com/loveranmar/omr-benchmark,
https://www.trysheetly.com/compare/omr-benchmark), licensed **CC BY 4.0**; unchanged.
homr reads all 84 notes exactly, yet four measures do not add up to the 2/2 bar
(the pick-up, the two halves around the repeat, the last bar), so it carries four
`measure-underfull` issues — real cases where the reason is the notation, not an error.

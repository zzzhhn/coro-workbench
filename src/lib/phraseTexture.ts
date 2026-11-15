import type { ArrangementSectionPlan, NoteEvent } from './types';

export type BackgroundVoice = 'S' | 'A' | 'T' | 'B';
export interface PhraseAttack {
  voice: BackgroundVoice;
  start: number;
  duration: number;
  reason: 'phrase-support' | 'held-note' | 'phrase-motif' | 'gap-response' | 'harmonic-entry';
  /** Source anchors are evidence, never notes copied from a reference arrangement. */
  sourceIds: string[];
}
interface Phrase { notes: NoteEvent[]; start: number; end: number }
const EPS = 1e-6;
const endOf = (n: NoteEvent) => n.start + n.duration;

/** A rhythm-only layer: it cannot change a pitch, chord, Solo note or syllable. */
export function phraseTexture(
  lead: NoteEvent[],
  section: ArrangementSectionPlan,
  from: number,
  to: number,
  chords: Array<{ start: number; end: number }>,
  tempo: number,
): PhraseAttack[] {
  const notes = lead.filter(n => n.midi !== null && n.duration > 0)
    .slice().sort((a, b) => a.start - b.start);
  // Group on the full lead, before section clipping. A planning boundary is not a breath.
  const breath = Math.max(0.5, tempo / 60 * 0.3);
  const phrases: Phrase[] = [];
  for (const note of notes) {
    const previous = phrases.at(-1);
    if (!previous || note.start - previous.end >= breath - EPS)
      phrases.push({ notes: [note], start: note.start, end: endOf(note) });
    else { previous.notes.push(note); previous.end = Math.max(previous.end, endOf(note)); }
  }
  const events: PhraseAttack[] = [];
  const emit = (voice: BackgroundVoice, start: number, end: number, reason: PhraseAttack['reason'], source: NoteEvent[]) => {
    start = Math.max(from, start); end = Math.min(to, end);
    if (end - start >= 0.5 - EPS)
      events.push({ voice, start, duration: end - start, reason, sourceIds: source.map(n => n.id) });
  };
  // Reduce onset density by selecting source anchors, not by looking up bar patterns.
  const motif = (phrase: Phrase) => {
    const spacing = section.energy >= 4 ? 0.5 : 1;
    return phrase.notes.reduce<NoteEvent[]>((selected, n) => {
      if (!selected.length || n.start - selected.at(-1)!.start >= spacing - EPS) selected.push(n);
      return selected;
    }, []);
  };
  for (let p = 0; p < phrases.length; p++) {
    const phrase = phrases[p];
    const next = phrases[p + 1];
    if ((next?.start ?? phrase.end + 2) <= from || phrase.start >= to) continue;
    const anchors = motif(phrase);
    const moving = section.texture === 'rhythm' || section.texture === 'lyric';
    emit('T', phrase.start, phrase.end, 'phrase-support', [phrase.notes[0]]);
    if (moving) {
      // Alto carries the source's rhythmic identity while Tenor supplies continuity.
      anchors.forEach((n, i) => emit('A', n.start,
        anchors[i + 1]?.start ?? phrase.end, 'phrase-motif', [n]));
    } else {
      // Let the solo establish its phrase before adding the second supporting voice.
      const entry = anchors[1] ?? anchors[0];
      emit('A', entry.start, phrase.end, 'phrase-support', [entry]);
    }
    const holds = phrase.notes.filter(n => n.duration >= 1.5);
    if (section.energy >= 3 && section.texture !== 'sparse') {
      // During a solo hold, a moving inner line can enter without doubling every syllable.
      for (const hold of holds) {
        const seed = anchors.filter(n => n.start < hold.start);
        if (moving && seed.length > 1) {
          const origin = seed[0].start;
          seed.forEach((n, i) => {
            const start = hold.start + (n.start - origin);
            const end = Math.min(endOf(hold), hold.start + ((seed[i + 1]?.start ?? origin + hold.duration) - origin));
            if (start < endOf(hold)) emit('S', start, end, 'held-note', [hold, n]);
          });
        } else emit('S', hold.start, endOf(hold), 'held-note', [hold]);
      }
    }
    // Answer only in a real phrase gap; length and spacing come from this phrase's motif.
    const gapEnd = Math.min(next?.start ?? to, to, phrase.end + Math.max(2,
      anchors.at(-1)!.start - (anchors.at(-3)?.start ?? anchors[0].start) + anchors.at(-1)!.duration));
    if (gapEnd - phrase.end >= 1 && section.texture !== 'sparse') {
      const start = phrase.end;
      const seed = anchors.slice(-3);
      const origin = seed[0]?.start ?? start;
      seed.forEach((n, i) => {
        const answerStart = start + n.start - origin;
        const answerEnd = Math.min(gapEnd - 0.5,
          start + ((seed[i + 1]?.start ?? origin + gapEnd - start - 0.5) - origin));
        emit('S', answerStart, answerEnd, 'gap-response', [n]);
      });
    }
    const bassAnchors = [phrase.start, ...chords.map(c => c.start).filter(t => t > phrase.start && t < phrase.end)];
    if (section.bass === 'groove') bassAnchors.push(...anchors.map(n => n.start));
    const unique = [...new Set(bassAnchors)].sort((a, b) => a - b)
      .reduce<number[]>((selected, t) => {
        if (!selected.length || t - selected.at(-1)! >= 0.5 - EPS) selected.push(t);
        return selected;
      }, []);
    unique.forEach((t, i) => emit('B', t, unique[i + 1] ?? phrase.end, 'phrase-support',
      [phrase.notes.find(n => n.start >= t - EPS) ?? phrase.notes.at(-1)!]));
  }
  // Instrumental spaces get a harmonic floor, not a fabricated vocal phrase.
  // Only fill gaps of at least one complete chord, outside solo phrases and their answers.
  for (const chord of chords) {
    if (phrases.some(p => p.start < chord.end && p.end > chord.start) ||
        events.some(e => e.start < chord.end && e.start + e.duration > chord.start)) continue;
    emit('B', chord.start, chord.end, 'harmonic-entry', []);
    emit('T', chord.start, chord.end, 'harmonic-entry', []);
  }
  return events.sort((a, b) => a.start - b.start || a.voice.localeCompare(b.voice));
}

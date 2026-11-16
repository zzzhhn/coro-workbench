import type { NoteEvent, ScoreProject } from './types';
import { beatsPerBar, validateProject } from './music';
import { extractSourceHarmony } from './sourceHarmony';
import { realizeJointVoicing } from './jointVoicing';

const IDS = ['voice-s', 'voice-a', 'voice-t', 'voice-b'];
const CENTRES = [69, 64, 57, 45];
const EPS = 1e-6;

/** A deliberately plain alternative to melodic dialogue. Background voices
 * sustain the source harmony; only harmonic arrivals can change their pitches.
 * There is no motif, section label, counter-melody or per-song lookup. */
export function createChordChant(
  scaffold: ScoreProject, source: ScoreProject, leadPartId: string,
  spans: Array<{ first: number; last: number }>,
  options: { sourceStructure?: boolean; leadPhrasing?: boolean; register?: 'original' | 'raised' } = {},
) {
  const evidence = extractSourceHarmony(source, leadPartId);
  let project = structuredClone(scaffold);
  const bar = beatsPerBar(project), trace = [];
  if (!IDS.every(id => project.parts.some(p => p.id === id))) throw Error('Chant requires Solo + SATB');
  for (const span of spans) {
    const start = (span.first - 1) * bar, end = span.last * bar;
    if (start < 0 || end <= start || end > project.measures * bar) throw Error('Invalid chant span');
    // A short accompaniment pickup is not a new background syllable/chord.
    // Keep its gap explicit rather than inventing a replacement harmony.
    const guides = evidence.guides.filter(g => g.duration >= 1 - EPS && g.start < end && g.start + g.duration > start)
      .map(g => ({ ...g, start: Math.max(start, g.start), duration: Math.min(end, g.start + g.duration) - Math.max(start, g.start) }));
    if (!guides.length) throw Error('No sustained source harmony for chant');
    const regions: Array<{ start: number; end: number }> = [];
    for (const g of guides) {
      const tail = regions.at(-1);
      if (tail && Math.abs(tail.end - g.start) < EPS) tail.end = g.start + g.duration;
      else regions.push({ start: g.start, end: g.start + g.duration });
    }
    // Rest together at a phrase gap; continuous textures get a half-beat breath
    // after at most two bars. Breath timing is shared, not an extra rhythmic role.
    let phrases = regions.flatMap(r => {
      const result = [];
      for (let t = r.start; t < r.end - EPS; t += bar * 2) {
        const stop = Math.min(r.end, t + bar * 2);
        result.push({ start: t, duration: stop - t - (stop < r.end - EPS ? .5 : 0) });
      }
      return result;
    });
    if (options.leadPhrasing) {
      const lead = project.parts.find(p => p.id === 'solo')!.notes.filter(n => n.midi !== null)
        .sort((a, b) => a.start - b.start);
      const breaths: Array<{ start: number; end: number }> = [];
      let soundingEnd = -Infinity;
      for (const n of lead) {
        if (Number.isFinite(soundingEnd) && n.start - soundingEnd >= .5 - EPS && n.start > start && n.start < end) {
          // A pickup in the final sixteenth joins the next beat's phrase. Let
          // the Solo lead it in, then rearticulate the background on that beat.
          const restart = Math.ceil(n.start) - n.start <= .25 + EPS ? Math.ceil(n.start) : n.start;
          breaths.push({ start: Math.max(soundingEnd, restart - .5), end: restart });
        }
        soundingEnd = Math.max(soundingEnd, n.start + n.duration);
      }
      for (const breath of breaths) phrases = phrases.flatMap(p => {
        const stop = p.start + p.duration;
        if (p.start >= breath.end || stop <= breath.start) return [p];
        return [
          ...(p.start < breath.start ? [{ start: p.start, duration: breath.start - p.start }] : []),
          ...(stop > breath.end ? [{ start: breath.end, duration: stop - breath.end }] : []),
        ];
      });
    }
    const isolated = structuredClone(project);
    IDS.forEach((id, v) => {
      isolated.parts.find(p => p.id === id)!.notes = phrases.map((phrase, i): NoteEvent => ({
        id: `chant-${id}-${start}-${i}`, ...phrase, midi: (options.register === 'raised' ? [74, 67, 62, 45] : CENTRES)[v],
        velocity: .48, lyric: 'Hmm', dynamic: 'p', origin: 'arranged',
      }));
    });
    // Do not let a previous experimental line seed the new phrase's registers.
    // Identical source/Solo passages produce identical music at different offsets.
    const realized = realizeJointVoicing(isolated, span, guides, {
      sourceStructure: options.sourceStructure,
      // Audition preference, not a universal claim about every singer's comfort.
      tessitura: options.register === 'raised' ? [[72, 76], [64, 69], [60, 64], [40, 52]] : undefined,
    });
    IDS.forEach(id => {
      const part = project.parts.find(p => p.id === id)!;
      const outside = part.notes.flatMap(n => n.start >= end || n.start + n.duration <= start ? [n] : [
        ...(n.start < start ? [{ ...n, duration: start - n.start }] : []),
        ...(n.start + n.duration > end ? [{ ...n, id: n.id + '-outside', start: end, duration: n.start + n.duration - end }] : []),
      ]);
      part.notes = [...outside, ...realized.project.parts.find(p => p.id === id)!.notes].sort((a, b) => a.start - b.start);
    });
    trace.push({ span, phrases, guides, decisions: realized.decisions });
  }
  const errors = validateProject(project);
  if (errors.length) throw Error(errors.join('\n'));
  return { project, evidence, trace };
}

import type { ArrangementPlan, ArrangementSectionPlan, NoteEvent } from './types';
import type { BackgroundVoice, PhraseAttack } from './phraseTexture';

const EPS = 1e-6;
type Upper = Exclude<BackgroundVoice, 'B'>;
type Role = 'motion' | 'support' | 'answer' | 'foundation';
interface Phrase { start: number; end: number; notes: NoteEvent[] }
interface MotifHit { offset: number; duration: number; sourceId: string }
export interface BackgroundMotif { id: string; length: number; hits: MotifHit[] }
export interface BackgroundTask {
  start: number; end: number; voice: BackgroundVoice; role: Role;
  motifId?: string; rationale: string;
}
export interface ContinuityAttack extends PhraseAttack { role: Role; motifId?: string }
export interface BackgroundTimeline {
  version: 1; motifs: BackgroundMotif[]; tasks: BackgroundTask[]; attacks: ContinuityAttack[];
}
const endOf = (n: NoteEvent) => n.start + n.duration;
const round = (n: number) => Math.round(n * 2) / 2;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const moving = (s: ArrangementSectionPlan) => s.texture === 'rhythm' || s.texture === 'lyric' || s.bass === 'groove';

/** Rhythm and participation only. References never enter this function.
 * Build once on the complete song, so render windows and planning seams cannot
 * restart a motif. A real long silence or a changed task policy starts an episode.
 */
export function planBackgroundContinuity(
  lead: NoteEvent[], plan: ArrangementPlan, chords: Array<{ start: number; end: number }>,
  tempo: number, bar: number, total: number,
): BackgroundTimeline {
  const notes = lead.filter(n => n.midi !== null && n.duration > 0 && n.start < total)
    .slice().sort((a, b) => a.start - b.start);
  const result: BackgroundTimeline = { version: 1, motifs: [], tasks: [], attacks: [] };
  if (!plan.sections.length || bar <= 0 || total <= 0) return result;
  const sectionAt = (beat: number) => plan.sections.find(s =>
    beat >= (s.startBar - 1) * bar - EPS && beat < (s.startBar - 1 + s.bars) * bar - EPS);
  const phrases: Phrase[] = [];
  const breath = Math.max(0.5, tempo / 60 * 0.3);
  for (const note of notes) {
    const last = phrases.at(-1);
    if (!last || note.start - last.end >= breath - EPS)
      phrases.push({ start: note.start, end: Math.min(total, endOf(note)), notes: [note] });
    else { last.notes.push(note); last.end = Math.min(total, Math.max(last.end, endOf(note))); }
  }
  const emit = (task: BackgroundTask, start: number, end: number, sourceIds: string[], reason: PhraseAttack['reason']) => {
    start = Math.max(task.start, start, 0); end = Math.min(task.end, end, total);
    // The generated background owns a half-beat clock. A sixteenth pickup in
    // Solo must not offset every subsequent cycle and create chord-edge shards.
    start = Math.max(0, Math.ceil((start - EPS) * 2) / 2);
    end = Math.floor((end + EPS) * 2) / 2;
    if (end - start < 0.5 - EPS) return;
    result.attacks.push({ voice: task.voice, role: task.role, motifId: task.motifId,
      start, duration: end - start, sourceIds, reason });
  };
  const task = (voice: BackgroundVoice, role: Role, start: number, end: number, rationale: string, motifId?: string) => {
    const value: BackgroundTask = { voice, role, start, end, rationale, ...(motifId ? { motifId } : {}) };
    result.tasks.push(value); return value;
  };
  const episodes: Phrase[][] = [];
  for (const phrase of phrases) {
    const previous = episodes.at(-1);
    const before = previous && sectionAt(previous.at(-1)!.start), current = sectionAt(phrase.start);
    const policyChange = before && current && (moving(before) !== moving(current) ||
      (before.texture === 'sparse') !== (current.texture === 'sparse'));
    if (!previous || phrase.start - previous.at(-1)!.end >= bar - EPS || policyChange) episodes.push([phrase]);
    else previous.push(phrase);
  }
  // Role choice uses register clearance, not voice-name templates or song identity.
  const register: Record<Upper, number> = { S: 69, A: 63, T: 57 };
  for (const episode of episodes) {
    const first = episode[0], last = episode.at(-1)!;
    const section = sectionAt(first.start);
    if (!section) continue;
    const phraseNotes = episode.flatMap(p => p.notes);
    const leadCenter = median(phraseNotes.map(n => n.midi!));
    const ranked = (['S', 'A', 'T'] as Upper[]).sort((a, b) =>
      Math.abs(register[b] - leadCenter) - Math.abs(register[a] - leadCenter));
    const motionVoice = ranked[0], supportVoice = ranked[1], answerVoice = ranked[2];
    // A source-derived motif is remembered through subsequent phrases. Its cycle
    // retains gaps and never stretches to fit the next singer's syllable timings.
    const length = Math.min(2 * bar, Math.max(bar, Math.ceil((first.end - first.start) / bar) * bar));
    const seed = first.notes.filter(n => n.start < first.start + length - EPS);
    const anchors = seed.reduce<NoteEvent[]>((out, n) => {
      const offset = round(n.start - first.start);
      if (offset < length && (!out.length || offset - round(out.at(-1)!.start - first.start) >= 0.5 - EPS)) out.push(n);
      return out;
    }, []);
    const hits = anchors.map((n, i) => {
      const offset = round(n.start - first.start);
      const available = (i + 1 < anchors.length ? round(anchors[i + 1].start - first.start) : length) - offset;
      return { offset, duration: Math.max(0.5, Math.min(available, round(n.duration))), sourceId: n.id };
    });
    const signature = JSON.stringify([length, hits.map(h => [h.offset, h.duration])]);
    let motif = result.motifs.find(m => JSON.stringify([m.length, m.hits.map(h => [h.offset, h.duration])]) === signature);
    if (!motif) { motif = { id: `motif-${result.motifs.length + 1}`, length, hits }; result.motifs.push(motif); }
    const episodeEnd = last.end;
    const useMotion = moving(section) || (hits.length >= 3 && section.texture !== 'sparse');
    if (useMotion) {
      const motion = task(motionVoice, 'motion', first.start, episodeEnd,
        '输入首句的节奏动机跨短换气延续；在真实长留白或任务改变后结束。', motif.id);
      for (let cycle = Math.ceil(first.start * 2) / 2; cycle < episodeEnd - EPS; cycle += motif.length) {
        for (const hit of motif.hits) {
          const start = cycle + hit.offset;
          // A long source hold offers space; dense lyric attacks do not trigger extra fills.
          emit(motion, start, start + hit.duration, [hit.sourceId], 'phrase-motif');
        }
      }
    }
    // A second layer joins after the first phrase establishes the motion. With
    // no second phrase, a real held note may supply the entry, never bar modulo.
    const supportEntry = useMotion ? (episode[1]?.start ?? first.notes.find(n => n.duration >= 2)?.start) : first.start;
    if (supportEntry !== undefined && (!useMotion || section.energy >= 3)) {
      for (const phrase of episode) {
        const start = Math.max(phrase.start, supportEntry);
        if (phrase.end - start < 1 - EPS) continue;
        const support = task(supportVoice, 'support', start, phrase.end,
          '支撑层在运动建立后进入，随真实句末退出以留出呼吸。');
        emit(support, start, phrase.end, [phrase.notes[0].id], 'phrase-support');
      }
    }
    // Responses are local events; the running motif is not reset at these gaps.
    for (let i = 0; i < episode.length; i++) {
      const phrase = episode[i], next = episode[i + 1];
      const gapEnd = Math.min(next?.start ?? episodeEnd, phrase.end + bar);
      if (gapEnd - phrase.end < 1.5 || section.texture === 'sparse' || section.energy < 3) continue;
      const response = task(answerVoice, 'answer', phrase.end, gapEnd - 0.5,
        '只在主唱真实留白回应，下一句前收住。', motif.id);
      const tail = motif.hits.slice(-2), origin = tail[0]?.offset ?? 0;
      for (const hit of tail) emit(response, phrase.end + hit.offset - origin,
        phrase.end + hit.offset - origin + hit.duration, [hit.sourceId], 'gap-response');
    }
    const bass = task('B', 'foundation', first.start, episodeEnd,
      '低音以和声落点连接乐句；律动型借用背景动机的稀疏重心，不复制主唱全部音头。', motif.id);
    const bassAnchors = [first.start, ...chords.map(c => c.start).filter(t => t > first.start && t < episodeEnd)];
    if (section.bass !== 'sustain') {
      // Select spaced landmarks from the learned motif, not an x--x pattern.
      const landmarks = motif.hits.filter((h, i) => i === 0 || h.offset - motif.hits[i - 1].offset >= 1);
      for (let cycle = Math.ceil(first.start * 2) / 2; cycle < episodeEnd; cycle += motif.length)
        bassAnchors.push(...landmarks.map(h => cycle + h.offset).filter(t => t < episodeEnd));
    }
    const bassTimes = [...new Set(bassAnchors)].sort((a, b) => a - b).reduce<number[]>((out, t) => {
      if (!out.length || t - out.at(-1)! >= 0.5 - EPS) out.push(t); return out;
    }, []);
    bassTimes.forEach((start, i) => {
      const end = bassTimes[i + 1] ?? episodeEnd;
      const gate = section.bass === 'sustain' ? end : Math.min(end, start + Math.max(0.5, round((end - start) * 0.65)));
      emit(bass, start, gate, [], 'harmonic-entry');
    });
  }
  // Long instrumental spaces keep a harmonic floor. Never fill short vocal
  // breaths here: those belong to the persistent episode above.
  const occupied = episodes.map(e => ({ start: e[0].start, end: e.at(-1)!.end }));
  const gaps = [0, ...occupied.map(e => e.end)].map((start, i) => ({ start, end: occupied[i]?.start ?? total }));
  for (const gap of gaps.filter(g => g.end - g.start >= bar - EPS)) {
    for (const chord of chords) {
      const start = Math.max(gap.start, chord.start), end = Math.min(gap.end, chord.end);
      if (end - start < 1) continue;
      const foundation = task('B', 'foundation', start, end, '无主唱的长段保留和声基础，不虚构歌词乐句。');
      emit(foundation, start, end, [], 'harmonic-entry');
    }
  }
  result.attacks.sort((a, b) => a.start - b.start || a.voice.localeCompare(b.voice));
  return result;
}

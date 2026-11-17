import type { ScorePart, ScoreProject } from './types';

export type BackgroundTimbre = 'piano' | 'original';

/** Playback solo/mute flags are not the musical Solo role. */
export function isVocalBacking(part: ScorePart): boolean {
  return part.id !== 'solo' && (part.role === 'harmony' || part.role === 'bass')
    && (/choir|voice/i.test(part.instrument) || (part.program >= 52 && part.program <= 54));
}

/** A non-mutating playback view: written instrumentation, notes and export stay intact. */
export function auditionPart(part: ScorePart, timbre: BackgroundTimbre = 'piano'): ScorePart {
  return timbre === 'piano' && isVocalBacking(part)
    ? { ...part, program: 0, instrument: 'acoustic_grand_piano' }
    : part;
}

export function auditionProject(project: ScoreProject, timbre: BackgroundTimbre = 'piano'): ScoreProject {
  return timbre === 'original' ? project : { ...project, parts: project.parts.map(p => auditionPart(p, timbre)) };
}

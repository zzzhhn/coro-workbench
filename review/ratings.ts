import { metronomeGrid } from '../src/lib/audio';
import type { ScoreProject } from '../src/lib/types';

export const reviewParts = {
  mix: '合唱混音', solo: 'Solo', s: 'S 女高', a: 'A 女低', t: 'T 男高', b: 'B 男低',
};
export type ReviewPart = keyof typeof reviewParts;
export type CommentField = 'favorite' | 'problem';
export type Readiness = '' | 'direct' | 'light' | 'rewrite';

export interface ReviewPosition {
  songId: string;
  versionRef: string;
  part: ReviewPart;
  bar: number;
  beat: number;
}
export interface VersionRating {
  readiness: Readiness;
  favorite: string;
  problem: string;
  estimatedEditMinutes: number | null;
  anchors?: Partial<Record<CommentField, ReviewPosition | null>>;
}
interface Vote {
  preference: string;
  versions: Record<string, VersionRating>;
}
export interface Rating extends Vote {
  roundId: string;
  songId: string;
  updatedAt: string;
  blindSubmittedAt?: string;
  blindSnapshot?: Vote & { submittedAt: string };
  revealedAt?: string;
}

interface ReviewVersion { label: string; dir: string; identity?: string }

// Stable identifiers for navigation and anonymized exports. The manifest is public
// to the listening client, so these are identifiers, not access control.
function hash(value: string): number {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  result = Math.imul(result ^ (result >>> 16), 0x85ebca6b);
  return (result ^ (result >>> 13)) >>> 0;
}

export function reviewChoices<T extends ReviewVersion>(roundId: string, songId: string, versions: readonly T[], reviewer: string) {
  const sorted = versions.map(version => {
    const id = JSON.stringify([roundId, songId, version.label, version.dir]);
    const ref = `${hash(id).toString(36)}-${hash(`position:${id}`).toString(36)}`;
    return { version, ref, rank: hash(JSON.stringify([reviewer, ref])) };
  }).sort((a, b) => a.rank - b.rank || a.ref.localeCompare(b.ref));
  return sorted.map(({ version, ref }, index) => ({
    version, ref, alias: sorted.length === 1 ? '试听版' : ['X', 'Y', 'Z'][index] ?? `版本 ${index + 1}`,
  }));
}

export function positionLink(page: URL, manifest: URL, position: ReviewPosition): string {
  const query = new URLSearchParams({ manifest: manifest.pathname + manifest.search });
  const fragment = new URLSearchParams({
    song: position.songId, version: position.versionRef, part: position.part,
    bar: String(position.bar), beat: String(position.beat),
  });
  return `${page.pathname}?${query}#${fragment}`;
}

export function readPosition(hash: string): ReviewPosition | undefined {
  const values = new URLSearchParams(hash.replace(/^#/, ''));
  const songId = values.get('song');
  const versionRef = values.get('version');
  const part = values.get('part');
  const bar = Number(values.get('bar'));
  const beat = Number(values.get('beat'));
  if (!songId || !versionRef || !part || !Object.hasOwn(reviewParts, part) ||
      !Number.isSafeInteger(bar) || bar < 1 || !Number.isSafeInteger(beat) || beat < 1) return;
  return { songId, versionRef, part: part as ReviewPart, bar, beat };
}

export function positionTime(position: ReviewPosition, score: Pick<ScoreProject, 'measures' | 'tempo' | 'timeSignature'>): number | undefined {
  const { measure, step } = metronomeGrid(score);
  if (position.bar > score.measures || (position.beat - 1) * step >= measure) return;
  return ((position.bar - 1) * measure + (position.beat - 1) * step) * 60 / score.tempo;
}

export function exportRating(rating: Rating, choices: ReturnType<typeof reviewChoices>, link: (position: ReviewPosition) => string) {
  const fields = ['favorite', 'problem'] as const;
  const exportVote = (vote: Vote) => ({
    preference: choices.find(({ version }) => version.label === vote.preference)?.alias ?? vote.preference,
    versions: Object.fromEntries(choices.map(({ alias, version }) => {
      const versionRating = vote.versions[version.label];
      if (!versionRating) return [alias, null];
      const { anchors, ...scoring } = versionRating;
      const locations = fields.flatMap(field => {
        const position = anchors?.[field];
        return position && scoring[field].trim() ? [[field, { ...position, url: link(position) }]] : [];
      });
      return [alias, locations.length ? { ...scoring, anchors: Object.fromEntries(locations) } : scoring];
    })),
  });
  return {
    songId: rating.songId,
    ...exportVote(rating),
    versionRefs: Object.fromEntries(choices.map(({ alias, ref }) => [alias, ref])),
    updatedAt: rating.updatedAt,
    blindSubmittedAt: rating.blindSubmittedAt,
    blindSnapshot: rating.blindSnapshot && { ...exportVote(rating.blindSnapshot), submittedAt: rating.blindSnapshot.submittedAt },
    revealedAt: rating.revealedAt,
    identities: rating.blindSubmittedAt && rating.revealedAt ? Object.fromEntries(choices.map(({ version, alias }) => [
      alias, { label: version.label, description: version.identity ?? version.dir },
    ])) : undefined,
  };
}

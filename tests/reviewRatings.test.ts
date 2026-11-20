import { describe, expect, it } from 'vitest';
import { exportRating, positionLink, positionTime, readPosition, reviewChoices } from '../review/ratings';
import type { Rating, ReviewPosition } from '../review/ratings';
import { playbackPosition } from '../review/playback';

const round = 'secret-round-from-identified-revisions';
const variants = [
  { label: 'A', dir: 'former', identity: 'Identified old version' },
  { label: 'B', dir: 'revisions/secret-filename', identity: 'Identified new version' },
];
const from = new URL('http://127.0.0.1:5173');
const to = new URL('http://localhost:8173');
const page = new URL('/review/arrangements.html', from);
const manifest = new URL('/output/round/manifest.json', from);

describe('blind arrangement ratings', () => {
  it('assigns stable X/Y aliases per song and reviewer while keeping candidate references stable', () => {
    const song = 'fragile';
    const choices = reviewChoices(round, song, variants, 'reviewer A');
    expect(choices.map(c => c.alias)).toEqual(['X', 'Y']);
    expect(reviewChoices(round, song, [...variants].reverse(), 'reviewer A')).toEqual(choices);
    const orders = Array.from({ length: 30 }, (_, i) => reviewChoices(round, song, variants, `reviewer ${i}`));
    expect(new Set(orders.map(ordered => ordered[0].version.label)).size).toBe(2);
    const works = Array.from({ length: 30 }, (_, i) => reviewChoices(round, `song ${i}`, variants, 'reviewer A'));
    expect(new Set(works.map(ordered => ordered[0].version.label)).size).toBe(2);
    for (const ordered of orders) {
      const candidate = ordered.find(c => c.version.label === choices[0].version.label);
      expect(candidate?.ref).toBe(choices[0].ref);
    }
  });

  it('carries the canonical candidate, voice and musical beat into another reviewer’s session and origin', () => {
    const song = '月光';
    const choices = reviewChoices(round, song, variants, 'reviewer A');
    const other = Array.from({ length: 30 }, (_, i) => reviewChoices(round, song, variants, `reviewer ${i}`))
      .find(order => order[0].ref !== choices[0].ref)!;
    const mark: ReviewPosition = { songId: song, versionRef: choices[0].ref, part: 't', bar: 9, beat: 2 };
    const reloaded = new URL(positionLink(page, manifest, mark), to);
    expect(reloaded.origin).toBe(to.origin);
    expect(reloaded.searchParams.get('manifest')).toBe(manifest.pathname);
    const resolved = readPosition(reloaded.hash)!;
    expect(resolved).toEqual(mark);
    expect(other.find(c => c.ref === resolved.versionRef)).toMatchObject({ alias: 'Y', version: choices[0].version });
    const score = { tempo: 120, measures: 9, timeSignature: [6, 8] as [number, number] };
    const time = positionTime(resolved, score)!;
    expect(time).toBe(12.75);
    expect(playbackPosition(time, score)).toMatchObject({ bar: 9, pulse: 2 });
    expect(positionTime({ ...resolved, bar: 10 }, score)).toBeUndefined();
    expect(positionTime({ ...resolved, beat: 3 }, score)).toBeUndefined();
    expect(readPosition(reloaded.hash.replace('part=t', 'part=constructor'))).toBeUndefined();
    expect(readPosition(reloaded.hash.replace('beat=2', 'beat=1.5'))).toBeUndefined();
  });

  it('preserves legacy content and the first ballot, supports equal preference and reveals identity only after reveal', () => {
    const songId = 'out';
    const choices = reviewChoices(round, songId, variants, 'reviewer A');
    const score = { readiness: 'direct', favorite: 'An old vote', problem: '', estimatedEditMinutes: 0 } as const;
    const old = { preference: 'B', versions: { A: score, B: score }, submittedAt: 'yesterday' };
    const rating: Rating = { ...old, roundId: round, songId, updatedAt: 'today', blindSubmittedAt: 'yesterday', blindSnapshot: old };
    const chosen = choices.find(c => c.version.label === 'B')!;
    const ref: ReviewPosition = { songId, versionRef: chosen.ref, part: 'b', bar: 16, beat: 3 };
    const link = (position: ReviewPosition) => positionLink(page, manifest, position);
    expect(exportRating(rating, choices, link).preference).toBe(chosen.alias);
    const updated = { ...rating, preference: 'equal', versions: { A: score, B: { ...score, problem: 'Needs space', anchors: { problem: ref } } } };
    const exported = exportRating(updated, choices, link);
    expect(exported.preference).toBe('equal');
    expect(exported.versions[chosen.alias]).toMatchObject({ readiness: 'direct', anchors: { problem: { ...ref, url: link(ref) } } });
    expect(exported.blindSnapshot).toMatchObject({ preference: chosen.alias, versions: { [chosen.alias]: score } });
    expect(JSON.stringify(exported)).not.toMatch(/secret|Identified|former/);
    expect(exportRating({ ...updated, revealedAt: 'today' }, choices, link).identities?.[chosen.alias]).toMatchObject({ label: 'B', description: variants[1].identity });
  });
});

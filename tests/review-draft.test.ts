import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createDemoProject } from '../src/lib/demo';
import {
  changeReview,
  deleteReviewDraft,
  newReviewDraft,
  readReviewDraft,
  reviewMatchesProject,
  reviewProject,
  saveReviewDraft,
  stepReview,
} from '../src/lib/reviewDraft';

beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const project = createDemoProject();
  project.parts[0].id = 'vocals';
  return project;
}
it('restores notes, manual review status, position and undo after reopening', async () => {
  const project = fixture();
  const original = newReviewDraft(project, 12);
  const notes = structuredClone(original.snapshot.notes);
  notes[0].midi = 73;
  const edited = changeReview(original, { notes, checkpoints: { region: 'uncertain' } });
  edited.position.cursor = 15;
  await saveReviewDraft(edited);
  const restored = (await readReviewDraft(project.id))!;
  expect(reviewProject(restored).parts[0].notes[0].midi).toBe(73);
  expect(restored.position.cursor).toBe(15);
  expect(restored.snapshot.checkpoints.region).toBe('uncertain');
  const undone = stepReview(restored, 'undo');
  expect(undone.snapshot).toEqual(original.snapshot);
  expect(stepReview(undone, 'redo').snapshot).toEqual(edited.snapshot);
  expect(project.parts[0].notes).toEqual(original.snapshot.notes);
  await deleteReviewDraft(project.id);
  expect(await readReviewDraft(project.id)).toBeUndefined();
});
it('detects changed source notes and timing but preserves independent part edits on apply', () => {
  const project = fixture(),
    record = newReviewDraft(project, 0);
  const other = structuredClone(project);
  other.parts[1].notes[0].lyric = 'new edit elsewhere';
  expect(reviewMatchesProject(record, other)).toBe(true);
  expect(reviewProject(record, other).parts[1].notes[0].lyric).toBe('new edit elsewhere');
  other.parts[0].notes[0].midi = 73;
  expect(reviewMatchesProject(record, other)).toBe(false);
  expect(reviewMatchesProject(record, { ...project, tempo: project.tempo + 10 })).toBe(false);
});

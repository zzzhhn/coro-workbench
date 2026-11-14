// Read access to the OMR review data (types.ts OmrReview, validated on import
// and project load by validateOmrReview). Kept as a seam so the editor never
// reaches into project.source directly.
import type { NoteEvent, OmrBox, OmrIssueKind, OmrReview, ScoreProject } from './types';

export type Box = OmrBox;
export type { OmrIssueKind, OmrReview };

export const omrReviewOf = (project: ScoreProject): OmrReview | undefined => project.source.omrReview;

export const sourceRefOf = (note: NoteEvent | undefined): string | undefined => note?.sourceRef;

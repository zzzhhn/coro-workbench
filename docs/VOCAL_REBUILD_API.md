# Existing-project vocal rebuild API

`POST /api/projects/{job_id}/vocal-rebuild`, JSON `{ "project": ScoreProject }`, returns the normal queued `AnalysisJob` (HTTP 202). Poll/cancel with existing `/api/jobs/{new_id}` GET/DELETE routes. Requests are limited to 30 MiB and reject non-finite JSON numbers. The default saved-input path does not upload, separate audio, detect beats or run independent CREPE verification.

An optional `vocalSource` field accepts `current` (the default), `original-vocals`,
`enhanced-lead`, or `enhanced-vocals`. The first two reuse a saved stem. Enhanced
choices run the optional MelBand separator on the authoritative original analysis
segment; `enhanced-lead` additionally runs KARA2. Both extract a fresh FCPE contour
from the newly selected input before alignment. No other instrumental stem is
retranscribed, and no new independent CREPE verification is claimed. Missing
engines produce a setup instruction before the job is queued.

Changing the input also updates the vocal part's `stemUrl` to the selected local
audio; other part metadata remains intact. Old pitch curves retain their explicit
source stem and are labelled as reference evidence for the old input, not a check
of the new input. Old uncertainty intervals move into the local model evidence
rather than being painted onto a different source's notes. Full vocals can include
backing singers and are not automatically identified as the main melody.

The snapshot must be a source audio score (no `arrangement`) whose `source.analysis.rawProjectUrl` is exactly `/api/projects/{job_id}/raw`, with the same original-audio URL as the stored complete result. A separated vocal part must exist in the stored result. Only its server-authoritative local `stemUrl` is used; caller audio paths are never opened. Changed source offset / inserted-measure timeline mappings are rejected. Practice tempo is preserved; notation uses `originalAudio.tempo` and `offsetSeconds`, including intentional beat reinterpretation.

A new result preserves snapshot metadata, other parts, chords and originalAudio. Only vocals.notes are replaced (lyrics on replaced notes disappear); vocal instrument/name/mix stay intact. Measures may grow. The submitted snapshot is saved as `previous-project.json`; the source result and source audio stay untouched. The original raw transcription is copied to the new raw endpoint. New analysis/evidence links point to the new result. Stored independent pitch curves may be copied after integrity checks; they remain prior audio evidence and do not validate the newly decoded notes. Legacy curves lacking an audio-binding manifest remain available with `priorPitchAudioBindingVerified: false`; the new copy is hash checked, but this does not retroactively authenticate the old audio association. Corrupt known hashes are rejected for reuse and visibly reported, not treated as a new successful verification.

Worker dispatch uses `request.action = "vocal-rebuild"`. Native ROSVOT inference is followed by acoustic alignment when stored FCPE exists, then joint rhythm notation. Failures fail the new job rather than silently keeping old fragments. Quality metadata includes `vocalRebuildFromJob`, before/after vocal note counts, decoder/profile and alignment/rhythm audit versions. Existing process-group cancellation also covers the native inference child.

The browser archives and saves the current source and arrangement before submitting. A completed job is previewed before opening its new source document; the previous arrangement is not automatically rewritten. A dedicated pending-task key restores progress after refresh, without overwriting the ordinary audio/OMR import task key. Closing the modal during inference leaves the task running; cancelling terminates the worker process group. Completed results also appear in the local result library.

Current source/workspace and recent-library state use a versioned compressed local-storage encoding. Legacy plain JSON remains readable and is compacted on the next save. Portable `.coro` and `.coro.json` export formats are unchanged. Full original files and stems remain in the backend or IndexedDB, never in local storage.

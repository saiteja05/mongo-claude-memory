// Shared capture size constants. sessionEnd.ts now chunks the transcript into
// consecutive slices of TRANSCRIPT_TAIL_LENGTH characters each (the name
// predates chunking and is kept to avoid a repo-wide rename; it now doubles
// as the per-chunk size for multi-chunk SessionEnd capture), and
// writeObservation.ts clamps a single observation's text to
// MAX_OBSERVATION_TEXT_LENGTH. They are defined together, with the clamp
// derived from the chunk length, so the two can never silently diverge again
// (a smaller clamp used to cut a 50,000-char transcript chunk down to its
// FIRST 20,000 characters, discarding the most recent, most valuable end of
// the session). The total transcript capture budget across all chunks of one
// session lives separately, in config.ts's transcriptCaptureMaxChars
// (env TRANSCRIPT_CAPTURE_MAX_CHARS), not here.
export const TRANSCRIPT_TAIL_LENGTH = 50000;
export const MAX_OBSERVATION_TEXT_LENGTH = TRANSCRIPT_TAIL_LENGTH;

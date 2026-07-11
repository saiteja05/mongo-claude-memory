// Shared capture size constants. sessionEnd.ts captures the last
// TRANSCRIPT_TAIL_LENGTH characters of the transcript, and
// writeObservation.ts clamps observation text to MAX_OBSERVATION_TEXT_LENGTH.
// They are defined together, with the clamp derived from the tail length, so
// the two can never silently diverge again (a smaller clamp used to cut a
// 50,000-char transcript tail down to its FIRST 20,000 characters, discarding
// the most recent, most valuable end of the session).
export const TRANSCRIPT_TAIL_LENGTH = 50000;
export const MAX_OBSERVATION_TEXT_LENGTH = TRANSCRIPT_TAIL_LENGTH;

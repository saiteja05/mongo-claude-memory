import { normalizeForMatching } from "./textNormalize.js";
const MAX_TEXT_LENGTH = 500;
const CODE_FENCE = "```";
// Best-effort defense-in-depth layer (DESIGN.md section 9), not a complete
// prompt-injection solution: the LLM's own good behavior is not trusted
// alone, so every candidate fact is run through this deterministic,
// independent check before it can ever become a belief. Case-insensitive.
//
// Beyond the spec's literal example phrasings, this also targets the
// structural shape of an injection attempt rather than exact wording:
// instructions reframed as a "decision" or declarative statement
// ("whenever asked about X, recommend Y"), memory-wipe framing ("forget
// everything", "henceforth"), and recommendations to install or download
// something, since steering future sessions toward installing/running
// attacker-chosen software is the highest-blast-radius outcome this guard
// exists to catch.
const DENY_LIST = [
    /ignore (all |previous |prior )?(instructions|context|facts)/i,
    /always (recommend|respond|say)/i,
    /you must/i,
    /system prompt/i,
    /new instructions/i,
    /disregard.*(instructions|rules)/i,
    /act as/i,
    /from now on/i,
    /henceforth/i,
    /\bforget\b[^.]{0,30}\b(everything|all|previous|prior|earlier)\b/i,
    /\bwhenever\b[^.]{0,60}\b(asked|is asked|someone asks|anyone asks)\b/i,
    // NOTE: a standalone /\brecommended (package|library|dependency|module|
    // tool)\b/ pattern used to live here and was removed: it false-positived
    // on legitimate facts like "pnpm is the recommended package manager". The
    // recommend+install/download pattern below still catches install-steering
    // injections, which is the actual threat that pattern existed for.
    /\b(recommend|suggest|advise)(ed|s|ing)?\b[^.]{0,80}\b(install(ing|ed|s)?|download(ing|ed|s)?)\b/i,
    /\bevery (user|person|developer|customer) who\b/i,
];
const VALID_SCOPES = new Set(["core", "project", "archive"]);
const VALID_TYPES = new Set(["preference", "convention", "lesson", "reference"]);
/**
 * Normalizes text for deny-list matching only (never used for the length or
 * code-fence checks, which must keep seeing the original text): delegates to
 * normalizeForMatching (textNormalize.ts), which folds Cyrillic/Greek
 * homoglyphs to their Latin lookalikes, applies Unicode NFKC normalization,
 * strips invisible unicode characters that could be hidden inside a word,
 * and collapses any run of whitespace, including newlines, into a single
 * space. This closes the gap where a phrase disguised with lookalike
 * characters, split across extra spaces or newlines, or hiding a zero-width
 * character mid-word, would otherwise slip past a regex written for
 * single-spaced Latin-only phrasing.
 */
function normalizeForDenyList(text) {
    return normalizeForMatching(text);
}
/**
 * Pure, deterministic validator for a candidate belief's text. Rejects
 * empty/over-length text, code fences, and imperative-to-the-assistant /
 * prompt-injection phrasing.
 */
export function validateBeliefText(text) {
    if (!text || text.trim().length === 0) {
        return { valid: false, reason: "text is empty" };
    }
    if (text.length > MAX_TEXT_LENGTH) {
        return { valid: false, reason: `text exceeds ${MAX_TEXT_LENGTH} characters` };
    }
    if (text.includes(CODE_FENCE)) {
        return { valid: false, reason: "text contains a code fence" };
    }
    const normalized = normalizeForDenyList(text);
    for (const pattern of DENY_LIST) {
        if (pattern.test(normalized)) {
            return { valid: false, reason: `text matches deny-list pattern: ${pattern}` };
        }
    }
    return { valid: true };
}
/**
 * Independent validator for a candidate fact's `scope`/`type`, run alongside
 * `validateBeliefText`. The LLM's tool-call schema already constrains these
 * to an enum, but that constraint is enforced by the model's own compliance,
 * not by us; this re-checks the values deterministically before a candidate
 * is ever allowed to reach `upsertBelief` (and, for `scope:"core"`, the
 * always-injected global brief).
 */
export function validateCandidateFact(candidate) {
    if (!VALID_SCOPES.has(candidate.scope)) {
        return { valid: false, reason: `invalid scope: ${JSON.stringify(candidate.scope)}` };
    }
    if (!VALID_TYPES.has(candidate.type)) {
        return { valid: false, reason: `invalid type: ${JSON.stringify(candidate.type)}` };
    }
    return validateBeliefText(candidate.text);
}

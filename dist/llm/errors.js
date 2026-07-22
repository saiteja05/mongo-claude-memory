/**
 * Shared non-retryable LLM error. Each provider (anthropic.ts, bedrock.ts,
 * ollama.ts) throws this instead of its own local error class when a call
 * fails in a way a retry cannot fix: output truncated by the model's
 * max-token limit, a well-formed response missing the expected tool call, or
 * (bedrock) an AWS error the SDK itself judges non-retryable, which is how a
 * too-long input surfaces there. Each provider's final wrap after exhausting
 * its retry loop re-throws as this same class when the underlying failure
 * was non-retryable, so callers can tell "permanent, do not retry the same
 * input again" apart from "transient, worth trying again later" without
 * knowing which provider produced the error.
 *
 * consolidation/run.ts's extractWithSplit is the consumer: on a non-retryable
 * failure it splits the batch to isolate the single observation actually
 * responsible (a batch too large for the model's context, for example)
 * instead of re-failing the same batch identically forever every time the
 * stale-claim sweep reclaims it.
 */
export class NonRetryableLLMError extends Error {
    constructor(message) {
        super(message);
        this.name = "NonRetryableLLMError";
    }
}
/** True when err is (or was wrapped as) a NonRetryableLLMError. */
export function isNonRetryableLLMError(err) {
    return err instanceof NonRetryableLLMError;
}

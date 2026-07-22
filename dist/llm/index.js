import { loadConfig } from "../config.js";
import { callWithTool as callAnthropic } from "./anthropic.js";
import { callWithTool as callBedrock } from "./bedrock.js";
import { callWithTool as callOllama } from "./ollama.js";
/**
 * Provider dispatcher. Reads config.llmProvider first and routes to the
 * matching implementation before any provider module runs its own checks, so
 * the anthropic path's ANTHROPIC_API_KEY guard never fires when
 * LLM_PROVIDER is set to "bedrock" or "ollama", and neither the bedrock nor
 * the ollama path is reached when it is unset (direct-Anthropic behavior
 * stays unchanged by default). Three providers are supported: anthropic
 * (default), bedrock, and ollama.
 */
export async function callWithTool(systemPrompt, userPrompt, toolName, toolSchema) {
    const config = loadConfig();
    if (config.llmProvider === "bedrock") {
        return callBedrock(systemPrompt, userPrompt, toolName, toolSchema);
    }
    if (config.llmProvider === "ollama") {
        return callOllama(systemPrompt, userPrompt, toolName, toolSchema);
    }
    return callAnthropic(systemPrompt, userPrompt, toolName, toolSchema);
}

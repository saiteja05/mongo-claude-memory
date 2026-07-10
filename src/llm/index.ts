import { loadConfig } from "../config.js";
import { callWithTool as callAnthropic } from "./anthropic.js";
import { callWithTool as callBedrock } from "./bedrock.js";

/**
 * Provider dispatcher. Reads config.llmProvider first and routes to the
 * matching implementation before either provider module runs any of its own
 * checks, so the anthropic path's ANTHROPIC_API_KEY guard never fires when
 * LLM_PROVIDER is set to "bedrock", and the bedrock path is never reached
 * when it is unset (direct-Anthropic behavior stays unchanged by default).
 */
export async function callWithTool(
  systemPrompt: string,
  userPrompt: string,
  toolName: string,
  toolSchema: object
): Promise<unknown> {
  const config = loadConfig();
  if (config.llmProvider === "bedrock") {
    return callBedrock(systemPrompt, userPrompt, toolName, toolSchema);
  }
  return callAnthropic(systemPrompt, userPrompt, toolName, toolSchema);
}

import { APICallError } from "ai";

/**
 * Produces a user-facing message for voice LLM failures (quota, 4xx/5xx, network).
 */
export function formatVoiceAgentLlmError(err: unknown): string {
  if (APICallError.isInstance(err)) {
    let msg = err.message;
    if (err.responseBody) {
      try {
        const parsed = JSON.parse(err.responseBody) as {
          error?: { message?: string; code?: number | string; status?: string };
        };
        const apiMsg = parsed?.error?.message;
        if (apiMsg) {
          msg = apiMsg;
        } else {
          msg = `${msg}: ${err.responseBody.slice(0, 400)}`;
        }
      } catch {
        msg = `${msg}: ${err.responseBody.slice(0, 400)}`;
      }
    }
    return msg;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function voiceAgentLlmErrorCode(err: unknown): string {
  if (APICallError.isInstance(err)) {
    if (err.statusCode === 429) return "LLM_RATE_LIMIT";
    if (err.statusCode != null && err.statusCode >= 500) return "LLM_SERVER_ERROR";
    if (err.statusCode != null && err.statusCode >= 400) return "LLM_CLIENT_ERROR";
  }
  return "AGENT_ERROR";
}

/** Short spoken apology when the voice LLM fails (Deepgram TTS). */
export function getVoiceLlmErrorSpokenLine(
  llmProvider: "google" | "openai" | "groq",
): string {
  if (llmProvider === "google") {
    return "Sorry, Gemini returned an error—often a quota or billing limit. Check your Google AI Studio key and try again.";
  }
  if (llmProvider === "groq") {
    return "Sorry, Groq returned an error. Check your Groq API key and rate limits, then try again.";
  }
  return "Sorry, the language model returned an error. Check your API key, usage limits, and billing, then try again.";
}

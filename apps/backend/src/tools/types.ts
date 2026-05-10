import type { VoiceWeatherWidgetPayload } from "@sarjy/shared-types";

/**
 * Shared types for the voice tool registry.
 *
 * A voice tool is a self-contained capability the assistant can invoke
 * during a turn (e.g. weather lookup). Each tool ships with:
 *  - metadata used to render its specification into the system prompt,
 *  - an executor invoked when the LLM emits a streamed `<tool>` JSON block.
 */

/** Per-socket context passed into tool execution (e.g. browser GPS). */
export interface VoiceToolSessionContext {
  getClientLocation: () => { latitude: number; longitude: number } | null;
  /** Tells the client to show the browser location prompt immediately. */
  signalNeedClientLocation: () => void;
}
export type VoiceToolParameterType = "string" | "number" | "boolean";

export interface VoiceToolParameterSpec {
  type: VoiceToolParameterType;
  description: string;
  /** Argument is allowed to be `null`, surfaced in the prompt. */
  nullable?: boolean;
  /** Argument must be present (defaults to `true`). */
  required?: boolean;
  /** Optional set of allowed values, surfaced in the prompt. */
  enum?: readonly string[];
}

export interface VoiceToolRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export interface VoiceToolExecution {
  request: VoiceToolRequest;
  /** Plain natural-language text appended as the next user turn after a tool runs (no wrappers or JSON). */
  contextText: string;
  /** When set, the voice socket may emit a small weather card to the client. */
  weatherWidget?: VoiceWeatherWidgetPayload;
}

export interface VoiceTool {
  name: string;
  /** One-line summary used in the prompt. */
  description: string;
  parameters: Record<string, VoiceToolParameterSpec>;
  /**
   * Example user phrases that should trigger this tool. Rendered into the
   * prompt to bias the LLM toward emitting `<tool>` blocks at the right time.
   */
  examples?: readonly string[];
  /** Extra free-form notes appended after the parameter list in the prompt. */
  guidance?: string;
  /**
   * Execute the tool when the LLM emits a streamed `<tool>` JSON block.
   * `session` is optional for tools that do not need client state.
   */
  execute(
    request: VoiceToolRequest,
    signal: AbortSignal,
    session?: VoiceToolSessionContext,
  ): Promise<VoiceToolExecution>;
}

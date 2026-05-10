import type {
  VoiceTool,
  VoiceToolExecution,
  VoiceToolRequest,
  VoiceToolSessionContext,
} from "@/tools/types";

const tools = new Map<string, VoiceTool>();

export function registerVoiceTool(tool: VoiceTool): void {
  if (tools.has(tool.name)) {
    throw new Error(`Voice tool already registered: ${tool.name}`);
  }
  tools.set(tool.name, tool);
}

export function getRegisteredVoiceTools(): VoiceTool[] {
  return Array.from(tools.values());
}

export function getVoiceTool(name: string): VoiceTool | undefined {
  return tools.get(name);
}

/** Pulls the outermost `{ ... }` substring so leading/trailing fences or prose do not break parse. */
function extractJsonObjectSlice(s: string): string | null {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end < start) return null;
  return s.slice(start, end + 1);
}

/**
 * Parse the JSON body of a streamed `<tool>` block. Returns `null` when the
 * payload is malformed or references an unregistered tool.
 */
export function parseVoiceToolRequest(raw: string): VoiceToolRequest | null {
  let cleaned = raw.trim();
  // Models often wrap the payload in ```json fences; trim may leave leading newlines before ```.
  for (let i = 0; i < 3; i++) {
    const next = cleaned
      .replace(/^\s*```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();
    if (next === cleaned) break;
    cleaned = next;
  }

  const jsonText = extractJsonObjectSlice(cleaned) ?? cleaned;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as { name?: unknown; arguments?: unknown };
  if (typeof candidate.name !== "string" || !tools.has(candidate.name)) return null;

  const args = candidate.arguments && typeof candidate.arguments === "object"
    ? candidate.arguments as Record<string, unknown>
    : {};

  return { name: candidate.name, arguments: args };
}

export async function executeVoiceTool(
  request: VoiceToolRequest,
  signal: AbortSignal,
  session?: VoiceToolSessionContext,
): Promise<VoiceToolExecution> {
  const tool = tools.get(request.name);
  if (!tool) {
    throw new Error(`Unknown voice tool: ${request.name}`);
  }
  return tool.execute(request, signal, session);
}

/** Plain text only — no tags, no JSON; memory never uses this path (only real tool executions). */
export function createVoiceToolContext(execution: VoiceToolExecution): string {
  return execution.contextText.trim();
}

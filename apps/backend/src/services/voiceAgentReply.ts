import { getVoiceAgentSystemPrompt } from "@/prompts/voiceAgentSystem";
import { sanitizeAssistantFullText, sanitizeAssistantSegment } from "@/services/guardrails/outputGuardrails";
import { getVoiceAgentModel, getVoiceAgentStreamTextOverrides } from "@/services/voiceAgentModel";
import type { VoiceToolSessionContext } from "@/tools/types";
import {
  createVoiceToolContext,
  executeVoiceTool,
  parseVoiceToolRequest,
  type VoiceToolExecution,
  type VoiceToolRequest,
} from "@/tools/voiceTools";
import { logger } from "@/utils/logger";
import { takeSpeakablePrefix } from "@/utils/speakableChunks";
import { stripAssistantFullMessage, stripSpeakableSegment } from "@/utils/stripVoiceHallucination";
import { WORKFLOW_UPDATE_RESERVATION_SLOTS } from "@/workflow/tools/workflowVoiceTools";
import type { VoicePersonaId, VoiceWeatherWidgetPayload } from "@sarjy/shared-types";
import { streamText, type ImagePart, type ModelMessage, type TextPart, type UserContent } from "ai";

/**
 * Image attachment shape consumed by the voice agent.
 * `data` is base-64 encoded bytes (no `data:` prefix).
 */
export interface VoiceAgentImageInput {
  id: string;
  mediaType: string;
  data: string;
}

export type VoiceAgentSegmentSink = (text: string, meta: {
  segmentIndex: number;
  triggerAt: number;
}) => Promise<void>;

/**
 * Tool-block delimiters the streaming parser recognises.
 *
 * The system prompt asks for `<tool>```json … ```</tool>`. Frontier models
 * (Gemini, GPT-4 class) follow this exactly. Smaller models — notably
 * Groq-hosted Llama-3-class — strip the custom XML wrapper and emit only the
 * inner markdown JSON fence; some omit the `json` hint and just use ``` `.
 *
 * We try patterns in priority order. First match wins per turn so a model
 * that uses the canonical wrapper still parses cleanly, while a Llama-style
 * bare fence is also captured (instead of being spoken aloud as audio).
 */
interface ToolDelimiters {
  open: string;
  close: string;
  /** Human-readable id for logs only. */
  label: string;
}

const TOOL_DELIMITERS: readonly ToolDelimiters[] = [
  { open: "<tool>", close: "</tool>", label: "xml" },
  { open: "```json", close: "```", label: "fence-json" },
  // Bare ``` is last because it's the least specific — it requires that the
  // first non-whitespace char inside be `{` (enforced when matching).
  { open: "```", close: "```", label: "fence-plain" },
];

/** Result of scanning the buffer for a tool-block opener. */
interface ToolOpenerMatch {
  /** Index in `buffer` where the opener starts. */
  openerIdx: number;
  /** Index in `buffer` immediately after the opener (where tool content begins). */
  contentStart: number;
  /** Closing delimiter to search for once we start collecting. */
  closer: string;
  label: string;
}

/**
 * Scan the buffer for the earliest tool-block opener of any registered
 * pattern. Returns null when none is present. For the bare ``` ``` `` opener
 * we additionally require the next non-whitespace char to be `{` so a stray
 * markdown code block does not get hijacked.
 */
function findEarliestToolOpener(buffer: string): ToolOpenerMatch | null {
  let earliest: ToolOpenerMatch | null = null;

  for (const { open, close, label } of TOOL_DELIMITERS) {
    const idx = buffer.indexOf(open);
    if (idx === -1) continue;

    if (label === "fence-plain") {
      // Skip if the chars right after ``` are `json` (already covered by
      // fence-json) or anything other than whitespace + `{`.
      const after = buffer.slice(idx + open.length);
      if (after.startsWith("json")) continue;
      const trimmedAfter = after.replace(/^\s+/, "");
      if (!trimmedAfter.startsWith("{")) {
        // Could still be incomplete — but only treat as opener once we see `{`.
        continue;
      }
    }

    if (earliest === null || idx < earliest.openerIdx) {
      earliest = {
        openerIdx: idx,
        contentStart: idx + open.length,
        closer: close,
        label,
      };
    }
  }

  return earliest;
}

/**
 * True when `suffix` is a non-empty prefix of any registered opener — used to
 * hold back streaming text that *might* be the start of a tool-block
 * delimiter so we don't flush half a fence into TTS.
 */
function isPotentialToolOpenerPrefix(suffix: string): boolean {
  if (!suffix) return false;
  for (const { open } of TOOL_DELIMITERS) {
    if (open.startsWith(suffix)) return true;
  }
  return false;
}

/** Last resort when the model yields no speakable text (bad tool JSON, wrong tool name, etc.). */
export const VOICE_EMPTY_REPLY_FALLBACK =
  "I didn’t quite catch that. Could you say again what you’d like, in a few words?";

export interface StreamVoiceAgentReplyOptions {
  /** Injected into the system prompt so the model knows how to use GPS / weather. */
  userLocationContextLine: string;
  /** Clock + optional local weather snapshot (prep-time) for the system prompt. */
  sessionContextBlock?: string;
  /** User-selected speaking personality for this voice session. */
  voicePersona: VoicePersonaId;
  voiceToolSession?: VoiceToolSessionContext;
  onWeatherWidget?: (payload: VoiceWeatherWidgetPayload) => void;
  /** Direct user memory (always in system prompt). */
  directMemoryBlock?: string;
  /**
   * Active workflow instruction block produced by WorkflowOrchestrator.
   * Appended after memory blocks so it overrides generic assistant behaviour
   * for the current turn.
   */
  workflowContextBlock?: string;
  /**
   * After `workflow_update_reservation_slots` mutates in-memory workflow state,
   * rebuild the workflow system block so the second LLM pass matches the new step.
   */
  reloadWorkflowContextBlock?: () => Promise<string | undefined>;
  /**
   * Optional fast-path: when this returns a non-empty string after the tool
   * executes, the second LLM pass is skipped and the returned text is sent
   * straight to TTS as the assistant's continuation. Used to deterministically
   * generate the next workflow question (e.g. "What time?") instead of paying
   * an extra ~1–2s of LLM TTFT for predictable slot-collection prompts.
   */
  deterministicReplyAfterTool?: (toolName: string) => string | null | undefined;
  /**
   * Images attached to the **current** user turn. Inlined into the multimodal
   * user content so the LLM can "see" them. Older turns are not back-filled.
   */
  pendingImages?: VoiceAgentImageInput[];
  /**
   * When set, skip the LLM entirely and emit this string as the assistant
   * reply. Used by the input-guardrail short-circuit so blocked utterances
   * still get a spoken refusal through TTS without paying for a model call.
   */
  forcedAssistantText?: string;
  /** Optional per-turn tracing (written to the voice session journey log on the socket). */
  onAgentJourney?: (event: VoiceAgentJourneyEvent) => void;
}

/**
 * Build the multimodal user content array for `streamText`. Returns a plain
 * string when no images are attached (cheaper + clearer in logs).
 */
export function buildVoiceUserContent(
  text: string,
  images?: VoiceAgentImageInput[],
): UserContent {
  if (!images?.length) return text;

  const safeText = text.trim() || "(See the attached image.)";
  const textPart: TextPart = { type: "text", text: safeText };
  const imageParts: ImagePart[] = images.map((img) => ({
    type: "image",
    image: img.data,
    mediaType: img.mediaType,
  }));
  return [textPart, ...imageParts];
}

/**
 * Streams an LLM reply with \`streamText\` (same API regardless of provider model),
 * slices text for early TTS, and invokes \`onSegment\` for each non-empty speakable chunk.
 */
export type LlmRoutingTag = "RESERVATION" | "GENERAL";

/** Structured events for per-session latency logs (voice socket journey file). */
export type VoiceAgentJourneyEvent =
  | { kind: "agent.reply.enter"; userTextChars: number; priorMessagesCount: number }
  | { kind: "agent.reply.forced_skip_llm"; reason: "input_guardrail" }
  | {
    kind: "agent.reply.exit";
    assistantChars: number;
    llmTtftMsReported: number;
    hadSecondPass: boolean;
    routingTag?: LlmRoutingTag;
  }
  | { kind: "llm.pass.begin"; pass: 1 | 2; messageCount: number }
  | { kind: "llm.streamText.before"; pass: 1 | 2 }
  | { kind: "llm.streamText.after"; pass: 1 | 2 }
  | { kind: "llm.first_text_delta"; pass: 1 | 2; ttftRequestToFirstTokenMs: number }
  | { kind: "llm.routing_tag"; pass: 1 | 2; tag: LlmRoutingTag }
  | { kind: "llm.tool_opener"; pass: 1 | 2; label: string }
  | { kind: "llm.tool_parse_ok"; pass: 1 | 2; tool: string }
  | { kind: "llm.tool_parse_tail"; pass: 1 | 2; tool: string }
  | { kind: "llm.pass.stream_reader_done"; pass: 1 | 2; hadToolRequest: boolean }
  | { kind: "llm.speakable_flush"; pass: 1 | 2; segmentIndex: number; chars: number; msSincePassBegin: number }
  | { kind: "tool.execute.begin"; tool: string }
  | { kind: "tool.execute.end"; tool: string; ms: number; ok: boolean }
  | { kind: "workflow.reload_context.begin" }
  | { kind: "workflow.reload_context.end"; ms: number; applied: boolean };

function emitAgentJourney(
  cb: ((e: VoiceAgentJourneyEvent) => void) | undefined,
  event: VoiceAgentJourneyEvent,
): void {
  if (!cb) return;
  try {
    cb(event);
  } catch {
    /* never break voice pipeline */
  }
}

export async function streamVoiceAgentReply(
  userText: string,
  priorMessages: ModelMessage[],
  signal: AbortSignal,
  onSegment: VoiceAgentSegmentSink,
  options: StreamVoiceAgentReplyOptions,
): Promise<{
  assistantText: string;
  llmTtftMs: number;
  llmPostFirstTokenMs?: number;
  /** Routing tag emitted by the LLM on the first line of a general-mode response. */
  routingTag?: LlmRoutingTag;
  /** Tool wall time when a tool fired (undefined for non-tool turns). */
  toolExecMs?: number;
  toolName?: string;
  /** TTFT for the second LLM pass when one ran. */
  pass2LlmTtftMs?: number;
}> {
  const journey = options.onAgentJourney;
  emitAgentJourney(journey, {
    kind: "agent.reply.enter",
    userTextChars: userText.length,
    priorMessagesCount: priorMessages.length,
  });

  let llmTtftMs = 0;
  let llmPostFirstTokenMs: number | undefined;
  let assistantText = "";
  let segmentIndex = 0;
  let isFirstFlush = true;
  let toolExecution: VoiceToolExecution | null = null;

  const userContent = buildVoiceUserContent(userText, options.pendingImages);

  const baseMessages: ModelMessage[] = [
    ...priorMessages,
    { role: "user", content: userContent },
  ];

  const emitSpeakableText = async (text: string): Promise<void> => {
    const cleaned = sanitizeAssistantSegment(stripSpeakableSegment(text)).trim();
    if (!cleaned || signal.aborted) return;
    const triggerAt = Date.now();
    await onSegment(cleaned, {
      segmentIndex: segmentIndex++,
      triggerAt,
    });
  };

  const finalizeAssistantText = async (): Promise<void> => {
    if (signal.aborted) return;
    if (sanitizeAssistantFullText(stripAssistantFullMessage(assistantText)).trim()) return;
    assistantText = assistantText.trim()
      ? `${assistantText} ${VOICE_EMPTY_REPLY_FALLBACK}`
      : VOICE_EMPTY_REPLY_FALLBACK;
    await emitSpeakableText(VOICE_EMPTY_REPLY_FALLBACK);
  };

  // ── Forced refusal short-circuit (input guardrails) ──────────────────────
  // The voice socket has already decided the user input is unsafe and supplied
  // a spoken refusal. Skip the LLM entirely; route the refusal straight to TTS
  // through the same onSegment plumbing so the timing breakdown still works.
  const forced = options.forcedAssistantText?.trim();
  if (forced && !signal.aborted) {
    assistantText = forced;
    emitAgentJourney(journey, { kind: "agent.reply.forced_skip_llm", reason: "input_guardrail" });
    await emitSpeakableText(forced);
    const out = sanitizeAssistantFullText(stripAssistantFullMessage(assistantText));
    emitAgentJourney(journey, {
      kind: "agent.reply.exit",
      assistantChars: out.length,
      llmTtftMsReported: 0,
      hadSecondPass: false,
      routingTag: "GENERAL",
    });
    return {
      assistantText: out,
      llmTtftMs: 0,
      llmPostFirstTokenMs: 0,
      routingTag: "GENERAL",
    };
  }

  const firstPass = await streamVoiceAgentPass(
    baseMessages,
    signal,
    options.userLocationContextLine,
    options.sessionContextBlock,
    options.voicePersona,
    options.directMemoryBlock,
    options.workflowContextBlock,
    1,
    journey,
    async (text, meta) => {
      assistantText += text;
      if (meta.segmentIndex === 0) {
        llmPostFirstTokenMs = meta.llmPostFirstTokenMs;
      }
      await emitSpeakableText(text);
    },
    isFirstFlush,
  );

  llmTtftMs = firstPass.llmTtftMs;
  isFirstFlush = firstPass.isFirstFlush;
  const routingTag = firstPass.routingTag;
  let toolExecMs: number | undefined;
  let toolName: string | undefined;
  if (firstPass.toolRequest && !signal.aborted) {
    const tTool0 = Date.now();
    emitAgentJourney(journey, { kind: "tool.execute.begin", tool: firstPass.toolRequest.name });
    toolExecution = await resolveVoiceTool(
      firstPass.toolRequest,
      signal,
      options.voiceToolSession,
      options.onWeatherWidget,
    );
    toolExecMs = Date.now() - tTool0;
    toolName = firstPass.toolRequest.name;
    emitAgentJourney(journey, {
      kind: "tool.execute.end",
      tool: firstPass.toolRequest.name,
      ms: toolExecMs,
      ok: Boolean(toolExecution),
    });
  } else {
    toolExecution = null;
  }

  if (!toolExecution || signal.aborted) {
    await finalizeAssistantText();
    const out = sanitizeAssistantFullText(stripAssistantFullMessage(assistantText));
    emitAgentJourney(journey, {
      kind: "agent.reply.exit",
      assistantChars: out.length,
      llmTtftMsReported: llmTtftMs,
      hadSecondPass: false,
      routingTag,
    });
    return {
      assistantText: out,
      llmTtftMs,
      llmPostFirstTokenMs,
      routingTag,
      toolExecMs,
      toolName,
    };
  }

  const continuationMessages: ModelMessage[] = [
    ...baseMessages,
    {
      role: "assistant",
      content: assistantText.trim() || "Let me check that quickly.",
    },
    {
      role: "user",
      content:
        `${createVoiceToolContext(toolExecution)}\n\n`
        + "Continue your spoken answer using ONLY the facts above (the live tool result for this turn). "
        + "Do not invent numbers, names, dates, prices, confirmation IDs, or details that are not present in those facts. "
        + "If the facts above contradict your earlier opening line, follow the facts. "
        + "Do not repeat your opening line. Do not call the same tool again.",
    },
  ];

  // ── Deterministic-reply fast path (skips second LLM pass) ─────────────────
  // For predictable slot-collection turns we already know exactly which
  // question comes next — no need to round-trip the LLM again. This shaves
  // ~1–2s of TTFT per slot-update turn.
  const deterministicReply = options.deterministicReplyAfterTool?.(
    firstPass.toolRequest!.name,
  )?.trim();
  if (deterministicReply) {
    // Refresh the workflow block (also syncs the UI sidebar) for parity with
    // the slow path, even though we won't run the LLM with it.
    if (
      firstPass.toolRequest?.name === WORKFLOW_UPDATE_RESERVATION_SLOTS
      && options.reloadWorkflowContextBlock
    ) {
      emitAgentJourney(journey, { kind: "workflow.reload_context.begin" });
      const w0 = Date.now();
      const fresh = await options.reloadWorkflowContextBlock();
      emitAgentJourney(journey, {
        kind: "workflow.reload_context.end",
        ms: Date.now() - w0,
        applied: Boolean(fresh?.trim()),
      });
    }
    if (!signal.aborted) {
      assistantText += `${assistantText.trim() ? " " : ""}${deterministicReply}`;
      await emitSpeakableText(deterministicReply);
    }
    const out = sanitizeAssistantFullText(stripAssistantFullMessage(assistantText));
    emitAgentJourney(journey, {
      kind: "agent.reply.exit",
      assistantChars: out.length,
      llmTtftMsReported: llmTtftMs,
      hadSecondPass: false,
      routingTag,
    });
    return {
      assistantText: out,
      llmTtftMs,
      llmPostFirstTokenMs,
      routingTag,
      toolExecMs,
      toolName,
    };
  }

  let secondPassWorkflowBlock = options.workflowContextBlock;
  if (
    firstPass.toolRequest?.name === WORKFLOW_UPDATE_RESERVATION_SLOTS
    && options.reloadWorkflowContextBlock
  ) {
    emitAgentJourney(journey, { kind: "workflow.reload_context.begin" });
    const w0 = Date.now();
    const fresh = await options.reloadWorkflowContextBlock();
    const applied = Boolean(fresh?.trim());
    if (applied) secondPassWorkflowBlock = fresh!.trim();
    emitAgentJourney(journey, {
      kind: "workflow.reload_context.end",
      ms: Date.now() - w0,
      applied,
    });
  }

  const secondPass = await streamVoiceAgentPass(
    continuationMessages,
    signal,
    options.userLocationContextLine,
    options.sessionContextBlock,
    options.voicePersona,
    options.directMemoryBlock,
    secondPassWorkflowBlock,
    2,
    journey,
    async (text, meta) => {
      assistantText += `${assistantText.trim() ? " " : ""}${text}`;
      if (llmPostFirstTokenMs === undefined && meta.segmentIndex === 0) {
        llmPostFirstTokenMs = meta.llmPostFirstTokenMs;
      }
      await emitSpeakableText(text);
    },
    isFirstFlush,
  );

  const pass2LlmTtftMs = secondPass.llmTtftMs;
  llmTtftMs = Math.max(llmTtftMs, pass2LlmTtftMs);

  await finalizeAssistantText();

  const out = sanitizeAssistantFullText(stripAssistantFullMessage(assistantText));
  emitAgentJourney(journey, {
    kind: "agent.reply.exit",
    assistantChars: out.length,
    llmTtftMsReported: llmTtftMs,
    hadSecondPass: true,
    routingTag,
  });

  return {
    assistantText: out,
    llmTtftMs,
    llmPostFirstTokenMs,
    routingTag,
    toolExecMs,
    toolName,
    pass2LlmTtftMs,
  };
}

async function resolveVoiceTool(
  request: VoiceToolRequest,
  signal: AbortSignal,
  voiceToolSession: VoiceToolSessionContext | undefined,
  onWeatherWidget: ((payload: VoiceWeatherWidgetPayload) => void) | undefined,
): Promise<VoiceToolExecution | null> {
  try {
    const execution = await executeVoiceTool(request, signal, voiceToolSession);
    if (execution.weatherWidget) onWeatherWidget?.(execution.weatherWidget);
    logger.info("Voice custom tool resolved", {
      tool: request.name,
      location: request.arguments?.location,
    });
    return execution;
  } catch (err) {
    if ((err as Error).name === "AbortError") return null;
    logger.warn("Voice custom tool failed", {
      tool: request.name,
      location: request.arguments?.location,
      err,
    });
    return {
      request,
      contextText: "The live weather tool failed. Apologize briefly and ask the user to try again or clarify the location.",
    };
  }
}

async function streamVoiceAgentPass(
  messages: ModelMessage[],
  signal: AbortSignal,
  userLocationContextLine: string,
  sessionContextBlock: string | undefined,
  voicePersona: VoicePersonaId,
  directMemoryBlock: string | undefined,
  workflowContextBlock: string | undefined,
  pass: 1 | 2,
  onAgentJourney: ((e: VoiceAgentJourneyEvent) => void) | undefined,
  onText: (text: string, meta: {
    segmentIndex: number;
    triggerAt: number;
    llmPostFirstTokenMs?: number;
  }) => Promise<void>,
  initialIsFirstFlush: boolean,
): Promise<{
  llmTtftMs: number;
  isFirstFlush: boolean;
  toolRequest: VoiceToolRequest | null;
  routingTag?: LlmRoutingTag;
}> {
  const passBeginAt = Date.now();
  emitAgentJourney(onAgentJourney, {
    kind: "llm.pass.begin",
    pass,
    messageCount: messages.length,
  });

  let llmTtftMs = 0;
  let sawFirstToken = false;
  let firstTokenAt = 0;
  let segmentIndex = 0;
  let isFirstFlush = initialIsFirstFlush;
  let buffer = "";
  let toolBuffer = "";
  let collectingTool = false;
  let activeToolCloser: string = "</tool>";
  let activeToolLabel: string = "xml";
  let toolRequest: VoiceToolRequest | null = null;

  // ── Routing-tag detection state ──────────────────────────────────────────
  // Only when NOT in workflow mode (base prompt includes the tag instruction).
  const parseIntentTags = Boolean(workflowContextBlock?.trim()) === false;
  let firstLineParsed = !parseIntentTags;
  let routingTag: LlmRoutingTag | undefined;

  emitAgentJourney(onAgentJourney, { kind: "llm.streamText.before", pass });
  const llmRequestSentAt = Date.now();
  const result = streamText({
    model: getVoiceAgentModel(),
    system: getVoiceAgentSystemPrompt(userLocationContextLine, voicePersona, {
      ...(sessionContextBlock?.trim() ? { sessionContextBlock: sessionContextBlock.trim() } : {}),
      directMemoryBlock,
      workflowContextBlock,
    }),
    messages,
    maxOutputTokens: 240,
    temperature: 0.55,
    abortSignal: signal,
    ...getVoiceAgentStreamTextOverrides(),
  });
  emitAgentJourney(onAgentJourney, { kind: "llm.streamText.after", pass });

  const flushSpeakableChunks = async (forceTail = false): Promise<void> => {
    while (!signal.aborted) {
      const safeBuffer = getBufferSafeBeforePossibleToolTag(buffer, forceTail);
      const chunk = forceTail
        ? safeBuffer.trim()
        : takeSpeakablePrefix(safeBuffer, isFirstFlush)?.spoken;
      if (!chunk) break;

      buffer = buffer.slice(chunk.length);
      isFirstFlush = false;
      const triggerAt = Date.now();
      const idx = segmentIndex;
      const llmPostFirstTokenMs = idx === 0
        ? triggerAt - (sawFirstToken ? firstTokenAt : llmRequestSentAt)
        : undefined;

      if (idx === 0) {
        logger.info("LLM segment[0] flush", {
          segmentIndex: idx,
          chars: chunk.length,
          preview: chunk.slice(0, 60),
          msSinceLlmStart: triggerAt - llmRequestSentAt,
          llmPostFirstTokenMs,
        });
      } else {
        logger.info("LLM segment flush", {
          segmentIndex: idx,
          chars: chunk.length,
          preview: chunk.slice(0, 60),
          msSinceLlmStart: triggerAt - llmRequestSentAt,
        });
      }

      emitAgentJourney(onAgentJourney, {
        kind: "llm.speakable_flush",
        pass,
        segmentIndex: idx,
        chars: chunk.length,
        msSincePassBegin: triggerAt - passBeginAt,
      });

      await onText(chunk, {
        segmentIndex: segmentIndex++,
        triggerAt,
        llmPostFirstTokenMs,
      });
    }
  };

  // Use fullStream (not textStream): provider failures are emitted as `{ type: "error" }`
  // chunks; textStream drops them, so the loop would end with empty text → false AGENT_EMPTY.
  for await (const part of result.fullStream) {
    if (signal.aborted) break;
    if (part.type === "error") {
      const e = part.error;
      throw e instanceof Error ? e : new Error(typeof e === "string" ? e : JSON.stringify(e));
    }
    if (part.type !== "text-delta") continue;
    if (!sawFirstToken) {
      sawFirstToken = true;
      firstTokenAt = Date.now();
      llmTtftMs = firstTokenAt - llmRequestSentAt;
      logger.info("LLM TTFT (first token)", { llmTtftMs, pass });
      emitAgentJourney(onAgentJourney, {
        kind: "llm.first_text_delta",
        pass,
        ttftRequestToFirstTokenMs: llmTtftMs,
      });
    }

    if (collectingTool) {
      toolBuffer += part.text;
    } else {
      buffer += part.text;
    }

    // ── First-line routing-tag detection (general / idle mode ONLY) ────────
    // In workflow mode the system prompt does not ask for tags; if we parsed
    // here, bracketed text (e.g. a menu item) could be misread as [GENERAL]
    // and break UX + routing.
    if (parseIntentTags && !firstLineParsed && !collectingTool) {
      const nlIdx = buffer.indexOf("\n");
      if (nlIdx !== -1) {
        const firstLine = buffer.slice(0, nlIdx).trim();
        if (firstLine === "[RESERVATION]") {
          routingTag = "RESERVATION";
          buffer = buffer.slice(nlIdx + 1);
          logger.info("LLM routing tag detected", { tag: "RESERVATION" });
          emitAgentJourney(onAgentJourney, { kind: "llm.routing_tag", pass, tag: "RESERVATION" });
        } else if (firstLine === "[GENERAL]") {
          routingTag = "GENERAL";
          buffer = buffer.slice(nlIdx + 1);
          logger.info("LLM routing tag detected", { tag: "GENERAL" });
          emitAgentJourney(onAgentJourney, { kind: "llm.routing_tag", pass, tag: "GENERAL" });
        }
        firstLineParsed = true;
      } else if (!buffer.trimStart().startsWith("[") && buffer.length > 25) {
        // Buffer is too long and doesn't look like a tag — skip detection.
        firstLineParsed = true;
      }
    }

    const opener = collectingTool ? null : findEarliestToolOpener(buffer);
    if (opener) {
      toolBuffer = buffer.slice(opener.contentStart);
      // Drop short label fragments right before the fence — small models
      // emit things like "weather```json{...}" where "weather" is a tool-name
      // hint, not actual speech. Keep the part up to the last sentence
      // terminator; discard a trailing fragment shorter than ~40 chars.
      buffer = trimTrailingToolLabel(buffer.slice(0, opener.openerIdx));
      activeToolCloser = opener.closer;
      activeToolLabel = opener.label;
      logger.info("Tool block opener detected", {
        label: opener.label,
        openerIdx: opener.openerIdx,
        bufferAfterTrim: buffer.length,
      });
      emitAgentJourney(onAgentJourney, { kind: "llm.tool_opener", pass, label: opener.label });
      await flushSpeakableChunks(true);
      collectingTool = true;
    }

    if (collectingTool) {
      const toolEndIndex = toolBuffer.indexOf(activeToolCloser);
      if (toolEndIndex !== -1) {
        const rawTool = toolBuffer.slice(0, toolEndIndex);
        const afterTool = toolBuffer.slice(toolEndIndex + activeToolCloser.length);
        const parsed = parseVoiceToolRequest(rawTool);
        if (parsed) {
          toolRequest = parsed;
          logger.info("Voice custom tool requested", {
            tool: toolRequest.name,
            location: toolRequest.arguments?.location,
            delimiter: activeToolLabel,
          });
          emitAgentJourney(onAgentJourney, { kind: "llm.tool_parse_ok", pass, tool: toolRequest.name });
          break;
        }
        logger.warn("Voice custom tool block ignored (malformed or unknown tool)", {
          rawTool: rawTool.slice(0, 200),
          delimiter: activeToolLabel,
        });
        buffer += afterTool;
        toolBuffer = "";
        collectingTool = false;
        await flushSpeakableChunks();
      }
    } else {
      await flushSpeakableChunks();
    }
  }

  if (!toolRequest && collectingTool && toolBuffer.trim()) {
    const salvaged = parseVoiceToolRequest(toolBuffer);
    if (salvaged) {
      toolRequest = salvaged;
      logger.info("Voice custom tool parsed from stream tail (no closing tag)", {
        tool: salvaged.name,
      });
      emitAgentJourney(onAgentJourney, { kind: "llm.tool_parse_tail", pass, tool: salvaged.name });
    } else {
      logger.warn("Voice <tool> block ended without </tool>; inner payload discarded", {
        preview: toolBuffer.slice(0, 120),
      });
    }
  }

  const tail = buffer.trim();
  if (tail && !signal.aborted && !toolRequest) await flushSpeakableChunks(true);

  emitAgentJourney(onAgentJourney, {
    kind: "llm.pass.stream_reader_done",
    pass,
    hadToolRequest: Boolean(toolRequest),
  });

  return {
    llmTtftMs,
    isFirstFlush,
    toolRequest,
    routingTag,
  };
}

/**
 * Hold back any tail of the buffer that *might* still be the partial start of
 * a tool-block opener so we don't flush half a delimiter (e.g. ``` `, `<tool`,
 * ` ```js`) into TTS where it would be read aloud as audio.
 *
 * Scans for the latest position whose suffix is a non-empty prefix of any
 * registered opener (`<tool>`, ` ```json`, ` ``` `). When one is found we
 * trim back to that position; otherwise the full buffer is safe to consider.
 */
function getBufferSafeBeforePossibleToolTag(buffer: string, forceTail: boolean): string {
  if (forceTail) return buffer;
  // Look for the trailing partial (start anywhere, but only the suffix of the
  // buffer can be in-flight). Walk back up to ~10 chars (longest opener is
  // "```json" = 7) and check each suffix.
  const maxLook = Math.min(buffer.length, 10);
  for (let len = maxLook; len >= 1; len--) {
    const suffix = buffer.slice(buffer.length - len);
    if (isPotentialToolOpenerPrefix(suffix)) {
      return buffer.slice(0, buffer.length - len);
    }
  }
  return buffer;
}

/**
 * Trim a trailing "tool label" fragment that small models emit right before
 * a markdown JSON fence — e.g. `... for you. weather` becomes `... for you.`.
 * Conservative on purpose: only drop a SINGLE-token tail (no whitespace) so
 * multi-word real speech like "checking now" is never swallowed.
 */
function trimTrailingToolLabel(buffer: string): string {
  const trimmed = buffer.replace(/[\s:.,;-]+$/u, "");
  if (!trimmed) return "";
  const lastTerminator = Math.max(
    trimmed.lastIndexOf("."),
    trimmed.lastIndexOf("!"),
    trimmed.lastIndexOf("?"),
    trimmed.lastIndexOf("\n"),
  );
  if (lastTerminator >= 0) {
    const head = trimmed.slice(0, lastTerminator + 1);
    const tail = trimmed.slice(lastTerminator + 1).trim();
    // Drop only if tail is a single bare token (no spaces, plain identifier).
    if (tail && tail.length <= 30 && !/\s/.test(tail) && /^[\w_-]+$/.test(tail)) {
      return head;
    }
    return trimmed;
  }
  // No terminator yet — only drop if the whole tail is a single bare token.
  if (trimmed.length <= 30 && !/\s/.test(trimmed) && /^[\w_-]+$/.test(trimmed)) {
    return "";
  }
  return trimmed;
}

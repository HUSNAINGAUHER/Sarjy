/**
 * Voice pipeline — Deepgram Flux STT + Vercel AI SDK (streamText) + Aura-2 TTS WebSocket
 *
 * STT : Deepgram Flux v2 (EagerEndOfTurn / TurnResumed / EndOfTurn)
 * LLM : Vercel AI SDK streamText (provider via VOICE_LLM_PROVIDER, model via VOICE_LLM_MODEL)
 * TTS : Deepgram TTS WebSocket — one persistent connection per voice session,
 *       opened eagerly on voice:start so the 800 ms connect cost is paid once.
 *
 * Per-turn flow
 * ─────────────
 *  1. LLM segments are sent to the warm WS as they arrive (non-blocking).
 *  2. Deepgram streams back binary PCM in real time.
 *  3. Turn completion is detected via Flush / Flushed event counting —
 *     no WS close needed between turns.
 *  4. Barge-in / cancel → `Clear` message resets Deepgram's buffer without
 *     tearing down the connection.
 *  5. voice:stop / disconnect → `Close` + ws.close() tears down cleanly.
 */
import { getCartesiaPersonaTtsSettings } from "@/config/cartesiaVoicePersonas";
import { env } from "@/config/env";
import { evaluateUserInput } from "@/services/guardrails/inputGuardrails";
import { scheduleMemoryExtraction } from "@/services/memoryExtractor";
import { getDirectMemoryPromptBlock, preloadDirectMemoryCache } from "@/services/memoryLoader";
import { loadConversationForVoice, persistVoiceExchange } from "@/services/sessionBuffer";
import {
  streamVoiceAgentReply,
  VOICE_EMPTY_REPLY_FALLBACK,
  type StreamVoiceAgentReplyOptions,
  type VoiceAgentImageInput,
  type VoiceAgentJourneyEvent,
} from "@/services/voiceAgentReply";
import { VoiceImageContextStore } from "@/services/voiceImageContext";
import { buildVoiceDateTimeContextLine } from "@/services/voiceSessionContextLines";
import { ensureCartesiaTtsWebsocketHandshakeErrorPatch } from "@/sockets/cartesiaTtsHandshakePatch";
import type { VoiceToolSessionContext } from "@/tools/types";
import "@/tools/voiceTools";
import { fetchWeatherSnapshotForCoordinates } from "@/tools/weatherTool";
import { logger } from "@/utils/logger";
import { VoiceSessionJourneyLog } from "@/utils/voiceSessionJourneyLog";
import {
  formatVoiceAgentLlmError,
  getVoiceLlmErrorSpokenLine,
  voiceAgentLlmErrorCode,
} from "@/utils/voiceAgentErrors";
import { prisma } from "@/db/client";
import { workflowOrchestrator } from "@/workflow";
import { buildDeterministicSlotPrompt } from "@/workflow/engine/ResponsePlanner";
import { WORKFLOW_UPDATE_RESERVATION_SLOTS } from "@/workflow/tools/workflowVoiceTools";
import { DUMMY_VOICE_RESTAURANTS } from "@/workflow/data/dummyVoiceRestaurants";
import type { OrchestratorResult } from "@/workflow/state/types";
import { Cartesia } from "@cartesia/cartesia-js";
import type * as DeepgramTypes from "@deepgram/sdk";
import { DeepgramClient } from "@deepgram/sdk";
import {
  isVoicePersonaId,
  type ClientToServerEvents,
  type InterServerEvents,
  type ServerToClientEvents,
  type SocketData,
  type VoicePersonaId,
  type VoiceReservationProgressPayload,
  type VoiceRestaurantPickerPayload,
  type VoiceTtsTimingBreakdown,
  type VoiceWeatherWidgetPayload,
} from "@sarjy/shared-types";
import type { ModelMessage, UserContent } from "ai";
import path from "node:path";
import type { Socket } from "socket.io";
import WebSocket from "ws";

type ListenV2TurnInfo = DeepgramTypes.listen.ListenV2TurnInfo;

type AppSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

type V2Socket = Awaited<
  ReturnType<InstanceType<typeof DeepgramClient>["listen"]["v2"]["connect"]>
>;
type CartesiaTtsWs = Awaited<ReturnType<Cartesia["tts"]["websocket"]>>;

const TTS_MODEL = "aura-2-thalia-en";
const TTS_SAMPLE_RATE = 24000;
const TTS_ENCODING = "linear16";
const TTS_WS_URL = `wss://api.deepgram.com/v1/speak?model=${TTS_MODEL}&encoding=${TTS_ENCODING}&sample_rate=${TTS_SAMPLE_RATE}`;

const MAX_CONVERSATION_MESSAGES = 30;

/**
 * Spoken once per voice session when the TTS WebSocket is ready (before first
 * user turn). Personalised with the user's first name + a time-of-day greeting
 * derived from the client's timezone (falls back to server time if absent).
 */
function buildVoiceConnectionWelcomeLine(
  userName: string | null | undefined,
  clientTz: string | null | undefined,
): string {
  let hour: number;
  try {
    const tz = clientTz?.trim();
    const fmt = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      ...(tz ? { timeZone: tz } : {}),
    });
    hour = Number(fmt.format(new Date()));
    if (!Number.isFinite(hour)) hour = new Date().getHours();
  } catch {
    hour = new Date().getHours();
  }
  let greeting: string;
  if (hour < 12) greeting = "Good morning";
  else if (hour < 17) greeting = "Good afternoon";
  else greeting = "Good evening";
  const firstName = userName?.trim().split(/\s+/)[0];
  const namePart = firstName ? ` ${firstName}` : "";
  return `Hi${namePart}, ${greeting}. How can I help you today?`;
}

// ── REST TTS (error apology only — single short string) ──────────────────────

async function streamTTSEchoRest(
  socket: AppSocket,
  text: string,
  triggerAt: number,
  abortSignal: AbortSignal,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed || abortSignal.aborted) return;
  const url = `https://api.deepgram.com/v1/speak?model=${TTS_MODEL}&encoding=${TTS_ENCODING}&sample_rate=${TTS_SAMPLE_RATE}&container=none`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: trimmed }),
      signal: abortSignal,
    });
  } catch (err) {
    if ((err as Error).name !== "AbortError") logger.warn("Apology TTS REST failed", { err });
    return;
  }
  if (!response.ok) { logger.warn("Apology TTS REST non-OK", { status: response.status }); return; }
  const reader = response.body!.getReader();
  let first = true;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || abortSignal.aborted) break;
      if (first) { socket.emit("voice:ttsStart"); first = false; }
      socket.emit("voice:ttsChunk", Buffer.from(value));
    }
  } catch { /* ignore */ }
  if (!first && !abortSignal.aborted) {
    socket.emit("voice:ttsEnd", { ttfaMs: Date.now() - triggerAt, totalMs: Date.now() - triggerAt });
  }
}


// ── Session handlers ──────────────────────────────────────────────────────────

export function registerVoiceHandlers(socket: AppSocket): void {
  const journeyLogDir = env.VOICE_SESSION_JOURNEY_LOG_DIR?.trim()
    ? env.VOICE_SESSION_JOURNEY_LOG_DIR.trim()
    : path.join(process.cwd(), "logs", "voice-sessions");

  let voiceJourney: VoiceSessionJourneyLog | null = null;
  let journeyTurnSeq = 0;
  /** Set at each `runAgentPipeline` entry so TTS logs tie to the active turn. */
  let activePipelineTurnId = 0;

  function emitVoiceAgentJourney(ev: VoiceAgentJourneyEvent): void {
    voiceJourney?.step("AGENT", ev.kind, { payload: JSON.stringify(ev) });
  }

  // ── STT (Flux) state ────────────────────────────────────────────────────────
  let dgSocket: V2Socket | null = null;
  let isFluxOpen = false;
  let pendingChunks: ArrayBuffer[] = [];

  // ── Pipeline state ──────────────────────────────────────────────────────────
  let pipelineAbort: AbortController | null = null;
  let isTtsStreaming = false;
  let inFlightUserText: string | null = null;
  let conversation: ModelMessage[] = [];
  let clientLocation: { latitude: number; longitude: number } | null = null;

  // ── Cached weather snapshot for prep-time session context ────────────────
  // Previously fetched on every turn (~1s wall on the LLM critical path). It's
  // only orientation context — the real `weather` tool handles user-asked
  // lookups. Cache per-session with a TTL; refresh in the background when stale
  // so context_prep never blocks on the network.
  const WEATHER_SNAPSHOT_TTL_MS = 5 * 60_000; // 5 min — orientation only
  let cachedWeatherSnapshot: {
    snapshot: string;
    fetchedAt: number;
    lat: number;
    lon: number;
  } | null = null;
  let weatherRefreshInFlight = false;
  function refreshWeatherSnapshotInBackground(
    lat: number,
    lon: number,
  ): void {
    if (weatherRefreshInFlight) return;
    weatherRefreshInFlight = true;
    void fetchWeatherSnapshotForCoordinates(lat, lon, AbortSignal.timeout(4000))
      .then((snap) => {
        if (snap) {
          cachedWeatherSnapshot = { snapshot: snap, fetchedAt: Date.now(), lat, lon };
        }
      })
      .catch(() => { /* keep prior cache; never break voice */ })
      .finally(() => {
        weatherRefreshInFlight = false;
      });
  }
  function getFreshWeatherSnapshotOrTriggerRefresh(): string | null {
    if (!clientLocation) return null;
    const { latitude, longitude } = clientLocation;
    const now = Date.now();
    const cache = cachedWeatherSnapshot;
    const sameCoord = cache
      && Math.abs(cache.lat - latitude) < 0.05
      && Math.abs(cache.lon - longitude) < 0.05;
    const fresh = sameCoord && now - cache!.fetchedAt < WEATHER_SNAPSHOT_TTL_MS;
    if (!fresh) refreshWeatherSnapshotInBackground(latitude, longitude);
    return sameCoord ? cache!.snapshot : null;
  }
  /** Browser IANA timezone from `voice:start` (for clock context in the system prompt). */
  let clientTimeZone: string | null = null;
  let voicePersona: VoicePersonaId = "jolly";
  let welcomePlaybackAbort: AbortController | null = null;
  let cancelWelcomeCartesia: (() => void) | null = null;
  /** Ensures we only enqueue one connection greeting per `voice:start`. */
  let sessionConnectionWelcomeEnqueued = false;
  let activeUserId: string | null = null;
  let activeUserName: string | null = null;
  let activeSessionId: string | null = null;
  /** Per-socket image attachment store (cleared on voice:stop / disconnect). */
  const imageContext = new VoiceImageContextStore();

  function buildUserLocationContextLine(): string {
    if (clientLocation) {
      return (
        `Approximate coordinates are on file: latitude ${clientLocation.latitude.toFixed(4)}, longitude ${clientLocation.longitude.toFixed(4)}. `
        + "For weather when the user does not name a place, call the weather tool with \"location\": null. "
        + "When they name a place, pass that name as location."
      );
    }
    return (
      "No coordinates on file yet. For weather when the user does not name a place, say in one or two sentences that you would like their location for a nearby forecast, "
      + "that their browser may show a permission prompt while you are speaking, and that after they allow it you can give local weather — "
      + "then still call the weather tool with \"location\": null so the app can request GPS and wait briefly."
    );
  }

  const voiceToolSession: VoiceToolSessionContext = {
    getClientLocation: () => clientLocation,
    signalNeedClientLocation: () => {
      socket.emit("voice:requestLocation", { reason: "weather" });
    },
  };

  function voiceAgentReplyOptionsBase() {
    return {
      userLocationContextLine: buildUserLocationContextLine(),
      voicePersona,
      voiceToolSession,
      onWeatherWidget: (payload: VoiceWeatherWidgetPayload) => {
        socket.emit("voice:weatherWidget", payload);
      },
    };
  }

  /** Show or hide the restaurant picker based on cached workflow state (no DB). */
  function syncRestaurantPickerUi(): void {
    if (!activeSessionId) {
      socket.emit("voice:restaurantPickerHide");
      return;
    }
    const st = workflowOrchestrator.peekCachedState(activeSessionId);
    const show =
      st?.activeFlow === "restaurant_reservation"
      && st.currentStep === "COLLECTING_RESTAURANT"
      && !st.slots.restaurant;
    if (!show) {
      socket.emit("voice:restaurantPickerHide");
      return;
    }
    const payload: VoiceRestaurantPickerPayload = {
      options: DUMMY_VOICE_RESTAURANTS.map((r) => ({
        id: r.id,
        name: r.name,
        cuisine: r.cuisine,
        rating: r.rating,
        area: r.area,
      })),
    };
    socket.emit("voice:restaurantPicker", payload);
  }

  function buildVoiceReservationProgressPayload(
    sessionId: string | null,
  ): VoiceReservationProgressPayload | null {
    if (!sessionId) return null;
    const st = workflowOrchestrator.peekCachedState(sessionId);
    if (!st || st.activeFlow !== "restaurant_reservation") return null;
    if (
      st.currentStep === "IDLE"
      || st.currentStep === "COMPLETED"
      || st.currentStep === "CANCELLED"
    ) {
      return null;
    }
    return {
      currentStep: st.currentStep,
      slots: { ...st.slots },
      pendingConfirmation: st.pendingConfirmation,
    };
  }

  function emitReservationProgress(): void {
    socket.emit("voice:reservationProgress", buildVoiceReservationProgressPayload(activeSessionId));
  }

  /** Restaurant picker tiles + reservation sidebar snapshot for the client. */
  function syncReservationSidebarUi(): void {
    syncRestaurantPickerUi();
    emitReservationProgress();
  }

  /**
   * Loads memory + workflow in parallel. `contextPrepMs` on the client is
   * wall clock for this await (≈ max of the two branches).
   */
  async function voiceAgentReplyOptionsForTurn(userText: string, opts?: {
    forcedAssistantText?: string;
    pendingImages?: VoiceAgentImageInput[];
    onAgentJourney?: (e: VoiceAgentJourneyEvent) => void;
  }): Promise<{
    options: StreamVoiceAgentReplyOptions;
    prep: {
      wallMs: number;
      memoryMs: number;
      workflowMs: number;
      workflow: OrchestratorResult;
    };
  }> {
    const base = voiceAgentReplyOptionsBase();
    const wallStart = Date.now();
    voiceJourney?.step("TURN.context_prep", "begin", {
      userTextLen: userText.length,
      turnId: activePipelineTurnId,
    });

    let memoryMs = 0;
    const memoryTask = (async (): Promise<string> => {
      const t0 = Date.now();
      if (!activeUserId) return "";
      const block = await getDirectMemoryPromptBlock(activeUserId);
      memoryMs = Date.now() - t0;
      return block;
    })();

    let workflowMs = 0;
    const workflowTask = (async () => {
      const t0 = Date.now();
      const r = await workflowOrchestrator.process(userText, activeSessionId);
      workflowMs = Date.now() - t0;
      return r;
    })();

    // Weather snapshot is read from a per-session cache; if stale or missing
    // we kick a refresh in the background instead of blocking this turn.
    const effectiveWeatherSnapshot = getFreshWeatherSnapshotOrTriggerRefresh();

    const [directMemoryBlock, workflowResult] = await Promise.all([
      memoryTask,
      workflowTask,
    ]);
    const wallMs = Date.now() - wallStart;

    // ── Memory leak diagnostics ────────────────────────────────────────────
    // Prints exactly what memory block + how many prior messages this turn is
    // about to pass to the LLM, plus a flag for any leaked-token red flags.
    // Search the logs for "MEMLEAK" to gather data.
    const priorChars = conversation.reduce(
      (n, m) => n + (typeof m.content === "string" ? m.content.length : 0),
      0,
    );
    const lastFew = conversation.slice(-4).map((m) => ({
      role: m.role,
      preview: typeof m.content === "string" ? m.content.slice(0, 160) : "[multimodal]",
    }));
    const memoryHasBlue = /\bblue\b/i.test(directMemoryBlock);
    const conversationHasBlue = conversation.some(
      (m) => typeof m.content === "string" && /\bblue\b/i.test(m.content),
    );
    logger.info("[MEMLEAK] turn context snapshot", {
      activeUserId,
      activeSessionId,
      activeUserName,
      userTextPreview: userText.slice(0, 200),
      directMemoryChars: directMemoryBlock.length,
      directMemoryPreview: directMemoryBlock.slice(0, 400),
      priorMessageCount: conversation.length,
      priorChars,
      priorTail: lastFew,
      flags: {
        memoryHasBlue,
        conversationHasBlue,
      },
    });

    const sessionContextLines = [
      "Session context (prep-time orientation only; for booking dates or a live weather refresh, use tools — the weather tool is authoritative when the user asks for conditions):",
      buildVoiceDateTimeContextLine(clientTimeZone),
    ];
    if (effectiveWeatherSnapshot) {
      sessionContextLines.push(
        "",
        "Weather snapshot near the user's device location (from GPS at prep time; may be stale over a long chat):",
        effectiveWeatherSnapshot,
      );
    }
    const sessionContextBlock = sessionContextLines.join("\n");

    logger.info("Voice prep (memory ∥ workflow)", {
      wallMs,
      memoryPrepMs: memoryMs,
      workflowOrchestrationMs: workflowMs,
      detectedIntent: workflowResult.detectedIntent,
      intentConfidence: workflowResult.intentConfidence,
      isWorkflowActive: workflowResult.isWorkflowActive,
      step: workflowResult.state.currentStep,
      flow: workflowResult.state.activeFlow,
      hasContextBlock: Boolean(workflowResult.workflowContextBlock),
    });

    const options: StreamVoiceAgentReplyOptions = {
      ...base,
      userLocationContextLine: buildUserLocationContextLine(),
      sessionContextBlock,
      ...(directMemoryBlock.trim() ? { directMemoryBlock: directMemoryBlock.trim() } : {}),
      ...(workflowResult.workflowContextBlock
        ? { workflowContextBlock: workflowResult.workflowContextBlock }
        : {}),
      ...(activeSessionId
        ? {
          reloadWorkflowContextBlock: async () => {
            // Emit updated step/slots to the client immediately after the slot
            // tool mutates state — before the second LLM pass starts so the
            // widget switches in real-time rather than waiting for TTS to finish.
            syncReservationSidebarUi();
            return workflowOrchestrator.buildLiveContextBlock(activeSessionId!);
          },
          // Skip the second LLM pass for deterministic slot collection turns —
          // the next question is fully determined by the new workflow step,
          // so we save ~1–2s of TTFT by emitting it directly to TTS.
          deterministicReplyAfterTool: (toolName: string) => {
            if (toolName !== WORKFLOW_UPDATE_RESERVATION_SLOTS) return null;
            const sessionId = activeSessionId;
            if (!sessionId) return null;
            const state = workflowOrchestrator.peekCachedState(sessionId);
            if (!state) return null;
            return buildDeterministicSlotPrompt(state);
          },
        }
        : {}),
      ...(opts?.pendingImages?.length ? { pendingImages: opts.pendingImages } : {}),
      ...(opts?.forcedAssistantText ? { forcedAssistantText: opts.forcedAssistantText } : {}),
      ...(opts?.onAgentJourney ? { onAgentJourney: opts.onAgentJourney } : {}),
    };

    voiceJourney?.step("TURN.context_prep", "end", {
      wallMs,
      memoryPrepMs: memoryMs,
      workflowOrchestrationMs: workflowMs,
      turnId: activePipelineTurnId,
      detectedIntent: workflowResult.detectedIntent,
      workflowStep: workflowResult.state.currentStep,
      workflowFlow: workflowResult.state.activeFlow ?? "null",
    });

    return { options, prep: { wallMs, memoryMs, workflowMs, workflow: workflowResult } };
  }

  function voicePrepTimingFields(prep: {
    wallMs: number;
    memoryMs: number;
    workflowMs: number;
    workflow: OrchestratorResult;
  }): Pick<
    VoiceTtsTimingBreakdown,
    | "contextPrepMs"
    | "memoryPrepMs"
    | "workflowOrchestrationMs"
    | "workflowIntent"
    | "workflowIntentConfidence"
    | "workflowStep"
    | "workflowActive"
    | "workflowFlowId"
  > {
    const w = prep.workflow;
    return {
      contextPrepMs: prep.wallMs,
      memoryPrepMs: prep.memoryMs,
      workflowOrchestrationMs: prep.workflowMs,
      workflowIntent: w.detectedIntent,
      workflowIntentConfidence: w.intentConfidence,
      workflowStep: w.state.currentStep,
      workflowActive: w.isWorkflowActive,
      workflowFlowId: w.state.activeFlow,
    };
  }

  type WorkflowTimingSlice = Pick<
    VoiceTtsTimingBreakdown,
    "workflowStep" | "workflowActive" | "workflowFlowId" | "workflowIntent" | "workflowIntentConfidence"
  >;

  /**
   * `voicePrepTimingFields` reflects orchestration **before** the LLM stream.
   * `workflow_update_reservation_slots` mutates cache mid-stream — overlay so
   * `voice:ttsEnd` and server logs match the post-turn FSM.
   */
  function postTurnWorkflowTimingOverlay(sessionId: string | null): Partial<WorkflowTimingSlice> {
    if (!sessionId) return {};
    const st = workflowOrchestrator.peekCachedState(sessionId);
    if (!st) return {};
    const active =
      st.activeFlow !== null
      && st.currentStep !== "IDLE"
      && st.currentStep !== "CANCELLED"
      && st.currentStep !== "COMPLETED";
    const slice: WorkflowTimingSlice = {
      workflowStep: st.currentStep,
      workflowActive: active,
      workflowFlowId: st.activeFlow,
      workflowIntent: st.lastIntent ?? "unknown",
      workflowIntentConfidence: active ? "high" : "low",
    };
    return slice;
  }

  async function appendTurnToConversationAndPersist(
    userText: string,
    assistantText: string,
    pendingImages?: VoiceAgentImageInput[],
  ): Promise<void> {
    // The empty-reply fallback ("I didn't quite catch that…") is a recovery
    // line, not a real assistant turn — keep the user's audio experience but
    // skip pollution of chat history and rolling LLM context. Otherwise the
    // model would see this as its own prior message and start parroting it.
    if (assistantText.trim() === VOICE_EMPTY_REPLY_FALLBACK.trim()) {
      logger.info("Skipping persistence of empty-reply fallback", {
        userTextLen: userText.length,
      });
      return;
    }

    // When images were attached this turn, store the multimodal user content
    // in the rolling conversation so subsequent turns ("what about the corner
    // of the picture?") still see them. Persistence below stays text-only.
    const userContent = buildVoiceUserContentForHistory(userText, pendingImages);
    conversation.push(
      { role: "user", content: userContent },
      { role: "assistant", content: assistantText },
    );
    while (conversation.length > MAX_CONVERSATION_MESSAGES) conversation.shift();

    if (!activeUserId || !activeSessionId) return;

    try {
      await persistVoiceExchange({
        sessionId: activeSessionId,
        userId: activeUserId,
        userText,
        assistantText,
      });
    } catch (err) {
      logger.warn("Failed to persist voice exchange", { err, activeSessionId, activeUserId });
    }

    scheduleMemoryExtraction({
      userId: activeUserId,
      sessionId: activeSessionId,
      userText,
      assistantText,
    });
  }

  /** Local copy of buildVoiceUserContent shape (avoids shipping ImagePart from inside the agent module to the socket). */
  function buildVoiceUserContentForHistory(
    text: string,
    images?: VoiceAgentImageInput[],
  ): UserContent {
    if (!images?.length) return text;
    const safeText = text.trim() || "(See the attached image.)";
    return [
      { type: "text", text: safeText },
      ...images.map((img) => ({
        type: "image" as const,
        image: img.data,
        mediaType: img.mediaType,
      })),
    ];
  }

  // ── Session TTS WebSocket — opened once on voice:start ─────────────────────
  let ttsWs: WebSocket | null = null;
  let ttsWsReady = false;
  let ttsWsOpenPromise: Promise<void> | null = null;
  let ttsSessionConnectStartAt = 0;
  let ttsSessionOpenedAt = 0;

  // ── Cartesia TTS WebSocket — alternative provider for realtime comparison ──
  const cartesiaClient = env.CARTESIA_API_KEY ? new Cartesia({ apiKey: env.CARTESIA_API_KEY }) : null;
  let cartesiaWs: CartesiaTtsWs | null = null;
  let cartesiaWsReady = false;
  let cartesiaWsOpenPromise: Promise<void> | null = null;
  let cartesiaSessionConnectStartAt = 0;
  let cartesiaSessionOpenedAt = 0;
  let cancelActiveCartesiaContext: (() => void) | null = null;

  // Per-turn TTS state — reset by resetTurnTtsState()
  let ttsDiscardAudio = false;   // true while a Clear is in-flight; drops arriving audio
  let ttsPendingFlushes = 0;     // Flush messages sent this turn
  let ttsFlushedCount = 0;       // Flushed events received this turn
  let ttsFlushResolve: (() => void) | null = null;
  let ttsClearResolve: (() => void) | null = null;
  let ttsStartEmitted = false;
  let firstAudioAt = 0;
  // metrics
  let ttsChunkCount = 0;
  let ttsTotalBytes = 0;
  let lastChunkAt = 0;
  let lastChunkAudioMs = 0;
  let maxInterChunkGapMs = 0;
  let maxRealtimeDeficitMs = 0;
  let underrunRiskEvents = 0;
  let generatedAudioMs = 0;
  let ttsSegmentCount = 0;
  let firstSegmentSentAt = 0;
  let llmStartedAt = 0;
  let currentTriggerAt = 0;

  function resetTurnTtsState(): void {
    ttsDiscardAudio = false;
    ttsPendingFlushes = 0;
    ttsFlushedCount = 0;
    ttsFlushResolve = null;
    ttsClearResolve = null;
    ttsStartEmitted = false;
    firstAudioAt = 0;
    ttsChunkCount = 0;
    ttsTotalBytes = 0;
    lastChunkAt = 0;
    lastChunkAudioMs = 0;
    maxInterChunkGapMs = 0;
    maxRealtimeDeficitMs = 0;
    underrunRiskEvents = 0;
    generatedAudioMs = 0;
    ttsSegmentCount = 0;
    firstSegmentSentAt = 0;
    llmStartedAt = 0;
  }

  function emitTtsAudioChunk(buf: Buffer, provider: "deepgram" | "cartesia"): void {
    if (ttsDiscardAudio || buf.byteLength === 0) return;

    if (!ttsStartEmitted) {
      socket.emit("voice:ttsStart");
      ttsStartEmitted = true;
      firstAudioAt = Date.now();
      logger.info("TTS first audio", { provider, ttfaMs: firstAudioAt - currentTriggerAt });
      voiceJourney?.step("TTS.first_audio_chunk", provider, {
        turnId: activePipelineTurnId,
        ttfaMsFromTurnTrigger: firstAudioAt - currentTriggerAt,
      });
    }

    ttsChunkCount++;
    ttsTotalBytes += buf.byteLength;
    const chunkAt = Date.now();
    const audioDurationMs = (buf.byteLength / 2 / TTS_SAMPLE_RATE) * 1000;
    generatedAudioMs += audioDurationMs;
    const interChunkGapMs = lastChunkAt > 0 ? chunkAt - lastChunkAt : 0;
    const realtimeDeficitMs = lastChunkAt > 0 ? interChunkGapMs - lastChunkAudioMs : 0;
    if (interChunkGapMs > maxInterChunkGapMs) maxInterChunkGapMs = interChunkGapMs;
    if (realtimeDeficitMs > 20) {
      underrunRiskEvents++;
      if (realtimeDeficitMs > maxRealtimeDeficitMs) maxRealtimeDeficitMs = realtimeDeficitMs;
    }
    // logger.debug("TTS chunk", {
    //   provider,
    //   chunk: ttsChunkCount,
    //   bytes: buf.byteLength,
    //   totalBytes: ttsTotalBytes,
    //   interChunkGapMs,
    //   audioDurationMs: Math.round(audioDurationMs),
    //   realtimeDeficitMs: Math.round(realtimeDeficitMs),
    // });
    socket.emit("voice:ttsChunk", buf);
    lastChunkAt = chunkAt;
    lastChunkAudioMs = audioDurationMs;
  }

  function isCartesiaInvalidContextError(err: unknown): boolean {
    const maybe = err as {
      error?: { title?: string; message?: string; status_code?: number };
      message?: string;
    };
    return (
      maybe.error?.status_code === 400 &&
      (
        maybe.error?.title === "Invalid context ID" ||
        maybe.error?.message?.includes("context ID does not exist") === true ||
        maybe.message?.includes("Invalid context ID") === true
      )
    );
  }

  function appendAssistantTranscript(current: string, segment: string): string {
    const trimmedSegment = segment.trim();
    if (!trimmedSegment) return current;
    return current ? `${current} ${trimmedSegment}` : trimmedSegment;
  }

  function abortSignalPromise(signal: AbortSignal): Promise<never> {
    return new Promise((_, reject) => {
      if (signal.aborted) {
        reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
        { once: true },
      );
    });
  }

  /**
   * Called from the TTS WebSocket `open` path (Deepgram or Cartesia). Plays once per `voice:start`.
   */
  function scheduleConnectionWelcomeWhenTtsReady(): void {
    if (sessionConnectionWelcomeEnqueued) return;
    sessionConnectionWelcomeEnqueued = true;
    void playConnectionWelcome().catch((err) => {
      logger.warn("playConnectionWelcome failed", { err });
    });
  }

  /**
   * Short greeting over the warm TTS WebSocket. Uses `isTtsStreaming` so
   * StartOfTurn barge-in runs `cancelPipeline` and aborts this playback.
   */
  async function playConnectionWelcome(): Promise<void> {
    if (!socket.connected) return;
    welcomePlaybackAbort = new AbortController();
    const signal = welcomePlaybackAbort.signal;
    isTtsStreaming = true;
    resetTurnTtsState();
    const triggerAt = Date.now();
    currentTriggerAt = triggerAt;
    const welcomeLine = buildVoiceConnectionWelcomeLine(activeUserName, clientTimeZone);
    try {
      if (env.VOICE_TTS_PROVIDER === "cartesia") {
        if (!cartesiaClient) return;
        if (!cartesiaWsReady && cartesiaWsOpenPromise) await cartesiaWsOpenPromise;
        if (signal.aborted || !cartesiaWs || !cartesiaWsReady) return;
        const { voiceId, generation_config } = getCartesiaPersonaTtsSettings(voicePersona);
        const ctx = cartesiaWs.context({
          model_id: env.CARTESIA_TTS_MODEL,
          voice: { mode: "id", id: voiceId },
          output_format: {
            container: "raw",
            encoding: "pcm_s16le",
            sample_rate: TTS_SAMPLE_RATE,
          },
          contextId: `${socket.id}-welcome-${Date.now()}`,
          timeout: 30_000,
        });
        cancelWelcomeCartesia = () => {
          void ctx.cancel().catch(() => { /* ignore */ });
        };
        const receiveTask = (async () => {
          try {
            for await (const msg of ctx.receive({ timeout: 60_000 })) {
              if (signal.aborted) break;
              if (msg.type === "chunk" && msg.audio) {
                emitTtsAudioChunk(msg.audio, "cartesia");
              }
            }
          } catch (err) {
            if (!signal.aborted && !isCartesiaInvalidContextError(err)) throw err;
          }
        })();
        // Same contract as agent turns: transcript uses continue:true, then flush,
        // then no_more_inputs. continue:false on the text alone closes the context
        // and makes a following flush hit "Context has closed" (Cartesia 400).
        await ctx.send({
          model_id: env.CARTESIA_TTS_MODEL,
          voice: { mode: "id", id: voiceId },
          output_format: {
            container: "raw",
            encoding: "pcm_s16le",
            sample_rate: TTS_SAMPLE_RATE,
          },
          transcript: welcomeLine,
          continue: true,
          add_timestamps: false,
          generation_config,
        });
        await ctx.flush();
        await ctx.no_more_inputs();
        await receiveTask;
        if (!signal.aborted && ttsStartEmitted) {
          socket.emit("voice:ttsEnd", {
            ttfaMs: firstAudioAt > 0 ? firstAudioAt - triggerAt : Date.now() - triggerAt,
            totalMs: Date.now() - triggerAt,
            assistantText: welcomeLine,
          });
        }
      } else {
        if (!ttsWs || !ttsWsReady) return;
        if (signal.aborted) return;
        ttsSendText(welcomeLine);
        ttsSendFlush();
        try {
          await Promise.race([waitForAllFlushed(), abortSignalPromise(signal)]);
        } catch {
          /* aborted or flush wait ended */
        }
        if (!signal.aborted && ttsStartEmitted) {
          socket.emit("voice:ttsEnd", {
            ttfaMs: firstAudioAt > 0 ? firstAudioAt - triggerAt : Date.now() - triggerAt,
            totalMs: Date.now() - triggerAt,
            assistantText: welcomeLine,
          });
        }
      }
    } catch (err) {
      if (!signal.aborted && (err as Error).name !== "AbortError") {
        logger.warn("Connection welcome TTS failed", { err });
      }
    } finally {
      isTtsStreaming = false;
      welcomePlaybackAbort = null;
      cancelWelcomeCartesia = null;
      if (socket.connected && !signal.aborted) socket.emit("voice:stateChange", "listening");
    }
  }

  // ── Session TTS WS setup ────────────────────────────────────────────────────

  function openSessionTtsWs(): void {
    if (ttsWs) {
      try { ttsWs.close(); } catch { /* ignore */ }
      ttsWs = null;
    }
    ttsWsReady = false;
    ttsSessionConnectStartAt = Date.now();

    const ws = new WebSocket(TTS_WS_URL, {
      headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}` },
    });

    ttsWsOpenPromise = new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    }).then(() => {
      ttsWsReady = true;
      ttsSessionOpenedAt = Date.now();
      logger.info("Session TTS WebSocket ready (warm)", {
        connectMs: ttsSessionOpenedAt - ttsSessionConnectStartAt,
      });
      scheduleConnectionWelcomeWhenTtsReady();
    }).catch((err) => {
      logger.error("Session TTS WebSocket failed to open", { err: (err as Error).message });
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        // ── Audio chunk ─────────────────────────────────────────────────────
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        emitTtsAudioChunk(buf, "deepgram");
      } else {
        // ── Control message ─────────────────────────────────────────────────
        try {
          const msg = JSON.parse((data as Buffer).toString()) as { type?: string; sequence_id?: number };
          logger.debug("TTS WS control", { type: msg.type, sequence_id: msg.sequence_id });
          if (msg.type === "Flushed") {
            ttsFlushedCount++;
            if (ttsFlushedCount >= ttsPendingFlushes && ttsFlushResolve) {
              const cb = ttsFlushResolve;
              ttsFlushResolve = null;
              cb();
            }
          } else if (msg.type === "Cleared") {
            ttsDiscardAudio = false;
            const cb = ttsClearResolve;
            ttsClearResolve = null;
            cb?.();
          }
        } catch { /* ignore parse errors */ }
      }
    });

    ws.on("close", (code, reason) => {
      ttsWsReady = false;
      if (ws === ttsWs) ttsWs = null;
      if (code !== 1000 && code !== 1001) {
        logger.warn("Session TTS WebSocket closed unexpectedly", { code, reason: reason.toString() });
      } else {
        logger.info("Session TTS WebSocket closed", { code });
      }
      // Unblock any pending promises so the pipeline can exit cleanly
      ttsFlushResolve?.(); ttsFlushResolve = null;
      ttsClearResolve?.(); ttsClearResolve = null;
    });

    ws.on("error", (err) => {
      logger.error("Session TTS WebSocket error", { err: err.message });
      ttsWsReady = false;
      ttsFlushResolve?.(); ttsFlushResolve = null;
      ttsClearResolve?.(); ttsClearResolve = null;
    });

    ttsWs = ws;
  }

  function closeSessionTtsWs(): void {
    if (!ttsWs) return;
    try {
      if (ttsWsReady) ttsWs.send(JSON.stringify({ type: "Close" }));
      ttsWs.close();
    } catch { /* ignore */ }
    ttsWs = null;
    ttsWsReady = false;
  }

  function openCartesiaTtsWs(): void {
    if (!cartesiaClient) return;
    ensureCartesiaTtsWebsocketHandshakeErrorPatch();
    if (cartesiaWs) {
      try { cartesiaWs.close({ code: 1000, reason: "reconnect" }); } catch { /* ignore */ }
      cartesiaWs = null;
    }
    cartesiaWsReady = false;
    cartesiaSessionConnectStartAt = Date.now();
    cartesiaWsOpenPromise = cartesiaClient.tts.websocket()
      .then((ws) => {
        ws.on("error", (err) => {
          if (isCartesiaInvalidContextError(err)) {
            logger.debug("Ignoring Cartesia invalid context error after cancel/cleanup", {
              message: err.message,
            });
            return;
          }
          logger.error("Cartesia TTS WebSocket error", { err: err.message });
        });
        cartesiaWs = ws;
        cartesiaWsReady = true;
        cartesiaSessionOpenedAt = Date.now();
        logger.info("Session Cartesia TTS WebSocket ready (warm)", {
          connectMs: cartesiaSessionOpenedAt - cartesiaSessionConnectStartAt,
        });
        scheduleConnectionWelcomeWhenTtsReady();
      })
      .catch((err) => {
        cartesiaWsReady = false;
        cartesiaWs = null;
        const msg = (err as Error).message ?? String(err);
        const quotaHint =
          msg.includes("402") || msg.toLowerCase().includes("payment required")
            ? " Cartesia returned 402 — often quota_exceeded / model credits; check billing in the Cartesia dashboard."
            : "";
        logger.error("Session Cartesia TTS WebSocket failed to open", { err: msg + quotaHint });
      });
  }

  function closeCartesiaTtsWs(): void {
    cancelActiveCartesiaContext?.();
    cancelActiveCartesiaContext = null;
    if (!cartesiaWs) return;
    try { cartesiaWs.close({ code: 1000, reason: "session ended" }); } catch { /* ignore */ }
    cartesiaWs = null;
    cartesiaWsReady = false;
  }

  /** Send text to the TTS WS without flushing (queues for synthesis). */
  function ttsSendText(text: string): void {
    if (!ttsWs || !ttsWsReady) return;
    ttsWs.send(JSON.stringify({ type: "Speak", text }));
  }

  /**
   * Flush the TTS WS buffer — tells Deepgram to synthesize everything queued
   * so far and start streaming audio back.
   */
  function ttsSendFlush(): void {
    if (!ttsWs || !ttsWsReady) return;
    ttsWs.send(JSON.stringify({ type: "Flush" }));
    ttsPendingFlushes++;
  }

  /**
   * Returns a promise that resolves once all Flushed events matching the
   * pendingFlushes counter have been received.
   */
  function waitForAllFlushed(): Promise<void> {
    if (ttsFlushedCount >= ttsPendingFlushes) return Promise.resolve();
    return new Promise<void>((resolve) => { ttsFlushResolve = resolve; });
  }

  /**
   * Send Clear and wait for the Cleared acknowledgement.
   * Drops any audio arriving before Cleared is received.
   */
  function clearTtsWs(): Promise<void> {
    if (!ttsWs || !ttsWsReady) return Promise.resolve();
    ttsDiscardAudio = true;
    ttsPendingFlushes = 0;
    ttsFlushedCount = 0;
    ttsFlushResolve = null;
    try { ttsWs.send(JSON.stringify({ type: "Clear" })); } catch { return Promise.resolve(); }
    return new Promise<void>((resolve) => { ttsClearResolve = resolve; });
  }

  // ── Pipeline helpers ────────────────────────────────────────────────────────

  const deepgramClient = new DeepgramClient({ apiKey: env.DEEPGRAM_API_KEY });

  function teardownDg(): void {
    if (dgSocket) {
      try { dgSocket.close(); } catch { /* already closed */ }
      dgSocket = null;
    }
    isFluxOpen = false;
    pendingChunks = [];
  }

  function cancelPipeline(): void {
    voiceJourney?.step("PIPE.cancel_pipeline");
    welcomePlaybackAbort?.abort();
    welcomePlaybackAbort = null;
    cancelWelcomeCartesia?.();
    cancelWelcomeCartesia = null;
    if (pipelineAbort) {
      pipelineAbort.abort();
      pipelineAbort = null;
    }
    isTtsStreaming = false;
    inFlightUserText = null;
    // Clear TTS WS buffer — fire and forget (Cleared arrives asynchronously)
    if (ttsWs && ttsWsReady) {
      ttsDiscardAudio = true;
      ttsPendingFlushes = 0;
      ttsFlushedCount = 0;
      ttsFlushResolve = null;
      try { ttsWs.send(JSON.stringify({ type: "Clear" })); } catch { /* ignore */ }
      // ttsClearResolve intentionally NOT set — we don't await here
    }
    if (cancelActiveCartesiaContext) {
      cancelActiveCartesiaContext();
      cancelActiveCartesiaContext = null;
      ttsDiscardAudio = true;
    }
  }

  /**
   * Per-turn pre-LLM prep:
   *   • Run input guardrails — if blocked, return a `forcedAssistantText` that
   *     the LLM short-circuit will route straight to TTS.
   *   • Drain pending image attachments so they're inlined into THIS turn's
   *     multimodal user content (they remain in the rolling conversation for
   *     subsequent turns about the same image).
   */
  function prepareTurn(userText: string): {
    forcedAssistantText?: string;
    pendingImages: VoiceAgentImageInput[];
  } {
    const g0 = Date.now();
    const verdict = evaluateUserInput(userText);
    const guardrailEvalMs = Date.now() - g0;
    if (!verdict.allow && verdict.spokenRefusal) {
      logger.warn("Input guardrail blocked utterance", {
        category: verdict.category,
        matched: verdict.matchedPattern,
        userLen: userText.length,
      });
      voiceJourney?.step("TURN.prepare", "input_guardrail_block", {
        turnId: activePipelineTurnId,
        guardrailEvalMs,
        category: verdict.category ?? "unknown",
      });
      return { forcedAssistantText: verdict.spokenRefusal, pendingImages: [] };
    }
    const drained = imageContext.takePendingForTurn();
    const pendingImages: VoiceAgentImageInput[] = drained.map((img) => ({
      id: img.id,
      mediaType: img.mediaType,
      data: img.data,
    }));
    if (pendingImages.length > 0) {
      logger.info("Voice turn includes attached images", {
        count: pendingImages.length,
        ids: pendingImages.map((i) => i.id),
        totalBytes: drained.reduce((s, i) => s + i.byteSize, 0),
      });
    }
    voiceJourney?.step("TURN.prepare", "input_guardrail_ok", {
      turnId: activePipelineTurnId,
      guardrailEvalMs,
      pendingImageCount: pendingImages.length,
    });
    return { pendingImages };
  }

  async function runCartesiaAgentPipeline(
    userText: string,
    triggerAt: number,
    signal: AbortSignal,
    turnPrep: { forcedAssistantText?: string; pendingImages: VoiceAgentImageInput[] },
  ): Promise<void> {
    const turnId = activePipelineTurnId;
    if (!cartesiaClient) {
      voiceJourney?.step("TTS.cartesia", "missing_client_config", { turnId });
      socket.emit("voice:error", {
        code: "TTS_CONFIG",
        message: "CARTESIA_API_KEY is required when VOICE_TTS_PROVIDER=cartesia.",
      });
      return;
    }

    if (!cartesiaWsReady && cartesiaWsOpenPromise) {
      logger.info("Waiting for session Cartesia TTS WS to open...");
      voiceJourney?.step("TTS.cartesia_session_ws", "await_open_promise", { turnId });
      await cartesiaWsOpenPromise;
    }
    if (signal.aborted) return;

    if (!cartesiaWsReady || !cartesiaWs) {
      logger.warn("Session Cartesia TTS WS not ready — re-opening");
      voiceJourney?.step("TTS.cartesia_session_ws", "reopen_requested", { turnId });
      openCartesiaTtsWs();
      await cartesiaWsOpenPromise;
      if (signal.aborted) return;
    }
    if (!cartesiaWs) {
      voiceJourney?.step("TTS.cartesia", "session_ws_missing_after_open", { turnId });
      socket.emit("voice:error", { code: "TTS_CONNECT_FAILED", message: "Cartesia TTS WebSocket did not open." });
      return;
    }

    const ttsConnectStartMs = cartesiaSessionConnectStartAt - triggerAt;
    const ttsConnectMs = cartesiaSessionOpenedAt > 0 ? cartesiaSessionOpenedAt - cartesiaSessionConnectStartAt : 0;
    const ttsWsWaitMs = cartesiaSessionOpenedAt > 0 ? Math.max(0, cartesiaSessionOpenedAt - triggerAt) : 0;

    const { voiceId: cartesiaVoiceId, generation_config: cartesiaGenerationConfig } =
      getCartesiaPersonaTtsSettings(voicePersona);
    const cartesiaTurnContextId = `${socket.id}-${Date.now()}`;
    voiceJourney?.step("TTS.cartesia_turn_context", "created", { turnId, contextId: cartesiaTurnContextId });
    const context = cartesiaWs.context({
      model_id: env.CARTESIA_TTS_MODEL,
      voice: { mode: "id", id: cartesiaVoiceId },
      output_format: {
        container: "raw",
        encoding: "pcm_s16le",
        sample_rate: TTS_SAMPLE_RATE,
      },
      contextId: cartesiaTurnContextId,
      timeout: 60_000,
    });

    cancelActiveCartesiaContext = () => {
      void context.cancel().catch((err) => {
        if (isCartesiaInvalidContextError(err)) return;
        logger.debug("Cartesia context cancel failed", { err });
      });
    };

    const receiveTask = (async () => {
      try {
        for await (const msg of context.receive({ timeout: 60_000 })) {
          if (signal.aborted) break;
          if (msg.type === "chunk" && msg.audio) {
            emitTtsAudioChunk(msg.audio, "cartesia");
          } else if (msg.type === "timestamps" && msg.word_timestamps?.words?.length) {
            const { words, start, end } = msg.word_timestamps;
            socket.emit("voice:ttsWordTimestamps", {
              words,
              start,
              end,
              flushId: msg.flush_id ?? undefined,
            });
          } else {
            logger.debug("Cartesia TTS control", {
              type: msg.type,
              done: "done" in msg ? msg.done : undefined,
              flushId: "flush_id" in msg ? msg.flush_id : undefined,
            });
          }
        }
      } catch (err) {
        if (!signal.aborted && !isCartesiaInvalidContextError(err)) throw err;
      }
    })();

    llmStartedAt = Date.now();
    voiceJourney?.step("TURN.llm", "cartesia_llmStartedAt_before_voice_prep", { turnId, llmStartedAt });
    let streamedAssistantText = "";
    const { options: llmOpts, prep: voicePrep } = await voiceAgentReplyOptionsForTurn(userText, {
      ...turnPrep,
      onAgentJourney: emitVoiceAgentJourney,
    });
    const prepTiming = voicePrepTimingFields(voicePrep);
    voiceJourney?.step("TURN.llm", "stream_voice_agent_reply_begin", { turnId });
    const { assistantText, llmTtftMs, llmPostFirstTokenMs, routingTag, toolExecMs, toolName, pass2LlmTtftMs } =
      await streamVoiceAgentReply(
        userText,
        conversation,
        signal,
        async (segment, meta) => {
          if (!segment.trim() || signal.aborted) return;
          const sentAt = Date.now();
          if (firstSegmentSentAt === 0) firstSegmentSentAt = sentAt;
          ttsSegmentCount++;
          streamedAssistantText = appendAssistantTranscript(streamedAssistantText, segment);
          socket.emit("voice:assistantTranscript", { text: streamedAssistantText, isFinal: false });
          voiceJourney?.step("TTS.cartesia_send", "before_context_send", {
            turnId,
            segmentIndex: meta.segmentIndex,
            chars: segment.length,
            msSinceLlmStartedAtField: sentAt - llmStartedAt,
          });
          try {
            await context.send({
              model_id: env.CARTESIA_TTS_MODEL,
              voice: { mode: "id", id: cartesiaVoiceId },
              output_format: {
                container: "raw",
                encoding: "pcm_s16le",
                sample_rate: TTS_SAMPLE_RATE,
              },
              transcript: segment,
              continue: true,
              add_timestamps: true,
              use_normalized_timestamps: true,
              generation_config: cartesiaGenerationConfig,
            });
            if (ttsSegmentCount === 1) await context.flush();
          } catch (err) {
            if (signal.aborted || isCartesiaInvalidContextError(err)) return;
            throw err;
          }
          const afterSend = Date.now();
          voiceJourney?.step("TTS.cartesia_send", "after_context_send_and_optional_flush", {
            turnId,
            segmentIndex: meta.segmentIndex,
            flushed: ttsSegmentCount === 1,
            contextSendMs: afterSend - sentAt,
          });
          logger.info("LLM segment → Cartesia TTS WS", {
            segmentIndex: meta.segmentIndex,
            flushed: ttsSegmentCount === 1,
            chars: segment.length,
            preview: segment.slice(0, 60),
            msSinceLlmStart: sentAt - llmStartedAt,
          });
        },
        llmOpts,
      );

    voiceJourney?.step("TURN.llm", "stream_voice_agent_reply_end", {
      turnId,
      llmTtftMs,
      llmPostFirstTokenMs: llmPostFirstTokenMs ?? -1,
      assistantChars: assistantText.length,
    });

    if (signal.aborted) return;

    if (routingTag === "RESERVATION" && !voicePrep.workflow.isWorkflowActive && activeSessionId) {
      const tTag = Date.now();
      await workflowOrchestrator.activateFromTag(activeSessionId, voicePrep.workflow.state.slots);
      voiceJourney?.step("TURN.workflow", "activate_from_reservation_tag", { turnId, ms: Date.now() - tTag });
    }

    if (!assistantText.trim()) {
      logger.warn("Voice agent: empty assistant reply", { userLen: userText.length });
      voiceJourney?.step("TURN.error", "agent_empty_reply", { turnId, provider: "cartesia" });
      socket.emit("voice:error", { code: "AGENT_EMPTY", message: "The model returned no speakable text." });
      cancelActiveCartesiaContext?.();
      await receiveTask.catch((err) => {
        if (!isCartesiaInvalidContextError(err)) logger.debug("Cartesia receive cleanup failed", { err });
      });
      return;
    }
    socket.emit("voice:assistantTranscript", { text: assistantText, isFinal: true });
    voiceJourney?.step("SOCKET.emit", "voice:assistantTranscript_final", { turnId, assistantChars: assistantText.length });

    if (ttsSegmentCount > 0) {
      const tNm = Date.now();
      voiceJourney?.step("TTS.cartesia", "no_more_inputs_begin", { turnId });
      try {
        await context.no_more_inputs();
      } catch (err) {
        if (!signal.aborted && !isCartesiaInvalidContextError(err)) throw err;
      }
      voiceJourney?.step("TTS.cartesia", "no_more_inputs_end", { turnId, ms: Date.now() - tNm });
      const tRecv = Date.now();
      voiceJourney?.step("TTS.cartesia", "receive_task_await_begin", { turnId });
      await receiveTask;
      voiceJourney?.step("TTS.cartesia", "receive_task_await_end", { turnId, ms: Date.now() - tRecv });
    } else {
      cancelActiveCartesiaContext?.();
      await receiveTask.catch((err) => {
        if (!isCartesiaInvalidContextError(err)) logger.debug("Cartesia receive cleanup failed", { err });
      });
    }

    if (signal.aborted || !ttsStartEmitted) return;

    const ttsDoneAt = Date.now();
    const totalMs = ttsDoneAt - triggerAt;
    const audioRealtimeRatio = generatedAudioMs > 0
      ? (ttsDoneAt - firstAudioAt) / generatedAudioMs
      : 0;
    const timing: VoiceTtsTimingBreakdown = {
      triggerToFetchMs: ttsConnectStartMs,
      fetchToHeadersMs: ttsConnectMs,
      headersToFirstChunkMs: firstSegmentSentAt > 0 ? firstAudioAt - firstSegmentSentAt : 0,
      triggerToTtsConnectStartMs: ttsConnectStartMs,
      ttsConnectMs,
      ttsWsWaitMs,
      ttsReadyToLlmStartMs: Math.max(0, llmStartedAt - Math.max(triggerAt, cartesiaSessionOpenedAt || triggerAt)),
      ...prepTiming,
      ...postTurnWorkflowTimingOverlay(activeSessionId),
      llmStartToFirstSegmentMs: firstSegmentSentAt > 0 ? firstSegmentSentAt - llmStartedAt : undefined,
      firstSegmentToFirstAudioMs: firstSegmentSentAt > 0 ? firstAudioAt - firstSegmentSentAt : undefined,
      firstAudioToTtsDoneMs: ttsDoneAt - firstAudioAt,
      ttsSegmentCount,
      generatedAudioMs: Math.round(generatedAudioMs),
      audioRealtimeRatio: Number(audioRealtimeRatio.toFixed(2)),
      maxInterChunkGapMs,
      underrunRiskEvents,
      maxRealtimeDeficitMs: Math.round(maxRealtimeDeficitMs),
      ...(toolExecMs !== undefined ? { toolExecMs } : {}),
      ...(toolName !== undefined ? { toolName } : {}),
      ...(pass2LlmTtftMs !== undefined ? { pass2LlmTtftMs } : {}),
    };

    logger.info("Voice pipeline timing breakdown", {
      provider: "cartesia",
      ttfaMs: firstAudioAt - triggerAt,
      totalMs,
      llmTtftMs,
      llmPostFirstTokenMs,
      ...timing,
    });

    socket.emit("voice:ttsEnd", {
      ttfaMs: firstAudioAt - triggerAt,
      totalMs,
      assistantText,
      timing: { ...timing, llmRoutingTag: routingTag ?? undefined },
      llmTtftMs,
      llmPostFirstTokenMs,
    });
    voiceJourney?.step("SOCKET.emit", "voice:ttsEnd", {
      turnId,
      provider: "cartesia",
      ttfaMs: firstAudioAt - triggerAt,
      totalMs,
      llmTtftMs,
    });

    const tPersist = Date.now();
    voiceJourney?.step("TURN.persist", "append_turn_begin", { turnId });
    await appendTurnToConversationAndPersist(userText, assistantText, turnPrep.pendingImages);
    voiceJourney?.step("TURN.persist", "append_turn_end", { turnId, ms: Date.now() - tPersist });
    cancelActiveCartesiaContext = null;
  }

  async function runAgentPipeline(userText: string, triggerAt: number): Promise<void> {
    activePipelineTurnId = ++journeyTurnSeq;
    const turnId = activePipelineTurnId;
    voiceJourney?.step("TURN.pipeline", "invoke", {
      turnId,
      userTextLen: userText.length,
      msSinceVoiceSessionStart: voiceJourney ? triggerAt - voiceJourney.anchorMs : -1,
    });

    cancelPipeline();
    isTtsStreaming = true;
    inFlightUserText = userText;
    pipelineAbort = new AbortController();
    const signal = pipelineAbort.signal;
    currentTriggerAt = triggerAt;

    socket.emit("voice:stateChange", "thinking");
    voiceJourney?.step("SOCKET.emit", "voice:stateChange", { state: "thinking", turnId });
    resetTurnTtsState();

    // Run input guardrails + drain pending image attachments ONCE per turn.
    // Both pipelines downstream consume the result; doing it twice would
    // either double-emit images or skip the guardrail in the wrong path.
    const turnPrep = prepareTurn(userText);

    try {
      if (env.VOICE_TTS_PROVIDER === "cartesia") {
        await runCartesiaAgentPipeline(userText, triggerAt, signal, turnPrep);
        return;
      }

      // Wait for the session TTS WS to be open (usually already open)
      if (!ttsWsReady && ttsWsOpenPromise) {
        logger.info("Waiting for session TTS WS to open…");
        voiceJourney?.step("TTS.deepgram_session_ws", "await_open_promise", { turnId });
        await ttsWsOpenPromise;
      }
      if (signal.aborted) return;

      if (!ttsWsReady) {
        logger.warn("Session TTS WS not ready — re-opening");
        voiceJourney?.step("TTS.deepgram_session_ws", "reopen_requested", { turnId });
        openSessionTtsWs();
        await ttsWsOpenPromise;
        if (signal.aborted) return;
      }

      // ── Timing: how long before WS was ready relative to this turn ──────
      const ttsConnectStartMs = ttsSessionConnectStartAt - triggerAt;
      const ttsConnectMs = ttsSessionOpenedAt > 0 ? ttsSessionOpenedAt - ttsSessionConnectStartAt : 0;
      const ttsWsWaitMs = ttsSessionOpenedAt > 0 ? Math.max(0, ttsSessionOpenedAt - triggerAt) : 0;

      llmStartedAt = Date.now();
      voiceJourney?.step("TURN.llm", "deepgram_llmStartedAt_before_voice_prep", { turnId, llmStartedAt });
      let streamedAssistantText = "";

      // ── Stream LLM → TTS WS ───────────────────────────────────────────────
      // Strategy: flush only after the FIRST segment so the user hears audio
      // quickly (low TTFA). All subsequent segments are queued with Speak-only
      // and synthesised as a single block by the final Flush at the end.
      // This eliminates the per-segment synthesis gaps that caused underruns.
      const { options: llmOpts, prep: voicePrep } = await voiceAgentReplyOptionsForTurn(userText, {
        ...turnPrep,
        onAgentJourney: emitVoiceAgentJourney,
      });
      const prepTiming = voicePrepTimingFields(voicePrep);
      voiceJourney?.step("TURN.llm", "stream_voice_agent_reply_begin", { turnId });
      const { assistantText, llmTtftMs, llmPostFirstTokenMs, routingTag, toolExecMs, toolName, pass2LlmTtftMs } =
        await streamVoiceAgentReply(
          userText,
          conversation,
          signal,
          async (segment, meta) => {
            if (!segment.trim() || signal.aborted) return;
            const sentAt = Date.now();
            if (firstSegmentSentAt === 0) firstSegmentSentAt = sentAt;
            ttsSegmentCount++;
            streamedAssistantText = appendAssistantTranscript(streamedAssistantText, segment);
            socket.emit("voice:assistantTranscript", { text: streamedAssistantText, isFinal: false });
            voiceJourney?.step("TTS.deepgram_ws", "before_speak", {
              turnId,
              segmentIndex: meta.segmentIndex,
              chars: segment.length,
              msSinceLlmStartedAtField: sentAt - llmStartedAt,
            });
            ttsSendText(segment);
            if (ttsSegmentCount === 1) {
              // First segment: flush immediately so synthesis starts right away
              voiceJourney?.step("TTS.deepgram_ws", "flush_sent_first_segment", { turnId });
              ttsSendFlush();
            }
            // Segments 2+: no per-segment flush — they will be included in the
            // final flush below, synthesised as one continuous block.
            const afterTts = Date.now();
            voiceJourney?.step("TTS.deepgram_ws", "after_speak_and_optional_flush", {
              turnId,
              segmentIndex: meta.segmentIndex,
              flushed: ttsSegmentCount === 1,
              ttsEnqueueMs: afterTts - sentAt,
            });
            logger.info("LLM segment → TTS WS", {
              segmentIndex: meta.segmentIndex,
              flushed: ttsSegmentCount === 1,
              chars: segment.length,
              preview: segment.slice(0, 60),
              msSinceLlmStart: sentAt - llmStartedAt,
            });
          },
          llmOpts,
        );

      voiceJourney?.step("TURN.llm", "stream_voice_agent_reply_end", {
        turnId,
        llmTtftMs,
        llmPostFirstTokenMs: llmPostFirstTokenMs ?? -1,
        assistantChars: assistantText.length,
      });

      if (signal.aborted) return;

      if (routingTag === "RESERVATION" && !voicePrep.workflow.isWorkflowActive && activeSessionId) {
        const tTag = Date.now();
        await workflowOrchestrator.activateFromTag(activeSessionId, voicePrep.workflow.state.slots);
        voiceJourney?.step("TURN.workflow", "activate_from_reservation_tag", { turnId, ms: Date.now() - tTag });
      }

      if (!assistantText.trim()) {
        logger.warn("Voice agent: empty assistant reply", { userLen: userText.length });
        socket.emit("voice:error", { code: "AGENT_EMPTY", message: "The model returned no speakable text." });
        voiceJourney?.step("TURN.error", "agent_empty_reply", { turnId });
        return;
      }
      socket.emit("voice:assistantTranscript", { text: assistantText, isFinal: true });
      voiceJourney?.step("SOCKET.emit", "voice:assistantTranscript_final", { turnId, assistantChars: assistantText.length });

      // ── Final flush ───────────────────────────────────────────────────────
      // Segment 1 was already flushed immediately for low TTFA. Only send a
      // final Flush when there is queued text from segment 2+; otherwise just
      // wait for the first Flush acknowledgement. Double-flushing one segment
      // causes unnecessary Deepgram work and extra Flushed control events.
      if (ttsWs && ttsWsReady && ttsSegmentCount > 0) {
        const tFlush = Date.now();
        if (ttsSegmentCount > 1) {
          voiceJourney?.step("TTS.deepgram_ws", "final_flush_sent_multi_segment", { turnId, ttsSegmentCount });
          ttsSendFlush();
        } else {
          voiceJourney?.step("TTS.deepgram_ws", "final_flush_skipped_single_segment", { turnId });
        }
        voiceJourney?.step("TTS.deepgram_ws", "wait_all_flushed_begin", {
          turnId,
          pendingFlushes: ttsPendingFlushes,
          flushedSoFar: ttsFlushedCount,
        });
        await waitForAllFlushed();
        voiceJourney?.step("TTS.deepgram_ws", "wait_all_flushed_end", { turnId, ms: Date.now() - tFlush });
      }

      if (signal.aborted || !ttsStartEmitted) return;

      // ── Timing breakdown ─────────────────────────────────────────────────
      const ttsDoneAt = Date.now();
      const totalMs = ttsDoneAt - triggerAt;
      const audioRealtimeRatio = generatedAudioMs > 0
        ? (ttsDoneAt - firstAudioAt) / generatedAudioMs
        : 0;

      const timing: VoiceTtsTimingBreakdown = {
        // Legacy REST fields — map to nearest equivalent so frontend math works
        triggerToFetchMs: ttsConnectStartMs,
        fetchToHeadersMs: ttsConnectMs,
        headersToFirstChunkMs: firstSegmentSentAt > 0 ? firstAudioAt - firstSegmentSentAt : 0,
        // WebSocket-specific breakdown
        triggerToTtsConnectStartMs: ttsConnectStartMs,
        ttsConnectMs,
        ttsWsWaitMs,
        ttsReadyToLlmStartMs: Math.max(0, llmStartedAt - Math.max(triggerAt, ttsSessionOpenedAt || triggerAt)),
        ...prepTiming,
        ...postTurnWorkflowTimingOverlay(activeSessionId),
        llmStartToFirstSegmentMs: firstSegmentSentAt > 0 ? firstSegmentSentAt - llmStartedAt : undefined,
        firstSegmentToFirstAudioMs: firstSegmentSentAt > 0 ? firstAudioAt - firstSegmentSentAt : undefined,
        firstAudioToTtsDoneMs: ttsDoneAt - firstAudioAt,
        ttsSegmentCount,
        generatedAudioMs: Math.round(generatedAudioMs),
        audioRealtimeRatio: Number(audioRealtimeRatio.toFixed(2)),
        maxInterChunkGapMs,
        underrunRiskEvents,
        maxRealtimeDeficitMs: Math.round(maxRealtimeDeficitMs),
      };

      logger.info("Voice pipeline timing breakdown", {
        ttfaMs: firstAudioAt - triggerAt,
        totalMs,
        llmTtftMs,
        llmPostFirstTokenMs,
        ...timing,
      });

      socket.emit("voice:ttsEnd", {
        ttfaMs: firstAudioAt - triggerAt,
        totalMs,
        assistantText,
        timing: { ...timing, llmRoutingTag: routingTag ?? undefined },
        llmTtftMs,
        llmPostFirstTokenMs,
      });
      voiceJourney?.step("SOCKET.emit", "voice:ttsEnd", {
        turnId,
        provider: "deepgram",
        ttfaMs: firstAudioAt - triggerAt,
        totalMs,
        llmTtftMs,
      });

      const tPersist = Date.now();
      voiceJourney?.step("TURN.persist", "append_turn_begin", { turnId });
      await appendTurnToConversationAndPersist(userText, assistantText, turnPrep.pendingImages);
      voiceJourney?.step("TURN.persist", "append_turn_end", { turnId, ms: Date.now() - tPersist });

    } catch (err) {
      if ((err as Error).name === "AbortError") {
        voiceJourney?.step("TURN.pipeline", "aborted_abort_error", { turnId });
        return;
      }
      logger.error("Voice agent pipeline error", { err });
      const code = voiceAgentLlmErrorCode(err);
      const message = formatVoiceAgentLlmError(err);
      voiceJourney?.step("TURN.pipeline", "caught_error", { turnId, code, message: message.slice(0, 200) });
      socket.emit("voice:error", { code, message });
      try {
        const apology = getVoiceLlmErrorSpokenLine(env.VOICE_LLM_PROVIDER);
        const tAp = Date.now();
        voiceJourney?.step("TURN.error", "apology_tts_rest_begin", { turnId });
        await streamTTSEchoRest(socket, apology, Date.now(), signal);
        voiceJourney?.step("TURN.error", "apology_tts_rest_end", { turnId, ms: Date.now() - tAp });
      } catch (ttsErr) {
        logger.warn("Apology TTS failed", { ttsErr });
      }
    } finally {
      isTtsStreaming = false;
      inFlightUserText = null;
      pipelineAbort = null;
      cancelActiveCartesiaContext = null;
      // Always refresh reservation widgets from cache — success paths can return early
      // (e.g. Cartesia without ttsStartEmitted) after orchestration already cleared the flow.
      syncReservationSidebarUi();
      if (!signal.aborted) {
        socket.emit("voice:stateChange", "listening");
        voiceJourney?.step("SOCKET.emit", "voice:stateChange", { state: "listening", turnId });
      }
      voiceJourney?.step("TURN.pipeline", "finally", { turnId, aborted: signal.aborted });
    }
  }

  // ── Flux STT ──────────────────────────────────────────────────────────────

  socket.on("voice:clientLocation", (payload) => {
    clientLocation = { latitude: payload.latitude, longitude: payload.longitude };
    // Warm the snapshot cache off the LLM critical path.
    refreshWeatherSnapshotInBackground(payload.latitude, payload.longitude);
  });

  socket.on("voice:start", async ({ sampleRate, location, clientTimeZone: tz, persona, userId, sessionId }) => {
    voiceJourney?.end("voice:start superseded");
    voiceJourney = env.VOICE_SESSION_JOURNEY_LOG_ENABLED
      ? new VoiceSessionJourneyLog({
        logDir: journeyLogDir,
        fileBaseName: `voice-${socket.id}-${Date.now()}`,
      })
      : null;
    journeyTurnSeq = 0;
    voiceJourney?.step("SESSION", "voice_start_begin", {
      socketId: socket.id,
      sampleRate,
      persona: persona ?? "default",
      ttsProvider: env.VOICE_TTS_PROVIDER,
      llmProvider: env.VOICE_LLM_PROVIDER,
      llmModel: env.VOICE_LLM_MODEL,
    });

    teardownDg();
    cancelPipeline();
    sessionConnectionWelcomeEnqueued = false;
    socket.emit("voice:stateChange", "connecting");
    voiceJourney?.step("SOCKET.emit", "voice:stateChange", { state: "connecting" });
    conversation = [];
    inFlightUserText = null;
    clientLocation = location
      ? { latitude: location.latitude, longitude: location.longitude }
      : null;
    cachedWeatherSnapshot = null;
    if (clientLocation) {
      refreshWeatherSnapshotInBackground(clientLocation.latitude, clientLocation.longitude);
    }
    clientTimeZone = typeof tz === "string" && tz.trim() ? tz.trim() : null;
    voicePersona = persona && isVoicePersonaId(persona) ? persona : "jolly";
    activeUserId = typeof userId === "string" && userId.trim() ? userId.trim() : null;
    activeSessionId = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;

    activeUserName = null;
    if (activeUserId && activeSessionId) {
      try {
        const tPre = Date.now();
        voiceJourney?.step("SESSION", "preload_direct_memory_cache_begin", { userId: activeUserId });
        // Fetch the user's display name in parallel with the memory cache
        // preload — used to personalise the connection greeting. Don't fail
        // the session if the lookup errors.
        const [, userRow] = await Promise.all([
          preloadDirectMemoryCache(activeUserId),
          prisma.user
            .findUnique({ where: { id: activeUserId }, select: { name: true } })
            .catch(() => null),
        ]);
        activeUserName = userRow?.name ?? null;
        voiceJourney?.step("SESSION", "preload_direct_memory_cache_end", { ms: Date.now() - tPre });
        const tLoad = Date.now();
        voiceJourney?.step("SESSION", "load_conversation_for_voice_begin", { sessionId: activeSessionId });
        conversation = await loadConversationForVoice({
          sessionId: activeSessionId,
          userId: activeUserId,
        });
        voiceJourney?.step("SESSION", "load_conversation_for_voice_end", {
          ms: Date.now() - tLoad,
          restoredMessages: conversation.length,
        });
        logger.info("[MEMLEAK] voice:start — session loaded", {
          socketId: socket.id,
          activeUserId,
          activeSessionId,
          activeUserName,
          restoredMessages: conversation.length,
          restoredHasBlue: conversation.some(
            (m) => typeof m.content === "string" && /\bblue\b/i.test(m.content),
          ),
        });
      } catch (err) {
        logger.warn("voice:start — failed to load persisted session", {
          err,
          userId: activeUserId,
          sessionId: activeSessionId,
        });
        voiceJourney?.step("SESSION", "load_persisted_session_failed", { sessionId: activeSessionId ?? "" });
        conversation = [];
        activeSessionId = null;
      }
    } else {
      activeUserId = null;
      activeSessionId = null;
      voiceJourney?.step("SESSION", "skip_db_conversation_load", { reason: "no_user_or_session" });
    }

    logger.info("voice:start — warming TTS WS + connecting Flux STT", {
      socketId: socket.id,
      sampleRate,
      hasClientLocation: Boolean(clientLocation),
      voicePersona,
      ttsProvider: env.VOICE_TTS_PROVIDER,
      activeUserId,
      activeSessionId,
      restoredMessages: conversation.length,
    });

    // Open session TTS WebSocket eagerly so it's warm before the first turn.
    if (env.VOICE_TTS_PROVIDER === "cartesia") {
      voiceJourney?.step("SESSION", "open_cartesia_session_tts_ws");
      openCartesiaTtsWs();
    } else {
      voiceJourney?.step("SESSION", "open_deepgram_session_tts_ws");
      openSessionTtsWs();
    }

    void (async () => {
      try {
        voiceJourney?.step("STT.flux", "connect_begin");
        dgSocket = await deepgramClient.listen.v2.connect({
          Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
          model: env.DEEPGRAM_STT_MODEL,
          encoding: "linear16",
          sample_rate: sampleRate,
          eager_eot_threshold: 0.5,
          eot_threshold: 0.7,
          eot_timeout_ms: 5000,
        } as Parameters<typeof deepgramClient.listen.v2.connect>[0]);

        dgSocket.on("open", () => {
          isFluxOpen = true;
          voiceJourney?.step("STT.flux", "websocket_open", { pendingChunksBuffered: pendingChunks.length });
          let flushed = 0;
          for (const chunk of pendingChunks) {
            try { dgSocket!.sendMedia(chunk); flushed++; } catch { /* ignore */ }
          }
          if (flushed > 0) logger.info("Flushed buffered audio chunks to Flux", { flushed });
          if (flushed > 0) voiceJourney?.step("STT.flux", "flushed_pending_audio_chunks", { flushed });
          pendingChunks = [];
          socket.emit("voice:stateChange", "listening");
          voiceJourney?.step("SOCKET.emit", "voice:stateChange", { state: "listening", phase: "flux_ready" });
          void (async () => {
            if (activeSessionId) await workflowOrchestrator.primeSessionCache(activeSessionId);
            syncReservationSidebarUi();
          })();
        });

        dgSocket.on("message", (data) => {
          if (data.type !== "TurnInfo") return;
          const turn = data as ListenV2TurnInfo;
          const { event, transcript, end_of_turn_confidence } = turn;
          const triggerAt = Date.now();
          // logger.debug("Flux TurnInfo", { event, transcriptLen: transcript?.length, confidence: end_of_turn_confidence });

          switch (event) {
            case "StartOfTurn": {
              voiceJourney?.step("STT.flux", "StartOfTurn", { transcriptLen: transcript?.length ?? 0 });
              socket.emit("voice:speechStarted");
              if (isTtsStreaming) {
                logger.info("Flux barge-in (StartOfTurn)", { socketId: socket.id });
                voiceJourney?.step("STT.flux", "StartOfTurn_barge_in_cancel_pipeline", { isTtsStreaming: 1 });
                cancelPipeline();
                socket.emit("voice:ttsCancel");
                socket.emit("voice:stateChange", "listening");
              }
              if (transcript) socket.emit("voice:transcript", { text: transcript, turnEvent: "StartOfTurn", isFinal: false, speechFinal: false });
              break;
            }
            case "Update": {
              if (transcript) {
                socket.emit("voice:transcript", { text: transcript, turnEvent: "Update", isFinal: false, speechFinal: false, endOfTurnConfidence: end_of_turn_confidence });
              }
              break;
            }
            case "EagerEndOfTurn": {
              if (transcript) {
                voiceJourney?.step("STT.flux", "EagerEndOfTurn", {
                  transcriptLen: transcript.length,
                  eotConfidence: end_of_turn_confidence ?? -1,
                  willStartPipeline: !isTtsStreaming ? 1 : 0,
                });
                socket.emit("voice:transcript", { text: transcript, turnEvent: "EagerEndOfTurn", isFinal: true, speechFinal: false, endOfTurnConfidence: end_of_turn_confidence });
                socket.emit("voice:eagerEndOfTurn", { transcript });
                if (!isTtsStreaming) {
                  logger.info("EagerEndOfTurn — starting voice agent (LLM)", { text: transcript });
                  void runAgentPipeline(transcript, triggerAt);
                }
              }
              break;
            }
            case "TurnResumed": {
              logger.info("TurnResumed — cancelling agent pipeline", { socketId: socket.id });
              voiceJourney?.step("STT.flux", "TurnResumed_cancel_pipeline");
              cancelPipeline();
              socket.emit("voice:ttsCancel");
              socket.emit("voice:turnResumed");
              socket.emit("voice:stateChange", "listening");
              break;
            }
            case "EndOfTurn": {
              if (transcript) {
                voiceJourney?.step("STT.flux", "EndOfTurn", {
                  transcriptLen: transcript.length,
                  eotConfidence: end_of_turn_confidence ?? -1,
                  isTtsStreaming: isTtsStreaming ? 1 : 0,
                  sameAsInFlight: transcript === inFlightUserText ? 1 : 0,
                });
                socket.emit("voice:transcript", { text: transcript, turnEvent: "EndOfTurn", isFinal: true, speechFinal: true, endOfTurnConfidence: end_of_turn_confidence });
                if (isTtsStreaming && transcript !== inFlightUserText) {
                  logger.info("EndOfTurn — final transcript differs, restarting", { inFlight: inFlightUserText, final: transcript });
                  voiceJourney?.step("STT.flux", "EndOfTurn_restart_pipeline_transcript_differs");
                  cancelPipeline();
                  socket.emit("voice:ttsCancel");
                  void runAgentPipeline(transcript, triggerAt);
                } else if (!isTtsStreaming) {
                  logger.info("EndOfTurn — starting voice agent (LLM)", { text: transcript });
                  void runAgentPipeline(transcript, triggerAt);
                } else {
                  logger.info("EndOfTurn — agent pipeline already running for matching transcript");
                  voiceJourney?.step("STT.flux", "EndOfTurn_skip_pipeline_already_running_same_text");
                }
              }
              break;
            }
          }
        });

        dgSocket.on("error", (err) => {
          logger.error("Flux STT error", { err: err.message, socketId: socket.id });
          socket.emit("voice:error", { code: "STT_ERROR", message: err.message });
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dgSocket.on("close", (event: any) => {
          const code: number = typeof event === "object" && event !== null ? event.code : event;
          const reason: string = typeof event === "object" && event !== null ? (event.reason ?? "") : "";
          isFluxOpen = false;
          pendingChunks = [];
          if (code !== 1000 && code !== 1001) {
            logger.error("Flux STT connection closed unexpectedly", { code, reason, socketId: socket.id });
            socket.emit("voice:error", { code: "STT_CLOSED", message: `Deepgram closed with code ${code}${reason ? `: ${reason}` : ""}` });
          } else {
            logger.info("Flux STT connection closed", { code, socketId: socket.id });
          }
        });

        dgSocket.connect();
        logger.info("Flux STT WebSocket connecting…", { socketId: socket.id });
        voiceJourney?.step("STT.flux", "connect_called");
      } catch (err) {
        pendingChunks = [];
        logger.error("Failed to connect to Flux STT", { err, socketId: socket.id });
        voiceJourney?.step("STT.flux", "connect_failed", { message: String(err).slice(0, 200) });
        socket.emit("voice:error", { code: "STT_CONNECT_FAILED", message: String(err) });
        socket.emit("voice:stateChange", "idle");
        voiceJourney?.step("SOCKET.emit", "voice:stateChange", { state: "idle", phase: "flux_connect_failed" });
      }
    })();
  });

  socket.on("voice:audioChunk", (chunk) => {
    const buf = chunk as ArrayBuffer;
    if (!dgSocket || !isFluxOpen) {
      pendingChunks.push(buf);
      if (pendingChunks.length === 1) logger.debug("Buffering audio until Flux is ready", { socketId: socket.id });
      return;
    }
    try { dgSocket.sendMedia(buf); } catch (err) { logger.warn("Failed to send audio chunk to Flux", { err }); }
  });

  socket.on("voice:bargeIn", () => {
    if (!isTtsStreaming) return;
    logger.info("voice:bargeIn (frontend RMS) — cancelling pipeline", { socketId: socket.id });
    voiceJourney?.step("SOCKET.rx", "voice:bargeIn");
    cancelPipeline();
    socket.emit("voice:ttsCancel");
    socket.emit("voice:stateChange", "listening");
  });

  socket.on("voice:restaurantPick", (payload) => {
    if (!activeSessionId) return;
    const id = typeof payload?.restaurantId === "string" ? payload.restaurantId.trim() : "";
    if (!id) return;
    const row = DUMMY_VOICE_RESTAURANTS.find((r) => r.id === id);
    if (!row) {
      logger.warn("voice:restaurantPick — unknown id", { id });
      return;
    }
    logger.info("voice:restaurantPick", { id, name: row.name });
    if (isTtsStreaming) {
      cancelPipeline();
      socket.emit("voice:ttsCancel");
      socket.emit("voice:stateChange", "listening");
    }
    const line = `Book a table at ${row.name}.`;
    voiceJourney?.step("SOCKET.rx", "voice:restaurantPick", { restaurantId: id });
    socket.emit("voice:transcript", {
      text: line,
      turnEvent: "EndOfTurn",
      isFinal: true,
      speechFinal: true,
    });
    void runAgentPipeline(line, Date.now());
  });

  socket.on("voice:reservationWidgetSubmit", (payload) => {
    const text = typeof payload?.text === "string" ? payload.text.trim() : "";
    if (!text || !activeSessionId) return;
    if (isTtsStreaming) {
      cancelPipeline();
      socket.emit("voice:ttsCancel");
      socket.emit("voice:stateChange", "listening");
    }
    voiceJourney?.step("SOCKET.rx", "voice:reservationWidgetSubmit", { textLen: text.length });
    socket.emit("voice:transcript", {
      text,
      turnEvent: "EndOfTurn",
      isFinal: true,
      speechFinal: true,
    });
    void runAgentPipeline(text, Date.now());
  });

  // ── Image attachments ─────────────────────────────────────────────────────
  socket.on("voice:imageAttach", (payload, ack) => {
    const result = imageContext.attach({
      mediaType: payload?.mediaType,
      data: payload?.data,
      caption: payload?.caption,
    });
    const attached = imageContext.listAllMeta();
    if (!result.ok || !result.image) {
      const ackPayload = { ok: false as const, error: result.error, attached };
      ack?.(ackPayload);
      socket.emit("voice:imageAttachAck", ackPayload);
      logger.warn("voice:imageAttach rejected", { error: result.error });
      return;
    }
    const meta = {
      id: result.image.id,
      mediaType: result.image.mediaType,
      byteSize: result.image.byteSize,
      caption: result.image.caption,
    };
    const ackPayload = { ok: true as const, image: meta, attached };
    ack?.(ackPayload);
    socket.emit("voice:imageAttachAck", ackPayload);
  });

  socket.on("voice:imageRemove", (payload) => {
    const id = typeof payload?.id === "string" ? payload.id.trim() : "";
    if (!id) return;
    const removed = imageContext.remove(id);
    if (!removed) return;
    socket.emit("voice:imageRemoved", {
      removedId: id,
      attached: imageContext.listAllMeta(),
    });
  });

  socket.on("voice:imageClearAll", () => {
    if (!imageContext.hasAny()) return;
    imageContext.reset();
    socket.emit("voice:imageRemoved", {
      removedId: "",
      attached: [],
    });
  });

  socket.on("voice:stop", () => {
    logger.info("voice:stop", { socketId: socket.id });
    voiceJourney?.step("SESSION", "voice_stop_begin");
    socket.emit("voice:restaurantPickerHide");
    socket.emit("voice:reservationProgress", null);
    cancelPipeline();
    teardownDg();
    closeSessionTtsWs();
    closeCartesiaTtsWs();
    if (activeSessionId) workflowOrchestrator.evictSession(activeSessionId);
    if (imageContext.hasAny()) {
      imageContext.reset();
      socket.emit("voice:imageRemoved", { removedId: "", attached: [] });
    }
    clientLocation = null;
    clientTimeZone = null;
    socket.emit("voice:stateChange", "idle");
    voiceJourney?.step("SOCKET.emit", "voice:stateChange", { state: "idle", phase: "voice_stop" });
    voiceJourney?.end("voice:stop");
    voiceJourney = null;
  });

  socket.on("disconnect", () => {
    voiceJourney?.step("SESSION", "socket_disconnect_begin");
    cancelPipeline();
    teardownDg();
    closeSessionTtsWs();
    closeCartesiaTtsWs();
    imageContext.reset();
    clientLocation = null;
    clientTimeZone = null;
    voiceJourney?.end("socket.disconnect");
    voiceJourney = null;
  });
}

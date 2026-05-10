import type { Message } from "./domain";
import type { VoicePersonaId } from "./voicePersona";

export type VoiceState = "idle" | "connecting" | "listening" | "thinking" | "speaking";

/** Flux TurnInfo event types from /v2/listen */
export type FluxTurnEvent =
  | "Update"          // More audio transcribed, turn ongoing
  | "StartOfTurn"     // User started speaking (VAD equivalent)
  | "EagerEndOfTurn"  // Moderate confidence — good time to start LLM/TTS
  | "TurnResumed"     // Was EagerEndOfTurn but user kept talking — cancel any eager response
  | "EndOfTurn";      // Definitive end of turn

export interface VoiceTranscriptPayload {
  text: string;
  /** Flux turn event type (undefined for legacy Nova-3 results) */
  turnEvent?: FluxTurnEvent;
  isFinal: boolean;
  speechFinal: boolean;
  confidence?: number;
  endOfTurnConfidence?: number;
}

export interface VoiceTtsTimingBreakdown {
  /** triggerAt → fetch() called: JS overhead (cancelTTS, AbortController, emit) */
  triggerToFetchMs: number;
  /** fetch() called → response headers received: TCP+TLS handshake + request transit */
  fetchToHeadersMs: number;
  /** Response headers → first audio chunk: TTS synthesis + first byte streaming */
  headersToFirstChunkMs: number;
  /** Flux turn event → TTS WebSocket connection attempt starts. */
  triggerToTtsConnectStartMs?: number;
  /** TTS WebSocket connection attempt → WebSocket open. */
  ttsConnectMs?: number;
  /**
   * How long this turn waited for the TTS WS to open.
   * 0 when the session-warm WS was already ready before the turn started.
   */
  ttsWsWaitMs?: number;
  /** TTS WebSocket open → LLM request starts. */
  ttsReadyToLlmStartMs?: number;
  /**
   * Wall clock for the full `Promise.all([memory, workflow])` before `streamText`.
   * Approximately max(memoryPrepMs, workflowOrchestrationMs) plus tiny JS overhead.
   * Not included in `llmTtftMs` (which starts at stream open).
   */
  contextPrepMs?: number;
  /** Time for direct memory fetch only (one branch of the parallel prep). */
  memoryPrepMs?: number;
  /** Time for `workflowOrchestrator.process` only (other branch). */
  workflowOrchestrationMs?: number;
  /** Workflow intent classifier output for this turn. */
  workflowIntent?: string;
  workflowIntentConfidence?: string;
  /** FSM step after orchestration (e.g. COLLECTING_RESTAURANT, CONFIRMING). */
  workflowStep?: string;
  workflowActive?: boolean;
  workflowFlowId?: string | null;
  /**
   * Routing tag emitted by the LLM on the first line of a general-mode
   * response ([RESERVATION] or [GENERAL]).  Absent when a workflow is already
   * active (the workflow shell does not include the tag instruction).
   */
  llmRoutingTag?: string;
  /** LLM start → first speakable segment sent to TTS. */
  llmStartToFirstSegmentMs?: number;
  /** First speakable segment sent to TTS → first TTS audio byte. */
  firstSegmentToFirstAudioMs?: number;
  /** First TTS audio byte → TTS WebSocket closed after all audio. */
  firstAudioToTtsDoneMs?: number;
  /** Number of LLM text segments sent to TTS. */
  ttsSegmentCount?: number;
  /** Generated audio duration, derived from PCM bytes. */
  generatedAudioMs?: number;
  /** Wall time receiving audio divided by generated audio duration. Lower is better; ~1 is realtime. */
  audioRealtimeRatio?: number;
  maxInterChunkGapMs?: number;
  underrunRiskEvents?: number;
  maxRealtimeDeficitMs?: number;
  /**
   * When the LLM emitted a <tool> block this turn, the wall time spent executing
   * that tool (e.g. weather API, workflow slot mutator). Slots between pass-1
   * and pass-2 of the LLM. Absent for non-tool turns.
   */
  toolExecMs?: number;
  /** Name of the tool that executed (when toolExecMs is set). */
  toolName?: string;
  /**
   * TTFT for the second LLM pass (after a tool returned). Absent when no tool
   * fired or when the deterministic-reply fast-path skipped pass 2.
   */
  pass2LlmTtftMs?: number;
}

export interface VoiceTtsEndPayload {
  /** First audio byte − first TTS segment `triggerAt` (equals A+B+C when timing is set). */
  ttfaMs: number;
  totalMs: number;
  /** Text spoken by the assistant for this TTS turn. */
  assistantText?: string;
  timing?: VoiceTtsTimingBreakdown;
  /** Time from `streamText` start to first streamed text token (TTFT). */
  llmTtftMs?: number;
  /** Time from first text token to first TTS request (speakable flush + scheduling). */
  llmPostFirstTokenMs?: number;
}

export interface VoiceAssistantTranscriptPayload {
  /** Accumulated assistant text generated so far for this turn. */
  text: string;
  /** True when this is the final assistant text for the turn. */
  isFinal: boolean;
}

/** Cartesia (and similar) word-level timings for karaoke-style captions during TTS. Times are in seconds (audio timeline). */
export interface VoiceTtsWordTimestampsPayload {
  words: string[];
  start: number[];
  end: number[];
  flushId?: number;
}

/** Browser geolocation sent to the voice session (used for local weather, etc.). */
export interface VoiceClientLocationPayload {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
}

/** Structured weather result for a small UI card after the tool succeeds. */
export interface VoiceWeatherWidgetPayload {
  placeLabel: string;
  condition: string;
  temperatureC: number | null;
  feelsLikeC: number | null;
  humidityPct: number | null;
  precipitationMm: number | null;
  cloudCoverPct: number | null;
  windSummary: string;
}

/** One row in the reservation restaurant picker (dummy demo data). */
export interface VoiceRestaurantPickerOption {
  id: string;
  name: string;
  cuisine: string;
  rating: number;
  area: string;
}

export interface VoiceRestaurantPickerPayload {
  options: VoiceRestaurantPickerOption[];
}

/** Compact metadata about a single image attachment held server-side. */
export interface VoiceImageAttachmentMeta {
  id: string;
  mediaType: string;
  byteSize: number;
  caption?: string;
}

/** Client → server: upload an image into the current voice session. */
export interface VoiceImageAttachClientPayload {
  /** Base-64 encoded image bytes (no `data:` prefix). */
  data: string;
  /** IANA media type — image/jpeg, image/png, image/webp, image/gif. */
  mediaType: string;
  /** Optional short user note shown alongside the thumbnail. */
  caption?: string;
}

/** Server → client: response to `voice:imageAttach` (also delivered as ack). */
export interface VoiceImageAttachAckPayload {
  ok: boolean;
  error?: string;
  /** When `ok: true`, the metadata for the freshly attached image. */
  image?: VoiceImageAttachmentMeta;
  /** Authoritative list of all images currently attached to this session. */
  attached: VoiceImageAttachmentMeta[];
}

/** Server → client: a removal happened (server-driven snapshot). */
export interface VoiceImageRemovedPayload {
  removedId: string;
  attached: VoiceImageAttachmentMeta[];
}

/** Snapshot of demo reservation workflow for sidebar UI (restaurant voice flow). */
export interface VoiceReservationSlotsSnapshot {
  restaurant: string | null;
  date: string | null;
  time: string | null;
  partySize: number | null;
  seatingPreference: string | null;
  phoneNumber: string | null;
}

export interface VoiceReservationProgressPayload {
  currentStep: string;
  slots: VoiceReservationSlotsSnapshot;
  pendingConfirmation: boolean;
}

export interface ServerToClientEvents {
  "message:new": (message: Message) => void;
  "session:updated": (sessionId: string) => void;
  "error": (payload: { code: string; message: string }) => void;

  "voice:transcript": (payload: VoiceTranscriptPayload) => void;
  /** Fires the instant Flux detects speech starting (StartOfTurn) — use for barge-in */
  "voice:speechStarted": () => void;
  /** Fires when Flux has moderate confidence the turn ended — good time to start preparing response */
  "voice:eagerEndOfTurn": (payload: { transcript: string }) => void;
  /** Fires when Flux's EagerEndOfTurn was a false positive — cancel any response started early */
  "voice:turnResumed": () => void;
  "voice:assistantTranscript": (payload: VoiceAssistantTranscriptPayload) => void;
  /** Word-level TTS timings (Cartesia when `add_timestamps` is enabled). */
  "voice:ttsWordTimestamps": (payload: VoiceTtsWordTimestampsPayload) => void;
  "voice:ttsStart": () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "voice:ttsChunk": (chunk: any) => void;
  "voice:ttsEnd": (payload: VoiceTtsEndPayload) => void;
  "voice:ttsCancel": () => void;
  "voice:stateChange": (state: VoiceState) => void;
  "voice:error": (payload: { code: string; message: string }) => void;
  /** Ask the client to call browser geolocation (e.g. while TTS explains why). */
  "voice:requestLocation": (payload: { reason: "weather" }) => void;
  /** Weather tool succeeded — show a compact widget (e.g. top-right). */
  "voice:weatherWidget": (payload: VoiceWeatherWidgetPayload) => void;
  /** Show dummy restaurant choices while collecting the restaurant slot. */
  "voice:restaurantPicker": (payload: VoiceRestaurantPickerPayload) => void;
  /** Hide the restaurant picker (left restaurant step or flow ended). */
  "voice:restaurantPickerHide": () => void;
  /**
   * Reservation FSM + slots after a turn (or null when flow inactive / session ended).
   * Drives progress + collection sidebars on the client.
   */
  "voice:reservationProgress": (payload: VoiceReservationProgressPayload | null) => void;
  /** Server-side acknowledgement of an `voice:imageAttach` request. */
  "voice:imageAttachAck": (payload: VoiceImageAttachAckPayload) => void;
  /** Server-driven snapshot when an image is removed (or all cleared). */
  "voice:imageRemoved": (payload: VoiceImageRemovedPayload) => void;
}

export interface ClientToServerEvents {
  "session:join": (sessionId: string) => void;
  "session:leave": (sessionId: string) => void;
  "message:send": (
    payload: { sessionId: string; content: string },
    ack?: (response: { ok: boolean; messageId?: string; error?: string }) => void
  ) => void;

  "voice:start": (payload: {
    sampleRate: number;
    location?: VoiceClientLocationPayload;
    /** IANA timezone from `Intl.DateTimeFormat().resolvedOptions().timeZone` for prompt + clock context. */
    clientTimeZone?: string;
    /** Speaking personality for the whole voice session. */
    persona?: VoicePersonaId;
    /** When set, conversation is persisted and memory is loaded for this user. */
    userId?: string;
    /** Resume this chat session (must belong to userId). */
    sessionId?: string;
  }) => void;
  /** Update device coordinates mid-session (after permission grant). */
  "voice:clientLocation": (payload: VoiceClientLocationPayload) => void;
  "voice:stop": () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "voice:audioChunk": (chunk: any) => void;
  "voice:bargeIn": () => void;
  /**
   * User tapped a restaurant in the picker — treated like saying that name
   * (runs the same LLM pipeline as a voice turn).
   */
  "voice:restaurantPick": (payload: { restaurantId: string }) => void;
  /**
   * Widget tap / form submit — injected as a finalized user turn (same path as voice STT).
   * Use short natural lines the booking model can map to tools (e.g. ISO date, "party of 4").
   */
  "voice:reservationWidgetSubmit": (payload: { text: string }) => void;
  /**
   * Attach an image to the live voice session. The image is included in the
   * NEXT user turn that goes to the LLM (and stays in the rolling
   * conversation context until removed or the session ends).
   */
  "voice:imageAttach": (
    payload: VoiceImageAttachClientPayload,
    ack?: (response: VoiceImageAttachAckPayload) => void,
  ) => void;
  /** Remove a single attachment by id. */
  "voice:imageRemove": (payload: { id: string }) => void;
  /** Drop every attachment for this session (also fires when the session stops). */
  "voice:imageClearAll": () => void;
}

export interface InterServerEvents {
  ping: () => void;
}

export interface SocketData {
  userId?: string;
  sessionId?: string;
}

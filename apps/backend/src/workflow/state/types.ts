/**
 * Core types for the workflow orchestration layer.
 *
 * These types are provider-agnostic and contain no LLM or socket specifics.
 * They define the shape of state, intents, slots, and orchestration results
 * that flow through every module in src/workflow/.
 */

// ── Intent ────────────────────────────────────────────────────────────────────

export type IntentLabel =
  | "reservation_booking"
  | "reservation_update"
  | "reservation_cancel"
  | "faq_question"
  | "small_talk"
  | "off_topic"
  | "correction"
  | "confirmation_yes"
  | "confirmation_no"
  /** In-workflow default: user is answering / correcting / continuing — not global NLU. */
  | "workflow_continue"
  | "unknown";

export interface IntentResult {
  label: IntentLabel;
  /** Qualitative confidence — used to decide whether to interrupt the flow. */
  confidence: "high" | "medium" | "low";
}

// ── Flows & Steps ─────────────────────────────────────────────────────────────

export type FlowId = "restaurant_reservation";

export type ReservationStep =
  | "IDLE"
  | "COLLECTING_RESTAURANT"
  | "COLLECTING_DATE"
  | "COLLECTING_TIME"
  | "COLLECTING_PARTY_SIZE"
  | "COLLECTING_SEATING"
  | "COLLECTING_PHONE"
  | "CONFIRMING"
  | "CALLING_TOOL"
  | "COMPLETED"
  | "CANCELLED";

// ── Slots ─────────────────────────────────────────────────────────────────────

export interface ReservationSlots {
  restaurant: string | null;
  /** ISO date string yyyy-MM-dd */
  date: string | null;
  /** 24-hour HH:mm string */
  time: string | null;
  partySize: number | null;
  seatingPreference: string | null;
  phoneNumber: string | null;
}

export interface SlotExtractionResult {
  slots: Partial<ReservationSlots>;
  /** Slot keys that overwrote previously filled values (user correction). */
  corrections: Array<keyof ReservationSlots>;
}

// ── Context Stack (interruptions) ─────────────────────────────────────────────

export interface PausedContext {
  flowId: FlowId;
  step: ReservationStep;
  slots: ReservationSlots;
  pausedAt: number;
  /** Short phrase the assistant appends when resuming ("Back to your reservation —"). */
  resumeHint: string;
}

// ── Workflow State ────────────────────────────────────────────────────────────

export interface WorkflowState {
  activeFlow: FlowId | null;
  currentStep: ReservationStep;
  slots: ReservationSlots;
  pausedContexts: PausedContext[];
  pendingConfirmation: boolean;
  lastIntent: IntentLabel | null;
  retryCount: number;
  /** Unix ms — used for staleness checks. */
  updatedAt: number;
}

// ── Tool Results ──────────────────────────────────────────────────────────────

export interface RestaurantSearchResult {
  name: string;
  cuisine: string;
  rating: number;
  address: string;
}

export interface AvailabilityResult {
  available: boolean;
  alternatives?: Array<{ date: string; time: string }>;
  confirmationId?: string;
}

export interface ReservationResult {
  success: boolean;
  confirmationId: string;
  details: string;
}

export interface CancelResult {
  success: boolean;
  message: string;
}

// ── Orchestrator Output ───────────────────────────────────────────────────────

/**
 * Result returned to the voice pipeline after each turn.
 * The pipeline injects workflowContextBlock into the system prompt and
 * proceeds with the normal LLM call. There is no separate direct-response
 * path — the LLM always generates speech, but with tight workflow instructions.
 */
export interface OrchestratorResult {
  /** Whether a workflow is currently active or was just completed. */
  isWorkflowActive: boolean;
  /**
   * Block injected at the end of the system prompt.
   * null when no workflow is active.
   */
  workflowContextBlock: string | null;
  /** The state after this turn — already persisted. */
  state: WorkflowState;
  /** Intent from the pattern classifier for this user utterance (always set). */
  detectedIntent: IntentLabel;
  intentConfidence: "high" | "medium" | "low";
}

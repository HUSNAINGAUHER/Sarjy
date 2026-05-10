/**
 * Workflow Orchestrator — per-turn entry point.
 *
 * Design contract (strict):
 * ─────────────────────────
 * This module is a PURE STATE READER.  It never mutates workflow state based
 * on user text, pattern matching, or heuristics.  The ONLY path to state
 * mutation is an explicit LLM tool call (workflow_update_reservation_slots,
 * workflow_cancel_reservation, workflow_book_reservation).
 *
 * process() responsibilities:
 *   1. Load persisted state (cached after first call).
 *   2. If no active workflow → return null context block.
 *   3. Build a scoped step-context block from the CURRENT PERSISTED step + slots.
 *   4. Return — no mutations, no inference, no regex.
 *
 * activateFromTag() — called AFTER the LLM emits [RESERVATION] on the first
 * general pass.  Seeds state so the second workflow-prompt pass is correct.
 */

import { buildStepContext } from "@/workflow/engine/WorkflowPromptBuilder";
import { createInitialState, workflowStateManager } from "@/workflow/state/WorkflowStateManager";
import {
  computeNextStep,
  describeFilledSlots,
  listMissingRequiredSlots,
} from "@/workflow/flows/restaurantReservation";
import type {
  OrchestratorResult,
  ReservationSlots,
  WorkflowState,
} from "@/workflow/state/types";
import { logger } from "@/utils/logger";

const stateManager = workflowStateManager;

export class WorkflowOrchestrator {
  /**
   * Process one user turn.
   *
   * • Not in workflow  → returns null context block; LLM uses base prompt with
   *   [RESERVATION]/[GENERAL] tag routing.
   * • In workflow      → returns scoped step-context block built from persisted
   *   state.  No state mutation happens here.
   */
  async process(
    _userText: string,
    sessionId: string | null,
  ): Promise<OrchestratorResult> {
    const stateKey = sessionId ?? `anon-${Date.now()}`;

    const state = sessionId
      ? await stateManager.load(sessionId)
      : createInitialState();

    const isInActiveFlow =
      state.activeFlow !== null
      && state.currentStep !== "IDLE"
      && state.currentStep !== "CANCELLED"
      && state.currentStep !== "COMPLETED";

    if (!isInActiveFlow) {
      return {
        isWorkflowActive: false,
        workflowContextBlock: null,
        state,
        detectedIntent: "unknown",
        intentConfidence: "low",
      };
    }

    const missingRequired = listMissingRequiredSlots(state.slots);

    logger.info("[Orchestrator] turn snapshot", {
      stateKey,
      step: state.currentStep,
      pendingConfirmation: state.pendingConfirmation,
      slots: state.slots,
      filledSummary: describeFilledSlots(state.slots),
      missingRequired,
    });

    const contextBlock = buildStepContext(state.currentStep, state.slots, sessionId);

    logger.info("[Orchestrator] turn complete", {
      stateKey,
      step: state.currentStep,
      flow: state.activeFlow,
      pendingConfirmation: state.pendingConfirmation,
      slots: state.slots,
      missingRequired,
    });

    return {
      isWorkflowActive: true,
      workflowContextBlock: contextBlock,
      state: { ...state, lastIntent: "workflow_continue" },
      detectedIntent: "workflow_continue",
      intentConfidence: "high",
    };
  }

  /**
   * Activate the reservation workflow from a detected [RESERVATION] LLM tag.
   *
   * Called AFTER the LLM response when the first pass returns routingTag
   * === "RESERVATION" and no workflow was active.  Pre-fills any slots that
   * the slot extractor already found in the user's utterance.
   */
  async activateFromTag(
    sessionId: string,
    extractedSlots: ReservationSlots,
  ): Promise<void> {
    const existing = await stateManager.load(sessionId);
    if (existing.activeFlow) {
      logger.info("[Orchestrator] activateFromTag skipped — flow already active", { sessionId });
      return;
    }

    const blankSlots = createInitialState().slots;
    const initialStep = computeNextStep(extractedSlots, false, false);
    const newState: WorkflowState = {
      ...createInitialState(),
      activeFlow: "restaurant_reservation",
      currentStep: initialStep,
      slots: { ...blankSlots, ...extractedSlots },
      lastIntent: "reservation_booking",
      updatedAt: Date.now(),
    };

    stateManager.save(sessionId, newState);

    const preFilledSlots = Object.entries(extractedSlots)
      .filter(([, v]) => v !== null)
      .map(([k]) => k);

    logger.info("[Orchestrator] activateFromTag — reservation flow started", {
      sessionId,
      initialStep,
      preFilledSlots,
    });
  }

  /** Called on voice:stop — evict in-memory state. */
  evictSession(sessionId: string): void {
    stateManager.evict(sessionId);
  }

  /** In-memory workflow snapshot for UI (no Prisma read). */
  peekCachedState(sessionId: string): WorkflowState | null {
    return stateManager.peekCached(sessionId);
  }

  /** Load workflow JSON from DB into the cache (first `peek` miss). */
  async primeSessionCache(sessionId: string): Promise<void> {
    await stateManager.load(sessionId);
  }

  /**
   * Rebuild the workflow system block from in-memory state after a voice tool
   * mutates slots (same turn as workflow_update_reservation_slots).
   */
  buildLiveContextBlock(sessionId: string): string | undefined {
    const s = stateManager.peekCached(sessionId);
    if (!s?.activeFlow) return undefined;
    if (s.currentStep === "COMPLETED" || s.currentStep === "CANCELLED") {
      return undefined;
    }
    return buildStepContext(s.currentStep, s.slots, sessionId);
  }
}

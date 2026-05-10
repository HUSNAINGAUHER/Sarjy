/**
 * Context Stack Manager
 *
 * Handles push/pop of paused workflow contexts when the user goes off-script
 * (e.g., asks an unrelated question mid-reservation flow).
 *
 * Push  → saves the current FSM position and slots, returns an interrupted state.
 * Pop   → restores the saved position, returns a resume hint for the LLM.
 */

import type { PausedContext, ReservationStep, WorkflowState } from "@/workflow/state/types";
import { logger } from "@/utils/logger";

// Maximum contexts to stack — prevents unbounded growth
const MAX_STACK_DEPTH = 3;

export class ContextStackManager {
  /**
   * Pause the active flow and push it onto the stack.
   * Returns the updated state (activeFlow is still set, step becomes the
   * caller's current step — the orchestrator must set it to IDLE-while-paused).
   */
  push(state: WorkflowState): WorkflowState {
    if (!state.activeFlow) return state;

    const context: PausedContext = {
      flowId: state.activeFlow,
      step: state.currentStep,
      slots: { ...state.slots },
      pausedAt: Date.now(),
      resumeHint: buildResumeHint(state.currentStep, state.slots),
    };

    const stack = [...state.pausedContexts];
    if (stack.length >= MAX_STACK_DEPTH) {
      stack.shift(); // drop oldest
    }
    stack.push(context);

    logger.info("[ContextStackManager] pushed context", {
      flow: context.flowId,
      step: context.step,
      stackDepth: stack.length,
    });

    return {
      ...state,
      pausedContexts: stack,
    };
  }

  /**
   * Pop the most recent paused context and restore the workflow state.
   * Returns the restored state and the resume hint string (or null if
   * nothing was paused).
   */
  pop(state: WorkflowState): { state: WorkflowState; resumeHint: string | null } {
    if (state.pausedContexts.length === 0) {
      return { state, resumeHint: null };
    }

    const stack = [...state.pausedContexts];
    const context = stack.pop()!;

    // Merge any new slot info collected after the interruption back onto
    // the restored slots (new info wins over old paused snapshot).
    const mergedSlots = mergeSlots(context.slots, state.slots);

    const restored: WorkflowState = {
      ...state,
      activeFlow: context.flowId,
      currentStep: context.step,
      slots: mergedSlots,
      pausedContexts: stack,
    };

    logger.info("[ContextStackManager] popped context", {
      flow: context.flowId,
      resumeStep: context.step,
      stackDepth: stack.length,
      resumeHint: context.resumeHint,
    });

    return { state: restored, resumeHint: context.resumeHint };
  }

  hasContext(state: WorkflowState): boolean {
    return state.pausedContexts.length > 0;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildResumeHint(step: ReservationStep, slots: WorkflowState["slots"]): string {
  const stepPhrases: Partial<Record<ReservationStep, string>> = {
    COLLECTING_RESTAURANT: "Back to your reservation — which restaurant did you want?",
    COLLECTING_DATE: "Back to your reservation — what date were you thinking?",
    COLLECTING_TIME: "Back to your reservation — what time works for you?",
    COLLECTING_PARTY_SIZE: "Back to your reservation — how many people?",
    COLLECTING_SEATING: "Back to your reservation — any seating preference?",
    COLLECTING_PHONE: "Back to your reservation — I just need a contact number.",
    CONFIRMING: `Back to your reservation — ready to confirm the details?`,
  };

  return stepPhrases[step] ?? "Now, back to your reservation —";
}

/**
 * Merge two slot objects: prefer newer non-null values over older ones.
 */
function mergeSlots(
  older: WorkflowState["slots"],
  newer: WorkflowState["slots"],
): WorkflowState["slots"] {
  return {
    restaurant: newer.restaurant ?? older.restaurant,
    date: newer.date ?? older.date,
    time: newer.time ?? older.time,
    partySize: newer.partySize ?? older.partySize,
    seatingPreference: newer.seatingPreference ?? older.seatingPreference,
    phoneNumber: newer.phoneNumber ?? older.phoneNumber,
  };
}

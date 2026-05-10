/**
 * Response Planner
 *
 * Given the current workflow state, produces a tight instruction block
 * that is injected at the end of the system prompt.
 *
 * The LLM always generates the actual speech — this planner only decides
 * WHAT to ask and HOW to constrain the response.  This keeps the
 * orchestration layer fully decoupled from the LLM provider.
 */

import type { ReservationSlots, ReservationStep, WorkflowState } from "@/workflow/state/types";
import { formatDateReadable, formatTimeReadable } from "@/workflow/tools/restaurantTools";
import { logger } from "@/utils/logger";

export interface PlannedResponse {
  contextBlock: string;
  targetStep: ReservationStep;
}

export class ResponsePlanner {
  /**
   * Build the workflow context block for the current state.
   *
   * @param state — current (post-transition) workflow state
   * @param opts.resumeHint — optional phrase prepended when resuming after interruption
   * @param opts.sessionId — injected into CALLING_TOOL block so the LLM passes it
   *   through as a tool argument, allowing the tool to update workflow state.
   */
  plan(
    state: WorkflowState,
    opts: {
      resumeHint?: string | null;
      toolSummary?: string | null;
      sessionId?: string | null;
    } = {},
  ): PlannedResponse {
    const { currentStep, slots, pendingConfirmation } = state;
    const resumePrefix = opts.resumeHint ? `${opts.resumeHint} ` : "";

    let contextBlock: string;

    switch (currentStep) {
      case "IDLE":
      case "COMPLETED":
      case "CANCELLED":
        contextBlock = "[WORKFLOW: none active] Respond naturally.";
        break;

      case "COLLECTING_RESTAURANT":
        contextBlock = buildCollectingBlock("restaurant", slots, resumePrefix, [
          "Which restaurant would you like?",
          "Got it. Which restaurant?",
        ]);
        break;

      case "COLLECTING_DATE":
        contextBlock = buildCollectingBlock("date", slots, resumePrefix, [
          "What date works for you?",
          "What day were you thinking?",
        ]);
        break;

      case "COLLECTING_TIME":
        contextBlock = buildCollectingBlock("time", slots, resumePrefix, [
          "What time would you like the table?",
          "What time works?",
        ]);
        break;

      case "COLLECTING_PARTY_SIZE":
        contextBlock = buildCollectingBlock("partySize", slots, resumePrefix, [
          "How many people will be dining?",
          "And how many guests?",
        ]);
        break;

      case "COLLECTING_SEATING":
        contextBlock = buildCollectingBlock("seatingPreference", slots, resumePrefix, [
          "Any seating preference — indoor, outdoor, booth?",
          "Do you have a seating preference?",
        ]);
        break;

      case "COLLECTING_PHONE":
        contextBlock = buildCollectingBlock("phoneNumber", slots, resumePrefix, [
          "Last thing — what number should we put for the reservation?",
          "And a contact number?",
        ]);
        break;

      case "CONFIRMING": {
        const summary = buildSlotSummary(slots);
        contextBlock = [
          "[WORKFLOW: restaurant_reservation | CONFIRMING]",
          `DETAILS: ${summary}`,
          `${resumePrefix}Read back the reservation details in one warm, short sentence. Then ask: "Shall I go ahead and book it?"`,
          "Keep your response under 30 words. No lists — speak it naturally.",
        ].filter(Boolean).join("\n");
        break;
      }

      case "CALLING_TOOL": {
        const s = state.slots;
        const sessionArg = opts.sessionId ? `"sessionId": "${opts.sessionId}"` : '"sessionId": null';
        contextBlock = [
          "[WORKFLOW: restaurant_reservation | CONFIRMED — INVOKE BOOKING TOOL NOW]",
          "The user confirmed the reservation. You MUST call the workflow_book_reservation tool immediately.",
          "Speak ONE short natural sentence first (e.g. 'Perfect, booking that now.'), then emit the tool block.",
          "Use EXACTLY these argument values — do not change or omit any field:",
          `  restaurant: "${s.restaurant ?? ""}"`,
          `  date: "${s.date ?? ""}"`,
          `  time: "${s.time ?? ""}"`,
          `  partySize: ${s.partySize ?? 0}`,
          `  seatingPreference: ${s.seatingPreference ? `"${s.seatingPreference}"` : "null"}`,
          `  phoneNumber: "${s.phoneNumber ?? ""}"`,
          `  ${sessionArg}`,
        ].join("\n");
        break;
      }

      default:
        contextBlock = "[WORKFLOW: none active] Respond naturally.";
    }

    logger.info("[ResponsePlanner]", { step: currentStep, hasResume: Boolean(opts.resumeHint) });

    return { contextBlock, targetStep: currentStep };
  }
}

/**
 * Deterministic next-question for slot collection steps. Used to bypass the
 * second LLM pass after `workflow_update_reservation_slots` — saves ~1–2s of
 * TTFT per slot turn since the question is fully determined by the new step.
 *
 * Returns null when the current step needs the LLM (CONFIRMING, CALLING_TOOL,
 * COMPLETED, CANCELLED, IDLE) — in those cases pass 2 still runs.
 *
 * Variants are rotated by a stable hash of the slot values so the same slot
 * state always picks the same wording (idempotent across retries) but
 * different turns vary naturally.
 */
export function buildDeterministicSlotPrompt(state: WorkflowState): string | null {
  if (state.activeFlow !== "restaurant_reservation") return null;
  const variants = SLOT_PROMPT_VARIANTS[state.currentStep];
  if (!variants) return null;
  const idx = stableHash(JSON.stringify(state.slots)) % variants.length;
  return variants[idx] ?? null;
}

const SLOT_PROMPT_VARIANTS: Partial<Record<ReservationStep, readonly string[]>> = {
  COLLECTING_RESTAURANT: [
    "Which restaurant would you like?",
    "Got it. Which restaurant did you have in mind?",
    "Sure — what restaurant?",
  ],
  COLLECTING_DATE: [
    "What date works for you?",
    "What day were you thinking?",
    "And which day?",
  ],
  COLLECTING_TIME: [
    "What time would you like the table?",
    "What time works?",
    "And what time?",
  ],
  COLLECTING_PARTY_SIZE: [
    "How many people will be dining?",
    "And how many guests?",
    "How many in your party?",
  ],
  COLLECTING_SEATING: [
    "Any seating preference — indoor, outdoor, or a booth?",
    "Do you have a seating preference?",
    "Indoor, outdoor, or no preference?",
  ],
  COLLECTING_PHONE: [
    "Last thing — what number should I put down for the reservation?",
    "And a contact number for the booking?",
    "What's a good phone number to reach you?",
  ],
};

function stableHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildCollectingBlock(
  missingSlot: keyof ReservationSlots,
  slots: ReservationSlots,
  resumePrefix: string,
  examples: [string, string],
): string {
  const collectedLine = buildCollectedLine(slots, missingSlot);
  const slotLabel = SLOT_LABELS[missingSlot] ?? missingSlot;

  return [
    `[WORKFLOW: restaurant_reservation | COLLECTING_${missingSlot.toUpperCase()}]`,
    collectedLine ? `COLLECTED: ${collectedLine}` : "",
    `MISSING: ${slotLabel}`,
    `${resumePrefix}Ask ONLY for the ${slotLabel}. One short question. Example: "${examples[0]}"`,
    "Do not ask for any other information. Keep response under 15 words.",
  ].filter(Boolean).join("\n");
}

const SLOT_LABELS: Record<keyof ReservationSlots, string> = {
  restaurant: "restaurant name",
  date: "reservation date",
  time: "reservation time",
  partySize: "party size",
  seatingPreference: "seating preference",
  phoneNumber: "contact number",
};

function buildCollectedLine(
  slots: ReservationSlots,
  excludeSlot: keyof ReservationSlots,
): string {
  const parts: string[] = [];

  if (slots.restaurant && excludeSlot !== "restaurant") parts.push(`restaurant=${slots.restaurant}`);
  if (slots.date && excludeSlot !== "date") parts.push(`date=${formatDateReadable(slots.date)}`);
  if (slots.time && excludeSlot !== "time") parts.push(`time=${formatTimeReadable(slots.time)}`);
  if (slots.partySize && excludeSlot !== "partySize") parts.push(`party=${slots.partySize}`);
  if (slots.seatingPreference && excludeSlot !== "seatingPreference") parts.push(`seating=${slots.seatingPreference}`);
  if (slots.phoneNumber && excludeSlot !== "phoneNumber") parts.push(`phone=${slots.phoneNumber}`);

  return parts.join(", ");
}

function buildSlotSummary(slots: ReservationSlots): string {
  const parts: string[] = [];
  if (slots.restaurant) parts.push(slots.restaurant);
  if (slots.date) parts.push(formatDateReadable(slots.date));
  if (slots.time) parts.push(`at ${formatTimeReadable(slots.time)}`);
  if (slots.partySize) parts.push(`for ${slots.partySize}`);
  if (slots.seatingPreference) parts.push(slots.seatingPreference);
  if (slots.phoneNumber) parts.push(`contact ${slots.phoneNumber}`);
  return parts.join(", ");
}

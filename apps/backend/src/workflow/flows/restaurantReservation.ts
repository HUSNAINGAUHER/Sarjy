/**
 * Restaurant Reservation Flow — FSM Definition
 *
 * Defines the state machine for collecting reservation slots, the priority
 * order for slot collection, and the transition function that decides the
 * next step given the current set of filled slots.
 *
 * This is a pure data / logic module — no I/O, no LLM calls.
 */

import type { ReservationSlots, ReservationStep } from "@/workflow/state/types";

// ── Slot collection order ─────────────────────────────────────────────────────

/**
 * Priority order in which the flow asks for slots.
 * Slots already filled are skipped; the first unfilled slot determines the step.
 */
const COLLECTION_ORDER: Array<{
  slot: keyof ReservationSlots;
  step: ReservationStep;
}> = [
  { slot: "restaurant", step: "COLLECTING_RESTAURANT" },
  { slot: "date", step: "COLLECTING_DATE" },
  { slot: "time", step: "COLLECTING_TIME" },
  { slot: "partySize", step: "COLLECTING_PARTY_SIZE" },
  { slot: "seatingPreference", step: "COLLECTING_SEATING" },
  { slot: "phoneNumber", step: "COLLECTING_PHONE" },
];

// ── Core slot check helpers ───────────────────────────────────────────────────

/** All slots required to move to CONFIRMING (seating is optional). */
const REQUIRED_SLOTS: Array<keyof ReservationSlots> = [
  "restaurant",
  "date",
  "time",
  "partySize",
  "phoneNumber",
];

export function allRequiredSlotsFilled(slots: ReservationSlots): boolean {
  return REQUIRED_SLOTS.every((key) => slots[key] !== null && slots[key] !== undefined);
}

/** Required slots not yet persisted (for prompts + divergence diagnostics). */
export function listMissingRequiredSlots(slots: ReservationSlots): Array<keyof ReservationSlots> {
  return REQUIRED_SLOTS.filter((key) => slots[key] === null || slots[key] === undefined);
}

// ── FSM transition ────────────────────────────────────────────────────────────

/**
 * Compute the next FSM step based on the current slots.
 * Called after slot extraction has been applied so the step always reflects
 * the latest known slot state.
 *
 * Returns:
 * - The collection step for the first missing required slot.
 * - "CONFIRMING" when all required slots are present and confirmation is pending.
 * - "CALLING_TOOL" when all required slots are present and confirmation was given.
 * - "COMPLETED" when the tool has been called successfully.
 */
export function computeNextStep(
  slots: ReservationSlots,
  pendingConfirmation: boolean,
  toolCalled: boolean,
): ReservationStep {
  // Walk the collection order — return the step for the first missing slot
  for (const { slot, step } of COLLECTION_ORDER) {
    // seatingPreference is optional — skip if still null
    if (slot === "seatingPreference") continue;
    if (slots[slot] === null || slots[slot] === undefined) {
      return step;
    }
  }

  // All required slots are filled
  if (toolCalled) return "COMPLETED";
  if (pendingConfirmation) return "CONFIRMING";
  return "CONFIRMING"; // default: ask for confirmation
}

// ── Slot merge ────────────────────────────────────────────────────────────────

/**
 * Merge extracted slots into the current state's slots.
 * New values always win (corrections overwrite prior fills).
 */
export function mergeExtractedSlots(
  current: ReservationSlots,
  extracted: Partial<ReservationSlots>,
): ReservationSlots {
  return {
    restaurant: extracted.restaurant !== undefined ? extracted.restaurant : current.restaurant,
    date: extracted.date !== undefined ? extracted.date : current.date,
    time: extracted.time !== undefined ? extracted.time : current.time,
    partySize: extracted.partySize !== undefined ? extracted.partySize : current.partySize,
    seatingPreference:
      extracted.seatingPreference !== undefined
        ? extracted.seatingPreference
        : current.seatingPreference,
    phoneNumber:
      extracted.phoneNumber !== undefined ? extracted.phoneNumber : current.phoneNumber,
  };
}

// ── Human-readable helpers ────────────────────────────────────────────────────

export function describeFilledSlots(slots: ReservationSlots): string {
  const parts: string[] = [];
  if (slots.restaurant) parts.push(`restaurant: ${slots.restaurant}`);
  if (slots.date) parts.push(`date: ${slots.date}`);
  if (slots.time) parts.push(`time: ${slots.time}`);
  if (slots.partySize) parts.push(`partySize: ${slots.partySize}`);
  if (slots.seatingPreference) parts.push(`seating: ${slots.seatingPreference}`);
  if (slots.phoneNumber) parts.push(`phone: ${slots.phoneNumber}`);
  return parts.join(", ") || "none";
}


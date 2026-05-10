/**
 * WorkflowPromptBuilder
 *
 * Generates the scoped system-prompt block injected when a reservation workflow
 * is active.  The orchestrator returns this block as `workflowContextBlock`;
 * `getVoiceAgentSystemPrompt` wraps it so the LLM responds in workflow-only
 * mode (no general-chat instructions, no intent-tag required).
 *
 * Design contract (strict):
 * ──────────────────────────
 * The LLM MUST call an explicit tool to change any state.
 * Every step prompt lists EXACTLY which tool to call and when.
 * No code path infers user intent from regex; the LLM decides.
 *
 * CONFIRMING is the final collection step — the LLM calls
 * workflow_book_reservation directly when the user confirms (no intermediate
 * CALLING_TOOL state needed; that step is only reachable via tool call).
 */

import { DUMMY_VOICE_RESTAURANTS } from "@/workflow/data/dummyVoiceRestaurants";
import { listMissingRequiredSlots } from "@/workflow/flows/restaurantReservation";
import type { ReservationSlots, ReservationStep } from "@/workflow/state/types";
import { formatDateReadable, formatTimeReadable } from "@/workflow/tools/restaurantTools";
import { logger } from "@/utils/logger";

const CANCEL_RULE =
  "If the user clearly wants to cancel or abandon the reservation entirely, call workflow_cancel_reservation with sessionId.";

export function buildStepContext(
  step: ReservationStep,
  slots: ReservationSlots,
  sessionId: string | null,
  resumeHint?: string | null,
): string {
  const progress = buildProgressLine(slots);
  const resumePrefix = resumeHint ? `${resumeHint} ` : "";

  let instruction: string;

  switch (step) {
    case "IDLE":
    case "COMPLETED":
    case "CANCELLED":
      return "[RESERVATION WORKFLOW: inactive]";

    case "COLLECTING_RESTAURANT": {
      const rows = DUMMY_VOICE_RESTAURANTS.map((r) => `  • restaurantId "${r.id}" → ${r.name}`).join("\n");
      instruction = [
        `${resumePrefix}Ask which restaurant in one short question.`,
        "When the user's answer maps to exactly ONE option below, call workflow_update_reservation_slots with restaurantId + sessionId.",
        "If the answer is ambiguous between two options, ask one short clarification — never guess.",
        "OPTIONS:",
        rows,
        CANCEL_RULE,
      ].join("\n");
      break;
    }

    case "COLLECTING_DATE":
      instruction = [
        `${resumePrefix}Ask for the reservation date. ONE question only.`,
        "When you can map speech to a calendar date, call workflow_update_reservation_slots with date (yyyy-MM-dd) + sessionId.",
        "Do NOT advance to the next field in speech before the tool call confirms the save.",
        CANCEL_RULE,
      ].join("\n");
      break;

    case "COLLECTING_TIME":
      instruction = [
        `${resumePrefix}Ask for the reservation time. ONE question only.`,
        "When you can map speech to a time, call workflow_update_reservation_slots with time (HH:mm 24-hour) + sessionId.",
        "Do NOT advance to the next field in speech before the tool call confirms the save.",
        CANCEL_RULE,
      ].join("\n");
      break;

    case "COLLECTING_PARTY_SIZE":
      instruction = [
        `${resumePrefix}Ask how many people will be dining. ONE question only.`,
        "When the user gives a number, call workflow_update_reservation_slots with partySize (integer) + sessionId.",
        "Do NOT ask for phone, seating, or confirmation until the tool call succeeds and 'party:' appears in Saved slots.",
        CANCEL_RULE,
      ].join("\n");
      break;

    case "COLLECTING_SEATING":
      instruction = [
        `${resumePrefix}Ask for seating preference — indoor, outdoor, booth, or no preference. ONE question only.`,
        "Call workflow_update_reservation_slots with seatingPreference + sessionId (pass null if they decline).",
        CANCEL_RULE,
      ].join("\n");
      break;

    case "COLLECTING_PHONE":
      instruction = [
        `${resumePrefix}Ask for a contact phone number. ONE question only.`,
        "When you have a number with enough digits, call workflow_update_reservation_slots with phoneNumber + sessionId.",
        CANCEL_RULE,
      ].join("\n");
      break;

    case "CONFIRMING": {
      const summary = buildConfirmSummary(slots);
      const bookArgs = buildBookArgs(slots, sessionId);
      instruction = [
        "DECISION TREE — follow exactly:",
        `  A. If the user's most recent message is a clear confirmation (yes / sounds good / book it / go ahead / etc.):`,
        `     → Call workflow_book_reservation immediately with EXACTLY these values:`,
        `       ${bookArgs}`,
        `     → Speak ONE warm line first (e.g. "Perfect, booking that now!"), then emit the tool call.`,
        `  B. If the user has NOT yet confirmed or is still deciding:`,
        `     → Read back the booking details in ONE warm sentence, then ask "Shall I book it?"`,
        `     → Details to read back: ${summary}`,
        `     → Keep total response under 30 words.`,
        `  C. If the user wants to change a specific field:`,
        `     → You MUST call workflow_update_reservation_slots FIRST with reopenSlot set to that field`,
        `        (restaurant | date | time | partySize | phone | seating) + sessionId.`,
        `     → Do NOT ask for the new value verbally before calling the tool. The tool moves the FSM`,
        `        to the correct collection step — only then does the UI show the right input widget.`,
        `     → If you already know the new value (e.g. user said "change date to Friday"), include`,
        `        it in the same call: reopenSlot:"date" + date:"yyyy-MM-dd".`,
        `     → Speaking without calling the tool first leaves the step at CONFIRMING and breaks the UI.`,
        `  D. If the user wants to cancel entirely:`,
        `     → Call workflow_cancel_reservation with sessionId.`,
      ].join("\n");
      break;
    }

    case "CALLING_TOOL": {
      const bookArgs = buildBookArgs(slots, sessionId);
      instruction = [
        "The user has confirmed. Call workflow_book_reservation NOW with EXACTLY these values:",
        `  ${bookArgs}`,
        "Speak ONE short line first (e.g. \"Perfect, booking that now!\"), then emit the tool call.",
      ].join("\n");
      break;
    }

    default:
      instruction = "Continue collecting reservation details per the workflow steps.";
  }

  const missing = listMissingRequiredSlots(slots);

  logger.info("[WorkflowPromptBuilder] built step context", {
    step,
    sessionIdPresent: Boolean(sessionId),
    slots,
    missingRequired: missing,
    progressLine: progress || null,
  });

  const sessionLine = sessionId ? `\n\nsessionId for all workflow tools: "${sessionId}"` : "";

  return [
    `[RESERVATION WORKFLOW — step: ${step}]`,
    "SOURCE OF TRUTH — use ONLY the Saved slots line below for booking details. Never recall or invent values from conversation history.",
    "STATE RULE — workflow state changes ONLY when you call a tool. Do not verbally skip ahead of what Saved slots shows.",
    progress ? `Saved slots: ${progress}` : "Saved slots: (none yet)",
    missing.length
      ? `Still required (not in state until you call the tool): ${missing.join(", ")}.`
      : "All required slots are present in state.",
    "",
    instruction,
    sessionLine,
  ].join("\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildProgressLine(slots: ReservationSlots): string {
  const parts: string[] = [];
  if (slots.restaurant) parts.push(`restaurant: ${slots.restaurant}`);
  if (slots.date) parts.push(`date: ${formatDateReadable(slots.date)}`);
  if (slots.time) parts.push(`time: ${formatTimeReadable(slots.time)}`);
  if (slots.partySize != null) parts.push(`party: ${slots.partySize}`);
  if (slots.seatingPreference) parts.push(`seating: ${slots.seatingPreference}`);
  if (slots.phoneNumber) parts.push(`phone: ${slots.phoneNumber}`);
  return parts.join(", ");
}

function buildConfirmSummary(slots: ReservationSlots): string {
  const parts: string[] = [];
  if (slots.restaurant) parts.push(slots.restaurant);
  if (slots.date) parts.push(formatDateReadable(slots.date));
  if (slots.time) parts.push(`at ${formatTimeReadable(slots.time)}`);
  if (slots.partySize != null) parts.push(`for ${slots.partySize}`);
  if (slots.seatingPreference) parts.push(slots.seatingPreference);
  if (slots.phoneNumber) parts.push(`contact ${slots.phoneNumber}`);
  return parts.join(", ");
}

function buildBookArgs(slots: ReservationSlots, sessionId: string | null): string {
  const parts = [
    `restaurant: "${slots.restaurant ?? ""}"`,
    `date: "${slots.date ?? ""}"`,
    `time: "${slots.time ?? ""}"`,
    `partySize: ${slots.partySize ?? 0}`,
    `seatingPreference: ${slots.seatingPreference != null ? `"${slots.seatingPreference}"` : "null"}`,
    `phoneNumber: "${slots.phoneNumber ?? ""}"`,
    `sessionId: ${sessionId ? `"${sessionId}"` : "null"}`,
  ];
  return parts.join(", ");
}

/**
 * Workflow voice tools — registered in the main voice tool registry so the
 * LLM can invoke them via the standard <tool> XML streaming protocol.
 *
 * State contract (strict):
 * Workflow state changes ONLY when the LLM calls one of these tools.
 * No code outside this file is allowed to mutate WorkflowState based on
 * user text, regex, or heuristics.
 *
 * Available tools:
 *  • workflow_update_reservation_slots  — save/patch slot values, advance FSM
 *  • workflow_cancel_reservation        — abandon the flow at any point
 *  • workflow_book_reservation          — check availability + confirm booking
 */

import { DUMMY_VOICE_RESTAURANTS } from "@/workflow/data/dummyVoiceRestaurants";
import {
  allRequiredSlotsFilled,
  computeNextStep,
  listMissingRequiredSlots,
  mergeExtractedSlots,
} from "@/workflow/flows/restaurantReservation";
import { checkAvailability, createReservation, formatDateReadable, formatTimeReadable } from "@/workflow/tools/restaurantTools";
import type { ReservationSlots } from "@/workflow/state/types";
import { createInitialState, workflowStateManager } from "@/workflow/state/WorkflowStateManager";
import type { VoiceTool, VoiceToolExecution, VoiceToolRequest } from "@/tools/types";
import { logger } from "@/utils/logger";

const stateManager = workflowStateManager;

function maskPhoneForLog(raw: string | null | undefined): string | undefined {
  if (raw == null || raw === "") return undefined;
  const d = raw.replace(/\D/g, "");
  if (d.length <= 4) return "(short)";
  return `***…${d.slice(-4)}`;
}

/** Voice-agent second pass reloads the workflow prompt when this tool mutates slots. */
export const WORKFLOW_UPDATE_RESERVATION_SLOTS = "workflow_update_reservation_slots";

const DEMO_RESTAURANT_IDS = DUMMY_VOICE_RESTAURANTS.map((r) => r.id) as readonly string[];

const REOPEN_SLOT_ENUM = ["restaurant", "date", "time", "partySize", "phone", "seating"] as const;

function normalizeTime(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m?.[1] || !m[2]) return null;
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const min = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function normalizePhone(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const digits = t.replace(/\D/g, "");
  if (digits.length < 7) return null;
  return t;
}

function buildSlotPatchFromArgs(args: Record<string, unknown>): {
  patch: Partial<ReservationSlots>;
  error: string | null;
} {
  const patch: Partial<ReservationSlots> = {};

  const reopenRaw = args.reopenSlot;
  if (reopenRaw !== undefined && reopenRaw !== null && reopenRaw !== "") {
    if (typeof reopenRaw !== "string") {
      return { patch: {}, error: "reopenSlot must be a string enum value." };
    }
    const slot = reopenRaw.trim().toLowerCase();
    const reopenMap: Record<string, keyof ReservationSlots> = {
      restaurant: "restaurant",
      date: "date",
      time: "time",
      partysize: "partySize",
      party: "partySize",
      phone: "phoneNumber",
      phonenumber: "phoneNumber",
      seating: "seatingPreference",
    };
    const slotKey = reopenMap[slot];
    if (!slotKey) {
      return {
        patch: {},
        error: `Invalid reopenSlot "${reopenRaw}". Use one of: ${REOPEN_SLOT_ENUM.join(", ")}.`,
      };
    }
    (patch as Record<string, unknown>)[slotKey] = null;
  }

  if (typeof args.restaurantId === "string" && args.restaurantId.trim()) {
    const id = args.restaurantId.trim().toLowerCase();
    const row = DUMMY_VOICE_RESTAURANTS.find((r) => r.id.toLowerCase() === id);
    if (!row) {
      return { patch: {}, error: `Invalid restaurantId "${args.restaurantId}". Use only ids from the workflow option list.` };
    }
    patch.restaurant = row.name;
  }

  if (typeof args.date === "string" && args.date.trim()) {
    const d = args.date.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      return { patch: {}, error: `Invalid date "${d}". Use yyyy-MM-dd only.` };
    }
    patch.date = d;
  }

  if (typeof args.time === "string" && args.time.trim()) {
    const t = normalizeTime(args.time);
    if (!t) {
      return { patch: {}, error: `Invalid time "${args.time}". Use HH:mm (24-hour) only.` };
    }
    patch.time = t;
  }

  if (args.partySize !== undefined && args.partySize !== null) {
    const n = typeof args.partySize === "number" ? args.partySize : Number(args.partySize);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 50) {
      return { patch: {}, error: "partySize must be an integer from 1 to 50." };
    }
    patch.partySize = n;
  }

  if (args.seatingPreference !== undefined) {
    if (args.seatingPreference === null || args.seatingPreference === "null") {
      patch.seatingPreference = null;
    } else if (typeof args.seatingPreference === "string" && args.seatingPreference.trim()) {
      patch.seatingPreference = args.seatingPreference.trim();
    }
  }

  if (typeof args.phoneNumber === "string" && args.phoneNumber.trim()) {
    const p = normalizePhone(args.phoneNumber);
    if (!p) {
      return { patch: {}, error: "phoneNumber must contain at least 7 digits." };
    }
    patch.phoneNumber = p;
  }

  if (Object.keys(patch).length === 0) {
    return {
      patch: {},
      error:
        "Provide reopenSlot and/or at least one of: restaurantId, date, time, partySize, seatingPreference, phoneNumber.",
    };
  }

  return { patch, error: null };
}

export const workflowBookReservationTool: VoiceTool = {
  name: "workflow_book_reservation",
  description: "Check availability and immediately book a restaurant reservation. Call ONLY after the user has explicitly confirmed all reservation details.",
  parameters: {
    restaurant:        { type: "string",  description: "Restaurant name", required: true },
    date:              { type: "string",  description: "Reservation date in yyyy-MM-dd format", required: true },
    time:              { type: "string",  description: "Reservation time in HH:mm (24-hour) format", required: true },
    partySize:         { type: "number",  description: "Number of guests", required: true },
    seatingPreference: { type: "string",  description: "Seating preference (indoor/outdoor/booth etc.)", nullable: true },
    phoneNumber:       { type: "string",  description: "Contact phone number for the reservation", required: true },
    sessionId:         { type: "string",  description: "Current session ID — pass through unchanged from the workflow context", nullable: true },
  },
  examples: [
    "yes book it",
    "go ahead and book",
    "confirm the reservation",
    "yes that works",
  ],
  guidance: "Do NOT call this tool when asking for confirmation — only call it AFTER the user says yes. Pass all slots and the sessionId exactly as provided in the workflow context block.",

  async execute(request: VoiceToolRequest, signal: AbortSignal): Promise<VoiceToolExecution> {
    const args = request.arguments as {
      restaurant?: string;
      date?: string;
      time?: string;
      partySize?: number;
      seatingPreference?: string | null;
      phoneNumber?: string;
      sessionId?: string | null;
    };

    const { restaurant, date, time, partySize, phoneNumber, seatingPreference, sessionId } = args;

    if (!restaurant || !date || !time || !partySize || !phoneNumber) {
      logger.warn("[WorkflowTool] workflow_book_reservation called with missing slots", { args });
      return {
        request,
        contextText: "I'm missing some details to complete the booking. Let me ask you again.",
      };
    }

    logger.info("[WorkflowTool] workflow_book_reservation starting", {
      restaurant, date, time, partySize, sessionId: sessionId ?? "none",
    });

    try {
      // Phase 1 — check availability
      const availability = await checkAvailability({ restaurant, date, time, partySize });

      if (!availability.available) {
        // Update state so the orchestrator re-collects date/time on the next turn
        if (sessionId) {
          const state = await stateManager.load(sessionId);
          stateManager.save(sessionId, {
            ...state,
            slots: { ...state.slots, date: null, time: null },
            currentStep: "COLLECTING_DATE",
            pendingConfirmation: false,
          });
        }

        if (availability.alternatives?.length) {
          const alts = availability.alternatives
            .map((a) => `${formatDateReadable(a.date)} at ${formatTimeReadable(a.time)}`)
            .join(", or ");
          return {
            request,
            contextText: `That slot is fully booked. Available alternatives: ${alts}. Ask the user which one they prefer.`,
          };
        }

        return {
          request,
          contextText: "That slot is fully booked and there are no nearby alternatives. Apologise and ask the user to suggest a different date or time.",
        };
      }

      const confirmationId = availability.confirmationId!;

      // Phase 2 — create the reservation
      const booking = await createReservation({
        slots: {
          restaurant,
          date,
          time,
          partySize,
          seatingPreference: seatingPreference ?? null,
          phoneNumber,
        },
        confirmationId,
      });

      if (!booking.success) {
        logger.warn("[WorkflowTool] createReservation failed", { restaurant, confirmationId });
        return {
          request,
          contextText: "The reservation system returned an error. Apologise and suggest the user try again or call the restaurant directly.",
        };
      }

      // Persist COMPLETED state
      if (sessionId) {
        const state = await stateManager.load(sessionId);
        stateManager.save(sessionId, {
          ...state,
          activeFlow: null,
          currentStep: "COMPLETED",
          pendingConfirmation: false,
        });
      }

      logger.info("[WorkflowTool] workflow_book_reservation succeeded", {
        confirmationId: booking.confirmationId,
        details: booking.details,
      });

      return {
        request,
        contextText: `Reservation confirmed. ${booking.details} Tell the user their booking is confirmed in one warm sentence, include the confirmation ID, then ask if there is anything else.`,
      };
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return { request, contextText: "The booking was interrupted." };
      }
      logger.error("[WorkflowTool] workflow_book_reservation error", { err });
      return {
        request,
        contextText: "Something went wrong while booking. Apologise briefly and suggest trying again.",
      };
    }
  },
};

export const workflowUpdateReservationSlotsTool: VoiceTool = {
  name: WORKFLOW_UPDATE_RESERVATION_SLOTS,
  description:
    "Persist reservation field(s) during an active booking. Use restaurantId from the OPTIONS list; date yyyy-MM-dd; time HH:mm (24h). When the user wants to edit one field (especially on the confirm screen), pass reopenSlot to clear that slot so the FSM returns to the right collection step — you can send the new value in the same call. sessionId from the workflow block when present.",
  parameters: {
    sessionId: {
      type: "string",
      description: "Current voice session id from the workflow block",
      nullable: true,
    },
    reopenSlot: {
      type: "string",
      description:
        "Clear this slot so the user can re-enter it (moves FSM to the matching COLLECTING_* step). Use when they ask to change one detail before booking. Optional; combine with new values in the same call to replace without an extra turn.",
      nullable: true,
      enum: REOPEN_SLOT_ENUM,
    },
    restaurantId: {
      type: "string",
      description: "Demo restaurant id when the user selects a venue (speech or implied choice)",
      nullable: true,
      enum: DEMO_RESTAURANT_IDS,
    },
    date: { type: "string", description: "Reservation date yyyy-MM-dd", nullable: true },
    time: { type: "string", description: "Reservation time HH:mm (24-hour)", nullable: true },
    partySize: { type: "number", description: "Party size (guest count)", nullable: true },
    seatingPreference: {
      type: "string",
      description: "Seating preference, e.g. indoor / outdoor / booth",
      nullable: true,
    },
    phoneNumber: { type: "string", description: "Contact phone for the reservation", nullable: true },
  },
  examples: [
    "the trattoria one",
    "Golden Fork please",
    "this Friday",
    "7:30 pm",
    "four people",
    "my number is 555-012-3456",
  ],
  guidance:
    "Call when you can map speech to structured values. On CONFIRMING, if the user wants to change e.g. only the time, call with reopenSlot:\"time\" (and optionally time:\"19:30\" in the same call). Never invent restaurantId. Pass sessionId from the workflow block.",

  async execute(request: VoiceToolRequest, signal: AbortSignal): Promise<VoiceToolExecution> {
    if (signal.aborted) return { request, contextText: "Aborted." };

    const args = request.arguments as Record<string, unknown>;
    const sessionId = typeof args.sessionId === "string" && args.sessionId.trim() ? args.sessionId.trim() : null;

    if (!sessionId) {
      return {
        request,
        contextText:
          "The slot tool had no sessionId, so state was not saved. On the next line, call workflow_update_reservation_slots again with sessionId copied exactly from the workflow block.",
      };
    }

    const { patch, error } = buildSlotPatchFromArgs(args);
    if (error) {
      return { request, contextText: `${error} Acknowledge briefly and fix the arguments or ask the user to rephrase.` };
    }

    const state = await stateManager.load(sessionId);

    logger.info("[WorkflowTool] workflow_update_reservation_slots — state before", {
      sessionId,
      step: state.currentStep,
      pendingConfirmation: state.pendingConfirmation,
      slots: state.slots,
      missingRequired: listMissingRequiredSlots(state.slots),
      patchKeys: Object.keys(patch),
      patchPreview: {
        ...patch,
        phoneNumber: patch.phoneNumber !== undefined ? maskPhoneForLog(patch.phoneNumber) : undefined,
      },
    });

    if (state.activeFlow !== "restaurant_reservation") {
      return {
        request,
        contextText: "There is no active reservation workflow. Do not call this tool again; answer normally.",
      };
    }

    if (
      state.currentStep === "CALLING_TOOL"
      || state.currentStep === "COMPLETED"
      || state.currentStep === "CANCELLED"
    ) {
      return {
        request,
        contextText: "Slot updates are not accepted in this booking phase. Continue in natural speech only.",
      };
    }

    const nextSlots = mergeExtractedSlots(state.slots, patch);
    const filled = allRequiredSlotsFilled(nextSlots);
    const nextStep = filled ? "CONFIRMING" : computeNextStep(nextSlots, false, false);

    const nextState = {
      ...state,
      slots: nextSlots,
      currentStep: nextStep,
      pendingConfirmation: filled,
      lastIntent: "workflow_continue" as const,
      updatedAt: Date.now(),
    };

    stateManager.save(sessionId, nextState);

    const savedBits = Object.keys(patch).join(", ");
    const progress: string[] = [];
    if (nextSlots.restaurant) progress.push(`restaurant ${nextSlots.restaurant}`);
    if (nextSlots.date) progress.push(`date ${formatDateReadable(nextSlots.date)}`);
    if (nextSlots.time) progress.push(`time ${formatTimeReadable(nextSlots.time)}`);
    if (nextSlots.partySize != null) progress.push(`party ${nextSlots.partySize}`);
    if (nextSlots.seatingPreference) progress.push(`seating ${nextSlots.seatingPreference}`);
    if (nextSlots.phoneNumber) progress.push("phone on file");

    const phase = filled
      ? "All required details are saved — read back once warmly and ask if you should book."
      : `Next workflow step: ${nextStep}. Ask only for the next missing item per the workflow instructions.`;

    const reopenedSlot = typeof args.reopenSlot === "string" ? args.reopenSlot : null;
    if (reopenedSlot) {
      logger.info("[WorkflowTool] workflow_update_reservation_slots — reopenSlot transition", {
        sessionId,
        reopenedSlot,
        stepBefore: state.currentStep,
        stepAfter: nextStep,
        slotsAfter: nextSlots,
        missingRequired: listMissingRequiredSlots(nextSlots),
        uiShouldShow: nextStep === "COLLECTING_RESTAURANT" ? "restaurant_picker" : `collect_widget:${nextStep}`,
      });
    } else {
      logger.info("[WorkflowTool] workflow_update_reservation_slots — slot save", {
        sessionId,
        patch: savedBits,
        stepBefore: state.currentStep,
        stepAfter: nextStep,
        slotsAfter: nextSlots,
        missingRequired: listMissingRequiredSlots(nextSlots),
      });
    }

    return {
      request,
      contextText: [
        "Slot tool succeeded.",
        `Updated: ${savedBits}.`,
        `Progress: ${progress.join("; ") || "nothing yet"}.`,
        phase,
      ].join(" "),
    };
  },
};

// ── Cancel tool ───────────────────────────────────────────────────────────────

export const workflowCancelReservationTool: VoiceTool = {
  name: "workflow_cancel_reservation",
  description:
    "Cancel the active reservation workflow and clear all collected data. Call ONLY when the user explicitly asks to cancel, abandon, stop, or give up on making the reservation.",
  parameters: {
    sessionId: {
      type: "string",
      description: "Current voice session ID from the workflow context block",
      nullable: true,
    },
    reason: {
      type: "string",
      description: "Brief reason for cancellation (for logging). E.g. 'user requested cancel'.",
      nullable: true,
    },
  },
  examples: [
    "cancel the reservation",
    "forget it",
    "never mind",
    "stop the reservation",
    "don't book it",
  ],
  guidance:
    "Call ONLY when the user clearly wants to abandon the booking entirely — not for field corrections, changes, or 'no I said X'. For field changes use workflow_update_reservation_slots with reopenSlot instead.",

  async execute(request: VoiceToolRequest, _signal: AbortSignal): Promise<VoiceToolExecution> {
    const args = request.arguments as { sessionId?: string | null; reason?: string | null };
    const sessionId = typeof args.sessionId === "string" && args.sessionId.trim()
      ? args.sessionId.trim()
      : null;

    if (sessionId) {
      stateManager.save(sessionId, {
        ...createInitialState(),
        lastIntent: "reservation_cancel",
      });
      logger.info("[WorkflowTool] workflow_cancel_reservation — flow cleared", {
        sessionId,
        reason: args.reason ?? "user requested",
      });
    } else {
      logger.warn("[WorkflowTool] workflow_cancel_reservation called without sessionId — state not cleared");
    }

    return {
      request,
      contextText:
        "Reservation cancelled and all data cleared. Acknowledge briefly that the reservation has been cancelled, then offer general help.",
    };
  },
};

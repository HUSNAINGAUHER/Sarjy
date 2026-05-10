/**
 * Tool Executor
 *
 * Runs restaurant workflow tools and returns structured results with
 * human-readable summaries the orchestrator can inject into the LLM context.
 *
 * All tools are async and can be awaited on the pipeline hot path.
 * In production, replace the mock implementations in restaurantTools.ts
 * without changing anything here.
 */

import {
  cancelReservation,
  checkAvailability,
  createReservation,
  formatDateReadable,
  formatTimeReadable,
  searchRestaurants,
  updateReservation,
} from "@/workflow/tools/restaurantTools";
import type { AvailabilityResult, ReservationSlots } from "@/workflow/state/types";
import { logger } from "@/utils/logger";

export interface ToolExecutionResult {
  success: boolean;
  toolName: string;
  summary: string;
  /** Raw data for downstream orchestrator decisions (e.g. availability check). */
  data: unknown;
}

export class ToolExecutor {
  async runSearchRestaurants(query: string): Promise<ToolExecutionResult> {
    try {
      const results = await searchRestaurants(query);
      const names = results.map((r) => r.name).join(", ");
      return {
        success: true,
        toolName: "searchRestaurants",
        summary: results.length > 0
          ? `Top options: ${names}.`
          : "No restaurants found for that query.",
        data: results,
      };
    } catch (err) {
      logger.warn("[ToolExecutor] searchRestaurants failed", { err });
      return { success: false, toolName: "searchRestaurants", summary: "Restaurant search failed.", data: null };
    }
  }

  async runCheckAvailability(slots: ReservationSlots): Promise<ToolExecutionResult> {
    if (!slots.restaurant || !slots.date || !slots.time || !slots.partySize) {
      return {
        success: false,
        toolName: "checkAvailability",
        summary: "Cannot check availability — missing required slot(s).",
        data: null,
      };
    }
    try {
      const result = await checkAvailability({
        restaurant: slots.restaurant,
        date: slots.date,
        time: slots.time,
        partySize: slots.partySize,
      });

      const summary = buildAvailabilitySummary(result, slots);

      return {
        success: true,
        toolName: "checkAvailability",
        summary,
        data: result,
      };
    } catch (err) {
      logger.warn("[ToolExecutor] checkAvailability failed", { err });
      return { success: false, toolName: "checkAvailability", summary: "Availability check failed.", data: null };
    }
  }

  async runCreateReservation(
    slots: ReservationSlots,
    confirmationId: string,
  ): Promise<ToolExecutionResult> {
    if (
      !slots.restaurant || !slots.date || !slots.time ||
      !slots.partySize || !slots.phoneNumber
    ) {
      return {
        success: false,
        toolName: "createReservation",
        summary: "Cannot create reservation — missing required slot(s).",
        data: null,
      };
    }
    try {
      const result = await createReservation({
        slots: slots as Parameters<typeof createReservation>[0]["slots"],
        confirmationId,
      });
      return {
        success: true,
        toolName: "createReservation",
        summary: result.details,
        data: result,
      };
    } catch (err) {
      logger.warn("[ToolExecutor] createReservation failed", { err });
      return { success: false, toolName: "createReservation", summary: "Reservation creation failed.", data: null };
    }
  }

  async runUpdateReservation(
    confirmationId: string,
    updates: Partial<ReservationSlots>,
  ): Promise<ToolExecutionResult> {
    try {
      const result = await updateReservation({ confirmationId, updates });
      return {
        success: true,
        toolName: "updateReservation",
        summary: result.details,
        data: result,
      };
    } catch (err) {
      logger.warn("[ToolExecutor] updateReservation failed", { err });
      return { success: false, toolName: "updateReservation", summary: "Reservation update failed.", data: null };
    }
  }

  async runCancelReservation(confirmationId: string): Promise<ToolExecutionResult> {
    try {
      const result = await cancelReservation({ confirmationId });
      return {
        success: true,
        toolName: "cancelReservation",
        summary: result.message,
        data: result,
      };
    } catch (err) {
      logger.warn("[ToolExecutor] cancelReservation failed", { err });
      return { success: false, toolName: "cancelReservation", summary: "Cancellation failed.", data: null };
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildAvailabilitySummary(
  result: AvailabilityResult,
  slots: ReservationSlots,
): string {
  if (result.available) {
    return `Available. Confirmation hold: ${result.confirmationId}.`;
  }

  if (result.alternatives?.length) {
    const alts = result.alternatives
      .map((a) => `${formatDateReadable(a.date)} at ${formatTimeReadable(a.time)}`)
      .join(", or ");
    return `Not available for that slot. Alternatives: ${alts}.`;
  }

  return "That slot is fully booked. No alternatives found.";
}

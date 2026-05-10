/**
 * Mock restaurant tool implementations.
 *
 * In production these would call a real reservations API or restaurant POS.
 * The signatures, parameters, and result shapes are stable — swap in real
 * implementations without changing any orchestrator code.
 */

import type {
  AvailabilityResult,
  CancelResult,
  ReservationResult,
  ReservationSlots,
  RestaurantSearchResult,
} from "@/workflow/state/types";
import { logger } from "@/utils/logger";

// ── Seed data ─────────────────────────────────────────────────────────────────

const MOCK_RESTAURANTS: RestaurantSearchResult[] = [
  { name: "Luigi's", cuisine: "Italian", rating: 4.7, address: "12 Via Roma, Downtown" },
  { name: "The Golden Fork", cuisine: "American", rating: 4.5, address: "45 Main St" },
  { name: "Sakura Garden", cuisine: "Japanese", rating: 4.8, address: "78 Maple Ave" },
  { name: "Maison Bleu", cuisine: "French", rating: 4.6, address: "3 Rue Lafayette" },
  { name: "El Rancho", cuisine: "Mexican", rating: 4.4, address: "99 Canyon Rd" },
];

const MOCK_CONFIRMATION_PREFIX = "RES";

function generateConfirmationId(): string {
  return `${MOCK_CONFIRMATION_PREFIX}-${Math.floor(10000 + Math.random() * 90000)}`;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

export async function searchRestaurants(
  query: string,
): Promise<RestaurantSearchResult[]> {
  logger.info("[WorkflowTool] searchRestaurants", { query });

  const q = query.toLowerCase();
  const matches = MOCK_RESTAURANTS.filter(
    (r) =>
      r.name.toLowerCase().includes(q) ||
      r.cuisine.toLowerCase().includes(q) ||
      q.includes(r.cuisine.toLowerCase()) ||
      q.includes(r.name.toLowerCase()),
  );

  const results = matches.length > 0 ? matches : MOCK_RESTAURANTS.slice(0, 3);

  logger.info("[WorkflowTool] searchRestaurants result", {
    query,
    count: results.length,
    names: results.map((r) => r.name).join(", "),
  });

  return results;
}

export interface CheckAvailabilityParams {
  restaurant: string;
  date: string;
  time: string;
  partySize: number;
}

export async function checkAvailability(
  params: CheckAvailabilityParams,
): Promise<AvailabilityResult> {
  logger.info("[WorkflowTool] checkAvailability", { ...params });

  // Simulate: Friday / Saturday peak hours occasionally unavailable.
  const d = new Date(params.date);
  const dayOfWeek = d.getDay(); // 0=Sun, 5=Fri, 6=Sat
  const hourParts = params.time.split(":");
  const hour = hourParts[0] !== undefined ? Number(hourParts[0]) : 0;
  const isPeakTime = (dayOfWeek === 5 || dayOfWeek === 6) && hour >= 19 && hour <= 21;
  const isUnavailable = isPeakTime && params.partySize >= 6;

  if (isUnavailable) {
    const altDate = new Date(d);
    altDate.setDate(altDate.getDate() + 1);
    const altIso = altDate.toISOString().split("T")[0] ?? "";
    const result: AvailabilityResult = {
      available: false,
      alternatives: [
        { date: altIso, time: "18:30" },
        { date: altIso, time: "21:30" },
      ],
    };
    logger.info("[WorkflowTool] checkAvailability — unavailable", { ...result });
    return result;
  }

  const result: AvailabilityResult = {
    available: true,
    confirmationId: generateConfirmationId(),
  };
  logger.info("[WorkflowTool] checkAvailability — available", { ...result });
  return result;
}

export interface CreateReservationParams {
  slots: Required<ReservationSlots> & { restaurant: string; date: string; time: string; partySize: number; phoneNumber: string };
  confirmationId: string;
}

export async function createReservation(
  params: CreateReservationParams,
): Promise<ReservationResult> {
  logger.info("[WorkflowTool] createReservation", {
    restaurant: params.slots.restaurant,
    date: params.slots.date,
    time: params.slots.time,
    partySize: params.slots.partySize,
    seating: params.slots.seatingPreference,
    confirmationId: params.confirmationId,
  });  const dateStr = formatDateReadable(params.slots.date);
  const timeStr = formatTimeReadable(params.slots.time);
  const seatingNote = params.slots.seatingPreference
    ? `, ${params.slots.seatingPreference} seating`
    : "";

  return {
    success: true,
    confirmationId: params.confirmationId,
    details: `Table for ${params.slots.partySize} at ${params.slots.restaurant} on ${dateStr} at ${timeStr}${seatingNote}. Confirmation: ${params.confirmationId}.`,
  };
}

export interface UpdateReservationParams {
  confirmationId: string;
  updates: Partial<ReservationSlots>;
}

export async function updateReservation(
  params: UpdateReservationParams,
): Promise<ReservationResult> {
  logger.info("[WorkflowTool] updateReservation", { confirmationId: params.confirmationId });
  return {
    success: true,
    confirmationId: params.confirmationId,
    details: `Reservation ${params.confirmationId} updated successfully.`,
  };
}

export interface CancelReservationParams {
  confirmationId: string;
}

export async function cancelReservation(
  params: CancelReservationParams,
): Promise<CancelResult> {
  logger.info("[WorkflowTool] cancelReservation", { confirmationId: params.confirmationId });
  return {
    success: true,
    message: `Reservation ${params.confirmationId} has been cancelled.`,
  };
}

// ── Formatting helpers ────────────────────────────────────────────────────────

export function formatDateReadable(isoDate: string): string {
  try {
    const d = new Date(`${isoDate}T12:00:00`);
    return d.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  } catch {
    return isoDate;
  }
}

export function formatTimeReadable(time24: string): string {
  try {
    const parts = time24.split(":");
    const h = parts[0] !== undefined ? parseInt(parts[0], 10) : 0;
    const m = parts[1] !== undefined ? parseInt(parts[1], 10) : 0;
    const ampm = h >= 12 ? "pm" : "am";
    const displayHour = h % 12 === 0 ? 12 : h % 12;
    return m === 0 ? `${displayHour}${ampm}` : `${displayHour}:${String(m).padStart(2, "0")}${ampm}`;
  } catch {
    return time24;
  }
}

/**
 * Workflow State Manager
 *
 * Owns the authoritative in-memory state map (fast reads) and synchronises
 * to Postgres via the Session.workflowState JSON column (durable storage).
 *
 * Callers should always go through this class — never read/write the DB
 * directly for workflow state.
 */

import { prisma } from "@/db/client";
import type { FlowId, ReservationSlots, ReservationStep, WorkflowState } from "@/workflow/state/types";
import { logger } from "@/utils/logger";

// ── Defaults ──────────────────────────────────────────────────────────────────

const EMPTY_SLOTS: ReservationSlots = {
  restaurant: null,
  date: null,
  time: null,
  partySize: null,
  seatingPreference: null,
  phoneNumber: null,
};

export function createInitialState(): WorkflowState {
  return {
    activeFlow: null,
    currentStep: "IDLE",
    slots: { ...EMPTY_SLOTS },
    pausedContexts: [],
    pendingConfirmation: false,
    lastIntent: null,
    retryCount: 0,
    updatedAt: Date.now(),
  };
}

// ── Manager ───────────────────────────────────────────────────────────────────

export class WorkflowStateManager {
  /** In-process cache keyed by sessionId. */
  private readonly cache = new Map<string, WorkflowState>();

  /**
   * Load state for a session.
   * Reads from cache first; falls back to Prisma on miss.
   * Returns a fresh initial state if the session has never had workflow state.
   */
  async load(sessionId: string): Promise<WorkflowState> {
    const cached = this.cache.get(sessionId);
    if (cached) return cloneState(cached);

    try {
      const row = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { workflowState: true },
      });

      if (row?.workflowState) {
        const parsed = parseWorkflowState(row.workflowState);
        if (parsed) {
          this.cache.set(sessionId, cloneState(parsed));
          logger.info("[WorkflowStateManager] loaded from DB", {
            sessionId,
            step: parsed.currentStep,
            flow: parsed.activeFlow,
          });
          return cloneState(parsed);
        }
      }
    } catch (err) {
      logger.warn("[WorkflowStateManager] DB load failed — using initial state", { sessionId, err });
    }

    return createInitialState();
  }

  /**
   * Persist state for a session.
   * Writes to in-memory cache immediately; DB write is fire-and-forget
   * (non-blocking) to keep the voice pipeline fast.
   */
  save(sessionId: string, state: WorkflowState): void {
    const stamped: WorkflowState = { ...state, updatedAt: Date.now() };
    this.cache.set(sessionId, cloneState(stamped));

    // Fire-and-forget DB write
    prisma.session
      .update({
        where: { id: sessionId },
        data: { workflowState: stamped as object },
      })
      .catch((err) => {
        logger.warn("[WorkflowStateManager] DB save failed", { sessionId, err });
      });
  }

  /** Remove cached state (called on voice:stop / disconnect). */
  evict(sessionId: string): void {
    this.cache.delete(sessionId);
  }

  /**
   * Synchronous read from the in-memory cache only (no DB).
   * Used for lightweight UI signals after a turn completes.
   */
  peekCached(sessionId: string): WorkflowState | null {
    const c = this.cache.get(sessionId);
    return c ? cloneState(c) : null;
  }

  /** Reset to idle state — used on reservation cancel or completion. */
  reset(sessionId: string): WorkflowState {
    const fresh = createInitialState();
    this.save(sessionId, fresh);
    return fresh;
  }
}

/**
 * Single in-process instance — `WorkflowOrchestrator` and workflow voice tools
 * must share this cache so tool calls and pre-LLM slot merges see the same state.
 */
export const workflowStateManager = new WorkflowStateManager();

// ── Helpers ───────────────────────────────────────────────────────────────────

function cloneState(s: WorkflowState): WorkflowState {
  return JSON.parse(JSON.stringify(s)) as WorkflowState;
}

function isValidStep(v: unknown): v is ReservationStep {
  const valid: ReservationStep[] = [
    "IDLE", "COLLECTING_RESTAURANT", "COLLECTING_DATE", "COLLECTING_TIME",
    "COLLECTING_PARTY_SIZE", "COLLECTING_SEATING", "COLLECTING_PHONE",
    "CONFIRMING", "CALLING_TOOL", "COMPLETED", "CANCELLED",
  ];
  return typeof v === "string" && (valid as string[]).includes(v);
}

function isValidFlowId(v: unknown): v is FlowId | null {
  return v === null || v === "restaurant_reservation";
}

function parseWorkflowState(raw: unknown): WorkflowState | null {
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (typeof obj !== "object" || obj === null) return null;
    const s = obj as Record<string, unknown>;
    if (!isValidStep(s.currentStep)) return null;
    if (!isValidFlowId(s.activeFlow)) return null;
    return s as unknown as WorkflowState;
  } catch {
    return null;
  }
}

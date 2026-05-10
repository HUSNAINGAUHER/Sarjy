/**
 * Intent routing — two modes, not one global pattern list.
 *
 * Design contract (strict):
 * ──────────────────────────
 * No regex in this classifier is allowed to mutate workflow state.
 * This module produces an IntentResult label used ONLY for logging and for
 * deciding whether an utterance is an "interrupting" sidebar (FAQ, off-topic).
 * All reservation-flow decisions are made by the LLM via explicit tool calls.
 *
 * In-workflow (activeFlow set, step ≠ IDLE):
 *   • Everything defaults to `workflow_continue` — let the LLM + tool calls decide.
 *   • Only genuine off-topic / FAQ utterances are flagged so the orchestrator
 *     can branch to a sidebar (no state mutation — purely a routing hint).
 */

import type { IntentLabel, IntentResult, WorkflowState } from "@/workflow/state/types";
import { logger } from "@/utils/logger";

// ── Idle-mode patterns (only when no active workflow) ─────────────────────────

const IDLE_PATTERNS: Array<{ label: IntentLabel; confidence: "high" | "medium" | "low"; patterns: RegExp[] }> = [
  {
    label: "reservation_booking",
    confidence: "high",
    patterns: [
      /\b(book|reserve|reservation|make a (booking|reservation|table)|get a table|table for|dining|dine|eat at|dinner (at|reservation)|lunch (at|reservation))\b/i,
    ],
  },
  {
    label: "reservation_update",
    confidence: "medium",
    patterns: [
      /\b(update|change|modify|reschedule|move (the|my) (reservation|booking|table))\b/i,
    ],
  },
  {
    label: "faq_question",
    confidence: "medium",
    patterns: [
      /\b(what|where|when|how|who|which|is it|do you|can you|tell me|what'?s|best|nearby|recommend|suggest|open|close|hours|menu|price|cost|parking|dress code|vegetarian|vegan|halal|kosher|allerg)\b/i,
    ],
  },
  {
    label: "small_talk",
    confidence: "medium",
    patterns: [
      /^(hi|hello|hey|howdy|greetings|good (morning|afternoon|evening|night))[!,. ]?$/i,
      /\b(thanks?|thank you|appreciate it|you'?re (great|awesome|helpful)|good job|well done|nice one)\b/i,
      /\b(how are you|how'?s it going|what'?s up|you doing)\b/i,
    ],
  },
];

const OFF_TOPIC_PATTERNS = [
  /\b(weather|temperature|forecast|stock|crypto|bitcoin|sport|score|game|news|headline|translate|math|calculate|poem|story|joke|play music|set (a )?timer|alarm|remind me)\b/i,
];

// ── In-workflow: sidebar detection only ──────────────────────────────────────
// Everything else → workflow_continue. The LLM tool calls handle all state.

const WORKFLOW_SIDEBAR_FAQ = [
  /\b(what'?s the best|best \w+.{0,24}(restaurant|italian|sushi|food|place)|recommend (a |some |me a )?\w|where should (i|we) eat|good \w+ near|nearby.{0,12}(restaurant|spot|place))\b/i,
  /\b(any suggestions|what do you suggest)\b/i,
];

const WORKFLOW_GREETING_ONLY = /^(hi|hello|hey|howdy)[!,. ]?$/i;

// ── Classifier ───────────────────────────────────────────────────────────────

export class IntentClassifier {
  /**
   * Single entry point.
   * Uses FSM-first routing when `state.activeFlow` is set — defaults to
   * `workflow_continue` for all in-flow utterances except genuine sidebars.
   */
  classifyForTurn(text: string, state: WorkflowState): IntentResult {
    const inWorkflow =
      state.activeFlow !== null && state.currentStep !== "IDLE";

    if (!inWorkflow) {
      return this.classifyIdleTurn(text);
    }
    return this.classifyWorkflowTurn(text, state);
  }

  /** Full pattern list — only when no active workflow. */
  classifyIdleTurn(text: string): IntentResult {
    const trimmed = text.trim();

    for (const entry of IDLE_PATTERNS) {
      for (const re of entry.patterns) {
        if (re.test(trimmed)) {
          const result: IntentResult = { label: entry.label, confidence: entry.confidence };
          logger.info("[IntentClassifier] idle", { text: trimmed.slice(0, 80), ...result });
          return result;
        }
      }
    }

    for (const re of OFF_TOPIC_PATTERNS) {
      if (re.test(trimmed)) {
        const result: IntentResult = { label: "off_topic", confidence: "high" };
        logger.info("[IntentClassifier] idle", { text: trimmed.slice(0, 80), ...result });
        return result;
      }
    }

    const result: IntentResult = { label: "unknown", confidence: "low" };
    logger.info("[IntentClassifier] idle", { text: trimmed.slice(0, 80), ...result });
    return result;
  }

  /**
   * Narrow routing inside an active reservation flow.
   * Default → `workflow_continue`. The LLM decides everything via tool calls.
   * Only genuine sidebars (off-topic, FAQ, bare greeting) are flagged here.
   */
  classifyWorkflowTurn(text: string, state: WorkflowState): IntentResult {
    const trimmed = text.trim();

    for (const re of OFF_TOPIC_PATTERNS) {
      if (re.test(trimmed)) {
        const result: IntentResult = { label: "off_topic", confidence: "high" };
        logger.info("[IntentClassifier] workflow-interrupt", { text: trimmed.slice(0, 80), ...result });
        return result;
      }
    }

    for (const re of WORKFLOW_SIDEBAR_FAQ) {
      if (re.test(trimmed)) {
        const result: IntentResult = { label: "faq_question", confidence: "medium" };
        logger.info("[IntentClassifier] workflow-interrupt", { text: trimmed.slice(0, 80), ...result });
        return result;
      }
    }

    if (WORKFLOW_GREETING_ONLY.test(trimmed)) {
      const result: IntentResult = { label: "small_talk", confidence: "medium" };
      logger.info("[IntentClassifier] workflow-interrupt", { text: trimmed.slice(0, 80), ...result });
      return result;
    }

    const result: IntentResult = { label: "workflow_continue", confidence: "high" };
    logger.info("[IntentClassifier] workflow-continue", { text: trimmed.slice(0, 80), step: state.currentStep });
    return result;
  }

  /**
   * True when the assistant should pause the slot machine and answer a sidebar.
   */
  isInterruptingIntent(intent: IntentResult, isInActiveFlow: boolean): boolean {
    if (!isInActiveFlow) return false;
    return intent.label === "small_talk"
      || intent.label === "off_topic"
      || intent.label === "faq_question";
  }
}

/**
 * Workflow module public API
 *
 * Import from here — never import engine internals directly in voice.ts.
 * A single shared orchestrator instance is exported to avoid redundant
 * in-memory state maps across imports.
 */

export { WorkflowOrchestrator } from "@/workflow/engine/WorkflowOrchestrator";
export type { OrchestratorResult, WorkflowState } from "@/workflow/state/types";

import { WorkflowOrchestrator } from "@/workflow/engine/WorkflowOrchestrator";

/** Shared singleton — one state map for all sessions in this process. */
export const workflowOrchestrator = new WorkflowOrchestrator();

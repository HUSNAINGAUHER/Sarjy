/**
 * Public entry point for the voice tool registry.
 *
 * Importing this module registers all built-in tools so callers (sockets,
 * agent reply, prompt builder) can rely on the registry being populated.
 * To add a new tool: create a new file exporting a `VoiceTool`, import it
 * here, and call `registerVoiceTool`.
 */
import { registerVoiceTool } from "@/tools/registry";
import { weatherTool } from "@/tools/weatherTool";
import {
  workflowBookReservationTool,
  workflowCancelReservationTool,
  workflowUpdateReservationSlotsTool,
} from "@/workflow/tools/workflowVoiceTools";

registerVoiceTool(weatherTool);
registerVoiceTool(workflowBookReservationTool);
registerVoiceTool(workflowCancelReservationTool);
registerVoiceTool(workflowUpdateReservationSlotsTool);

export {
  createVoiceToolContext,
  executeVoiceTool,
  getRegisteredVoiceTools,
  getVoiceTool,
  parseVoiceToolRequest,
  registerVoiceTool,
} from "@/tools/registry";

export type {
  VoiceTool,
  VoiceToolExecution,
  VoiceToolParameterSpec,
  VoiceToolParameterType,
  VoiceToolRequest,
} from "@/tools/types";

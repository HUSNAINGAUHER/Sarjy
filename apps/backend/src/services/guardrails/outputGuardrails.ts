/**
 * Output guardrails for the voice assistant.
 *
 * Strips low-hanging system-prompt leaks from assistant text BEFORE it leaves
 * the server (TTS + transcript persistence). This is a complement to
 * `stripVoiceHallucination`, which targets a different hallucination pattern
 * (fake `[Live tool context]` blocks). Here we focus on:
 *
 *   • System-prompt phrasing leaking into spoken output
 *     (e.g. "[RESERVATION WORKFLOW", "BASE_PROMPT", "Available tools:").
 *   • Routing-tag leaks ([RESERVATION] / [GENERAL]) when the parser misses
 *     them on the first line (defensive — they SHOULD be stripped earlier).
 *   • Verbatim restate of "I am Sarjy, a fast voice assistant" when the user
 *     never asked — this is template echo, not a refusal.
 *
 * The functions are forgiving: they only remove unambiguous leaks. If the
 * model genuinely says "Sarjy here" naturally, we keep it.
 */

const ROUTING_TAG_LINE = /^\s*\[(?:RESERVATION|GENERAL)\]\s*\n?/i;

const LEAK_PHRASES: ReadonlyArray<RegExp> = [
  /\[RESERVATION WORKFLOW[^\]]*\]/gi,
  /\[Live tool context\]/gi,
  /Available tool[s]?:\s*/gi,
  /Tool call protocol:\s*/gi,
  /Intent routing[^.]*?\./gi,
  /BASE[_\s]?PROMPT[:\s]*/gi,
  /WORKFLOW[_\s]?SHELL[:\s]*/gi,
  /TOOL[_\s]?PROTOCOL[:\s]*/gi,
];

const TEMPLATE_INTRO = /^\s*I am Sarjy,?\s*a (fast|voice|helpful)[^.]*?\.\s*/i;

/**
 * Sanitize one streamed segment before it goes to TTS.
 * Idempotent — safe to call multiple times.
 */
export function sanitizeAssistantSegment(segment: string): string {
  if (!segment) return segment;
  let out = segment;

  out = out.replace(ROUTING_TAG_LINE, "");

  for (const re of LEAK_PHRASES) {
    out = out.replace(re, "");
  }

  out = out.replace(TEMPLATE_INTRO, "");

  return out;
}

/**
 * Sanitize the final accumulated assistant text before persistence /
 * transcript display. Same patterns as the streaming path, plus
 * collapse-trim-runs cleanup so leak removals don't leave double spaces.
 */
export function sanitizeAssistantFullText(text: string): string {
  if (!text) return text;
  let out = sanitizeAssistantSegment(text);
  out = out.replace(/[ \t]{2,}/g, " ");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

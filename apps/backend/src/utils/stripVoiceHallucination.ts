/**
 * The model sometimes hallucinates a fake tool follow-up when answering from
 * memory (e.g. "[Live tool context]" + JSON). Strip that from streamed chunks
 * before TTS and from the final assistant string before persistence.
 */

const LIVE_TAG = /^\s*\[Live tool context\]\s*/i;
const NAME_JSON = /^\s*\{\s*"name"\s*:\s*"[^"]*"\s*,?\s*/i;
const ARGS_TAIL = /^\s*"arguments"\s*:\s*\{\s*\}\s*\}\s*/i;
const ORPHAN_BRACE = /^\s*\}\s*/;

/** Strip known garbage prefixes from one speakable segment (may run multiple times per chunk). */
export function stripSpeakableSegment(chunk: string): string {
  let c = chunk;
  for (let i = 0; i < 10; i++) {
    const before = c;
    c = c.replace(LIVE_TAG, "");
    c = c.replace(NAME_JSON, "");
    c = c.replace(ARGS_TAIL, "");
    c = c.replace(ORPHAN_BRACE, "");
    if (c === before) break;
  }
  return c;
}

/**
 * Best-effort cleanup on the full assistant reply (handles garbage split across
 * segment boundaries).
 */
export function stripAssistantFullMessage(text: string): string {
  let s = text.trim();
  s = s.replace(
    /^\s*\[Live tool context\]\s*\{[\s\S]*?"arguments"\s*:\s*\{\s*\}\s*\}\s*/i,
    "",
  );
  s = stripSpeakableSegment(s);
  return s.trim();
}

/** Prevent stored memory values from re-injecting JSON/tool phrasing into the system prompt. */
export function sanitizeMemoryValueForPrompt(value: string): string {
  let v = value.replace(/\s*\[Live tool context\][\s\S]*/i, "").trim();
  v = v.replace(/^\s*\{[\s\S]*?"arguments"\s*:\s*\{[\s\S]*?\}\s*\}\s*/i, "").trim();
  if (v.length > 400) v = `${v.slice(0, 397)}…`;
  return v || "—";
}

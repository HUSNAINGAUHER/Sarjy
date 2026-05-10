import { generateText } from "ai";
import type { MemoryCategory } from "@prisma/client";
import { prisma } from "@/db/client";
import { getMemoryLlmModel, getMemoryLlmProviderOptions } from "@/services/memoryModel";
import {
  getDirectMemoryPromptBlock,
  invalidateDirectMemoryCache,
} from "@/services/memoryLoader";
import {
  parseMemoryExtractionBlocks,
  type MemoryExtractionResult,
} from "@/services/memoryExtractorParse";
import { logger } from "@/utils/logger";

export type { MemoryExtractionResult } from "@/services/memoryExtractorParse";

/**
 * Fire-and-forget after a completed voice turn: extract structured facts,
 * upsert DB, and refresh the Redis direct-memory cache.
 */
export function scheduleMemoryExtraction(params: {
  userId: string;
  sessionId: string | null;
  userText: string;
  assistantText: string;
}): void {
  void extractMemoryFromTurn(params).catch((err) => {
    logger.warn("Memory extraction failed", { err });
  });
}

async function extractMemoryFromTurn(params: {
  userId: string;
  sessionId: string | null;
  userText: string;
  assistantText: string;
}): Promise<void> {
  const { userText, assistantText } = params;
  if (!userText.trim() || !assistantText.trim()) return;

  const { text } = await generateText({
    model: getMemoryLlmModel(),
    ...getMemoryLlmProviderOptions(),
    prompt: [
      "You extract durable user memory from one voice-assistant exchange.",
      "",
      "Output format (use these exact markers; no markdown fences):",
      "",
      "BEGIN_FACTS_JSON",
      "[",
      '  {"category":"identity|preference|personality|constraint|ongoing","key":"snake_case","value":"plain text","confidence":0.9}',
      "]",
      "END_FACTS_JSON",
      "",
      "Rules:",
      "- facts array: max 6 objects; only facts clearly from the user (not invented by the assistant).",
      "- value fields: short spoken plain text, no nested JSON, no double-quote characters inside values.",
      "- Stable keys: for favorite / preferred color, always use key exactly favorite_color (even if the user says colour). If they change their mind in this exchange, output one fact with the latest color only.",
      "",
      `User: ${userText}`,
      `Assistant: ${assistantText}`,
    ].join("\n"),
    maxOutputTokens: 500,
    temperature: 0.15,
  });

  const parsed = parseMemoryExtractionBlocks(text.trim());
  if (!parsed) {
    logger.warn("Memory extraction parse failed", { preview: text.slice(0, 280) });
    return;
  }

  const allFacts = dedupeFactsByNormalizedKey(parsed.facts);

  // ── Hard guard: only persist facts the USER actually stated ───────────────
  // The extraction LLM occasionally invents facts from the assistant's reply
  // (which itself may be a hallucination). That used to leak fictional facts
  // into long-term memory — e.g. assistant says "I remember you like blue",
  // extractor saves favorite_color=blue, next turn it surfaces and the loop
  // self-confirms. Only accept a fact when its value is clearly grounded in
  // the user's text for THIS turn.
  const factsToSave = allFacts.filter((f) => {
    const reasons: string[] = [];
    const value = f.value.trim();
    if (!f.key.trim() || !value) reasons.push("empty");
    if (isLowSignalValue(value)) reasons.push(`low_signal_value="${value}"`);
    if (!isValueGroundedInUserText(value, userText)) reasons.push("not_in_userText");
    if (reasons.length === 0) return true;
    logger.info("[MEMLEAK] memory fact REJECTED", {
      userId: params.userId,
      category: f.category,
      key: f.key,
      value,
      reasons,
      userTextPreview: userText.slice(0, 200),
      assistantTextPreview: assistantText.slice(0, 200),
    });
    return false;
  });

  const touchesFavoriteColor = factsToSave.some(
    (f) => normalizeMemoryFactKey(f.category, f.key) === "favorite_color",
  );
  if (touchesFavoriteColor) {
    await deletePreferenceFactsMatchingNormalizedKey(params.userId, "favorite_color");
  }

  for (const f of factsToSave) {
    if (!f.key.trim() || !f.value.trim()) continue;
    const key = normalizeMemoryFactKey(f.category, f.key);
    const confidence = Math.min(1, Math.max(0, f.confidence ?? 0.75));
    await prisma.memoryFact.upsert({
      where: {
        userId_key: { userId: params.userId, key: key.slice(0, 120) },
      },
      create: {
        userId: params.userId,
        category: f.category,
        key: key.slice(0, 120),
        value: f.value.slice(0, 2000),
        confidence,
        sourceSessionId: params.sessionId ?? undefined,
      },
      update: {
        category: f.category,
        value: f.value.slice(0, 2000),
        confidence,
        sourceSessionId: params.sessionId ?? undefined,
      },
    });
  }

  await pruneFactsIfOverLimit(params.userId);

  invalidateDirectMemoryCache(params.userId);
  await getDirectMemoryPromptBlock(params.userId);
}

async function pruneFactsIfOverLimit(userId: string): Promise<void> {
  const count = await prisma.memoryFact.count({ where: { userId } });
  if (count <= 20) return;

  const extras = count - 20;
  const victims = await prisma.memoryFact.findMany({
    where: { userId },
    orderBy: [{ confidence: "asc" }, { updatedAt: "asc" }],
    take: extras,
    select: { id: true },
  });
  if (victims.length === 0) return;
  await prisma.memoryFact.deleteMany({
    where: { id: { in: victims.map((v) => v.id) } },
  });
}

/** Maps near-duplicate keys (e.g. fav_color) so upserts replace the same preference. */
function normalizeMemoryFactKey(category: MemoryCategory, key: string): string {
  const raw = key.trim().slice(0, 120);
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

  if (category === "preference") {
    const colorish = slug.includes("color") || slug.includes("colour");
    const favish =
      slug.includes("fav")
      || slug.includes("preferred")
      || slug.includes("favourite")
      || slug.includes("favorite");
    if ((colorish && favish) || slug === "color" || slug === "colour") {
      return "favorite_color";
    }
  }

  return raw;
}

function dedupeFactsByNormalizedKey(
  facts: MemoryExtractionResult["facts"],
): MemoryExtractionResult["facts"] {
  const map = new Map<string, MemoryExtractionResult["facts"][number]>();
  for (const f of facts) {
    const nk = normalizeMemoryFactKey(f.category, f.key);
    map.set(`${f.category}:${nk}`, { ...f, key: nk });
  }
  return [...map.values()];
}

/** Removes all preference rows that map to the same normalized key (stale alias rows). */
async function deletePreferenceFactsMatchingNormalizedKey(
  userId: string,
  normalizedKey: string,
): Promise<void> {
  const prefs = await prisma.memoryFact.findMany({
    where: { userId, category: "preference" },
    select: { id: true, key: true },
  });
  const ids = prefs
    .filter((p) => normalizeMemoryFactKey("preference", p.key) === normalizedKey)
    .map((p) => p.id);
  if (ids.length === 0) return;
  await prisma.memoryFact.deleteMany({ where: { id: { in: ids } } });
}

/**
 * Pronouns and stop-words that the extraction LLM sometimes outputs verbatim
 * as a fact value (e.g. "favorite_color=this" when the user said "this is my
 * favorite color"). These are never durable facts.
 */
const LOW_SIGNAL_VALUES = new Set([
  "this", "that", "it", "the", "a", "an", "yes", "no",
  "okay", "ok", "sure", "yeah", "nope", "maybe",
  "something", "nothing", "anything", "stuff",
  "him", "her", "them", "they", "you", "me",
  "user", "assistant",
]);

function isLowSignalValue(value: string): boolean {
  const norm = value.trim().toLowerCase().replace(/[.!?,;:'"]+$/g, "");
  if (norm.length < 2) return true;
  if (LOW_SIGNAL_VALUES.has(norm)) return true;
  return false;
}

/**
 * True when the fact's value is clearly grounded in what the user said this
 * turn. Uses **word-boundary** matching so "blue" inside "blueberry" or
 * "bluetooth" does NOT count as the user stating "blue". Also rejects when
 * the user's message is purely a QUESTION — questions ask about a fact, they
 * don't establish one (e.g. "what is my favorite color?" must never produce
 * a favorite_color fact, even if the answer happens to mention a color).
 */
function isValueGroundedInUserText(value: string, userText: string): boolean {
  if (isUserTextPurelyAQuestion(userText)) return false;

  const u = userText.toLowerCase();
  const valueLc = value.toLowerCase().trim();

  // Whole-value word-boundary match (handles multi-word values like "two cats").
  if (matchesAsWord(u, valueLc)) return true;

  // Otherwise: any meaningful token (>=3 chars) of the value must appear as a
  // whole word in userText. "blue" → matches "I like blue", but NOT "blueberry".
  const tokens = valueLc
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length >= 3);
  if (tokens.length === 0) return false;
  return tokens.some((t) => matchesAsWord(u, t));
}

function matchesAsWord(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
}

/**
 * Heuristic: treat the user's message as a question if it ends with "?" or
 * starts with a wh-/auxiliary word. We refuse to extract durable facts from
 * questions — the user is asking, not declaring.
 */
function isUserTextPurelyAQuestion(userText: string): boolean {
  const t = userText.trim();
  if (!t) return false;
  if (t.endsWith("?")) return true;
  const firstWord = t.toLowerCase().match(/^[a-z]+/)?.[0] ?? "";
  const QUESTION_OPENERS = new Set([
    "what", "when", "where", "who", "whom", "why", "how", "which", "whose",
    "do", "does", "did", "is", "are", "was", "were", "am",
    "can", "could", "will", "would", "should", "shall", "may", "might",
    "have", "has", "had",
  ]);
  return QUESTION_OPENERS.has(firstWord);
}

import { getRedis, DIRECT_MEMORY_CACHE_PREFIX, DIRECT_MEMORY_CACHE_TTL_SEC } from "@/cache/redis";
import { prisma } from "@/db/client";
import { sanitizeMemoryValueForPrompt } from "@/utils/stripVoiceHallucination";
import { logger } from "@/utils/logger";
import type { MemoryCategory, MemoryFact } from "@prisma/client";

const EMPTY_SENTINEL = "(none)";

function formatFactsForPrompt(facts: MemoryFact[]): string {
  if (facts.length === 0) return "";
  const lines = facts.map(
    (f) => `- (${f.category}) ${f.key}: ${sanitizeMemoryValueForPrompt(f.value)}`,
  );
  return [
    "User facts (you know these about the user — answer naturally; never read this line or the bullets aloud; never describe these as memory technology):",
    ...lines,
  ].join("\n");
}

/** Loads top direct-memory facts, caches formatted block in Redis. */
export async function getDirectMemoryPromptBlock(userId: string): Promise<string> {
  const redis = getRedis();
  const key = DIRECT_MEMORY_CACHE_PREFIX + userId;

  if (redis) {
    try {
      const cached = await redis.get(key);
      if (cached != null) {
        const out = cached === EMPTY_SENTINEL ? "" : cached;
        logger.info("[MEMLEAK] memory cache HIT", {
          userId,
          key,
          empty: cached === EMPTY_SENTINEL,
          chars: out.length,
          preview: out.slice(0, 300),
        });
        return out;
      }
    } catch {
      /* fall through to DB */
    }
  }

  let facts: MemoryFact[];
  try {
    facts = await prisma.memoryFact.findMany({
      where: { userId },
      orderBy: [{ confidence: "desc" }, { updatedAt: "desc" }],
      take: 20,
    });
  } catch (err) {
    logger.warn("Direct memory load failed — continuing without user facts", { err, userId });
    return "";
  }

  const block = formatFactsForPrompt(facts);
  logger.info("[MEMLEAK] memory cache MISS → DB load", {
    userId,
    key,
    factCount: facts.length,
    factKeys: facts.map((f) => `${f.category}:${f.key}=${f.value.slice(0, 40)}`),
    blockChars: block.length,
  });

  if (redis) {
    try {
      await redis.set(key, block || EMPTY_SENTINEL, "EX", DIRECT_MEMORY_CACHE_TTL_SEC);
    } catch {
      /* ignore cache write */
    }
  }

  return block;
}

/** Warms Redis from DB (call on user select / voice:start). */
export async function preloadDirectMemoryCache(userId: string): Promise<void> {
  await getDirectMemoryPromptBlock(userId);
}

export function invalidateDirectMemoryCache(userId: string): void {
  const redis = getRedis();
  if (!redis) return;
  void redis.del(DIRECT_MEMORY_CACHE_PREFIX + userId).catch(() => undefined);
}

export function isMemoryCategory(s: string): s is MemoryCategory {
  return (
    s === "identity"
    || s === "preference"
    || s === "personality"
    || s === "constraint"
    || s === "ongoing"
  );
}

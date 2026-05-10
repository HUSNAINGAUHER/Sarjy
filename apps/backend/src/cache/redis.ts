import Redis from "ioredis";
import { env } from "@/config/env";
import { logger } from "@/utils/logger";

const globalForRedis = globalThis as unknown as { redis?: Redis | null };

function createRedis(): Redis | null {
  const url = env.REDIS_URL?.trim();
  if (!url) {
    logger.info("REDIS_URL not set — skipping Redis");
    return null;
  }
  const client = new Redis(url, {
    maxRetriesPerRequest: 2,
    retryStrategy(times) {
      if (times > 3) return null;
      return Math.min(times * 200, 2000);
    },
  });
  client.on("error", (err) => {
    logger.warn("Redis error", { err: String(err) });
  });
  return client;
}

export function getRedis(): Redis | null {
  if (globalForRedis.redis === undefined) {
    globalForRedis.redis = createRedis();
  }
  return globalForRedis.redis;
}

/** Bump suffix when prompt formatting changes so stale wording is not served from Redis. */
export const DIRECT_MEMORY_CACHE_PREFIX = "user:memory:direct:v3:";
export const DIRECT_MEMORY_CACHE_TTL_SEC = 300;

import type { MemoryCategory } from "@prisma/client";

export interface MemoryExtractionResult {
  facts: Array<{
    category: MemoryCategory;
    key: string;
    value: string;
    confidence?: number;
  }>;
}

const CAT: MemoryCategory[] = [
  "identity",
  "preference",
  "personality",
  "constraint",
  "ongoing",
];

function isCategory(s: string): s is MemoryCategory {
  return (CAT as readonly string[]).includes(s);
}

/**
 * Parses model output with explicit delimiters so unescaped quotes in prose
 * cannot break JSON.
 */
export function parseMemoryExtractionBlocks(raw: string): MemoryExtractionResult | null {
  const text = raw.trim();
  const factsMatch = text.match(
    /BEGIN_FACTS_JSON\s*([\s\S]*?)\s*END_FACTS_JSON/i,
  );

  if (!factsMatch) return null;

  const facts: MemoryExtractionResult["facts"] = [];
  const inner = factsMatch[1]!.trim();
  if (inner.length > 0) {
    try {
      const arr = JSON.parse(inner) as unknown;
      if (Array.isArray(arr)) {
        for (const row of arr.slice(0, 8)) {
          if (!row || typeof row !== "object") continue;
          const o = row as Record<string, unknown>;
          const category = typeof o.category === "string" ? o.category : "";
          const key = typeof o.key === "string" ? o.key : "";
          const value = typeof o.value === "string" ? o.value : "";
          const conf = typeof o.confidence === "number" ? o.confidence : undefined;
          if (!key.trim() || !value.trim() || !isCategory(category)) continue;
          facts.push({
            category,
            key: key.slice(0, 120),
            value: value.slice(0, 2000),
            confidence:
              conf !== undefined ? Math.min(1, Math.max(0, conf)) : undefined,
          });
        }
      }
    } catch {
      return null;
    }
  }

  return { facts };
}

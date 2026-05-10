const FIRST_FLUSH_MIN = 14;
const STEADY_FLUSH_MIN = 22;
const HARD_MAX = 96;

/**
 * Pull a prefix of \`buffer\` that is safe to send to TTS early (clause boundaries),
 * while keeping the remainder for more tokens. Optimizes perceived TTFT.
 */
export function takeSpeakablePrefix(
  buffer: string,
  isFirstFlush: boolean
): { spoken: string; rest: string } | null {
  const min = isFirstFlush ? FIRST_FLUSH_MIN : STEADY_FLUSH_MIN;
  if (buffer.length < min) return null;

  // Sentence or strong clause end (space after punctuation helps TTS breathe)
  const punctIdx = buffer.search(/[.!?](?:\s|$)/);
  if (punctIdx !== -1 && punctIdx >= min - 1) {
    const cut = punctIdx + 1;
    return { spoken: buffer.slice(0, cut).trim(), rest: buffer.slice(cut) };
  }

  // Clause break on comma after enough text
  const commaIdx = buffer.indexOf(",");
  if (commaIdx !== -1 && commaIdx >= min + 8) {
    const cut = commaIdx + 1;
    return { spoken: buffer.slice(0, cut).trim(), rest: buffer.slice(cut) };
  }

  if (buffer.length >= HARD_MAX) {
    const slice = buffer.slice(0, HARD_MAX);
    const lastSpace = slice.lastIndexOf(" ");
    const cut = lastSpace > min ? lastSpace : HARD_MAX;
    return { spoken: buffer.slice(0, cut).trim(), rest: buffer.slice(cut) };
  }

  return null;
}

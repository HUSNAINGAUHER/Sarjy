/**
 * Per-socket image attachment store for the voice assistant.
 *
 * Lifecycle
 * ─────────
 *  1. Client uploads an image while the voice session is open
 *     (`voice:imageAttach`). The bytes are kept in memory under this socket.
 *  2. On the NEXT user turn (after STT settles) the pipeline drains pending
 *     attachments and inlines them into the multimodal user message sent to
 *     the LLM. This pattern means a fresh upload is included only on the next
 *     turn, not retroactively into past conversation.
 *  3. After draining, attachments are tracked as "in conversation" — the LLM
 *     keeps them in the rolling `conversation` ModelMessage[] (so follow-up
 *     turns about the same image still work) until either the conversation is
 *     trimmed by `MAX_CONVERSATION_MESSAGES` or the client clears them.
 *  4. Disconnect / `voice:stop` empties the store.
 *
 * Validation is deliberately strict: image MIME type whitelist + total byte
 * cap per session. Bytes never touch disk and are not persisted to Postgres
 * (chat history is text-only).
 */

import { logger } from "@/utils/logger";

/** Image MIME types accepted by both major vision models we ship today. */
export const SUPPORTED_IMAGE_MIME_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/** Per-image hard cap (bytes). Keeps single uploads under typical socket limits. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Per-session aggregate cap (bytes) — protects against attach spam. */
export const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;

/** Maximum number of attachments that may live in the store at once. */
export const MAX_IMAGE_COUNT = 6;

export interface VoiceAttachedImage {
  id: string;
  mediaType: string;
  /** Base-64 encoded image bytes (no `data:` prefix). */
  data: string;
  byteSize: number;
  caption?: string;
  attachedAt: number;
}

export interface VoiceAttachedImageMeta {
  id: string;
  mediaType: string;
  byteSize: number;
  caption?: string;
}

export interface AttachResult {
  ok: boolean;
  error?: string;
  image?: VoiceAttachedImage;
}

let counter = 0;
function nextImageId(): string {
  counter += 1;
  return `img_${Date.now().toString(36)}_${counter.toString(36)}`;
}

/**
 * Validate base-64 input and approximate decoded byte size without allocating
 * a Buffer (avoids paying memory cost twice). Base64 length × 0.75 minus
 * padding chars is exact for well-formed input.
 */
function approximateBase64ByteSize(b64: string): number {
  let len = b64.length;
  if (b64.endsWith("==")) len -= 2;
  else if (b64.endsWith("=")) len -= 1;
  return Math.floor((len * 3) / 4);
}

/** Crude sanity check that a string looks like base-64 image bytes. */
function looksLikeBase64(b64: string): boolean {
  if (!b64 || b64.length < 32) return false;
  // Allow standard base64 alphabet plus whitespace.
  return /^[A-Za-z0-9+/=\s]+$/.test(b64);
}

export class VoiceImageContextStore {
  private pending: VoiceAttachedImage[] = [];
  private inConversation: VoiceAttachedImage[] = [];

  attach(input: {
    mediaType: string;
    data: string;
    caption?: string;
  }): AttachResult {
    const mediaType = (input.mediaType ?? "").toLowerCase().trim();
    if (!SUPPORTED_IMAGE_MIME_TYPES.has(mediaType)) {
      return { ok: false, error: `Unsupported image type: ${mediaType || "unknown"}` };
    }

    const data = (input.data ?? "").replace(/^data:[^;]+;base64,/, "");
    if (!looksLikeBase64(data)) {
      return { ok: false, error: "Invalid base64 image payload" };
    }

    const byteSize = approximateBase64ByteSize(data);
    if (byteSize <= 0) {
      return { ok: false, error: "Empty image payload" };
    }
    if (byteSize > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        error: `Image too large (${(byteSize / 1024).toFixed(0)}KB; max ${(MAX_IMAGE_BYTES / 1024).toFixed(0)}KB)`,
      };
    }

    const totalAfter =
      this.pending.reduce((s, i) => s + i.byteSize, 0)
      + this.inConversation.reduce((s, i) => s + i.byteSize, 0)
      + byteSize;
    if (totalAfter > MAX_TOTAL_IMAGE_BYTES) {
      return {
        ok: false,
        error: `Session image cap exceeded (${(totalAfter / 1024).toFixed(0)}KB > ${(MAX_TOTAL_IMAGE_BYTES / 1024).toFixed(0)}KB)`,
      };
    }
    if (this.pending.length + this.inConversation.length >= MAX_IMAGE_COUNT) {
      return { ok: false, error: `Too many attachments (max ${MAX_IMAGE_COUNT})` };
    }

    const image: VoiceAttachedImage = {
      id: nextImageId(),
      mediaType,
      data,
      byteSize,
      caption: input.caption?.trim() || undefined,
      attachedAt: Date.now(),
    };
    this.pending.push(image);

    logger.info("voiceImageContext.attach", {
      id: image.id,
      mediaType,
      byteSize,
      pending: this.pending.length,
      inConversation: this.inConversation.length,
    });

    return { ok: true, image };
  }

  remove(id: string): boolean {
    const before = this.pending.length + this.inConversation.length;
    this.pending = this.pending.filter((i) => i.id !== id);
    this.inConversation = this.inConversation.filter((i) => i.id !== id);
    const after = this.pending.length + this.inConversation.length;
    return after < before;
  }

  /**
   * Move all pending images into the "in conversation" bucket and return them
   * for inlining into the next user turn. Idempotent within a turn — a second
   * call returns an empty array.
   */
  takePendingForTurn(): VoiceAttachedImage[] {
    if (!this.pending.length) return [];
    const taken = this.pending;
    this.pending = [];
    this.inConversation.push(...taken);
    return taken;
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  hasAny(): boolean {
    return this.pending.length > 0 || this.inConversation.length > 0;
  }

  reset(): void {
    if (!this.pending.length && !this.inConversation.length) return;
    logger.info("voiceImageContext.reset", {
      pending: this.pending.length,
      inConversation: this.inConversation.length,
    });
    this.pending = [];
    this.inConversation = [];
  }

  listAllMeta(): VoiceAttachedImageMeta[] {
    return [...this.pending, ...this.inConversation].map((i) => ({
      id: i.id,
      mediaType: i.mediaType,
      byteSize: i.byteSize,
      caption: i.caption,
    }));
  }

  listPendingMeta(): VoiceAttachedImageMeta[] {
    return this.pending.map((i) => ({
      id: i.id,
      mediaType: i.mediaType,
      byteSize: i.byteSize,
      caption: i.caption,
    }));
  }
}

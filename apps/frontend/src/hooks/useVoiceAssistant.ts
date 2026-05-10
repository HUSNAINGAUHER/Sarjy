"use client";

import { getSocket } from "@/lib/socket";
import type {
  VoiceAssistantTranscriptPayload,
  VoiceImageAttachAckPayload,
  VoiceImageAttachmentMeta,
  VoiceImageRemovedPayload,
  VoicePersonaId,
  VoiceReservationProgressPayload,
  VoiceRestaurantPickerPayload,
  VoiceState,
  VoiceTranscriptPayload,
  VoiceTtsEndPayload,
  VoiceTtsTimingBreakdown,
  VoiceTtsWordTimestampsPayload,
  VoiceWeatherWidgetPayload,
} from "@sarjy/shared-types";
import { isVoicePersonaId } from "@sarjy/shared-types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const TTS_SAMPLE_RATE = 24000;

/** Mirror of backend MAX_IMAGE_BYTES — keeps client preview consistent. */
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export interface VoiceAttachedImageView {
  id: string;
  mediaType: string;
  byteSize: number;
  caption?: string;
  /** Local data URL used as a thumbnail. Lives in browser memory only. */
  thumbDataUrl: string;
}

function readFileAsBase64(file: Blob): Promise<{ base64: string; dataUrl: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const commaIdx = dataUrl.indexOf(",");
      const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
      resolve({ base64, dataUrl });
    };
    reader.readAsDataURL(file);
  });
}

// Minimum ms of audio to buffer before starting playback.
// Deepgram TTS WS delivers audio in bursts with gaps up to ~2 s between them;
// this head-start absorbs most gaps and prevents audible underruns.
const JITTER_BUFFER_MS = 800;

// RMS threshold above which we consider the user to be speaking (barge-in).
// Raised from 0.015 → 0.05 so faint speaker bleed doesn't trigger a false barge-in.
const BARGE_IN_RMS_THRESHOLD = 0.05;
// Grace period after TTS starts before barge-in can trigger (ms)
const BARGE_IN_GRACE_MS = 800;
// How long after TTS ends to keep the mic muted to Flux (lets echo decay, ms)
const MIC_UNMUTE_DELAY_MS = 300;
const VOICE_PERSONA_STORAGE_KEY = "sarjy-voice-persona";

function readStoredVoicePersona(): VoicePersonaId {
  if (typeof window === "undefined") return "jolly";
  try {
    const raw = localStorage.getItem(VOICE_PERSONA_STORAGE_KEY);
    if (raw && isVoicePersonaId(raw)) return raw;
  } catch {
    /* ignore */
  }
  return "jolly";
}

function readBrowserLocation(
  options?: PositionOptions,
): Promise<{ latitude: number; longitude: number; accuracyMeters?: number } | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.resolve(null);
  }
  const opts: PositionOptions = options ?? {
    enableHighAccuracy: false,
    maximumAge: 300_000,
    timeout: 10_000,
  };
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracyMeters: pos.coords.accuracy,
        });
      },
      () => resolve(null),
      opts,
    );
  });
}

export interface VoiceTranscriptEntry {
  role: "user" | "assistant";
  text: string;
}

export interface VoiceWordTimings {
  words: string[];
  start: number[];
  end: number[];
}

export type VoiceCaptionMode = "none" | "connecting" | "user" | "assistant";

function lastRoleText(history: VoiceTranscriptEntry[], role: "user" | "assistant"): string {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === role) return history[i]!.text;
  }
  return "";
}

function mergeWordTimings(
  prev: VoiceWordTimings | null,
  next: VoiceTtsWordTimestampsPayload,
): VoiceWordTimings {
  if (!prev || prev.words.length === 0) {
    return {
      words: [...next.words],
      start: [...next.start],
      end: [...next.end],
    };
  }
  const prevEnd = prev.end[prev.end.length - 1] ?? 0;
  const batchMin = Math.min(...next.start);
  const offset = batchMin + 0.05 < prevEnd ? prevEnd - batchMin : 0;

  return {
    words: [...prev.words, ...next.words],
    start: [...prev.start, ...next.start.map((s) => s + offset)],
    end: [...prev.end, ...next.end.map((e) => e + offset)],
  };
}

function activeWordIndexAtTime(timings: VoiceWordTimings, t: number): number {
  if (!timings.words.length) return -1;
  if (t < timings.start[0]!) return -1;
  for (let i = 0; i < timings.words.length; i++) {
    if (t < timings.end[i]!) return i;
  }
  const lastEnd = timings.end[timings.end.length - 1] ?? 0;
  return t >= lastEnd ? -1 : timings.words.length - 1;
}

export interface UseVoiceAssistantReturn {
  state: VoiceState;
  interimText: string;
  finalText: string;
  transcriptHistory: VoiceTranscriptEntry[];
  /** Single-line caption: user while listening/thinking; assistant while speaking (not both). */
  captionMode: VoiceCaptionMode;
  captionUserText: string;
  captionAssistantText: string;
  /** Merged Cartesia word timings for the current TTS turn (null for Deepgram or before data arrives). */
  assistantWordTimings: VoiceWordTimings | null;
  /** Index into `assistantWordTimings.words` for karaoke highlight (-1 = none). */
  assistantSpokenWordIndex: number;
  latency: {
    ttfaMs: number;
    totalMs: number;
    timing?: VoiceTtsTimingBreakdown;
    llmTtftMs?: number;
    llmPostFirstTokenMs?: number;
  } | null;
  error: string | null;
  isSessionActive: boolean;
  /** When true: mic is physically disconnected during TTS (hard mute).
   *  When false: mic stays active so browser AEC can run, but audio chunks
   *  are suppressed from being forwarded to Flux (soft / echo-cancel mode). */
  muteMicDuringTts: boolean;
  setMuteMicDuringTts: (v: boolean) => void;
  startSession: () => Promise<void>;
  stopSession: () => void;
  /** Last successful weather tool result for a small on-screen card. */
  weatherWidget: VoiceWeatherWidgetPayload | null;
  dismissWeatherWidget: () => void;
  /** Demo restaurant tiles while the assistant is collecting the restaurant slot. */
  restaurantPicker: VoiceRestaurantPickerPayload | null;
  dismissRestaurantPicker: () => void;
  pickRestaurantFromWidget: (restaurantId: string) => void;
  /** Live reservation FSM + slots for sidebar widgets (null when inactive). */
  reservationProgress: VoiceReservationProgressPayload | null;
  /** Submit a line as if the user said it (drives the same pipeline as STT). */
  submitReservationWidgetLine: (text: string) => void;
  /** Selected speaking personality (saved locally; sent on next `voice:start`). */
  voicePersona: VoicePersonaId;
  setVoicePersona: (persona: VoicePersonaId) => void;
  /** Replace drawer transcript from persisted session messages. */
  loadTranscriptFromHistory: (entries: VoiceTranscriptEntry[]) => void;
  /** Images currently attached to the live voice session (with thumbnails). */
  attachedImages: VoiceAttachedImageView[];
  /** True while an attach upload is in flight (validation + base64 transfer). */
  isAttachingImage: boolean;
  /** Last attach error (size, mime type, server-side rejection); null when none. */
  imageAttachError: string | null;
  /** Upload one image. Server includes it in the next user turn sent to the LLM. */
  attachImage: (file: File, caption?: string) => Promise<void>;
  /** Remove a single attachment by id (server stops sending it on future turns). */
  removeAttachedImage: (id: string) => void;
  /** Drop every attachment from this voice session. */
  clearAttachedImages: () => void;
}

export interface UseVoiceAssistantOptions {
  userId?: string | null;
  sessionId?: string | null;
}

export function useVoiceAssistant(opts?: UseVoiceAssistantOptions): UseVoiceAssistantReturn {
  const [state, setState] = useState<VoiceState>("idle");
  const [interimText, setInterimText] = useState("");
  const [finalText, setFinalText] = useState("");
  const [transcriptHistory, setTranscriptHistory] = useState<VoiceTranscriptEntry[]>([]);
  const [latency, setLatency] = useState<{
    ttfaMs: number;
    totalMs: number;
    timing?: VoiceTtsTimingBreakdown;
    llmTtftMs?: number;
    llmPostFirstTokenMs?: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const isSessionActiveRef = useRef(false);
  const [muteMicDuringTts, setMuteMicDuringTts] = useState(true);
  const muteMicDuringTtsRef = useRef(true);
  const [weatherWidget, setWeatherWidget] = useState<VoiceWeatherWidgetPayload | null>(null);
  const [restaurantPicker, setRestaurantPicker] = useState<VoiceRestaurantPickerPayload | null>(null);
  const [reservationProgress, setReservationProgress] = useState<VoiceReservationProgressPayload | null>(null);
  const [voicePersona, setVoicePersonaState] = useState<VoicePersonaId>("jolly");
  const [attachedImages, setAttachedImages] = useState<VoiceAttachedImageView[]>([]);
  const [isAttachingImage, setIsAttachingImage] = useState(false);
  const [imageAttachError, setImageAttachError] = useState<string | null>(null);
  /** Local thumbnails keyed by id — used to repopulate when the server snapshot lands. */
  const imageThumbsRef = useRef<Map<string, string>>(new Map());
  const chatUserIdRef = useRef<string | null>(opts?.userId ?? null);
  const chatSessionIdRef = useRef<string | null>(opts?.sessionId ?? null);

  useEffect(() => {
    chatUserIdRef.current = opts?.userId ?? null;
    chatSessionIdRef.current = opts?.sessionId ?? null;
  }, [opts?.userId, opts?.sessionId]);

  useEffect(() => {
    setVoicePersonaState(readStoredVoicePersona());
  }, []);

  const setVoicePersona = useCallback((persona: VoicePersonaId) => {
    setVoicePersonaState(persona);
    try {
      localStorage.setItem(VOICE_PERSONA_STORAGE_KEY, persona);
    } catch {
      /* ignore */
    }
  }, []);

  // Refs that don't need to trigger re-renders
  const captureCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  // TTS playback
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const ttsSpeakingRef = useRef(false);
  const ttsStartedAtRef = useRef(0);
  // Leftover byte carried between PCM chunks to handle odd-length buffers
  const ttsLeftoverByteRef = useRef<number | null>(null);
  // Counters for per-session TTS chunk logging
  const ttsChunkCountRef = useRef(0);
  const ttsTotalBytesRef = useRef(0);
  // Jitter buffer — holds decoded AudioBuffers until JITTER_BUFFER_MS is reached
  const jitterBufferRef = useRef<AudioBuffer[]>([]);
  const jitterBufferedMsRef = useRef(0);
  const jitterStartedRef = useRef(false);

  /** Web Audio `currentTime` when the first sample of this TTS turn was scheduled. */
  const ttsPlaybackAnchorCtxTimeRef = useRef<number | null>(null);
  const [ttsWordTimings, setTtsWordTimings] = useState<VoiceWordTimings | null>(null);
  const ttsWordTimingsRef = useRef<VoiceWordTimings | null>(null);
  const [assistantSpokenWordIndex, setAssistantSpokenWordIndex] = useState(-1);

  // When true, mic audio is NOT forwarded to Flux (prevents speaker bleed → false StartOfTurn)
  const muteMicToFluxRef = useRef(false);
  const muteMicTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Physical mic mute: disconnect mic source from worklet while TTS plays
  const micMutedRef = useRef(false);

  const stateRef = useRef<VoiceState>("idle");
  const pendingUserTranscriptIndexRef = useRef<number | null>(null);
  const pendingAssistantTranscriptIndexRef = useRef<number | null>(null);

  const updateState = useCallback((s: VoiceState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  const handleSetMuteMicDuringTts = useCallback((v: boolean) => {
    muteMicDuringTtsRef.current = v;
    setMuteMicDuringTts(v);
  }, []);

  const dismissWeatherWidget = useCallback(() => {
    setWeatherWidget(null);
  }, []);

  const dismissRestaurantPicker = useCallback(() => {
    setRestaurantPicker(null);
  }, []);

  const pickRestaurantFromWidget = useCallback((restaurantId: string) => {
    if (!restaurantId.trim()) return;
    getSocket().emit("voice:restaurantPick", { restaurantId: restaurantId.trim() });
    setRestaurantPicker(null);
  }, []);

  const submitReservationWidgetLine = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    getSocket().emit("voice:reservationWidgetSubmit", { text: t });
  }, []);

  // ── Image attachments ─────────────────────────────────────────────────────

  const reconcileAttachedImages = useCallback(
    (serverList: VoiceImageAttachmentMeta[]) => {
      setAttachedImages(
        serverList.map((meta) => ({
          id: meta.id,
          mediaType: meta.mediaType,
          byteSize: meta.byteSize,
          caption: meta.caption,
          // Thumb is local-only — fall back to a 1px transparent if we never
          // had it (e.g. server-only attach in another tab; not currently
          // possible but keeps the type happy).
          thumbDataUrl: imageThumbsRef.current.get(meta.id) ?? "",
        })),
      );
      // Drop thumbnails for ids the server no longer reports.
      const liveIds = new Set(serverList.map((m) => m.id));
      for (const id of Array.from(imageThumbsRef.current.keys())) {
        if (!liveIds.has(id)) imageThumbsRef.current.delete(id);
      }
    },
    [],
  );

  const attachImage = useCallback(
    async (file: File, caption?: string): Promise<void> => {
      setImageAttachError(null);
      const trimmedCaption = caption?.trim() || undefined;

      if (!isSessionActiveRef.current) {
        setImageAttachError("Start a voice session before attaching images.");
        return;
      }
      if (!SUPPORTED_IMAGE_MIME_TYPES.has(file.type)) {
        setImageAttachError(
          `Unsupported type: ${file.type || "unknown"}. Use JPEG, PNG, WebP, or GIF.`,
        );
        return;
      }
      if (file.size > IMAGE_MAX_BYTES) {
        setImageAttachError(
          `Image is ${(file.size / 1024 / 1024).toFixed(1)}MB; max is ${(IMAGE_MAX_BYTES / 1024 / 1024).toFixed(0)}MB.`,
        );
        return;
      }

      setIsAttachingImage(true);
      try {
        const { base64, dataUrl } = await readFileAsBase64(file);
        await new Promise<void>((resolve) => {
          getSocket().emit(
            "voice:imageAttach",
            { data: base64, mediaType: file.type, caption: trimmedCaption },
            (response: VoiceImageAttachAckPayload) => {
              if (!response.ok || !response.image) {
                setImageAttachError(response.error ?? "Image upload was rejected.");
              } else {
                imageThumbsRef.current.set(response.image.id, dataUrl);
                reconcileAttachedImages(response.attached);
              }
              resolve();
            },
          );
        });
      } catch (err) {
        setImageAttachError(
          err instanceof Error ? err.message : "Failed to read the image.",
        );
      } finally {
        setIsAttachingImage(false);
      }
    },
    [reconcileAttachedImages],
  );

  const removeAttachedImage = useCallback((id: string) => {
    if (!id) return;
    setImageAttachError(null);
    getSocket().emit("voice:imageRemove", { id });
    // Optimistic local clear — the server will follow with a `voice:imageRemoved` snapshot.
    imageThumbsRef.current.delete(id);
    setAttachedImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const clearAttachedImages = useCallback(() => {
    setImageAttachError(null);
    if (attachedImages.length === 0) return;
    getSocket().emit("voice:imageClearAll");
    imageThumbsRef.current.clear();
    setAttachedImages([]);
  }, [attachedImages.length]);

  // ── TTS playback helpers ──────────────────────────────────────────────────

  function getOrCreatePlaybackContext(): AudioContext {
    if (!playbackCtxRef.current || playbackCtxRef.current.state === "closed") {
      playbackCtxRef.current = new AudioContext({ sampleRate: TTS_SAMPLE_RATE });
    }
    if (playbackCtxRef.current.state === "suspended") {
      void playbackCtxRef.current.resume();
    }
    return playbackCtxRef.current;
  }

  function muteMic(): void {
    // Cancel any pending unmute
    if (muteMicTimerRef.current) {
      clearTimeout(muteMicTimerRef.current);
      muteMicTimerRef.current = null;
    }
    muteMicToFluxRef.current = true;

    if (muteMicDuringTtsRef.current) {
      // Hard mute: physically disconnect mic from worklet
      if (micMutedRef.current) return;
      micMutedRef.current = true;
      try { micSourceRef.current?.disconnect(); } catch { /* already disconnected */ }
    }
    // Soft mode: mic stays connected (browser AEC runs), but chunks are
    // blocked from reaching Flux via muteMicToFluxRef
  }

  function unmuteMic(delayMs = MIC_UNMUTE_DELAY_MS): void {
    if (muteMicTimerRef.current) clearTimeout(muteMicTimerRef.current);
    muteMicTimerRef.current = setTimeout(() => {
      muteMicTimerRef.current = null;
      muteMicToFluxRef.current = false;

      if (micMutedRef.current) {
        micMutedRef.current = false;
        // Reconnect mic source → worklet (hard mute path)
        if (micSourceRef.current && workletNodeRef.current) {
          try { micSourceRef.current.connect(workletNodeRef.current); } catch { /* ignore */ }
        }
      }
    }, delayMs);
  }

  function clearTtsKaraokeState(): void {
    ttsPlaybackAnchorCtxTimeRef.current = null;
    ttsWordTimingsRef.current = null;
    setTtsWordTimings(null);
    setAssistantSpokenWordIndex(-1);
  }

  function stopAllPlayback(): void {
    for (const src of activeSourcesRef.current) {
      try { src.stop(); } catch { /* already stopped */ }
    }
    activeSourcesRef.current = [];
    nextPlayTimeRef.current = 0;
    ttsSpeakingRef.current = false;
    ttsLeftoverByteRef.current = null;
    ttsChunkCountRef.current = 0;
    ttsTotalBytesRef.current = 0;
    // Reset jitter buffer
    jitterBufferRef.current = [];
    jitterBufferedMsRef.current = 0;
    jitterStartedRef.current = false;
    clearTtsKaraokeState();
    // Unmute mic after echo decay (called here for barge-in path)
    unmuteMic();
  }

  /**
   * Flush all queued jitter buffers to the Web Audio scheduler and mark
   * playback as started. Safe to call multiple times — only the first call
   * actually does work.
   */
  function flushJitterBuffer(): void {
    if (jitterStartedRef.current) return;
    jitterStartedRef.current = true;
    const ctx = playbackCtxRef.current;
    if (!ctx) return;
    for (const buf of jitterBufferRef.current) {
      scheduleAudioBuffer(ctx, buf);
    }
    jitterBufferRef.current = [];
    jitterBufferedMsRef.current = 0;
  }

  function scheduleAudioBuffer(ctx: AudioContext, audioBuffer: AudioBuffer): void {
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    source.onended = () => {
      activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== source);
    };

    // Schedule with a tiny cushion so queued buffers play continuously.
    const now = ctx.currentTime;
    if (nextPlayTimeRef.current > 0 && now > nextPlayTimeRef.current + 0.02) {
      console.warn(
        `[TTS][${new Date().toISOString()}] playback underrun — audio arrived ${Math.round(
          (now - nextPlayTimeRef.current) * 1000
        )} ms after scheduled buffer ran dry`
      );
    }
    const startAt = Math.max(now + 0.005, nextPlayTimeRef.current);
    source.start(startAt);
    nextPlayTimeRef.current = startAt + audioBuffer.duration;

    if (ttsPlaybackAnchorCtxTimeRef.current === null && ttsSpeakingRef.current) {
      ttsPlaybackAnchorCtxTimeRef.current = startAt;
    }

    activeSourcesRef.current.push(source);
  }

  function schedulePCMChunk(rawBuffer: ArrayBuffer): void {
    const ctx = getOrCreatePlaybackContext();

    // Merge any leftover byte from the previous chunk so the 2-byte PCM
    // alignment is preserved even when the TTS stream delivers odd-length
    // network packets (which would crash `new Int16Array(rawBuffer)`).
    let bytes = new Uint8Array(rawBuffer);
    if (ttsLeftoverByteRef.current !== null) {
      const merged = new Uint8Array(1 + bytes.byteLength);
      merged[0] = ttsLeftoverByteRef.current;
      merged.set(bytes, 1);
      bytes = merged;
      ttsLeftoverByteRef.current = null;
    }
    if (bytes.byteLength % 2 !== 0) {
      ttsLeftoverByteRef.current = bytes[bytes.byteLength - 1] ?? null;
      bytes = bytes.slice(0, bytes.byteLength - 1);
    }
    if (bytes.byteLength === 0) return;

    const chunkIdx = ttsChunkCountRef.current++;
    ttsTotalBytesRef.current += bytes.byteLength;
    const samples = bytes.byteLength / 2;
    const durationMs = Math.round((samples / TTS_SAMPLE_RATE) * 1000);
    console.log(
      `[TTS][${new Date().toISOString()}] chunk #${chunkIdx} — ${bytes.byteLength} bytes / ${samples} samples / ~${durationMs} ms audio | cumulative ${ttsTotalBytesRef.current} bytes`
    );

    const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, samples);
    const float32 = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      float32[i] = (int16[i] as number) / 32768;
    }

    const audioBuffer = ctx.createBuffer(1, float32.length, TTS_SAMPLE_RATE);
    audioBuffer.copyToChannel(float32, 0);

    if (!jitterStartedRef.current) {
      // Still filling the jitter buffer — hold this chunk until we have enough
      // audio to absorb any inter-burst gaps from the TTS provider.
      jitterBufferRef.current.push(audioBuffer);
      jitterBufferedMsRef.current += audioBuffer.duration * 1000;
      if (jitterBufferedMsRef.current >= JITTER_BUFFER_MS) {
        flushJitterBuffer();
      }
    } else {
      scheduleAudioBuffer(ctx, audioBuffer);
    }
  }

  // ── Audio capture helpers ─────────────────────────────────────────────────

  async function startCapture(): Promise<number> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    micStreamRef.current = stream;

    const captureCtx = new AudioContext();
    captureCtxRef.current = captureCtx;

    await captureCtx.audioWorklet.addModule("/pcm-processor.js");

    const workletNode = new AudioWorkletNode(captureCtx, "pcm-processor");
    workletNodeRef.current = workletNode;

    workletNode.port.onmessage = (evt: MessageEvent<{ audio: ArrayBuffer; rms: number }>) => {
      const { audio, rms } = evt.data;
      const socket = getSocket();

      // Barge-in detection: user speaks while assistant is playing.
      // Do this BEFORE the mute check so a real barge-in immediately unmutes.
      if (
        ttsSpeakingRef.current &&
        rms > BARGE_IN_RMS_THRESHOLD &&
        Date.now() - ttsStartedAtRef.current > BARGE_IN_GRACE_MS
      ) {
        muteMicToFluxRef.current = false;
        if (muteMicTimerRef.current) {
          clearTimeout(muteMicTimerRef.current);
          muteMicTimerRef.current = null;
        }
        socket.emit("voice:bargeIn");
        stopAllPlayback();
        ttsSpeakingRef.current = false;
      }

      // Suppress mic → Flux during TTS to prevent speaker bleed from triggering
      // a false Flux StartOfTurn and cutting TTS short.
      if (muteMicToFluxRef.current) return;

      socket.emit("voice:audioChunk", audio);
    };

    const micSource = captureCtx.createMediaStreamSource(stream);
    micSourceRef.current = micSource;
    micSource.connect(workletNode);

    return captureCtx.sampleRate;
  }

  function stopCapture(): void {
    if (muteMicTimerRef.current) {
      clearTimeout(muteMicTimerRef.current);
      muteMicTimerRef.current = null;
    }
    muteMicToFluxRef.current = false;
    micMutedRef.current = false;
    micSourceRef.current?.disconnect();
    workletNodeRef.current?.disconnect();
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    if (captureCtxRef.current?.state !== "closed") {
      void captureCtxRef.current?.close();
    }
    captureCtxRef.current = null;
    workletNodeRef.current = null;
    micSourceRef.current = null;
    micStreamRef.current = null;
  }

  // ── Session lifecycle ─────────────────────────────────────────────────────

  const startSession = useCallback(async () => {
    setError(null);
    setInterimText("");
    setFinalText("");
    setTranscriptHistory([]);
    pendingUserTranscriptIndexRef.current = null;
    pendingAssistantTranscriptIndexRef.current = null;
    setLatency(null);
    clearTtsKaraokeState();

    setIsSessionActive(true);
    setReservationProgress(null);
    updateState("connecting");
    try {
      const sampleRate = await startCapture();
      const socket = getSocket();
      const clientTimeZone =
        typeof Intl !== "undefined"
          ? Intl.DateTimeFormat().resolvedOptions().timeZone
          : undefined;
      // Emit voice:start IMMEDIATELY so the backend can warm Flux STT + Cartesia
      // TTS in parallel with the user's mic audio buffering. Awaiting browser
      // geolocation here used to block this for 5–10s on the first prompt;
      // now we send location asynchronously via voice:clientLocation when (or
      // if) it resolves. The backend re-warms its weather snapshot cache as
      // soon as that arrives.
      socket.emit("voice:start", {
        sampleRate,
        persona: voicePersona,
        ...(clientTimeZone ? { clientTimeZone } : {}),
        ...(chatUserIdRef.current ? { userId: chatUserIdRef.current } : {}),
        ...(chatSessionIdRef.current ? { sessionId: chatSessionIdRef.current } : {}),
      });
      void readBrowserLocation().then((loc) => {
        if (loc) socket.emit("voice:clientLocation", loc);
      });
      // "listening" is set when the server opens the Flux STT WebSocket (voice:stateChange).
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      stopCapture();
      setIsSessionActive(false);
      updateState("idle");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- startCapture is in-module stable
  }, [updateState, voicePersona]);

  const stopSession = useCallback(() => {
    const socket = getSocket();
    socket.emit("voice:stop");
    stopCapture();
    stopAllPlayback();
    setWeatherWidget(null);
    setRestaurantPicker(null);
    setReservationProgress(null);
    setAttachedImages([]);
    setImageAttachError(null);
    imageThumbsRef.current.clear();
    setIsSessionActive(false);
    updateState("idle");
    setInterimText("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateState]);

  useEffect(() => {
    isSessionActiveRef.current = isSessionActive;
  }, [isSessionActive]);

  // ── Socket event listeners ────────────────────────────────────────────────

  useEffect(() => {
    const socket = getSocket();

    const upsertUserTranscript = (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setTranscriptHistory((prev) => {
        const pendingIndex = pendingUserTranscriptIndexRef.current;
        const pendingEntry = pendingIndex != null ? prev[pendingIndex] : undefined;

        if (pendingIndex != null && pendingEntry?.role === "user") {
          if (pendingEntry.text.trim() === trimmed) return prev;
          const next = [...prev];
          next[pendingIndex] = { role: "user", text: trimmed };
          return next;
        }

        const lastIndex = prev.length - 1;
        const lastEntry = prev[lastIndex];
        if (lastEntry?.role === "user") {
          pendingUserTranscriptIndexRef.current = lastIndex;
          if (lastEntry.text.trim() === trimmed) return prev;
          const next = [...prev];
          next[lastIndex] = { role: "user", text: trimmed };
          return next;
        }

        pendingUserTranscriptIndexRef.current = prev.length;
        return [...prev, { role: "user", text: trimmed }];
      });
    };

    const upsertAssistantTranscript = (text: string, isFinal: boolean) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      pendingUserTranscriptIndexRef.current = null;

      setTranscriptHistory((prev) => {
        const pendingIndex = pendingAssistantTranscriptIndexRef.current;
        const pendingEntry = pendingIndex != null ? prev[pendingIndex] : undefined;

        if (pendingIndex != null && pendingEntry?.role === "assistant") {
          if (pendingEntry.text.trim() === trimmed) return prev;
          const next = [...prev];
          next[pendingIndex] = { role: "assistant", text: trimmed };
          return next;
        }

        const lastIndex = prev.length - 1;
        const lastEntry = prev[lastIndex];
        if (lastEntry?.role === "assistant") {
          pendingAssistantTranscriptIndexRef.current = lastIndex;
          if (lastEntry.text.trim() === trimmed) return prev;
          const next = [...prev];
          next[lastIndex] = { role: "assistant", text: trimmed };
          return next;
        }

        pendingAssistantTranscriptIndexRef.current = prev.length;
        return [...prev, { role: "assistant", text: trimmed }];
      });

      if (isFinal) pendingAssistantTranscriptIndexRef.current = null;
    };

    const onTranscript = (payload: VoiceTranscriptPayload) => {
      // Flux EndOfTurn / EagerEndOfTurn → treat as final utterance
      if (payload.speechFinal || payload.turnEvent === "EndOfTurn" || payload.turnEvent === "EagerEndOfTurn") {
        const text = payload.text.trim();
        if (!text) return;
        setFinalText(text);
        setInterimText("");
        upsertUserTranscript(text);
      } else if (payload.isFinal) {
        setFinalText((prev) => {
          const text = payload.text.trim();
          const next = prev && text ? `${prev} ${text}` : text || prev;
          upsertUserTranscript(next);
          return next;
        });
        setInterimText("");
      } else {
        // Update / StartOfTurn → show as interim (live)
        setInterimText(payload.text);
      }
    };

    // Flux StartOfTurn: server-confirmed speech start → instant barge-in
    const onSpeechStarted = () => {
      if (ttsSpeakingRef.current) {
        stopAllPlayback();
        ttsSpeakingRef.current = false;
        updateState("listening");
        setInterimText("");
      }
    };

    // Flux TurnResumed: cancel any response started on EagerEndOfTurn
    const onTurnResumed = () => {
      stopAllPlayback();
      ttsSpeakingRef.current = false;
      updateState("listening");
    };

    const onTtsStart = () => {
      clearTtsKaraokeState();
      ttsChunkCountRef.current = 0;
      ttsTotalBytesRef.current = 0;
      ttsLeftoverByteRef.current = null;
      // Start each assistant turn from the current audio clock. Without this,
      // the first scheduled buffer can compare against a stale end time from
      // the previous turn and report a huge false underrun.
      nextPlayTimeRef.current = 0;
      // Reset jitter buffer for this turn
      jitterBufferRef.current = [];
      jitterBufferedMsRef.current = 0;
      jitterStartedRef.current = false;
      ttsSpeakingRef.current = true;
      ttsStartedAtRef.current = Date.now();
      console.log(`[TTS][${new Date().toISOString()}] ttsStart — buffering ${JITTER_BUFFER_MS} ms before playback`);
      muteMic();
      updateState("speaking");
    };

    const onTtsChunk = (chunk: ArrayBuffer) => {
      // Socket.io delivers binary as ArrayBuffer in browser
      const buf: ArrayBuffer =
        chunk instanceof ArrayBuffer
          ? chunk
          : (chunk as unknown as { buffer: ArrayBuffer }).buffer;
      schedulePCMChunk(buf);
    };

    const onAssistantTranscript = (payload: VoiceAssistantTranscriptPayload) => {
      upsertAssistantTranscript(payload.text, payload.isFinal);
    };

    const onTtsWordTimestamps = (payload: VoiceTtsWordTimestampsPayload) => {
      setTtsWordTimings((prev) => mergeWordTimings(prev, payload));
    };

    const onTtsEnd = (payload: VoiceTtsEndPayload) => {
      // Flush any remaining jitter buffer (e.g. short reply that never hit the threshold)
      flushJitterBuffer();
      console.log(
        `[TTS][${new Date().toISOString()}] ttsEnd — ${ttsChunkCountRef.current} chunks / ${ttsTotalBytesRef.current} bytes total | ttfa=${payload.ttfaMs}ms total=${payload.totalMs}ms`
      );
      setLatency({
        ttfaMs: payload.ttfaMs,
        totalMs: payload.totalMs,
        timing: payload.timing,
        llmTtftMs: payload.llmTtftMs,
        llmPostFirstTokenMs: payload.llmPostFirstTokenMs,
      });
      const assistantText = payload.assistantText?.trim();
      if (assistantText) {
        upsertAssistantTranscript(assistantText, true);
      }
      // Wait for audio to finish playing before returning to listening
      const ctx = playbackCtxRef.current;
      const remaining = ctx
        ? Math.max(0, (nextPlayTimeRef.current - ctx.currentTime) * 1000)
        : 0;
      setTimeout(() => {
        ttsSpeakingRef.current = false;
        clearTtsKaraokeState();
        if (stateRef.current === "speaking") {
          updateState("listening");
          setInterimText("");
        }
        // Unmute mic after audio finishes + echo decay
        unmuteMic();
      }, remaining + 100);
    };

    const onTtsCancel = () => {
      stopAllPlayback(); // also calls unmuteMic() internally
      ttsSpeakingRef.current = false;
      updateState("listening");
    };

    const onStateChange = (s: VoiceState) => {
      // The backend returns to "listening" as soon as it has finished sending
      // audio bytes. Locally we may still be playing buffered/scheduled audio,
      // so keep the UI in "speaking" until onTtsEnd's playback timer completes.
      if (s === "listening" && ttsSpeakingRef.current) return;
      updateState(s);
    };

    const onVoiceError = (payload: { code: string; message: string }) => {
      setError(`${payload.code}: ${payload.message}`);
      if (payload.code === "STT_CONNECT_FAILED") {
        stopSession();
        return;
      }
      // Stay in-session so follow-up TTS (e.g. LLM provider apology) can run; ttsStart will move to speaking.
      updateState(isSessionActiveRef.current ? "listening" : "idle");
    };

    const onRequestLocation = () => {
      void readBrowserLocation({
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 20_000,
      }).then((loc) => {
        if (!loc) return;
        socket.emit("voice:clientLocation", loc);
      });
    };

    const onWeatherWidget = (payload: VoiceWeatherWidgetPayload) => {
      setWeatherWidget(payload);
    };

    const onRestaurantPicker = (payload: VoiceRestaurantPickerPayload) => {
      setRestaurantPicker(payload.options.length ? payload : null);
    };

    const onRestaurantPickerHide = () => {
      setRestaurantPicker(null);
    };

    const onReservationProgress = (payload: VoiceReservationProgressPayload | null) => {
      setReservationProgress(payload);
    };

    const onImageAttachAck = (payload: VoiceImageAttachAckPayload) => {
      if (!payload.ok) {
        setImageAttachError(payload.error ?? "Image upload was rejected.");
      }
      reconcileAttachedImages(payload.attached);
    };

    const onImageRemoved = (payload: VoiceImageRemovedPayload) => {
      reconcileAttachedImages(payload.attached);
    };

    socket.on("voice:transcript", onTranscript);
    socket.on("voice:speechStarted", onSpeechStarted);
    socket.on("voice:turnResumed", onTurnResumed);
    socket.on("voice:assistantTranscript", onAssistantTranscript);
    socket.on("voice:ttsWordTimestamps", onTtsWordTimestamps);
    socket.on("voice:ttsStart", onTtsStart);
    socket.on("voice:ttsChunk", onTtsChunk);
    socket.on("voice:ttsEnd", onTtsEnd);
    socket.on("voice:ttsCancel", onTtsCancel);
    socket.on("voice:stateChange", onStateChange);
    socket.on("voice:error", onVoiceError);
    socket.on("voice:requestLocation", onRequestLocation);
    socket.on("voice:weatherWidget", onWeatherWidget);
    socket.on("voice:restaurantPicker", onRestaurantPicker);
    socket.on("voice:restaurantPickerHide", onRestaurantPickerHide);
    socket.on("voice:reservationProgress", onReservationProgress);
    socket.on("voice:imageAttachAck", onImageAttachAck);
    socket.on("voice:imageRemoved", onImageRemoved);

    return () => {
      socket.off("voice:transcript", onTranscript);
      socket.off("voice:speechStarted", onSpeechStarted);
      socket.off("voice:turnResumed", onTurnResumed);
      socket.off("voice:assistantTranscript", onAssistantTranscript);
      socket.off("voice:ttsWordTimestamps", onTtsWordTimestamps);
      socket.off("voice:ttsStart", onTtsStart);
      socket.off("voice:ttsChunk", onTtsChunk);
      socket.off("voice:ttsEnd", onTtsEnd);
      socket.off("voice:ttsCancel", onTtsCancel);
      socket.off("voice:stateChange", onStateChange);
      socket.off("voice:error", onVoiceError);
      socket.off("voice:requestLocation", onRequestLocation);
      socket.off("voice:weatherWidget", onWeatherWidget);
      socket.off("voice:restaurantPicker", onRestaurantPicker);
      socket.off("voice:restaurantPickerHide", onRestaurantPickerHide);
      socket.off("voice:reservationProgress", onReservationProgress);
      socket.off("voice:imageAttachAck", onImageAttachAck);
      socket.off("voice:imageRemoved", onImageRemoved);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateState, stopSession, reconcileAttachedImages]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopCapture();
      stopAllPlayback();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    ttsWordTimingsRef.current = ttsWordTimings;
  }, [ttsWordTimings]);

  useEffect(() => {
    if (state !== "speaking") {
      setAssistantSpokenWordIndex(-1);
      return;
    }
    let raf = 0;
    const tick = () => {
      const ctx = playbackCtxRef.current;
      const anchor = ttsPlaybackAnchorCtxTimeRef.current;
      const tm = ttsWordTimingsRef.current;
      if (!ctx || anchor == null || !tm?.words.length) {
        setAssistantSpokenWordIndex(-1);
      } else {
        const elapsed = ctx.currentTime - anchor;
        setAssistantSpokenWordIndex(activeWordIndexAtTime(tm, elapsed));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state]);

  const captionMode = useMemo((): VoiceCaptionMode => {
    if (!isSessionActive) return "none";
    if (state === "connecting") return "connecting";
    if (state === "speaking") return "assistant";
    if (state === "thinking") return "user";
    if (state === "listening") {
      // After TTS ends we land in "listening". If the user hasn't spoken yet
      // (no interim STT) and the most recent turn is the assistant's, keep
      // their caption visible instead of snapping back to the user's prior
      // message — that flip looked like a bug.
      if (interimText.trim()) return "user";
      const last = transcriptHistory[transcriptHistory.length - 1];
      if (last?.role === "assistant") return "assistant";
      return "user";
    }
    return "none";
  }, [isSessionActive, state, interimText, transcriptHistory]);

  const captionUserText = useMemo(() => {
    if (captionMode !== "user") return "";
    const live = interimText.trim();
    if (live) return interimText;
    return lastRoleText(transcriptHistory, "user");
  }, [captionMode, interimText, transcriptHistory]);

  const captionAssistantText = useMemo(() => {
    if (captionMode !== "assistant") return "";
    return lastRoleText(transcriptHistory, "assistant");
  }, [captionMode, transcriptHistory]);

  const loadTranscriptFromHistory = useCallback((entries: VoiceTranscriptEntry[]) => {
    setTranscriptHistory(entries);
    pendingUserTranscriptIndexRef.current = null;
    pendingAssistantTranscriptIndexRef.current = null;
  }, []);

  return {
    state,
    interimText,
    finalText,
    transcriptHistory,
    captionMode,
    captionUserText,
    captionAssistantText,
    assistantWordTimings: ttsWordTimings,
    assistantSpokenWordIndex,
    latency,
    error,
    isSessionActive,
    muteMicDuringTts,
    setMuteMicDuringTts: handleSetMuteMicDuringTts,
    startSession,
    stopSession,
    weatherWidget,
    dismissWeatherWidget,
    restaurantPicker,
    dismissRestaurantPicker,
    pickRestaurantFromWidget,
    reservationProgress,
    submitReservationWidgetLine,
    voicePersona,
    setVoicePersona,
    loadTranscriptFromHistory,
    attachedImages,
    isAttachingImage,
    imageAttachError,
    attachImage,
    removeAttachedImage,
    clearAttachedImages,
  };
}

"use client";

import { useEffect, useRef } from "react";
import type { VoiceState } from "@sarjy/shared-types";

interface VoiceOrbProps {
  state: VoiceState;
  onClick: () => void;
  disabled?: boolean;
}

// State → visual config
const STATE_CONFIG = {
  idle: {
    label: "Tap to speak",
    gradient: "radial-gradient(circle at 40% 35%, #312e81, #1e1b4b 60%, #0a0a0f)",
    glow: "0 0 40px 8px rgba(99, 102, 241, 0.25), 0 0 80px 20px rgba(79, 70, 229, 0.1)",
    ringColor: "rgba(99, 102, 241, 0.15)",
    animation: "orb-idle",
  },
  connecting: {
    label: "Connecting STT…",
    gradient: "radial-gradient(circle at 40% 35%, #3730a3, #4f46e5 55%, #312e81 90%)",
    glow: "0 0 50px 12px rgba(129, 140, 248, 0.35), 0 0 100px 28px rgba(99, 102, 241, 0.15)",
    ringColor: "rgba(129, 140, 248, 0.35)",
    animation: "orb-thinking",
  },
  listening: {
    label: "Listening…",
    gradient: "radial-gradient(circle at 40% 35%, #065f46, #0d9488 50%, #0891b2 90%)",
    glow: "0 0 50px 12px rgba(20, 184, 166, 0.35), 0 0 100px 30px rgba(6, 182, 212, 0.15)",
    ringColor: "rgba(20, 184, 166, 0.3)",
    animation: "orb-listening",
  },
  thinking: {
    label: "Thinking…",
    gradient: "radial-gradient(circle at 40% 35%, #4c1d95, #7c3aed 50%, #6d28d9 90%)",
    glow: "0 0 50px 12px rgba(124, 58, 237, 0.4), 0 0 100px 30px rgba(109, 40, 217, 0.2)",
    ringColor: "rgba(124, 58, 237, 0.25)",
    animation: "orb-thinking",
  },
  speaking: {
    label: "Speaking…",
    gradient: "radial-gradient(circle at 40% 35%, #92400e, #d97706 45%, #f59e0b 80%)",
    glow: "0 0 50px 15px rgba(217, 119, 6, 0.4), 0 0 100px 35px rgba(245, 158, 11, 0.2)",
    ringColor: "rgba(245, 158, 11, 0.3)",
    animation: "orb-speaking",
  },
} as const;

export function VoiceOrb({ state, onClick, disabled }: VoiceOrbProps) {
  const orbRef = useRef<HTMLButtonElement>(null);
  const prevStateRef = useRef<VoiceState>(state);

  // Swap animation class when state changes
  useEffect(() => {
    prevStateRef.current = state;
  }, [state]);

  const cfg = STATE_CONFIG[state];

  return (
    <div className="relative flex flex-col items-center gap-8 select-none">
      {/* Outer decorative rings */}
      <div className="relative flex items-center justify-center" style={{ width: 320, height: 320 }}>
        {/* Ring 3 — outermost, slowest */}
        <div
          className="absolute rounded-full pointer-events-none"
          style={{
            width: 310,
            height: 310,
            border: `1px solid ${cfg.ringColor}`,
            animation: state !== "idle" ? "ring-pulse 3s ease-in-out infinite" : undefined,
            opacity: state !== "idle" ? 1 : 0,
            transition: "opacity 0.6s ease, border-color 0.6s ease",
          }}
        />
        {/* Ring 2 */}
        <div
          className="absolute rounded-full pointer-events-none"
          style={{
            width: 260,
            height: 260,
            border: `1px solid ${cfg.ringColor}`,
            animation: state !== "idle" ? "ring-pulse 3s ease-in-out 0.5s infinite" : undefined,
            opacity: state !== "idle" ? 1 : 0,
            transition: "opacity 0.6s ease, border-color 0.6s ease",
          }}
        />
        {/* Ring 1 */}
        <div
          className="absolute rounded-full pointer-events-none"
          style={{
            width: 210,
            height: 210,
            border: `1.5px solid ${cfg.ringColor}`,
            animation: state !== "idle" ? "ring-pulse 3s ease-in-out 1s infinite" : undefined,
            opacity: state !== "idle" ? 1 : 0,
            transition: "opacity 0.6s ease, border-color 0.6s ease",
          }}
        />

        {/* The main orb */}
        <button
          ref={orbRef}
          onClick={onClick}
          disabled={disabled}
          aria-label={cfg.label}
          className="relative z-10 rounded-full outline-none focus-visible:ring-4 focus-visible:ring-white/20 cursor-pointer disabled:cursor-not-allowed"
          style={{
            width: 160,
            height: 160,
            background: cfg.gradient,
            boxShadow: cfg.glow,
            animation: `${cfg.animation} ${
              state === "speaking" ? "0.9s" :
              state === "listening" ? "1.8s" :
              state === "thinking" || state === "connecting" ? "2.4s" :
              "4s"
            } ease-in-out infinite`,
            transition: "background 0.5s ease, box-shadow 0.5s ease",
          }}
        >
          {/* Inner highlight shimmer */}
          <span
            className="absolute inset-0 rounded-full pointer-events-none"
            style={{
              background:
                "radial-gradient(circle at 35% 30%, rgba(255,255,255,0.18) 0%, transparent 60%)",
            }}
          />

          {/* State icon */}
          <span className="absolute inset-0 flex items-center justify-center">
            {state === "idle" && (
              <MicIcon className="w-8 h-8 text-white/60" />
            )}
            {state === "listening" && (
              <MicActiveIcon className="w-8 h-8 text-white/80 animate-pulse" />
            )}
            {(state === "thinking" || state === "connecting") && (
              <ThinkingIcon className="w-8 h-8 text-white/80" style={{ animation: "spin-slow 2s linear infinite" }} />
            )}
            {state === "speaking" && (
              <SoundWaveIcon className="w-8 h-8 text-white/80" />
            )}
          </span>
        </button>
      </div>

      {/* State label */}
      <p
        className="text-sm font-medium tracking-widest uppercase transition-all duration-500"
        style={{
          color:
            state === "listening" ? "rgb(94 234 212)" :
            state === "thinking" || state === "connecting" ? "rgb(165 180 252)" :
            state === "speaking" ? "rgb(251 191 36)" :
            "rgb(148 163 184)",
          letterSpacing: "0.2em",
        }}
      >
        {cfg.label}
      </p>
    </div>
  );
}

// ── Minimal inline SVG icons ──────────────────────────────────────────────

function MicIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
    </svg>
  );
}

function MicActiveIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M8.25 4.5a3.75 3.75 0 1 1 7.5 0v8.25a3.75 3.75 0 1 1-7.5 0V4.5Z" />
      <path d="M6 10.5a.75.75 0 0 1 .75.75v1.5a5.25 5.25 0 1 0 10.5 0v-1.5a.75.75 0 0 1 1.5 0v1.5a6.751 6.751 0 0 1-6 6.709v2.291h3a.75.75 0 0 1 0 1.5h-7.5a.75.75 0 0 1 0-1.5h3v-2.291a6.751 6.751 0 0 1-6-6.709v-1.5A.75.75 0 0 1 6 10.5Z" />
    </svg>
  );
}

function ThinkingIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
    </svg>
  );
}

function SoundWaveIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" d="M3 12h1m16 0h1M6.5 8.5v7M17.5 8.5v7M9.5 6v12M14.5 6v12M12 4v16" />
    </svg>
  );
}

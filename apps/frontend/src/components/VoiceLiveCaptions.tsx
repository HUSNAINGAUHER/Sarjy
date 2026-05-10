"use client";

import type { VoiceCaptionMode, VoiceWordTimings } from "@/hooks/useVoiceAssistant";

interface VoiceLiveCaptionsProps {
  mode: VoiceCaptionMode;
  userText: string;
  assistantText: string;
  wordTimings: VoiceWordTimings | null;
  /** Index into `wordTimings.words` for the word currently being spoken (-1 = none). */
  spokenWordIndex: number;
  isSessionActive: boolean;
  listeningStateLabel?: boolean;
}

const USER_COLOR = "rgb(186, 230, 253)";
const USER_DIM = "rgba(125, 211, 252, 0.45)";
const ASSIST_BASE = "rgb(153, 246, 228)";
const ASSIST_DIM = "rgba(94, 234, 212, 0.42)";
const ASSIST_HOT = "rgb(254, 243, 199)";

/**
 * Single caption lane: user OR assistant (never both). Assistant uses Cartesia word timings when available.
 */
export function VoiceLiveCaptions({
  mode,
  userText,
  assistantText,
  wordTimings,
  spokenWordIndex,
  isSessionActive,
  listeningStateLabel,
}: VoiceLiveCaptionsProps) {
  if (!isSessionActive || mode === "none") {
    return null;
  }

  if (mode === "connecting") {
    return (
      <div
        className="w-full max-w-lg px-4 text-center min-h-[3.5rem] flex flex-col items-center justify-center gap-1"
        aria-live="polite"
        aria-busy="true"
      >
        <p className="text-sm font-medium animate-pulse" style={{ color: "rgb(165, 180, 252)" }}>
          Connecting speech recognition…
        </p>
        <p className="text-[11px] text-slate-500">Opening WebSocket to Deepgram (STT)</p>
      </div>
    );
  }

  if (mode === "user") {
    const show = userText.trim();
    return (
      <div
        className="w-full max-w-lg px-4 text-center min-h-[3.5rem] flex flex-col items-center justify-center"
        aria-live="polite"
      >
        {show ? (
          <p
            className="text-lg sm:text-xl font-medium leading-relaxed tracking-wide"
            style={{ color: USER_COLOR, textShadow: "0 0 24px rgba(56, 189, 248, 0.15)" }}
          >
            {userText}
          </p>
        ) : listeningStateLabel ? (
          <p className="text-sm animate-pulse" style={{ color: USER_DIM }}>
            Say something…
          </p>
        ) : null}
      </div>
    );
  }

  // Assistant speaking
  const plain = assistantText.trim();
  const useWords = wordTimings && wordTimings.words.length > 0;

  return (
    <div
      className="w-full max-w-2xl px-4 text-center min-h-[3.5rem] flex flex-col items-center justify-center"
      aria-live="polite"
    >
      {useWords ? (
        <p className="text-lg sm:text-xl font-medium leading-relaxed tracking-wide">
          {wordTimings.words.map((w, i) => {
            const isHot = i === spokenWordIndex;
            return (
              <span key={`${i}-${w}`}>
                {i > 0 ? " " : null}
                <span
                  style={{
                    color: isHot ? ASSIST_HOT : ASSIST_BASE,
                    fontWeight: isHot ? 600 : 500,
                    textShadow: isHot ? "0 0 20px rgba(251, 191, 36, 0.35)" : "none",
                    transition: "color 80ms ease, font-weight 80ms ease",
                  }}
                >
                  {w}
                </span>
              </span>
            );
          })}
        </p>
      ) : plain ? (
        <p
          className="text-lg sm:text-xl font-medium leading-relaxed tracking-wide"
          style={{ color: ASSIST_BASE, textShadow: "0 0 24px rgba(45, 212, 191, 0.12)" }}
        >
          {assistantText}
        </p>
      ) : (
        <p className="text-sm animate-pulse" style={{ color: ASSIST_DIM }}>
          …
        </p>
      )}
    </div>
  );
}

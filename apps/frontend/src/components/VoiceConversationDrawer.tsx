"use client";

import type { VoiceTranscriptEntry } from "@/hooks/useVoiceAssistant";
import { useEffect, useRef } from "react";

interface VoiceConversationDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transcriptHistory: VoiceTranscriptEntry[];
  interimText: string;
  isSessionActive: boolean;
}

export function VoiceConversationDrawer({
  open,
  onOpenChange,
  transcriptHistory,
  interimText,
  isSessionActive,
}: VoiceConversationDrawerProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [open, transcriptHistory, interimText]);

  const turnCount = transcriptHistory.length + (interimText.trim() ? 1 : 0);

  return (
    <>
      <button
        type="button"
        aria-label={open ? "Close conversation" : "Open conversation"}
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full shadow-lg transition hover:scale-[1.03] active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/60"
        style={{
          background: "linear-gradient(145deg, rgba(30,41,59,0.95), rgba(15,23,42,0.98))",
          border: "1px solid rgba(148,163,184,0.25)",
          color: "rgb(226,232,240)",
        }}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M4 6h16M4 12h10M4 18h14"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
        {isSessionActive && turnCount > 0 ? (
          <span
            className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-semibold"
            style={{
              background: "rgb(45,212,191)",
              color: "rgb(15,23,42)",
              border: "2px solid rgb(15,23,42)",
            }}
          >
            {Math.min(turnCount, 99)}
          </span>
        ) : null}
      </button>

      {open ? (
        <>
          <button
            type="button"
            aria-label="Dismiss overlay"
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]"
            onClick={() => onOpenChange(false)}
          />
          <aside
            className="fixed bottom-0 right-0 z-40 flex max-h-[min(78vh,520px)] w-full max-w-md flex-col rounded-t-2xl border border-white/10 shadow-2xl sm:bottom-24 sm:right-6 sm:max-h-[min(70vh,480px)] sm:rounded-2xl"
            style={{
              background: "linear-gradient(180deg, rgba(22,27,42,0.98) 0%, rgba(12,14,24,0.99) 100%)",
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="voice-conv-title"
          >
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <h2 id="voice-conv-title" className="text-sm font-semibold tracking-wide text-slate-200">
                Conversation
              </h2>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="rounded-lg p-1.5 text-slate-500 transition hover:bg-white/5 hover:text-slate-300"
                aria-label="Close"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
              {transcriptHistory.map((entry, i) => (
                <div
                  key={i}
                  className={`flex flex-col gap-0.5 ${entry.role === "user" ? "items-end" : "items-start"}`}
                >
                  <span className="text-[10px] uppercase tracking-widest text-slate-600">
                    {entry.role === "user" ? "You" : "Sarjy"}
                  </span>
                  <p
                    className="max-w-[95%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed"
                    style={{
                      background:
                        entry.role === "user"
                          ? "rgba(56,189,248,0.12)"
                          : "rgba(45,212,191,0.1)",
                      border:
                        entry.role === "user"
                          ? "1px solid rgba(56,189,248,0.2)"
                          : "1px solid rgba(45,212,191,0.18)",
                      color: entry.role === "user" ? "rgb(224,242,254)" : "rgb(167,243,208)",
                    }}
                  >
                    {entry.text}
                  </p>
                </div>
              ))}
              {interimText.trim() ? (
                <div className="flex flex-col items-center gap-0.5">
                  <span className="text-[10px] uppercase tracking-widest text-slate-600">Listening</span>
                  <p
                    className="w-full rounded-2xl border border-white/10 px-3.5 py-2.5 text-center text-sm italic leading-relaxed text-slate-500"
                    style={{ background: "rgba(255,255,255,0.03)" }}
                  >
                    {interimText}
                  </p>
                </div>
              ) : null}
              {!transcriptHistory.length && !interimText.trim() && isSessionActive ? (
                <p className="py-8 text-center text-sm text-slate-600">No messages yet.</p>
              ) : null}
              {!isSessionActive && !transcriptHistory.length ? (
                <p className="py-8 text-center text-sm text-slate-600">Start the orb to begin.</p>
              ) : null}
              <div ref={endRef} />
            </div>
          </aside>
        </>
      ) : null}
    </>
  );
}

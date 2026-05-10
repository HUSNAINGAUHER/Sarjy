"use client";

import { SessionListDrawer } from "@/components/SessionListDrawer";
import { UserSelectScreen } from "@/components/UserSelectScreen";
import { VoiceConversationDrawer } from "@/components/VoiceConversationDrawer";
import { VoiceImageAttachments } from "@/components/VoiceImageAttachments";
import { VoiceLiveCaptions } from "@/components/VoiceLiveCaptions";
import { VoiceOrb } from "@/components/VoiceOrb";
import { VoiceReservationCollectWidget } from "@/components/VoiceReservationCollectWidget";
import { VoiceReservationProgressPanel } from "@/components/VoiceReservationProgressPanel";
import { VoiceRestaurantPickerWidget } from "@/components/VoiceRestaurantPickerWidget";
import { VoiceWeatherWidget } from "@/components/VoiceWeatherWidget";
import { fetchSessionTranscript, useCurrentUser } from "@/hooks/useCurrentUser";
import { useVoiceAssistant, type UseVoiceAssistantReturn } from "@/hooks/useVoiceAssistant";
import { VOICE_PERSONA_OPTIONS } from "@sarjy/shared-types";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import type { ApiSession } from "@/lib/userApi";

/** LLM start → first audio: D + E + A + B + C (matches server timeline when timing + LLM fields exist). */
function combinedTtfaMs(latency: NonNullable<UseVoiceAssistantReturn["latency"]>): number {
  const t = latency.timing;
  if (!t) return latency.ttfaMs;
  if (t.triggerToTtsConnectStartMs != null) return latency.ttfaMs;
  const a = t.triggerToFetchMs;
  const b = t.fetchToHeadersMs;
  const c = t.headersToFirstChunkMs;
  const hasLlm = latency.llmTtftMs != null || latency.llmPostFirstTokenMs != null;
  if (!hasLlm) return latency.ttfaMs;
  return (latency.llmTtftMs ?? 0) + (latency.llmPostFirstTokenMs ?? 0) + a + b + c;
}

export default function HomePage() {
  const cu = useCurrentUser();
  const voice = useVoiceAssistant({
    userId: cu.user?.id ?? null,
    sessionId: cu.sessionId,
  });

  useEffect(() => {
    if (cu.gate !== "app" || !cu.user?.id || !cu.sessionId) return;
    void fetchSessionTranscript(cu.sessionId, cu.user.id).then(voice.loadTranscriptFromHistory);
  }, [cu.gate, cu.sessionId, cu.user?.id, voice.loadTranscriptFromHistory]);

  const {
    state,
    interimText,
    transcriptHistory,
    captionMode,
    captionUserText,
    captionAssistantText,
    assistantWordTimings,
    assistantSpokenWordIndex,
    latency,
    error,
    isSessionActive,
    muteMicDuringTts,
    setMuteMicDuringTts,
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
    attachedImages,
    isAttachingImage,
    imageAttachError,
    attachImage,
    removeAttachedImage,
    clearAttachedImages,
  } = voice;

  const [conversationOpen, setConversationOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isDraggingImage, setIsDraggingImage] = useState(false);

  const handleOrbClick = useCallback(() => {
    if (isSessionActive) {
      stopSession();
    } else {
      void startSession();
    }
  }, [isSessionActive, startSession, stopSession]);

  const handleSelectSession = useCallback(
    async (session: ApiSession) => {
      if (isSessionActive) stopSession();
      await cu.selectSession(session);
    },
    [cu, isSessionActive, stopSession],
  );

  const handleNewSessionFromDrawer = useCallback(async () => {
    if (isSessionActive) stopSession();
    await cu.startNewChatSession();
  }, [cu, isSessionActive, stopSession]);

  // ── Drag-and-drop image upload (whole-page target) ────────────────────────
  // The browser fires dragenter/over against every nested element when the
  // mouse moves; we only flip the overlay on the first enter and back off
  // on the last leave (counter pattern keeps it stable).
  const dragCounterRef = useRef(0);

  const handleDragEnter = useCallback(
    (e: DragEvent<HTMLElement>) => {
      if (!isSessionActive) return;
      const types = e.dataTransfer?.types;
      if (!types || !Array.from(types).includes("Files")) return;
      e.preventDefault();
      dragCounterRef.current += 1;
      if (dragCounterRef.current === 1) setIsDraggingImage(true);
    },
    [dragCounterRef, isSessionActive],
  );

  const handleDragLeave = useCallback(
    (e: DragEvent<HTMLElement>) => {
      if (!isSessionActive) return;
      e.preventDefault();
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current === 0) setIsDraggingImage(false);
    },
    [dragCounterRef, isSessionActive],
  );

  const handleDragOver = useCallback(
    (e: DragEvent<HTMLElement>) => {
      if (!isSessionActive) return;
      e.preventDefault();
    },
    [isSessionActive],
  );

  const handleDrop = useCallback(
    async (e: DragEvent<HTMLElement>) => {
      if (!isSessionActive) return;
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDraggingImage(false);
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) =>
        f.type.startsWith("image/"),
      );
      for (const file of files) {
        await attachImage(file);
      }
    },
    [attachImage, dragCounterRef, isSessionActive],
  );

  const combinedTtfa = latency ? combinedTtfaMs(latency) : null;

  const showReservationCollectCard =
    reservationProgress != null && reservationProgress.currentStep !== "COLLECTING_RESTAURANT";

  if (cu.gate === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#05050a] text-sm text-slate-500">
        Loading…
      </div>
    );
  }

  if (cu.gate === "onboarding") {
    return (
      <UserSelectScreen
        mode={cu.onboardingMode}
        returningUser={cu.user}
        userList={cu.userList}
        error={cu.error}
        onSubmitNewUser={cu.submitNewUser}
        onContinue={cu.continueLastSession}
        onNewSession={cu.startNewChatSession}
        onSwitchUser={cu.openUserSwitch}
        onPickUser={cu.pickUser}
        onBackFromSwitch={cu.cancelUserSwitch}
      />
    );
  }

  return (
    <main
      className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden"
      style={{ background: "radial-gradient(ellipse at 50% 60%, #0d0d1a 0%, #05050a 70%)" }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <SessionListDrawer
        open={sessionsOpen}
        onOpenChange={setSessionsOpen}
        sessions={cu.sessions}
        currentSessionId={cu.sessionId}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSessionFromDrawer}
      />

      <header className="fixed left-0 right-0 top-0 z-20 flex items-center justify-between gap-2 border-b border-white/5 bg-[#05050a]/80 px-3 py-2 backdrop-blur-md md:px-6">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSessionsOpen(true)}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-white/5"
          >
            Sessions
          </button>
        </div>
        <div className="flex max-w-[60%] items-center gap-2 truncate text-right">
          <span className="truncate text-xs text-slate-500" title={cu.user?.fullName}>
            {cu.user?.fullName}
          </span>
          <button
            type="button"
            onClick={() => {
              if (isSessionActive) stopSession();
              cu.goBackToOnboarding();
            }}
            className="shrink-0 rounded-lg px-2 py-1 text-[10px] uppercase tracking-wide text-slate-600 hover:text-slate-300"
          >
            Account
          </button>
        </div>
      </header>

      {reservationProgress && (
        <div className="pointer-events-none fixed left-3 top-14 z-30 max-h-[calc(100vh-4rem)] overflow-y-auto pr-1 pt-1 md:left-5 md:top-16">
          <VoiceReservationProgressPanel data={reservationProgress} />
        </div>
      )}

      {(weatherWidget ||
        (restaurantPicker && restaurantPicker.options.length > 0) ||
        showReservationCollectCard) && (
        <div className="pointer-events-none fixed right-3 top-14 z-30 flex max-h-[calc(100vh-4rem)] flex-col items-end gap-3 overflow-y-auto pr-1 pt-1 md:right-5 md:top-16">
          {weatherWidget && (
            <VoiceWeatherWidget data={weatherWidget} onDismiss={dismissWeatherWidget} />
          )}
          {restaurantPicker && restaurantPicker.options.length > 0 && (
            <VoiceRestaurantPickerWidget
              options={restaurantPicker.options}
              onPick={pickRestaurantFromWidget}
              onDismiss={dismissRestaurantPicker}
            />
          )}
          {showReservationCollectCard && reservationProgress && (
            <VoiceReservationCollectWidget
              data={reservationProgress}
              onSubmitLine={submitReservationWidgetLine}
            />
          )}
        </div>
      )}

      <VoiceConversationDrawer
        open={conversationOpen}
        onOpenChange={setConversationOpen}
        transcriptHistory={transcriptHistory}
        interimText={interimText}
        isSessionActive={isSessionActive}
      />

      {/* Drag-and-drop image overlay — visible only while a session is active and the user drags files in */}
      {isDraggingImage && (
        <div
          className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center"
          style={{
            background: "rgba(13, 148, 136, 0.08)",
            backdropFilter: "blur(2px)",
          }}
        >
          <div
            className="rounded-2xl px-8 py-6 text-center"
            style={{
              background: "rgba(8, 47, 73, 0.85)",
              border: "1px dashed rgba(45, 212, 191, 0.5)",
              color: "rgb(153, 246, 228)",
              boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
            }}
          >
            <p className="text-base font-semibold tracking-wide">Drop to share with Sarjy</p>
            <p className="mt-1 text-xs text-teal-200/80">JPEG · PNG · WebP · GIF — up to 4 MB each</p>
          </div>
        </div>
      )}

      {/* Ambient background glow */}
      <div
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          background:
            state === "listening"
              ? "radial-gradient(ellipse 600px 400px at 50% 50%, rgba(13, 148, 136, 0.06) 0%, transparent 70%)"
              : state === "connecting"
                ? "radial-gradient(ellipse 600px 400px at 50% 50%, rgba(79, 70, 229, 0.08) 0%, transparent 70%)"
                : state === "thinking"
                  ? "radial-gradient(ellipse 600px 400px at 50% 50%, rgba(124, 58, 237, 0.07) 0%, transparent 70%)"
                  : state === "speaking"
                    ? "radial-gradient(ellipse 600px 400px at 50% 50%, rgba(217, 119, 6, 0.08) 0%, transparent 70%)"
                    : "radial-gradient(ellipse 600px 400px at 50% 50%, rgba(79, 70, 229, 0.04) 0%, transparent 70%)",
          transition: "background 0.8s ease",
        }}
      />

      <div className="relative z-10 mt-14 flex flex-col items-center gap-12 px-6 w-full max-w-lg">
        {/* Header */}
        <div className="text-center">
          <h1
            className="text-3xl font-bold tracking-tight"
            style={{
              background: "linear-gradient(135deg, #e2e8f0 0%, #94a3b8 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            Sarjy
          </h1>
          <p className="mt-1 text-xs text-slate-600 tracking-widest uppercase">
            Echo Voice Assistant
          </p>
        </div>

        {/* Persona — applies when you start the next voice session */}
        <div className="flex w-full max-w-md flex-col gap-2">
          <p className="text-center text-[10px] font-medium uppercase tracking-widest text-slate-600">
            Personality
          </p>
          <div
            className="grid grid-cols-2 gap-2 sm:grid-cols-4"
            role="radiogroup"
            aria-label="Voice assistant personality"
          >
            {VOICE_PERSONA_OPTIONS.map((opt) => {
              const selected = voicePersona === opt.id;
              const disabled = isSessionActive;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={disabled}
                  title={opt.hint}
                  onClick={() => setVoicePersona(opt.id)}
                  className="rounded-xl px-2 py-2.5 text-center text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40"
                  style={{
                    background: selected
                      ? "rgba(45,212,191,0.12)"
                      : "rgba(255,255,255,0.04)",
                    border: selected
                      ? "1px solid rgba(45,212,191,0.35)"
                      : "1px solid rgba(255,255,255,0.08)",
                    color: selected ? "rgb(153,246,228)" : "rgb(148,163,184)",
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          {isSessionActive && (
            <p className="text-center text-[10px] text-slate-600">
              Stop voice to switch personality
            </p>
          )}
        </div>

        {/* Orb */}
        <VoiceOrb state={state} onClick={handleOrbClick} />

        {/* Image attachments — only meaningful while session is active */}
        <VoiceImageAttachments
          attachedImages={attachedImages}
          isAttachingImage={isAttachingImage}
          imageAttachError={imageAttachError}
          isSessionActive={isSessionActive}
          onAttach={attachImage}
          onRemove={removeAttachedImage}
          onClearAll={clearAttachedImages}
        />

        {/* Single-line live captions: user OR assistant (opens full log via floating button) */}
        <VoiceLiveCaptions
          mode={captionMode}
          userText={captionUserText}
          assistantText={captionAssistantText}
          wordTimings={assistantWordTimings}
          spokenWordIndex={assistantSpokenWordIndex}
          isSessionActive={isSessionActive}
          listeningStateLabel={state === "listening"}
        />

        {/* Compact TTFA pill (always visible during a session) — full breakdown lives in Settings */}
        {latency && (
          <div className="animate-fade-up flex items-center gap-2">
            <div
              className="flex gap-3 rounded-full px-4 py-1.5 text-xs font-mono"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                color: "rgb(100,116,139)",
              }}
            >
              <span title="First audio − Flux trigger (server)">
                TTFA{" "}
                <span
                  style={{
                    color:
                      combinedTtfa! < 900
                        ? "rgb(52,211,153)"
                        : combinedTtfa! < 1600
                          ? "rgb(251,191,36)"
                          : "rgb(248,113,113)",
                  }}
                >
                  {combinedTtfa}ms
                </span>
              </span>
              <span className="text-slate-700">|</span>
              <span title="Flux turn → last TTS byte (full reply)">
                Total <span className="text-slate-400">{latency.totalMs}ms</span>
              </span>
              {latency.llmTtftMs != null && (
                <>
                  <span className="text-slate-700">|</span>
                  <span title="LLM time to first token (model TTFT). When a tool fired this is max(pass1, pass2) — see Settings for D and D₂.">
                    TTFT{" "}
                    <span
                      style={{
                        color:
                          latency.llmTtftMs < 350
                            ? "rgb(52,211,153)"
                            : latency.llmTtftMs < 700
                              ? "rgb(251,191,36)"
                              : "rgb(248,113,113)",
                      }}
                    >
                      {latency.llmTtftMs}ms
                    </span>
                  </span>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => setSettingsOpen((v) => !v)}
              aria-label="Toggle settings"
              aria-pressed={settingsOpen}
              className="flex h-7 w-7 items-center justify-center rounded-full text-slate-500 transition hover:bg-white/5 hover:text-slate-300"
              title="Settings — detailed timing, mic & echo"
              style={{
                border: "1px solid rgba(255,255,255,0.08)",
                background: settingsOpen ? "rgba(255,255,255,0.06)" : "transparent",
              }}
            >
              {/* gear icon */}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
        )}

        {/* Settings popover (latency breakdown + mic toggles) */}
        {settingsOpen && latency && (
          <div
            className="animate-fade-up flex flex-col items-center gap-2"
          >
            {/* Per-stage breakdown */}
            {latency.timing && (
              <div
                className="flex flex-col gap-1 rounded-xl px-4 py-2 text-xs font-mono w-full"
                style={{
                  background: "rgba(255,255,255,0.02)",
                  border: "1px solid rgba(255,255,255,0.05)",
                  color: "rgb(71,85,105)",
                }}
              >
                {latency.timing.triggerToTtsConnectStartMs != null && (
                  <>
                    <div className="flex justify-between gap-6">
                      <span title="How long this turn waited for TTS WS — 0 ms when session WS is warm">
                        B  TTS WS wait{" "}
                        <span className="text-slate-600 text-[10px]">
                          {(latency.timing.ttsWsWaitMs ?? latency.timing.ttsConnectMs ?? 0) === 0
                            ? "(warm ✓)"
                            : `(cold, connect=${latency.timing.ttsConnectMs}ms)`}
                        </span>
                      </span>
                      <span
                        style={{
                          color:
                            (latency.timing.ttsWsWaitMs ?? latency.timing.ttsConnectMs ?? 0) < 50
                              ? "rgb(52,211,153)"
                              : (latency.timing.ttsWsWaitMs ?? latency.timing.ttsConnectMs ?? 0) < 300
                                ? "rgb(251,191,36)"
                                : "rgb(248,113,113)",
                        }}
                      >
                        {latency.timing.ttsWsWaitMs ?? latency.timing.ttsConnectMs}ms
                      </span>
                    </div>
                    {latency.timing.ttsReadyToLlmStartMs != null && (
                      <div className="flex justify-between gap-6">
                        <span
                          title="Flux trigger → pipeline ready for LLM stage (Cartesia context open). Does not include memory work below."
                        >
                          C  TTS ready → LLM stage
                        </span>
                        <span className="text-slate-500">{latency.timing.ttsReadyToLlmStartMs}ms</span>
                      </div>
                    )}
                    {latency.timing.contextPrepMs != null && (
                      <div className="flex justify-between gap-6">
                        <span
                          title="Wall clock for Promise.all([memory, workflow]) before streamText. ≈ max(memory, workflow) + small overhead. Not shown separately: LLM tool round-trip (second pass) after &lt;tool&gt; blocks."
                        >
                          H  Prep (memory ∥ workflow wall)
                        </span>
                        <span
                          style={{
                            color:
                              latency.timing.contextPrepMs < 120
                                ? "rgb(52,211,153)"
                                : latency.timing.contextPrepMs < 400
                                  ? "rgb(251,191,36)"
                                  : "rgb(248,113,113)",
                          }}
                        >
                          {latency.timing.contextPrepMs}ms
                        </span>
                      </div>
                    )}
                    {latency.timing.memoryPrepMs != null && (
                      <div className="flex justify-between gap-6 pl-2">
                        <span
                          className="text-[10px] text-slate-600"
                          title="Direct memory fetch only"
                        >
                          Hm  Memory branch
                        </span>
                        <span className="text-slate-500">{latency.timing.memoryPrepMs}ms</span>
                      </div>
                    )}
                    {latency.timing.workflowOrchestrationMs != null && (
                      <div className="flex justify-between gap-6 pl-2">
                        <span
                          className="text-[10px] text-slate-600"
                          title="Workflow orchestrator (intent + slots + FSM); no awaited tool I/O here"
                        >
                          Hw  Workflow branch
                        </span>
                        <span className="text-slate-500">{latency.timing.workflowOrchestrationMs}ms</span>
                      </div>
                    )}
                    {latency.timing.workflowIntent != null && (
                      <div className="flex justify-between gap-6 border-t border-white/5 pt-1 mt-1">
                        <span className="text-[10px] text-slate-600" title="In-workflow FSM escape (cancel/confirm); absent in general mode">
                          Workflow escape
                        </span>
                        <span className="text-right text-[10px] text-slate-400 max-w-[200px] truncate" title={latency.timing.workflowIntent}>
                          {latency.timing.workflowIntent}
                          {latency.timing.workflowIntentConfidence
                            ? ` (${latency.timing.workflowIntentConfidence})`
                            : ""}
                        </span>
                      </div>
                    )}
                    {latency.timing.llmRoutingTag != null && (
                      <div className="flex justify-between gap-6 border-t border-white/5 pt-1 mt-1">
                        <span className="text-[10px] text-slate-600" title="First-line tag emitted by LLM (general mode only)">
                          LLM tag
                        </span>
                        <span className={`text-right text-[10px] font-medium max-w-[200px] truncate ${latency.timing.llmRoutingTag === "RESERVATION" ? "text-emerald-400" : "text-sky-400"}`}>
                          [{latency.timing.llmRoutingTag}]
                        </span>
                      </div>
                    )}
                    {latency.timing.workflowStep != null && (
                      <div className="flex justify-between gap-6">
                        <span className="text-[10px] text-slate-600">Workflow step</span>
                        <span className="text-[10px] text-slate-500">
                          {latency.timing.workflowStep}
                          {latency.timing.workflowActive ? "" : " (inactive)"}
                        </span>
                      </div>
                    )}
                  </>
                )}
                {latency.llmTtftMs != null && (
                  <div className="flex justify-between gap-6">
                    <span>D  LLM first token (TTFT)</span>
                    <span
                      style={{
                        color:
                          latency.llmTtftMs < 350
                            ? "rgb(52,211,153)"
                            : latency.llmTtftMs < 700
                              ? "rgb(251,191,36)"
                              : "rgb(248,113,113)",
                      }}
                    >
                      {latency.llmTtftMs}ms
                    </span>
                  </div>
                )}
                {latency.llmPostFirstTokenMs != null && (
                  <div className="flex justify-between gap-6">
                    <span>E  First token → first segment</span>
                    <span className="text-slate-500">{latency.llmPostFirstTokenMs}ms</span>
                  </div>
                )}
                {latency.timing?.toolExecMs != null && (
                  <div className="flex justify-between gap-6">
                    <span title="Wall time for tool execution between LLM pass 1 and pass 2.">
                      T  Tool exec
                      {latency.timing.toolName ? (
                        <span className="text-[10px] text-slate-600 ml-1">({latency.timing.toolName})</span>
                      ) : null}
                    </span>
                    <span className="text-slate-500">{latency.timing.toolExecMs}ms</span>
                  </div>
                )}
                {latency.timing?.pass2LlmTtftMs != null && (
                  <div className="flex justify-between gap-6">
                    <span title="TTFT for the second LLM pass (continuation after a tool returned).">D₂  LLM pass 2 TTFT</span>
                    <span
                      style={{
                        color:
                          latency.timing.pass2LlmTtftMs < 350
                            ? "rgb(52,211,153)"
                            : latency.timing.pass2LlmTtftMs < 700
                              ? "rgb(251,191,36)"
                              : "rgb(248,113,113)",
                      }}
                    >
                      {latency.timing.pass2LlmTtftMs}ms
                    </span>
                  </div>
                )}
                {latency.timing.firstSegmentToFirstAudioMs != null ? (
                  <>
                    <div className="flex justify-between gap-6">
                      <span>F  First segment → first audio</span>
                      <span
                        style={{
                          color:
                            latency.timing.firstSegmentToFirstAudioMs < 300
                              ? "rgb(52,211,153)"
                              : latency.timing.firstSegmentToFirstAudioMs < 700
                                ? "rgb(251,191,36)"
                                : "rgb(248,113,113)",
                        }}
                      >
                        {latency.timing.firstSegmentToFirstAudioMs}ms
                      </span>
                    </div>
                    {latency.timing.firstAudioToTtsDoneMs != null && (
                      <div className="flex justify-between gap-6">
                        <span>G  First audio → done</span>
                        <span className="text-slate-500">{latency.timing.firstAudioToTtsDoneMs}ms</span>
                      </div>
                    )}
                    {latency.timing.audioRealtimeRatio != null && (
                      <div className="flex justify-between gap-6">
                        <span>Audio realtime ratio</span>
                        <span className="text-slate-500">{latency.timing.audioRealtimeRatio}x</span>
                      </div>
                    )}
                    {latency.timing.maxInterChunkGapMs != null && (
                      <div className="flex justify-between gap-6">
                        <span>Max chunk gap</span>
                        <span className="text-slate-500">{latency.timing.maxInterChunkGapMs}ms</span>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="flex justify-between gap-6">
                      <span>A  JS overhead</span>
                      <span className="text-slate-500">{latency.timing.triggerToFetchMs}ms</span>
                    </div>
                    <div className="flex justify-between gap-6">
                      <span>B  TCP · TLS · transit</span>
                      <span
                        style={{
                          color:
                            latency.timing.fetchToHeadersMs < 150
                              ? "rgb(52,211,153)"
                              : latency.timing.fetchToHeadersMs < 300
                                ? "rgb(251,191,36)"
                                : "rgb(248,113,113)",
                        }}
                      >
                        {latency.timing.fetchToHeadersMs}ms
                      </span>
                    </div>
                    <div className="flex justify-between gap-6">
                      <span>C  TTS first byte</span>
                      <span
                        style={{
                          color:
                            latency.timing.headersToFirstChunkMs < 300
                              ? "rgb(52,211,153)"
                              : latency.timing.headersToFirstChunkMs < 600
                                ? "rgb(251,191,36)"
                                : "rgb(248,113,113)",
                        }}
                      >
                        {latency.timing.headersToFirstChunkMs}ms
                      </span>
                    </div>
                  </>
                )}
                <div
                  className="mt-1 flex justify-between gap-6 border-t border-white/5 pt-1 text-slate-400"
                  title="Server wall TTFA (first audio − Flux trigger). WebSocket path: ≈ C+H+D+E+F when B=0; D is TTFT only after streamText, so H was previously hidden."
                >
                  <span>Σ  TTFA</span>
                  <span className="text-slate-300">{combinedTtfa}ms</span>
                </div>
              </div>
            )}

            {/* Mic mode toggle (lives inside Settings) */}
            <div
              className="flex items-center justify-between gap-3 w-full rounded-xl px-4 py-2.5 text-xs"
              style={{
                background: "rgba(255,255,255,0.02)",
                border: "1px solid rgba(255,255,255,0.05)",
              }}
            >
              <span className="text-slate-400 select-none">Echo cancel</span>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-slate-600 select-none">off</span>
                <button
                  onClick={() => setMuteMicDuringTts(!muteMicDuringTts)}
                  aria-pressed={muteMicDuringTts}
                  className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors duration-200 focus:outline-none"
                  style={{
                    background: muteMicDuringTts
                      ? "rgba(20,184,166,0.7)"
                      : "rgba(255,255,255,0.1)",
                    border: "1px solid rgba(255,255,255,0.1)",
                  }}
                >
                  <span
                    className="pointer-events-none inline-block h-4 w-4 rounded-full shadow transition-transform duration-200"
                    style={{
                      background: "rgb(226,232,240)",
                      transform: muteMicDuringTts ? "translateX(16px)" : "translateX(1px)",
                      marginTop: "1px",
                    }}
                  />
                </button>
                <span className="text-[10px] text-slate-400 select-none">mute mic</span>
              </div>
            </div>
            <p className="text-[10px] text-slate-600 px-1 leading-snug max-w-[260px] text-center">
              Mute mic during TTS prevents speaker bleed from triggering false STT turns. Turn off only if you have hardware echo cancellation.
            </p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div
            className="animate-fade-up rounded-xl px-5 py-3 text-sm text-center max-w-sm"
            style={{
              background: "rgba(239,68,68,0.08)",
              border: "1px solid rgba(239,68,68,0.2)",
              color: "rgb(252,165,165)",
            }}
          >
            {error}
          </div>
        )}

        {/* Hint */}
        {!isSessionActive && !error && (
          <p className="text-xs text-slate-700 text-center">
            Tap the orb to start · speak · hear yourself echoed back
          </p>
        )}
      </div>
    </main>
  );
}

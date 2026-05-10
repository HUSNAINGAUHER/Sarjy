"use client";

import type { VoiceWeatherWidgetPayload } from "@sarjy/shared-types";

interface VoiceWeatherWidgetProps {
  data: VoiceWeatherWidgetPayload;
  onDismiss: () => void;
}

export function VoiceWeatherWidget({ data, onDismiss }: VoiceWeatherWidgetProps) {
  const temp =
    data.temperatureC != null ? `${Math.round(data.temperatureC)}°` : "—";
  const feels =
    data.feelsLikeC != null ? `${Math.round(data.feelsLikeC)}°` : null;

  return (
    <div
      className="animate-fade-up pointer-events-auto z-30 w-[min(100vw-2rem,280px)] rounded-2xl p-4 shadow-xl backdrop-blur-md"
      style={{
        background: "linear-gradient(145deg, rgba(15,23,42,0.92) 0%, rgba(30,41,59,0.88) 100%)",
        border: "1px solid rgba(94,234,212,0.25)",
        boxShadow: "0 12px 40px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.04) inset",
      }}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-teal-400/90">Weather</p>
          <p className="mt-0.5 text-sm font-medium leading-snug text-slate-100">{data.placeLabel}</p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded-lg px-2 py-1 text-xs text-slate-500 transition hover:bg-white/5 hover:text-slate-300"
          aria-label="Dismiss weather"
        >
          ✕
        </button>
      </div>
      <p className="mt-2 text-lg font-semibold capitalize text-slate-50">{data.condition}</p>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-3xl font-light tracking-tight text-white">{temp}</span>
        {feels && <span className="text-xs text-slate-500">Feels {feels}</span>}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs text-slate-400">
        {data.humidityPct != null && (
          <>
            <dt>Humidity</dt>
            <dd className="text-right text-slate-300">{Math.round(data.humidityPct)}%</dd>
          </>
        )}
        {data.windSummary && (
          <>
            <dt className="col-span-2 pt-1 text-slate-500">Wind</dt>
            <dd className="col-span-2 text-slate-300">{data.windSummary}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

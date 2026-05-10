"use client";

import type { VoiceRestaurantPickerOption } from "@sarjy/shared-types";

interface VoiceRestaurantPickerWidgetProps {
  options: VoiceRestaurantPickerOption[];
  onPick: (restaurantId: string) => void;
  onDismiss: () => void;
}

export function VoiceRestaurantPickerWidget({ options, onPick, onDismiss }: VoiceRestaurantPickerWidgetProps) {
  if (!options.length) return null;

  return (
    <div
      className="animate-fade-up pointer-events-auto z-30 w-[min(100vw-2rem,300px)] rounded-2xl p-4 shadow-xl backdrop-blur-md"
      style={{
        background: "linear-gradient(145deg, rgba(15,23,42,0.95) 0%, rgba(30,27,75,0.9) 100%)",
        border: "1px solid rgba(167,139,250,0.35)",
        boxShadow: "0 16px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05) inset",
      }}
      role="dialog"
      aria-label="Choose a restaurant"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-violet-300/90">Pick a place</p>
          <p className="mt-0.5 text-sm font-medium text-slate-100">Tap one or say the name</p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded-lg px-2 py-1 text-xs text-slate-500 transition hover:bg-white/5 hover:text-slate-300"
          aria-label="Hide suggestions"
        >
          ✕
        </button>
      </div>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {options.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => onPick(r.id)}
              className="flex w-full flex-col rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-left transition hover:border-violet-400/40 hover:bg-violet-500/10"
            >
              <span className="text-sm font-semibold text-slate-50">{r.name}</span>
              <span className="text-[11px] text-slate-400">
                {r.cuisine} · {r.area}
              </span>
              <span className="mt-1 text-[10px] text-amber-200/90">★ {r.rating.toFixed(1)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

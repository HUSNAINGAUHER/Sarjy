"use client";

import type { VoiceReservationProgressPayload } from "@sarjy/shared-types";

function formatIsoDate(iso: string | null): string | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(y!, m! - 1, d!);
  if (Number.isNaN(dt.getTime())) return iso;
  return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function formatTime(hhmm: string | null): string | null {
  if (!hhmm) return null;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return hhmm;
  let h = parseInt(m[1]!, 10);
  const min = m[2]!;
  const ap = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${min} ${ap}`;
}

const SLOT_ORDER: Array<{ key: keyof VoiceReservationProgressPayload["slots"]; label: string }> = [
  { key: "restaurant", label: "Restaurant" },
  { key: "date", label: "Date" },
  { key: "time", label: "Time" },
  { key: "partySize", label: "Party" },
  { key: "seatingPreference", label: "Seating" },
  { key: "phoneNumber", label: "Phone" },
];

const REQUIRED_KEYS: Array<keyof VoiceReservationProgressPayload["slots"]> = [
  "restaurant",
  "date",
  "time",
  "partySize",
  "phoneNumber",
];

function displayValue(
  key: keyof VoiceReservationProgressPayload["slots"],
  slots: VoiceReservationProgressPayload["slots"],
): string | null {
  const v = slots[key];
  if (key === "partySize") {
    return slots.partySize != null ? `${slots.partySize} guests` : null;
  }
  if (v === null || v === undefined || v === "") return null;
  if (key === "date") return formatIsoDate(slots.date);
  if (key === "time") return formatTime(slots.time);
  return String(v);
}

function pendingLabels(data: VoiceReservationProgressPayload): string[] {
  const { currentStep, slots, pendingConfirmation } = data;
  if (currentStep === "CONFIRMING" && pendingConfirmation) {
    return ["Your go-ahead to book"];
  }
  if (currentStep === "CALLING_TOOL") {
    return ["Completing booking…"];
  }
  const need: string[] = [];
  for (const k of REQUIRED_KEYS) {
    if (k === "partySize") {
      if (slots.partySize === null || slots.partySize === undefined) {
        need.push(SLOT_ORDER.find((s) => s.key === k)!.label);
      }
      continue;
    }
    const v = slots[k];
    if (v === null || v === undefined || v === "") {
      need.push(SLOT_ORDER.find((s) => s.key === k)!.label);
    }
  }
  if (currentStep === "COLLECTING_SEATING" && !slots.seatingPreference) {
    need.push("Seating (optional)");
  }
  return need;
}

function confirmedRows(data: VoiceReservationProgressPayload): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  for (const { key, label } of SLOT_ORDER) {
    const disp = displayValue(key, data.slots);
    if (disp) rows.push({ label, value: disp });
  }
  return rows;
}

function stepLabel(step: string): string {
  const map: Record<string, string> = {
    COLLECTING_RESTAURANT: "Restaurant",
    COLLECTING_DATE: "Date",
    COLLECTING_TIME: "Time",
    COLLECTING_PARTY_SIZE: "Party size",
    COLLECTING_SEATING: "Seating",
    COLLECTING_PHONE: "Phone",
    CONFIRMING: "Confirm",
    CALLING_TOOL: "Booking",
  };
  return map[step] ?? step;
}

interface VoiceReservationProgressPanelProps {
  data: VoiceReservationProgressPayload;
}

export function VoiceReservationProgressPanel({ data }: VoiceReservationProgressPanelProps) {
  const confirmed = confirmedRows(data);
  const pending = pendingLabels(data);

  return (
    <div
      className="animate-fade-up pointer-events-auto z-30 w-[min(100vw-2rem,280px)] rounded-2xl p-4 shadow-xl backdrop-blur-md"
      style={{
        background: "linear-gradient(145deg, rgba(15,23,42,0.95) 0%, rgba(15,30,42,0.92) 100%)",
        border: "1px solid rgba(56,189,248,0.35)",
        boxShadow: "0 16px 48px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.05) inset",
      }}
      role="region"
      aria-label="Reservation progress"
    >
      <p className="text-[10px] font-semibold uppercase tracking-widest text-sky-300/90">Reservation</p>
      <p className="mt-1 text-xs text-slate-400">
        Step: <span className="font-medium text-slate-200">{stepLabel(data.currentStep)}</span>
      </p>

      <div className="mt-4 border-t border-white/10 pt-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400/90">Confirmed</p>
        {confirmed.length === 0 ? (
          <p className="mt-1.5 text-xs text-slate-500">Nothing saved yet — speak or use the panel on the right.</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {confirmed.map((row) => (
              <li key={row.label} className="flex justify-between gap-2 text-xs">
                <span className="text-slate-500">{row.label}</span>
                <span className="max-w-[60%] truncate text-right text-slate-100">{row.value}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-4 border-t border-white/10 pt-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-300/90">Still needed</p>
        {pending.length === 0 ? (
          <p className="mt-1.5 text-xs text-slate-500">All set for this step.</p>
        ) : (
          <ul className="mt-2 list-inside list-disc text-xs text-slate-300">
            {pending.map((p) => (
              <li key={p} className="marker:text-amber-400/80">
                {p}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

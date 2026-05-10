"use client";

import type { VoiceReservationProgressPayload } from "@sarjy/shared-types";
import { useState } from "react";

function localIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

const TIME_CHIPS: { label: string; utterance: string }[] = [
  { label: "12:00 PM", utterance: "Noon, 12 pm please." },
  { label: "1:00 PM", utterance: "1 pm please." },
  { label: "6:00 PM", utterance: "6 pm please." },
  { label: "6:30 PM", utterance: "6:30 pm please." },
  { label: "7:00 PM", utterance: "7 pm please." },
  { label: "7:30 PM", utterance: "7:30 pm please." },
  { label: "8:00 PM", utterance: "8 pm please." },
];

const CHANGE_CHIPS: { label: string; utterance: string; slot: string }[] = [
  { label: "Restaurant", utterance: "I'd like to change the restaurant.", slot: "restaurant" },
  { label: "Date", utterance: "I'd like to change the date.", slot: "date" },
  { label: "Time", utterance: "I'd like to change the time.", slot: "time" },
  { label: "Party size", utterance: "I'd like to change the number of people.", slot: "partySize" },
  { label: "Phone", utterance: "I'd like to change the phone number.", slot: "phone" },
  { label: "Seating", utterance: "I'd like to change the seating preference.", slot: "seating" },
];

interface VoiceReservationCollectWidgetProps {
  data: VoiceReservationProgressPayload;
  onSubmitLine: (text: string) => void;
}

export function VoiceReservationCollectWidget({ data, onSubmitLine }: VoiceReservationCollectWidgetProps) {
  const { currentStep } = data;
  const [dateVal, setDateVal] = useState("");
  const [phoneVal, setPhoneVal] = useState("");

  if (currentStep === "COLLECTING_RESTAURANT") {
    return null;
  }

  if (currentStep === "CALLING_TOOL") {
    return (
      <div
        className="animate-fade-up pointer-events-auto z-30 w-[min(100vw-2rem,300px)] rounded-2xl p-4 text-center shadow-xl backdrop-blur-md"
        style={{
          background: "linear-gradient(145deg, rgba(15,23,42,0.95) 0%, rgba(30,27,75,0.9) 100%)",
          border: "1px solid rgba(167,139,250,0.35)",
        }}
      >
        <p className="text-[10px] font-semibold uppercase tracking-widest text-violet-300/90">Booking</p>
        <p className="mt-2 text-sm text-slate-200">Placing your reservation…</p>
      </div>
    );
  }

  if (currentStep === "COLLECTING_DATE") {
    const today = new Date();
    const chips = [
      { label: "Today", iso: localIsoDate(today) },
      { label: "Tomorrow", iso: localIsoDate(addDays(today, 1)) },
      { label: "+2 days", iso: localIsoDate(addDays(today, 2)) },
    ];
    return (
      <div
        className="animate-fade-up pointer-events-auto z-30 w-[min(100vw-2rem,300px)] rounded-2xl p-4 shadow-xl backdrop-blur-md"
        style={{
          background: "linear-gradient(145deg, rgba(15,23,42,0.95) 0%, rgba(30,27,75,0.9) 100%)",
          border: "1px solid rgba(167,139,250,0.35)",
        }}
      >
        <p className="text-[10px] font-semibold uppercase tracking-widest text-violet-300/90">Date</p>
        <p className="mt-0.5 text-sm font-medium text-slate-100">Pick or type a date</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {chips.map((c) => (
            <button
              key={c.label}
              type="button"
              onClick={() => onSubmitLine(`Let's book for ${c.iso}.`)}
              className="rounded-lg border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-slate-100 transition hover:border-violet-400/40 hover:bg-violet-500/15"
            >
              {c.label}
            </button>
          ))}
        </div>
        <label className="mt-4 block text-[10px] uppercase tracking-wider text-slate-500">Calendar</label>
        <div className="mt-1 flex gap-2">
          <input
            type="date"
            value={dateVal}
            onChange={(e) => setDateVal(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-slate-100"
          />
          <button
            type="button"
            disabled={!dateVal}
            onClick={() => {
              onSubmitLine(`I'd like ${dateVal} for the reservation.`);
              setDateVal("");
            }}
            className="shrink-0 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            Use
          </button>
        </div>
      </div>
    );
  }

  if (currentStep === "COLLECTING_TIME") {
    return (
      <div
        className="animate-fade-up pointer-events-auto z-30 w-[min(100vw-2rem,300px)] rounded-2xl p-4 shadow-xl backdrop-blur-md"
        style={{
          background: "linear-gradient(145deg, rgba(15,23,42,0.95) 0%, rgba(30,27,75,0.9) 100%)",
          border: "1px solid rgba(167,139,250,0.35)",
        }}
      >
        <p className="text-[10px] font-semibold uppercase tracking-widest text-violet-300/90">Time</p>
        <p className="mt-0.5 text-sm font-medium text-slate-100">Common times</p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {TIME_CHIPS.map((t) => (
            <button
              key={t.label}
              type="button"
              onClick={() => onSubmitLine(t.utterance)}
              className="rounded-lg border border-white/10 bg-white/[0.06] px-2 py-2 text-xs font-medium text-slate-100 transition hover:border-violet-400/40 hover:bg-violet-500/15"
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (currentStep === "COLLECTING_PARTY_SIZE") {
    const sizes = [2, 3, 4, 5, 6, 8, 10];
    return (
      <div
        className="animate-fade-up pointer-events-auto z-30 w-[min(100vw-2rem,300px)] rounded-2xl p-4 shadow-xl backdrop-blur-md"
        style={{
          background: "linear-gradient(145deg, rgba(15,23,42,0.95) 0%, rgba(30,27,75,0.9) 100%)",
          border: "1px solid rgba(167,139,250,0.35)",
        }}
      >
        <p className="text-[10px] font-semibold uppercase tracking-widest text-violet-300/90">Guests</p>
        <p className="mt-0.5 text-sm font-medium text-slate-100">How many people?</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {sizes.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onSubmitLine(`Party of ${n} please.`)}
              className="rounded-lg border border-white/10 bg-white/[0.06] px-3 py-2 text-xs font-semibold text-slate-100 transition hover:border-violet-400/40 hover:bg-violet-500/15"
            >
              {n}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (currentStep === "COLLECTING_SEATING") {
    const opts = [
      { label: "Indoor", line: "Indoor seating please." },
      { label: "Outdoor", line: "Outdoor seating please." },
      { label: "Booth", line: "A booth please." },
      { label: "No preference", line: "No seating preference." },
    ];
    return (
      <div
        className="animate-fade-up pointer-events-auto z-30 w-[min(100vw-2rem,300px)] rounded-2xl p-4 shadow-xl backdrop-blur-md"
        style={{
          background: "linear-gradient(145deg, rgba(15,23,42,0.95) 0%, rgba(30,27,75,0.9) 100%)",
          border: "1px solid rgba(167,139,250,0.35)",
        }}
      >
        <p className="text-[10px] font-semibold uppercase tracking-widest text-violet-300/90">Seating</p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {opts.map((o) => (
            <button
              key={o.label}
              type="button"
              onClick={() => onSubmitLine(o.line)}
              className="rounded-lg border border-white/10 bg-white/[0.06] px-2 py-2.5 text-xs font-medium text-slate-100 transition hover:border-violet-400/40 hover:bg-violet-500/15"
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (currentStep === "COLLECTING_PHONE") {
    return (
      <div
        className="animate-fade-up pointer-events-auto z-30 w-[min(100vw-2rem,300px)] rounded-2xl p-4 shadow-xl backdrop-blur-md"
        style={{
          background: "linear-gradient(145deg, rgba(15,23,42,0.95) 0%, rgba(30,27,75,0.9) 100%)",
          border: "1px solid rgba(167,139,250,0.35)",
        }}
      >
        <p className="text-[10px] font-semibold uppercase tracking-widest text-violet-300/90">Phone</p>
        <p className="mt-0.5 text-sm font-medium text-slate-100">Number for the booking</p>
        <div className="mt-3 flex gap-2">
          <input
            type="tel"
            value={phoneVal}
            onChange={(e) => setPhoneVal(e.target.value)}
            placeholder="555-0100"
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-600"
          />
          <button
            type="button"
            disabled={phoneVal.replace(/\D/g, "").length < 7}
            onClick={() => {
              onSubmitLine(`My phone number is ${phoneVal.trim()}.`);
              setPhoneVal("");
            }}
            className="shrink-0 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    );
  }

  if (currentStep === "CONFIRMING") {
    return <ConfirmingPanel onSubmitLine={onSubmitLine} />;
  }

  return null;
}

function ConfirmingPanel({ onSubmitLine }: { onSubmitLine: (line: string) => void }) {
  const [showChangeMenu, setShowChangeMenu] = useState(false);
  return (
    <div
      className="animate-fade-up pointer-events-auto z-30 w-[min(100vw-2rem,300px)] rounded-2xl p-4 shadow-xl backdrop-blur-md"
      style={{
        background: "linear-gradient(145deg, rgba(15,23,42,0.95) 0%, rgba(30,27,75,0.9) 100%)",
        border: "1px solid rgba(167,139,250,0.35)",
      }}
    >
      <p className="text-[10px] font-semibold uppercase tracking-widest text-violet-300/90">Confirm</p>
      {!showChangeMenu ? (
        <>
          <p className="mt-1 text-sm text-slate-200">Ready to book?</p>
          <div className="mt-4 flex flex-col gap-2">
            <button
              type="button"
              onClick={() => onSubmitLine("Yes, please go ahead and book it.")}
              className="rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500"
            >
              Yes, book it
            </button>
            <button
              type="button"
              onClick={() => setShowChangeMenu(true)}
              className="rounded-xl border border-white/15 py-2 text-xs font-medium text-slate-300 transition hover:bg-white/5"
            >
              Change a detail
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-1 text-sm text-slate-200">Which detail?</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {CHANGE_CHIPS.map((c) => (
              <button
                key={c.slot}
                type="button"
                onClick={() => {
                  setShowChangeMenu(false);
                  onSubmitLine(c.utterance);
                }}
                className="rounded-lg border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-slate-100 transition hover:border-violet-400/40 hover:bg-violet-500/15"
              >
                {c.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setShowChangeMenu(false)}
            className="mt-3 text-[10px] text-slate-500 hover:text-slate-300"
          >
            ← Back
          </button>
        </>
      )}
    </div>
  );
}

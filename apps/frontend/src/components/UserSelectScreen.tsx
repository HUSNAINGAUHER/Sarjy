"use client";

import type { OnboardingMode } from "@/hooks/useCurrentUser";
import type { ApiUser } from "@/lib/userApi";
import { useState } from "react";

interface UserSelectScreenProps {
  mode: OnboardingMode;
  returningUser: ApiUser | null;
  userList: ApiUser[];
  error: string | null;
  onSubmitNewUser: (fullName: string) => Promise<void>;
  onContinue: () => Promise<void>;
  onNewSession: () => Promise<void>;
  onSwitchUser: () => Promise<void>;
  onPickUser: (user: ApiUser) => Promise<void>;
  onBackFromSwitch: () => void;
}

export function UserSelectScreen({
  mode,
  returningUser,
  userList,
  error,
  onSubmitNewUser,
  onContinue,
  onNewSession,
  onSwitchUser,
  onPickUser,
  onBackFromSwitch,
}: UserSelectScreenProps) {
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState(false);

  const cardStyle: React.CSSProperties = {
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: "1rem",
  };

  if (mode === "switch_user") {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center px-6 py-12"
        style={{ background: "radial-gradient(ellipse at 50% 40%, #0d0d1a 0%, #05050a 70%)" }}
      >
        <div className="w-full max-w-md space-y-4" style={cardStyle}>
          <div className="border-b border-white/10 px-5 py-4">
            <h2 className="text-lg font-semibold text-slate-200">Choose profile</h2>
            <p className="mt-1 text-xs text-slate-500">Stored on this device&apos;s server</p>
          </div>
          <ul className="max-h-72 overflow-y-auto px-2 pb-2">
            {userList.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  onClick={async () => {
                    await onPickUser(u);
                  }}
                  className="mb-1 w-full rounded-lg px-4 py-3 text-left text-sm text-slate-300 transition hover:bg-white/5"
                >
                  <span className="font-medium text-slate-100">{u.fullName}</span>
                  <span className="ml-2 text-xs text-slate-600">{u.name}</span>
                </button>
              </li>
            ))}
          </ul>
          {error && <p className="px-5 pb-2 text-center text-sm text-red-300">{error}</p>}
          <div className="border-t border-white/10 px-5 py-3">
            <button
              type="button"
              onClick={onBackFromSwitch}
              className="text-xs text-slate-500 underline hover:text-slate-300"
            >
              Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (mode === "returning" && returningUser) {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center px-6 py-12"
        style={{ background: "radial-gradient(ellipse at 50% 40%, #0d0d1a 0%, #05050a 70%)" }}
      >
        <div className="w-full max-w-md space-y-6 p-8" style={cardStyle}>
          <div className="text-center">
            <h1
              className="text-2xl font-bold tracking-tight"
              style={{
                background: "linear-gradient(135deg, #e2e8f0 0%, #94a3b8 100%)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}
            >
              Welcome back
            </h1>
            <p className="mt-3 text-lg text-teal-200/90">{returningUser.fullName}</p>
          </div>
          {error && <p className="text-center text-sm text-red-300">{error}</p>}
          <div className="flex flex-col gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onContinue();
                } finally {
                  setBusy(false);
                }
              }}
              className="rounded-xl bg-teal-600/80 py-3 text-sm font-medium text-white transition hover:bg-teal-500 disabled:opacity-50"
            >
              Continue last session
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onNewSession();
                } finally {
                  setBusy(false);
                }
              }}
              className="rounded-xl border border-white/15 py-3 text-sm font-medium text-slate-200 transition hover:bg-white/5 disabled:opacity-50"
            >
              New session
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onSwitchUser();
                } finally {
                  setBusy(false);
                }
              }}
              className="rounded-xl py-2 text-xs text-slate-500 underline hover:text-slate-300 disabled:opacity-50"
            >
              Switch user
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* new user */
  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center px-6 py-12"
      style={{ background: "radial-gradient(ellipse at 50% 40%, #0d0d1a 0%, #05050a 70%)" }}
    >
      <div className="w-full max-w-md space-y-6 p-8" style={cardStyle}>
        <div className="text-center">
          <h1
            className="text-2xl font-bold tracking-tight"
            style={{
              background: "linear-gradient(135deg, #e2e8f0 0%, #94a3b8 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            Sarjy
          </h1>
          <p className="mt-2 text-xs uppercase tracking-widest text-slate-600">Echo Voice Assistant</p>
          <p className="mt-4 text-sm text-slate-400">Enter your full name to get started</p>
        </div>
        <input
          type="text"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          placeholder="Full name"
          className="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-600 focus:border-teal-500/50 focus:outline-none"
          autoComplete="name"
        />
        {error && <p className="text-center text-sm text-red-300">{error}</p>}
        <button
          type="button"
          disabled={busy || !fullName.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              await onSubmitNewUser(fullName);
            } finally {
              setBusy(false);
            }
          }}
          className="w-full rounded-xl bg-teal-600/80 py-3 text-sm font-medium text-white transition hover:bg-teal-500 disabled:opacity-40"
        >
          Continue
        </button>
      </div>
    </div>
  );
}

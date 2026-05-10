"use client";

import type { ApiSession } from "@/lib/userApi";

interface SessionListDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: ApiSession[];
  currentSessionId: string | null;
  onSelectSession: (session: ApiSession) => void;
  onNewSession: () => void;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function SessionListDrawer({
  open,
  onOpenChange,
  sessions,
  currentSessionId,
  onSelectSession,
  onNewSession,
}: SessionListDrawerProps) {
  return (
    <>
      {open && (
        <button
          type="button"
          aria-label="Close sessions"
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
          onClick={() => onOpenChange(false)}
        />
      )}
      <aside
        className={`fixed left-0 top-0 z-50 flex h-full w-[min(100%,320px)] flex-col border-r border-white/10 shadow-2xl transition-transform duration-300 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{ background: "#08080f" }}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
            Sessions
          </h2>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-lg px-2 py-1 text-xs text-slate-500 hover:bg-white/5 hover:text-slate-300"
          >
            Close
          </button>
        </div>
        <div className="px-3 py-2">
          <button
            type="button"
            onClick={() => {
              onNewSession();
              onOpenChange(false);
            }}
            className="w-full rounded-lg border border-teal-500/30 bg-teal-500/10 py-2 text-xs font-medium text-teal-200/90 hover:bg-teal-500/20"
          >
            + New session
          </button>
        </div>
        <ul className="flex-1 overflow-y-auto px-2 pb-6">
          {sessions.map((s) => {
            const active = s.id === currentSessionId;
            return (
              <li key={s.id} className="mb-1">
                <button
                  type="button"
                  onClick={() => {
                    onSelectSession(s);
                    onOpenChange(false);
                  }}
                  className="w-full rounded-lg px-3 py-2.5 text-left text-xs transition hover:bg-white/5"
                  style={{
                    border: active ? "1px solid rgba(45,212,191,0.35)" : "1px solid transparent",
                    background: active ? "rgba(45,212,191,0.08)" : "transparent",
                  }}
                >
                  <div className="line-clamp-2 font-medium text-slate-200">
                    {s.title?.trim() || "Untitled chat"}
                  </div>
                  <div className="mt-1 text-[10px] text-slate-600">
                    {formatDate(s.updatedAt)} · {s.messageCount} msgs
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
    </>
  );
}

"use client";

import {
  createSession,
  createUser,
  getSessionWithMessages,
  getUser,
  listSessions,
  listUsers,
  type ApiSession,
  type ApiUser,
} from "@/lib/userApi";
import { useCallback, useEffect, useState } from "react";

const LS_USER_ID = "sarjy_user_id";
const LS_USER_NAME = "sarjy_user_full_name";
const LS_SESSION_ID = "sarjy_session_id";

export type AppGate = "loading" | "onboarding" | "app";

export type OnboardingMode = "new" | "returning" | "switch_user";

export interface UseCurrentUserReturn {
  gate: AppGate;
  onboardingMode: OnboardingMode;
  user: ApiUser | null;
  sessionId: string | null;
  sessions: ApiSession[];
  userList: ApiUser[];
  error: string | null;
  /** First visit: register and start first session. */
  submitNewUser: (fullName: string) => Promise<void>;
  /** Resume last local session (or most recent from API). */
  continueLastSession: () => Promise<void>;
  /** New chat session for current user. */
  startNewChatSession: () => Promise<void>;
  openUserSwitch: () => Promise<void>;
  pickUser: (user: ApiUser) => Promise<void>;
  selectSession: (session: ApiSession) => Promise<void>;
  goBackToOnboarding: () => void;
  cancelUserSwitch: () => void;
}

export function useCurrentUser(): UseCurrentUserReturn {
  const [gate, setGate] = useState<AppGate>("loading");
  const [onboardingMode, setOnboardingMode] = useState<OnboardingMode>("new");
  const [user, setUser] = useState<ApiUser | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ApiSession[]>([]);
  const [userList, setUserList] = useState<ApiUser[]>([]);
  const [error, setError] = useState<string | null>(null);

  const persistLocalUser = useCallback((u: ApiUser, sid: string) => {
    localStorage.setItem(LS_USER_ID, u.id);
    localStorage.setItem(LS_USER_NAME, u.fullName);
    localStorage.setItem(LS_SESSION_ID, sid);
  }, []);

  const refreshSessions = useCallback(async (uid: string) => {
    const list = await listSessions(uid);
    setSessions(list);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const uid = localStorage.getItem(LS_USER_ID);
        if (!uid) {
          setOnboardingMode("new");
          setGate("onboarding");
          return;
        }
        const u = await getUser(uid);
        setUser(u);
        const sid = localStorage.getItem(LS_SESSION_ID);
        setSessionId(sid);
        setOnboardingMode("returning");
        setGate("onboarding");
      } catch {
        localStorage.removeItem(LS_USER_ID);
        localStorage.removeItem(LS_USER_NAME);
        localStorage.removeItem(LS_SESSION_ID);
        setOnboardingMode("new");
        setGate("onboarding");
      }
    })();
  }, []);

  useEffect(() => {
    if (gate !== "app" || !user) return;
    void refreshSessions(user.id);
  }, [gate, user?.id, refreshSessions]);

  const submitNewUser = useCallback(async (fullName: string) => {
    setError(null);
    try {
      const u = await createUser(fullName.trim());
      const s = await createSession(u.id);
      setUser(u);
      setSessionId(s.id);
      persistLocalUser(u, s.id);
      await refreshSessions(u.id);
      setGate("app");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create user");
    }
  }, [persistLocalUser, refreshSessions]);

  const continueLastSession = useCallback(async () => {
    if (!user) return;
    setError(null);
    try {
      let sid = localStorage.getItem(LS_SESSION_ID);
      if (!sid) {
        const list = await listSessions(user.id);
        sid = list[0]?.id ?? null;
        if (!sid) {
          const s = await createSession(user.id);
          sid = s.id;
        }
        localStorage.setItem(LS_SESSION_ID, sid);
      }
      setSessionId(sid);
      await refreshSessions(user.id);
      setGate("app");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not resume session");
    }
  }, [refreshSessions, user]);

  const startNewChatSession = useCallback(async () => {
    if (!user) return;
    setError(null);
    try {
      const s = await createSession(user.id);
      setSessionId(s.id);
      persistLocalUser(user, s.id);
      await refreshSessions(user.id);
      setGate("app");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create session");
    }
  }, [persistLocalUser, refreshSessions, user]);

  const openUserSwitch = useCallback(async () => {
    setError(null);
    try {
      const users = await listUsers();
      setUserList(users);
      setOnboardingMode("switch_user");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load users");
    }
  }, []);

  const pickUser = useCallback(async (picked: ApiUser) => {
    setError(null);
    try {
      setUser(picked);
      localStorage.setItem(LS_USER_ID, picked.id);
      localStorage.setItem(LS_USER_NAME, picked.fullName);
      const list = await listSessions(picked.id);
      setSessions(list);
      const sid = list[0]?.id ?? (await createSession(picked.id)).id;
      setSessionId(sid);
      localStorage.setItem(LS_SESSION_ID, sid);
      setOnboardingMode("returning");
      setGate("app");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not select user");
    }
  }, []);

  const selectSession = useCallback(
    async (session: ApiSession) => {
      if (!user) return;
      setSessionId(session.id);
      localStorage.setItem(LS_SESSION_ID, session.id);
      await refreshSessions(user.id);
    },
    [refreshSessions, user],
  );

  const goBackToOnboarding = useCallback(() => {
    setGate("onboarding");
    setOnboardingMode(user ? "returning" : "new");
  }, [user]);

  const cancelUserSwitch = useCallback(() => {
    setOnboardingMode(user ? "returning" : "new");
  }, [user]);

  return {
    gate,
    onboardingMode,
    user,
    sessionId,
    sessions,
    userList,
    error,
    submitNewUser,
    continueLastSession,
    startNewChatSession,
    openUserSwitch,
    pickUser,
    selectSession,
    goBackToOnboarding,
    cancelUserSwitch,
  };
}

/** Map API messages to voice drawer entries (skip system summary lines in UI or show as assistant — use user/assistant only). */
export function messagesToTranscriptEntries(
  messages: { role: string; content: string }[],
): { role: "user" | "assistant"; text: string }[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      text: m.content,
    }));
}

export async function fetchSessionTranscript(
  sessionId: string,
  userId: string,
): Promise<{ role: "user" | "assistant"; text: string }[]> {
  const { messages } = await getSessionWithMessages(sessionId, userId);
  return messagesToTranscriptEntries(messages);
}

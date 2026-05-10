import { apiClient } from "@/lib/apiClient";

export interface ApiUser {
  id: string;
  name: string;
  fullName: string;
  createdAt: string;
}

export interface ApiSession {
  id: string;
  userId: string;
  title: string;
  summary: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApiMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

export async function createUser(fullName: string): Promise<ApiUser> {
  const { data } = await apiClient.post<{ user: ApiUser }>("/api/users", { fullName });
  return data.user;
}

export async function listUsers(): Promise<ApiUser[]> {
  const { data } = await apiClient.get<{ users: ApiUser[] }>("/api/users");
  return data.users;
}

export async function getUser(id: string): Promise<ApiUser> {
  const { data } = await apiClient.get<{ user: ApiUser }>(`/api/users/${id}`);
  return data.user;
}

export async function createSession(userId: string, title?: string): Promise<ApiSession> {
  const { data } = await apiClient.post<{ session: ApiSession }>("/api/sessions", {
    userId,
    title,
  });
  return data.session;
}

export async function listSessions(userId: string): Promise<ApiSession[]> {
  const { data } = await apiClient.get<{ sessions: ApiSession[] }>("/api/sessions", {
    params: { userId },
  });
  return data.sessions;
}

export async function getSessionWithMessages(
  sessionId: string,
  userId: string,
): Promise<{ session: ApiSession; messages: ApiMessage[] }> {
  const { data } = await apiClient.get<{
    session: ApiSession;
    messages: ApiMessage[];
  }>(`/api/sessions/${sessionId}`, { params: { userId } });
  return data;
}

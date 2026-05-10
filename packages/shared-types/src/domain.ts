export interface User {
  id: string;
  name: string;
  /** Full display name the user entered on first visit. */
  fullName?: string;
  createdAt: string;
}

export interface Session {
  id: string;
  userId: string;
  title: string;
  summary: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export type MemoryCategory =
  | "identity"
  | "preference"
  | "personality"
  | "constraint"
  | "ongoing";

export interface MemoryFact {
  id: string;
  userId: string;
  category: MemoryCategory;
  key: string;
  value: string;
  confidence: number;
  sourceSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export type MessageRole = "user" | "assistant" | "system";

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

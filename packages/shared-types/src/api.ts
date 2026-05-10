import type { Message, Session, User } from "./domain";

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export interface HealthResponse {
  status: "ok";
  uptime: number;
  timestamp: string;
}

export interface CreateUserRequest {
  name: string;
}

export type CreateUserResponse = ApiResponse<User>;

export type GetSessionsResponse = ApiResponse<Session[]>;

export interface GetMessagesQuery {
  sessionId: string;
  limit?: number;
}

export type GetMessagesResponse = ApiResponse<Message[]>;

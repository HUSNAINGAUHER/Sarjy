import type { Server as HttpServer } from "http";
import { Server as SocketIOServer, type Socket } from "socket.io";
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from "@sarjy/shared-types";
import { env } from "@/config/env";
import { logger } from "@/utils/logger";
import { registerVoiceHandlers } from "@/sockets/voice";

export type AppIOServer = SocketIOServer<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

type AppSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export function createSocketServer(httpServer: HttpServer): AppIOServer {
  const io: AppIOServer = new SocketIOServer(httpServer, {
    cors: {
      origin: env.CORS_ORIGIN,
      credentials: true,
    },
  });

  io.on("connection", (socket: AppSocket) => {
    logger.info("socket connected", { id: socket.id });

    registerVoiceHandlers(socket);

    socket.on("session:join", (sessionId) => {
      socket.data.sessionId = sessionId;
      void socket.join(`session:${sessionId}`);
      logger.info("session:join", { id: socket.id, sessionId });
    });

    socket.on("session:leave", (sessionId) => {
      void socket.leave(`session:${sessionId}`);
      logger.info("session:leave", { id: socket.id, sessionId });
    });

    socket.on("message:send", ({ sessionId, content }, ack) => {
      const messageId = `msg_${Date.now()}`;
      io.to(`session:${sessionId}`).emit("message:new", {
        id: messageId,
        sessionId,
        role: "user",
        content,
        createdAt: new Date().toISOString(),
      });
      ack?.({ ok: true, messageId });
    });

    socket.on("disconnect", (reason) => {
      logger.info("socket disconnected", { id: socket.id, reason });
    });
  });

  return io;
}

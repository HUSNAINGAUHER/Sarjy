import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@sarjy/shared-types";
import { env } from "@/lib/env";

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: AppSocket | null = null;

export function getSocket(): AppSocket {
  if (!socket) {
    socket = io(env.socketUrl, {
      autoConnect: true,
      transports: ["websocket"],
    });
  }
  return socket;
}

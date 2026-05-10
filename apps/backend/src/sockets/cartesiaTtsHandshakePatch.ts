import type { Cartesia } from "@cartesia/cartesia-js";
import type { ClientOptions } from "ws";
import { TTS, TTSWS } from "@cartesia/cartesia-js/resources/tts";

let installed = false;

/**
 * Cartesia's `TTS.prototype.websocket` builds a `TTSWS` then awaits `connect()`. The socket has two
 * `error` listeners; on failed handshake both run. The second calls `_onError`, which does a bare
 * `Promise.reject(...)` when no `error` listener is registered on the emitter yet — so handshake
 * failures (402 quota, invalid key, etc.) can crash Node even though `connect()` rejects cleanly.
 * Registering a noop `error` listener first matches Cartesia's own guidance and avoids the stray rejection.
 */
export function ensureCartesiaTtsWebsocketHandshakeErrorPatch(): void {
  if (installed) return;
  installed = true;

  TTS.prototype.websocket = async function patchedWebsocket(
    this: TTS,
    options?: ClientOptions,
  ): Promise<TTSWS> {
    const client = (this as unknown as { _client: Cartesia })._client;
    const ws = new TTSWS(client, options);
    ws.on("error", () => {});
    return ws.connect();
  };
}

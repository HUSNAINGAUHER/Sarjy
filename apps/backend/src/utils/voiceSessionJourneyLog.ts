import fs from "node:fs";
import path from "node:path";

export type VoiceJourneyScalar = string | number | boolean | null;

export type VoiceJourneyMeta = Record<string, VoiceJourneyScalar | undefined>;

/**
 * Append-only text log for one voice Socket.io session (voice:start → stop/disconnect).
 * Timestamps are wall clock + milliseconds since this object was constructed.
 */
export class VoiceSessionJourneyLog {
  readonly anchorMs: number;
  readonly filePath: string;
  private readonly stream: fs.WriteStream;

  constructor(params: { logDir: string; fileBaseName: string }) {
    this.anchorMs = Date.now();
    fs.mkdirSync(params.logDir, { recursive: true });
    this.filePath = path.join(params.logDir, `${params.fileBaseName}.log`);
    this.stream = fs.createWriteStream(this.filePath, { flags: "a" });
    this.raw(`===== voice session journey =====`);
    this.raw(`path=${this.filePath}`);
    this.raw(`sessionStartIso=${new Date(this.anchorMs).toISOString()}`);
  }

  private raw(line: string): void {
    this.stream.write(`${line}\n`);
  }

  /**
   * One pipeline step. `meta` is JSON-serialized (shallow values only).
   */
  step(phase: string, detail?: string, meta?: VoiceJourneyMeta): void {
    const now = Date.now();
    const rel = now - this.anchorMs;
    const iso = new Date(now).toISOString();
    const bits = [`[+${rel}ms]`, `[${iso}]`, phase];
    if (detail) bits.push(detail);
    let line = bits.join(" ");
    if (meta) {
      const cleaned: Record<string, VoiceJourneyScalar> = {};
      for (const [k, v] of Object.entries(meta)) {
        if (v !== undefined) cleaned[k] = v;
      }
      if (Object.keys(cleaned).length) line += ` ${JSON.stringify(cleaned)}`;
    }
    this.raw(line);
  }

  end(reason: string): void {
    const now = Date.now();
    this.raw(
      `[+${now - this.anchorMs}ms] [${new Date(now).toISOString()}] SESSION.end reason=${JSON.stringify(reason)} totalSessionMs=${now - this.anchorMs}`,
    );
    this.raw(`===== end voice session journey =====`);
    this.stream.end();
  }
}

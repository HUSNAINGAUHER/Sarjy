type Level = "info" | "warn" | "error" | "debug";

function log(level: Level, message: string, meta?: Record<string, unknown>): void {
  const time = new Date().toISOString();
  const metaStr = meta && Object.keys(meta).length > 0
    ? " " + JSON.stringify(meta)
    : "";
  const line = `[${level.toUpperCase()}] [${time}] ${message}${metaStr}`;
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (msg: string, meta?: Record<string, unknown>) => log("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log("error", msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => log("debug", msg, meta),
};

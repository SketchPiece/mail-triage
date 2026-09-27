// All settings come from the environment (.env via `node --env-file`).
import { resolve } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function num(name: string, fallback: number) {
  const v = process.env[name];
  return v ? Number(v) : fallback;
}

export const config = {
  root: ROOT,
  dataDir: resolve(ROOT, process.env.DATA_DIR ?? "data"),
  dbPath: resolve(ROOT, process.env.DATA_DIR ?? "data", "mail-triage.db"),
  googleCredentials: resolve(ROOT, process.env.GOOGLE_CREDENTIALS ?? "credentials.json"),
  openrouterKey: process.env.OPENROUTER_API_KEY ?? "",
  host: process.env.HOST ?? "127.0.0.1",
  port: num("PORT", 8790),
  // Bearer token MCP clients must send. Required unless the server only listens on localhost.
  token: process.env.MAIL_TRIAGE_TOKEN ?? "",
  syncIntervalMin: num("SYNC_INTERVAL_MIN", 10),
  timeZone: process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  minConfidence: 0.8,
};

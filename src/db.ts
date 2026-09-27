// SQLite store (node:sqlite). Every table is scoped by account (the mailbox address).
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

export type Category = "marketing" | "service" | "finance" | "shopping" | "travel" | "personal";

export type MessageRow = {
  account: string;
  id: string;
  thread_id: string;
  date: number;
  from_email: string;
  from_name: string;
  subject: string;
  snippet: string;
  labels: string; // JSON array
  list_unsubscribe: string | null;
  list_unsubscribe_post: string | null;
};

export type TriageRow = {
  account: string;
  message_id: string;
  category: Category;
  confidence: number;
  needs_action: number; // 0..1
  urgency: number; // 0 = no deadline, 1 = this week, 2 = today/overdue
  source: "sender" | "jev" | "override";
};

mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS accounts (
    email TEXT PRIMARY KEY,
    refresh_token TEXT NOT NULL,
    history_id TEXT,
    last_sync_at INTEGER,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    account TEXT NOT NULL,
    id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    date INTEGER NOT NULL,
    from_email TEXT NOT NULL,
    from_name TEXT NOT NULL,
    subject TEXT NOT NULL,
    snippet TEXT NOT NULL,
    labels TEXT NOT NULL,
    list_unsubscribe TEXT,
    list_unsubscribe_post TEXT,
    PRIMARY KEY (account, id)
  );
  CREATE INDEX IF NOT EXISTS messages_by_date ON messages (account, date);
  CREATE INDEX IF NOT EXISTS messages_by_sender ON messages (account, from_email);
  -- Sender-level knowledge: Jev classification from onboarding, or the owner's override.
  CREATE TABLE IF NOT EXISTS senders (
    account TEXT NOT NULL,
    email TEXT NOT NULL,
    category TEXT NOT NULL,
    confidence REAL NOT NULL,
    mixed REAL NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account, email)
  );
  -- Per-message triage result.
  CREATE TABLE IF NOT EXISTS triage (
    account TEXT NOT NULL,
    message_id TEXT NOT NULL,
    category TEXT NOT NULL,
    confidence REAL NOT NULL,
    needs_action REAL NOT NULL,
    urgency REAL NOT NULL,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (account, message_id)
  );
`);

export const labelsOf = (m: Pick<MessageRow, "labels">): string[] => JSON.parse(m.labels);

export function upsertMessage(m: MessageRow) {
  db.prepare(
    `INSERT INTO messages (account, id, thread_id, date, from_email, from_name, subject, snippet, labels, list_unsubscribe, list_unsubscribe_post)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (account, id) DO UPDATE SET labels = excluded.labels`,
  ).run(m.account, m.id, m.thread_id, m.date, m.from_email, m.from_name, m.subject, m.snippet, m.labels, m.list_unsubscribe, m.list_unsubscribe_post);
}

export function setLabels(account: string, id: string, labels: string[]) {
  db.prepare(`UPDATE messages SET labels = ? WHERE account = ? AND id = ?`).run(JSON.stringify(labels), account, id);
}

export function upsertTriage(t: TriageRow) {
  db.prepare(
    `INSERT OR REPLACE INTO triage (account, message_id, category, confidence, needs_action, urgency, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(t.account, t.message_id, t.category, t.confidence, t.needs_action, t.urgency, t.source, Date.now());
}

export function getSender(account: string, email: string) {
  return db.prepare(`SELECT * FROM senders WHERE account = ? AND email = ?`).get(account, email) as
    | { category: Category; confidence: number; mixed: number; source: string }
    | undefined;
}

export function upsertSender(account: string, email: string, s: { category: Category; confidence: number; mixed: number; source: string }) {
  db.prepare(
    `INSERT OR REPLACE INTO senders (account, email, category, confidence, mixed, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(account, email, s.category, s.confidence, s.mixed, s.source, Date.now());
}

// Read models over triaged mail: digest groups, filtered lists, single message.
// Output is compact and speakable: a voice assistant reads it and retells it in its own words.
import { config } from "./config.ts";
import { db, labelsOf, type Category } from "./db.ts";
import { getBodyText } from "./gmail.ts";
import { clean } from "./triage.ts";
import { listAccounts } from "./sync.ts";

export type Group = "action" | "notable" | "other";
const NOTABLE: Category[] = ["finance", "travel", "shopping", "personal"];
const ACTION_MIN = 0.6;
const URGENT_MIN = 1.5;

type Row = {
  account: string;
  id: string;
  date: number;
  from_email: string;
  from_name: string;
  subject: string;
  snippet: string;
  labels: string;
  category: Category;
  needs_action: number;
  urgency: number;
};

export function groupOf(r: Pick<Row, "category" | "needs_action" | "urgency">): Group {
  if (r.category !== "marketing" && (r.needs_action >= ACTION_MIN || r.urgency >= URGENT_MIN)) return "action";
  if (NOTABLE.includes(r.category)) return "notable";
  return "other";
}

const urgencyLabel = (u: number) => (u >= URGENT_MIN ? "today" : u >= 0.75 ? "this week" : "no rush");

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: config.timeZone,
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function item(r: Row, withSnippet: boolean) {
  return {
    id: r.id,
    ...(r.account ? { account: r.account } : {}),
    from: r.from_name || r.from_email,
    subject: clean(r.subject, 90),
    category: r.category,
    ...(groupOf(r) === "action" ? { urgency: urgencyLabel(r.urgency) } : {}),
    received: fmt.format(r.date),
    unread: labelsOf(r).includes("UNREAD"),
    ...(withSnippet ? { snippet: clean(r.snippet, 140) } : {}),
  };
}

export function resolveAccounts(account?: string): string[] {
  const all = listAccounts();
  if (!all.length) throw new Error("No mail accounts connected yet.");
  if (!account) return [all[0].email]; // default account sorts first
  if (account === "all") return all.map((a) => a.email);
  const match = all.find((a) => a.email === account.toLowerCase() || a.email.startsWith(account.toLowerCase() + "@"));
  if (!match) throw new Error(`Unknown account "${account}". Connected: ${all.map((a) => a.email).join(", ")}`);
  return [match.email];
}

function query(accounts: string[], opts: { sinceMs: number; inboxOnly: boolean; category?: Category; sender?: string }): Row[] {
  const marks = accounts.map(() => "?").join(",");
  const params: (string | number)[] = [...accounts, opts.sinceMs];
  let sql = `SELECT m.account, m.id, m.date, m.from_email, m.from_name, m.subject, m.snippet, m.labels,
                    t.category, t.needs_action, t.urgency
             FROM messages m JOIN triage t ON t.account = m.account AND t.message_id = m.id
             WHERE m.account IN (${marks}) AND m.date >= ?`;
  if (opts.inboxOnly) sql += ` AND m.labels LIKE '%"INBOX"%'`;
  if (opts.category) {
    sql += ` AND t.category = ?`;
    params.push(opts.category);
  }
  if (opts.sender) {
    sql += ` AND (m.from_email LIKE ? OR m.from_name LIKE ?)`;
    params.push(`%${opts.sender.toLowerCase()}%`, `%${opts.sender}%`);
  }
  sql += ` ORDER BY m.date DESC`;
  return db.prepare(sql).all(...params) as Row[];
}

export function digest(opts: { account?: string; sinceHours?: number; detail?: "brief" | "full" }) {
  const accounts = resolveAccounts(opts.account);
  const sinceHours = opts.sinceHours ?? 24;
  const rows = query(accounts, { sinceMs: Date.now() - sinceHours * 3600e3, inboxOnly: true });
  const multi = accounts.length > 1;
  const strip = (r: Row) => (multi ? r : { ...r, account: "" });
  const byGroup = (g: Group) => rows.filter((r) => groupOf(r) === g);
  const action = byGroup("action").sort((a, b) => b.urgency - a.urgency || b.date - a.date);
  const notable = byGroup("notable");
  const other = byGroup("other");
  const full = opts.detail === "full";

  const countBy = (list: Row[]) =>
    list.reduce<Record<string, number>>((acc, r) => ((acc[r.category] = (acc[r.category] ?? 0) + 1), acc), {});

  return {
    accounts,
    window_hours: sinceHours,
    totals: { in_inbox: rows.length, action: action.length, notable: notable.length, other: other.length },
    action: action.slice(0, full ? 30 : 5).map((r) => item(strip(r), full)),
    notable: full
      ? notable.slice(0, 30).map((r) => item(strip(r), false))
      : Object.entries(countBy(notable)).map(([category, count]) => ({
          category,
          count,
          examples: notable.filter((r) => r.category === category).slice(0, 2).map((r) => `${r.from_name || r.from_email}: ${clean(r.subject, 60)}`),
        })),
    other_by_category: countBy(other),
    hint: "Say the action items first, then one sentence per notable category. Offer details via list(group or category) and read(id).",
  };
}

export function list(opts: {
  account?: string;
  group?: Group;
  category?: Category;
  sender?: string;
  sinceHours?: number;
  includeArchived?: boolean;
  limit?: number;
}) {
  const accounts = resolveAccounts(opts.account);
  const sinceHours = opts.sinceHours ?? (opts.sender ? 24 * 90 : 24 * 7);
  let rows = query(accounts, {
    sinceMs: Date.now() - sinceHours * 3600e3,
    inboxOnly: !opts.includeArchived,
    category: opts.category,
    sender: opts.sender,
  });
  if (opts.group) rows = rows.filter((r) => groupOf(r) === opts.group);
  const limit = Math.min(opts.limit ?? 10, 30);
  const multi = accounts.length > 1;
  return {
    total: rows.length,
    shown: Math.min(limit, rows.length),
    items: rows.slice(0, limit).map((r) => item(multi ? r : { ...r, account: "" }, true)),
  };
}

const MAX_BODY = 5000;

export async function read(opts: { id: string; account?: string }) {
  const accounts = resolveAccounts(opts.account ?? "all");
  const row = db
    .prepare(
      `SELECT m.*, t.category, t.needs_action, t.urgency FROM messages m LEFT JOIN triage t ON t.account = m.account AND t.message_id = m.id
       WHERE m.id = ? AND m.account IN (${accounts.map(() => "?").join(",")})`,
    )
    .get(opts.id, ...accounts) as (Row & { account: string }) | undefined;
  if (!row) throw new Error(`Message ${opts.id} not found.`);
  const text = await getBodyText(row.account, row.id);
  return {
    id: row.id,
    account: row.account,
    from: row.from_name ? `${row.from_name} <${row.from_email}>` : row.from_email,
    subject: row.subject,
    received: fmt.format(row.date),
    category: row.category ?? null,
    text: text.length > MAX_BODY ? text.slice(0, MAX_BODY) + "\n[…truncated]" : text,
  };
}

export function accountsInfo() {
  return listAccounts().map((a) => {
    const counts = db
      .prepare(
        `SELECT COUNT(*) AS inbox, SUM(labels LIKE '%"UNREAD"%') AS unread FROM messages WHERE account = ? AND labels LIKE '%"INBOX"%'`,
      )
      .get(a.email) as { inbox: number; unread: number };
    return {
      email: a.email,
      default: Boolean(a.is_default),
      last_sync: a.last_sync_at ? fmt.format(a.last_sync_at) : null,
      known_inbox_messages: counts.inbox,
      known_unread: counts.unread ?? 0,
    };
  });
}

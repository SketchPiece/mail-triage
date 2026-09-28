// mark_read touches only what the owner was shown, and only the UNREAD label.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "mail-triage-test-"));
const { db, upsertMessage, upsertTriage, labelsOf, setShown } = await import("./db.ts");
const { list, digest } = await import("./digest.ts");
const { markRead, SHOWN_TTL_MS } = await import("./mark.ts");

const ME = "me@example.com";
const WORK = "work@example.com";
const HOUR = 3600e3;

function seed(account: string, id: string, labels: string[], category: "service" | "marketing" | "finance", ageHours: number) {
  upsertMessage({
    account,
    id,
    thread_id: id,
    date: Date.now() - ageHours * HOUR,
    from_email: `${category}@shop.example`,
    from_name: category,
    subject: `subject ${id}`,
    snippet: "",
    labels: JSON.stringify(labels),
    list_unsubscribe: null,
    list_unsubscribe_post: null,
  });
  upsertTriage({ account, message_id: id, category, confidence: 1, needs_action: 0, urgency: 0, source: "sender" });
}

const labels = (account: string, id: string) =>
  labelsOf(db.prepare(`SELECT labels FROM messages WHERE account = ? AND id = ?`).get(account, id) as { labels: string });

let calls: { account: string; ids: string[] }[] = [];
const remove = async (account: string, ids: string[]) => void calls.push({ account, ids: [...ids] });

beforeEach(() => {
  calls = [];
  for (const t of ["messages", "triage", "shown", "accounts"]) db.exec(`DELETE FROM ${t}`);
  db.prepare(`INSERT INTO accounts (email, refresh_token, is_default, created_at) VALUES (?, 'x', 1, 0), (?, 'x', 0, 0)`).run(ME, WORK);
  seed(ME, "a", ["INBOX", "UNREAD", "CATEGORY_UPDATES"], "service", 1);
  seed(ME, "b", ["INBOX", "UNREAD", "IMPORTANT"], "marketing", 2);
  seed(ME, "c", ["INBOX"], "finance", 3);
  seed(ME, "d", ["INBOX", "UNREAD"], "service", 4); // older: outside a limit-3 list
  seed(WORK, "w", ["INBOX", "UNREAD"], "service", 1);
});

test("refuses when nothing was shown", async () => {
  await assert.rejects(markRead({}, remove), /digest or list first/);
  assert.deepEqual(calls, []);
});

test("list reports unread among shown items and asks to offer marking", () => {
  const result = list({ limit: 3 });
  assert.equal(result.shown, 3);
  assert.equal(result.unread_shown, 2);
  assert.match(result.hint!, /mark_read only after a clear yes/);
  assert.equal(list({ category: "finance" }).hint, undefined);
});

test("without ids marks exactly the unread messages the last list showed, any category", async () => {
  list({ limit: 3 });
  const result = await markRead({}, remove);
  assert.deepEqual(result, { marked: 2, already_read: 1 });
  assert.deepEqual(calls, [{ account: ME, ids: ["a", "b"] }]);
  assert.deepEqual(labels(ME, "a"), ["INBOX", "CATEGORY_UPDATES"]);
  assert.deepEqual(labels(ME, "b"), ["INBOX", "IMPORTANT"]);
  assert.deepEqual(labels(ME, "d"), ["INBOX", "UNREAD"], "not shown: untouched");
  assert.deepEqual(labels(WORK, "w"), ["INBOX", "UNREAD"], "other mailbox: untouched");
});

test("ids pick a subset; ids that were not shown are refused, not touched", async () => {
  list({ limit: 3 });
  const result = await markRead({ ids: ["b", "d", "w"] }, remove);
  assert.deepEqual(result, { marked: 1, already_read: 0, not_shown: ["d", "w"] });
  assert.deepEqual(calls, [{ account: ME, ids: ["b"] }]);
  assert.deepEqual(labels(ME, "a"), ["INBOX", "UNREAD", "CATEGORY_UPDATES"]);
});

test("a new list replaces what can be marked", async () => {
  list({ limit: 3 });
  list({ category: "finance" });
  const result = await markRead({}, remove);
  assert.deepEqual(result, { marked: 0, already_read: 1 });
  assert.deepEqual(calls, []);
});

test("digest remembers only items it returned with ids", async () => {
  db.prepare(`UPDATE triage SET needs_action = 1 WHERE message_id = 'a'`).run();
  const d = digest({});
  assert.equal(d.unread_shown, 1);
  await markRead({}, remove);
  assert.deepEqual(calls, [{ account: ME, ids: ["a"] }]);
});

test("shown list expires", async () => {
  list({ limit: 3 });
  db.prepare(`UPDATE shown SET shown_at = ?`).run(Date.now() - SHOWN_TTL_MS - 1);
  await assert.rejects(markRead({}, remove), /digest or list first/);
});

test("account filter limits marking to that mailbox", async () => {
  list({ account: "all", limit: 30 });
  const result = await markRead({ account: "work" }, remove);
  assert.deepEqual(result, { marked: 1, already_read: 0 });
  assert.deepEqual(calls, [{ account: WORK, ids: ["w"] }]);
});

test("Gmail failure leaves local labels unchanged", async () => {
  setShown([{ account: ME, id: "a" }]);
  await assert.rejects(markRead({}, async () => { throw new Error("gmail down"); }), /gmail down/);
  assert.deepEqual(labels(ME, "a"), ["INBOX", "UNREAD", "CATEGORY_UPDATES"]);
});

test("more than 50 ids is refused", async () => {
  list({ limit: 3 });
  await assert.rejects(markRead({ ids: Array.from({ length: 51 }, (_, i) => `x${i}`) }, remove), /At most 50/);
});

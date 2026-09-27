// Owner-only setup commands. Anything that grants access happens here, never through MCP.
//
//   npm run cli -- accounts                 list connected mailboxes
//   npm run cli -- accounts add             connect a Gmail account (opens the browser)
//   npm run cli -- accounts default <email> make a mailbox the default
//   npm run cli -- accounts remove <email>  forget a mailbox and all its local data
//   npm run cli -- import-cleanup <email>   import sender knowledge from the one-off cleanup (data/*.jsonl)
//   npm run cli -- sync                     sync all mailboxes now
//   npm run cli -- retriage [days]          re-run triage on inbox mail from the last N days (default 14)
import { readFile } from "node:fs/promises";
import { config } from "./config.ts";
import { db, upsertMessage, upsertSender, type Category, type MessageRow } from "./db.ts";
import { triageMessage } from "./triage.ts";
import { addAccount, parseFrom } from "./gmail.ts";
import { accountsInfo } from "./digest.ts";
import { syncAll } from "./sync.ts";

const [cmd, sub, arg] = process.argv.slice(2);

const readJsonl = async (file: string) =>
  (await readFile(`${config.dataDir}/${file}`, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));

if (cmd === "accounts" && !sub) {
  console.table(accountsInfo());
} else if (cmd === "accounts" && sub === "add") {
  const email = await addAccount();
  console.log(`Connected ${email}. Run \`npm run cli -- sync\` or start the server to fetch recent mail.`);
} else if (cmd === "accounts" && sub === "default" && arg) {
  db.exec("UPDATE accounts SET is_default = 0");
  const r = db.prepare("UPDATE accounts SET is_default = 1 WHERE email = ?").run(arg.toLowerCase());
  console.log(r.changes ? `Default: ${arg}` : `Unknown account ${arg}`);
} else if (cmd === "accounts" && sub === "remove" && arg) {
  const email = arg.toLowerCase();
  for (const t of ["messages", "senders", "triage"]) db.prepare(`DELETE FROM ${t} WHERE account = ?`).run(email);
  db.prepare("DELETE FROM accounts WHERE email = ?").run(email);
  console.log(`Removed ${email} and its local data. Revoke access at https://myaccount.google.com/permissions`);
} else if (cmd === "import-cleanup" && sub) {
  const account = sub.toLowerCase();
  if (!db.prepare("SELECT 1 FROM accounts WHERE email = ?").get(account)) {
    // The one-off cleanup authorized via token.json; reuse that refresh token.
    const token = JSON.parse(await readFile(`${config.root}token.json`, "utf8"));
    db.prepare("INSERT INTO accounts (email, refresh_token, is_default, created_at) VALUES (?, ?, 1, ?)").run(account, token.refresh_token, Date.now());
    console.log(`Connected ${account} using token.json`);
  }
  let senders = 0;
  for (const c of await readJsonl("classified.jsonl")) {
    upsertSender(account, c.email, { category: c.category as Category, confidence: c.confidence, mixed: c.mixed, source: "jev" });
    senders++;
  }
  let messages = 0;
  db.exec("BEGIN");
  for (const m of await readJsonl("messages.jsonl")) {
    const from = parseFrom(m.from);
    upsertMessage({
      account,
      id: m.id,
      thread_id: m.threadId,
      date: m.date,
      from_email: from.email,
      from_name: from.name,
      subject: m.subject,
      snippet: m.snippet,
      labels: JSON.stringify(m.labels),
      list_unsubscribe: m.listUnsubscribe ?? null,
      list_unsubscribe_post: m.listUnsubscribePost ?? null,
    });
    messages++;
  }
  // The export predates the cleanup: drop INBOX from everything apply.ts archived.
  let archived = 0;
  try {
    const ids: string[] = JSON.parse(await readFile(`${config.dataDir}/archived-ids.json`, "utf8"));
    const stmt = db.prepare(
      `UPDATE messages SET labels = (SELECT json_group_array(value) FROM json_each(labels) WHERE value != 'INBOX') WHERE account = ? AND id = ?`,
    );
    for (const id of ids) archived += Number(stmt.run(account, id).changes);
  } catch {}
  db.exec("COMMIT");
  console.log(`Imported ${senders} senders and ${messages} messages for ${account} (${archived} marked archived).`);
} else if (cmd === "sync") {
  for (const s of await syncAll()) {
    console.log(`${s.account}: fetched ${s.fetched}, triaged ${s.triaged}, label updates ${s.labelUpdates}, errors ${s.errors.length}`);
    for (const e of s.errors.slice(0, 5)) console.log(`  ${e}`);
  }
} else if (cmd === "retriage") {
  const since = Date.now() - Number(sub ?? 14) * 864e5;
  const rows = db
    .prepare(`SELECT * FROM messages WHERE date >= ? AND labels LIKE '%"INBOX"%'`)
    .all(since) as unknown as MessageRow[];
  let n = 0;
  for (const m of rows) {
    await triageMessage(m);
    n++;
  }
  console.log(`Re-triaged ${n} messages.`);
} else {
  console.log(await readFile(new URL(import.meta.url).pathname, "utf8").then((t) => t.split("\n").filter((l) => l.startsWith("//")).join("\n")));
  process.exit(cmd ? 1 : 0);
}

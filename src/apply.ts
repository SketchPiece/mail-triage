// Executes data/actions.json against Gmail.
//
//   pnpm -s run apply                 dry run: prints what would happen
//   pnpm -s run apply --execute       archives messages and sends one-click unsubscribes
//   pnpm -s run apply undo            moves every archived message back to the inbox
import { readFile, writeFile } from "node:fs/promises";
import { getGmail } from "./auth.ts";
import type { Actions } from "./actions.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const ARCHIVED_LOG = ROOT + "data/archived-ids.json";
const UNSUB_LOG = ROOT + "data/unsubscribe-results.json";
const BATCH = 1000; // batchModify limit

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const undo = args[0] === "undo";

async function modifyInBatches(ids: string[], change: { addLabelIds?: string[]; removeLabelIds?: string[] }) {
  const gmail = await getGmail();
  for (let i = 0; i < ids.length; i += BATCH) {
    await gmail.users.messages.batchModify({ userId: "me", requestBody: { ids: ids.slice(i, i + BATCH), ...change } });
    process.stdout.write(`\r  ${Math.min(i + BATCH, ids.length)}/${ids.length}`);
  }
  console.log();
}

async function oneClickUnsubscribe(url: string) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
    });
    return { ok: res.ok, status: res.status };
  } catch (err: any) {
    return { ok: false, status: 0, error: String(err.message) };
  }
}

if (undo) {
  const ids: string[] = JSON.parse(await readFile(ARCHIVED_LOG, "utf8"));
  console.log(`Moving ${ids.length} messages back to the inbox`);
  await modifyInBatches(ids, { addLabelIds: ["INBOX"] });
  process.exit(0);
}

const actions: Actions = JSON.parse(await readFile(ROOT + "data/actions.json", "utf8"));
console.log(`${execute ? "EXECUTING" : "DRY RUN"}:`);
console.log(`  archive ${actions.archiveIds.length} messages`);
console.log(`  one-click unsubscribe from ${actions.oneClickUnsubscribe.length} senders`);
if (!execute) {
  console.log("Rerun with --execute to apply.");
  process.exit(0);
}

// Log ids first so `undo` works even if archiving is interrupted.
await writeFile(ARCHIVED_LOG, JSON.stringify(actions.archiveIds));
console.log("Archiving:");
await modifyInBatches(actions.archiveIds, { removeLabelIds: ["INBOX"] });

console.log("Unsubscribing:");
const results = [];
for (const u of actions.oneClickUnsubscribe) {
  const r = await oneClickUnsubscribe(u.url);
  results.push({ ...u, ...r });
  console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.status || ""} ${u.email}`);
}
await writeFile(UNSUB_LOG, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`Done. Unsubscribed ${results.length - failed.length}/${results.length}; failures logged in ${UNSUB_LOG}`);

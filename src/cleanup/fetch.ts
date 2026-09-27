// Downloads metadata (no bodies) for every message outside Spam/Trash into data/messages.jsonl.
// Resumable: already-fetched ids are skipped on rerun.
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { getGmail } from "./auth.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const OUT = ROOT + "data/messages.jsonl";
const IDS = ROOT + "data/ids.json";
const CONCURRENCY = 5;
// Gmail caps "query cost" units per user per minute; messages.get costs 5 units.
// 10 requests/s = 3000 units/min keeps us well under it.
const MIN_INTERVAL_MS = 100;
const HEADERS = ["From", "Subject", "Date", "List-Unsubscribe", "List-Unsubscribe-Post", "List-Id"];

export type MessageMeta = {
  id: string;
  threadId: string;
  labels: string[];
  date: number;
  from: string;
  subject: string;
  snippet: string;
  listUnsubscribe?: string;
  listUnsubscribePost?: string;
  listId?: string;
};

const gmail = await getGmail();
await mkdir(ROOT + "data", { recursive: true });

const done = new Set<string>();
try {
  for (const line of (await readFile(OUT, "utf8")).split("\n")) if (line) done.add(JSON.parse(line).id);
} catch {}

let nextSlot = 0;
async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL_MS;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

async function withRetry<T>(fn: () => Promise<T>, attempt = 0): Promise<T> {
  await throttle();
  try {
    return await fn();
  } catch (err: any) {
    const status = err?.status ?? err?.code;
    if (attempt < 10 && (status === 429 || status === 403 || status >= 500)) {
      // Per-minute quota: back off up to a full minute before retrying.
      await new Promise((r) => setTimeout(r, Math.min(60_000, 2000 * 2 ** attempt)));
      return withRetry(fn, attempt + 1);
    }
    throw err;
  }
}

let ids: string[] = [];
try {
  ids = JSON.parse(await readFile(IDS, "utf8"));
} catch {
  let pageToken: string | undefined;
  do {
    const { data } = await withRetry(() => gmail.users.messages.list({ userId: "me", maxResults: 500, pageToken }));
    for (const m of data.messages ?? []) ids.push(m.id!);
    pageToken = data.nextPageToken ?? undefined;
    process.stdout.write(`\rListing: ${ids.length}`);
  } while (pageToken);
  await writeFile(IDS, JSON.stringify(ids));
}
console.log(`\nTotal ${ids.length}, already fetched ${done.size}`);

const todo = ids.filter((id) => !done.has(id));
let fetched = 0;

async function getMeta(id: string): Promise<MessageMeta> {
  const { data } = await withRetry(() => gmail.users.messages.get({
    userId: "me",
    id,
    format: "metadata",
    metadataHeaders: HEADERS,
  }));
  const h = (name: string) =>
    data.payload?.headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;
  return {
    id,
    threadId: data.threadId!,
    labels: data.labelIds ?? [],
    date: Number(data.internalDate),
    from: h("From") ?? "",
    subject: h("Subject") ?? "",
    snippet: data.snippet ?? "",
    listUnsubscribe: h("List-Unsubscribe"),
    listUnsubscribePost: h("List-Unsubscribe-Post"),
    listId: h("List-Id"),
  };
}

let next = 0;
async function worker() {
  while (next < todo.length) {
    const id = todo[next++];
    const meta = await getMeta(id);
    await appendFile(OUT, JSON.stringify(meta) + "\n");
    if (++fetched % 100 === 0 || fetched === todo.length) process.stdout.write(`\rFetched ${fetched}/${todo.length}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log("\nDone →", OUT);

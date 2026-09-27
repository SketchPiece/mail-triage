// Downloads metadata (no bodies) for every message outside Spam/Trash into data/messages.jsonl.
// Resumable: already-fetched ids are skipped on rerun.
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { getGmail } from "./auth.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = ROOT + "data/messages.jsonl";
const CONCURRENCY = 10;
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

const ids: string[] = [];
let pageToken: string | undefined;
do {
  const { data } = await gmail.users.messages.list({ userId: "me", maxResults: 500, pageToken });
  for (const m of data.messages ?? []) ids.push(m.id!);
  pageToken = data.nextPageToken ?? undefined;
  process.stdout.write(`\rListing: ${ids.length}`);
} while (pageToken);
console.log(`\nTotal ${ids.length}, already fetched ${done.size}`);

const todo = ids.filter((id) => !done.has(id));
let fetched = 0;

async function getWithRetry(id: string, attempt = 0): Promise<MessageMeta> {
  try {
    const { data } = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: HEADERS,
    });
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
  } catch (err: any) {
    const status = err?.status ?? err?.code;
    if (attempt < 6 && (status === 429 || status === 403 || status >= 500)) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return getWithRetry(id, attempt + 1);
    }
    throw err;
  }
}

let next = 0;
async function worker() {
  while (next < todo.length) {
    const id = todo[next++];
    const meta = await getWithRetry(id);
    await appendFile(OUT, JSON.stringify(meta) + "\n");
    if (++fetched % 100 === 0 || fetched === todo.length) process.stdout.write(`\rFetched ${fetched}/${todo.length}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log("\nDone →", OUT);

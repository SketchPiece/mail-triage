// Turns data/classified.jsonl into a cleanup plan (data/plan.json) and a readable report (data/plan.md).
// Nothing in Gmail is changed here.
import { readFile, writeFile } from "node:fs/promises";
import { loadSenders, type Classified, type Sender } from "./classify.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const MIN_CONFIDENCE = 0.8;
const MAX_MIXED = 0.5;
// Newsletters the owner wants to keep receiving (archived, but not unsubscribed).
const KEEP_SUBSCRIBED = [/@email\.openai\.com$/, /@email\.claude\.com$/, /@mail\.anthropic\.com$/];

export type Action = "archive+unsubscribe" | "archive" | "keep" | "review";
export type PlanItem = { email: string; name: string; category: string; confidence: number; mixed: number; action: Action; inInbox: number; count: number; oneClick: boolean };

function decide(s: Sender, c: Classified): Action {
  if (c.confidence < MIN_CONFIDENCE) return "review";
  if (c.category === "marketing") {
    if (c.mixed >= MAX_MIXED) return "review";
    return KEEP_SUBSCRIBED.some((re) => re.test(s.email)) ? "archive" : "archive+unsubscribe";
  }
  if (c.category === "service") return c.mixed >= MAX_MIXED ? "review" : "archive";
  return "keep";
}

const senders = new Map((await loadSenders()).map((s) => [s.email, s]));
const oneClick = new Set<string>();
for (const line of (await readFile(ROOT + "data/messages.jsonl", "utf8")).split("\n")) {
  if (!line) continue;
  const m = JSON.parse(line);
  if (m.listUnsubscribePost?.includes("One-Click")) {
    const email = (m.from.match(/<([^>]+)>/)?.[1] ?? m.from).trim().toLowerCase();
    oneClick.add(email);
  }
}

const plan: PlanItem[] = [];
for (const line of (await readFile(ROOT + "data/classified.jsonl", "utf8")).split("\n")) {
  if (!line) continue;
  const c: Classified = JSON.parse(line);
  const s = senders.get(c.email);
  if (!s) continue;
  plan.push({
    email: s.email,
    name: s.name,
    category: c.category,
    confidence: Number(c.confidence.toFixed(2)),
    mixed: Number(c.mixed.toFixed(2)),
    action: decide(s, c),
    inInbox: s.inInbox,
    count: s.count,
    oneClick: oneClick.has(s.email),
  });
}
plan.sort((a, b) => b.count - a.count);
await writeFile(ROOT + "data/plan.json", JSON.stringify(plan, null, 2));

const actions: Action[] = ["archive+unsubscribe", "archive", "review", "keep"];
const titles: Record<Action, string> = {
  "archive+unsubscribe": "Archive and unsubscribe",
  archive: "Archive only",
  review: "Needs your review (low confidence or mixed sender)",
  keep: "Keep in inbox",
};
let md = "# Cleanup plan\n\n| Action | Senders | Messages in inbox |\n|---|---|---|\n";
for (const a of actions) {
  const items = plan.filter((p) => p.action === a);
  md += `| ${titles[a]} | ${items.length} | ${items.reduce((n, p) => n + p.inInbox, 0)} |\n`;
}
for (const a of actions) {
  const items = plan.filter((p) => p.action === a);
  md += `\n## ${titles[a]} (${items.length})\n\n| Sender | Category | Conf. | Mixed | Inbox / total | One-click unsub |\n|---|---|---|---|---|---|\n`;
  for (const p of items)
    md += `| ${p.name ? `${p.name} ` : ""}\`${p.email}\` | ${p.category} | ${p.confidence} | ${p.mixed} | ${p.inInbox} / ${p.count} | ${p.oneClick ? "yes" : ""} |\n`;
}
await writeFile(ROOT + "data/plan.md", md);
console.log(md.split("\n## ")[0]);

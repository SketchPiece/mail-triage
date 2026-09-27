// Resolves data/plan.json + per-message results into concrete Gmail actions (data/actions.json).
// Nothing in Gmail is changed here; see apply.ts.
import { readFile, writeFile } from "node:fs/promises";
import type { MessageMeta } from "./fetch.ts";
import type { ClassifiedMessage } from "./classify.ts";
import type { PlanItem } from "./plan.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const MIN_CONFIDENCE = 0.8;
// Keep fresh service mail (security alerts, billing warnings) in the inbox.
const KEEP_RECENT_SERVICE_MS = 14 * 864e5;
// Only unsubscribe from lists that still send mail.
const ACTIVE_WITHIN_MS = 365 * 864e5;

export type Actions = {
  archiveIds: string[];
  oneClickUnsubscribe: { email: string; url: string }[];
  manualUnsubscribe: { email: string; name: string; links: string[] }[];
};

const readJsonl = async <T>(path: string): Promise<T[]> =>
  (await readFile(path, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const senderOf = (m: MessageMeta) => (m.from.match(/<([^>]+)>/)?.[1] ?? m.from).trim().toLowerCase();
const unsubLinks = (header?: string) => [...(header ?? "").matchAll(/<([^>]+)>/g)].map((x) => x[1]);

const plan: PlanItem[] = JSON.parse(await readFile(ROOT + "data/plan.json", "utf8"));
const messages = await readJsonl<MessageMeta>(ROOT + "data/messages.jsonl");
const perMessage = new Map((await readJsonl<ClassifiedMessage>(ROOT + "data/classified-messages.jsonl")).map((c) => [c.id, c]));
const planBySender = new Map(plan.map((p) => [p.email, p]));
const now = Date.now();

const archiveIds: string[] = [];
const latestBySender = new Map<string, MessageMeta>();
const tally = { senderLevel: 0, messageLevel: 0, keptRecentService: 0 };

for (const m of messages) {
  const email = senderOf(m);
  const p = planBySender.get(email);
  if (!p) continue;
  const prev = latestBySender.get(email);
  if (m.listUnsubscribe && (!prev || m.date > prev.date)) latestBySender.set(email, m);
  if (!m.labels.includes("INBOX")) continue;

  let category: string | undefined;
  if (p.action === "archive" || p.action === "archive+unsubscribe") {
    category = p.category;
  } else if (p.action === "review") {
    const c = perMessage.get(m.id);
    if (c && c.confidence >= MIN_CONFIDENCE && (c.category === "marketing" || c.category === "service")) category = c.category;
  }
  if (!category) continue;
  if (category === "service" && now - m.date < KEEP_RECENT_SERVICE_MS) {
    tally.keptRecentService++;
    continue;
  }
  archiveIds.push(m.id);
  if (p.action === "review") tally.messageLevel++;
  else tally.senderLevel++;
}

const oneClickUnsubscribe: Actions["oneClickUnsubscribe"] = [];
const manualUnsubscribe: Actions["manualUnsubscribe"] = [];
for (const p of plan) {
  if (p.action !== "archive+unsubscribe") continue;
  const latest = latestBySender.get(p.email);
  if (!latest || now - latest.date > ACTIVE_WITHIN_MS) continue;
  const links = unsubLinks(latest.listUnsubscribe);
  const https = links.find((l) => l.startsWith("https://"));
  if (https && latest.listUnsubscribePost?.includes("One-Click")) oneClickUnsubscribe.push({ email: p.email, url: https });
  else manualUnsubscribe.push({ email: p.email, name: p.name, links });
}
// Active marketing senders with no List-Unsubscribe header at all.
for (const p of plan) {
  if (p.action !== "archive+unsubscribe" || latestBySender.has(p.email)) continue;
  const last = Math.max(...messages.filter((m) => senderOf(m) === p.email).map((m) => m.date));
  if (now - last <= ACTIVE_WITHIN_MS) manualUnsubscribe.push({ email: p.email, name: p.name, links: [] });
}

const actions: Actions = { archiveIds, oneClickUnsubscribe, manualUnsubscribe };
await writeFile(ROOT + "data/actions.json", JSON.stringify(actions, null, 2));

let md = "# Unsubscribe manually\n\nThese senders don't support one-click unsubscribe.\n\n";
for (const u of manualUnsubscribe) {
  md += `- **${u.name || u.email}** \`${u.email}\``;
  md += u.links.length ? `: ${u.links.map((l) => (l.startsWith("mailto:") ? `\`${l}\`` : `[link](${l})`)).join(", ")}\n` : ": no unsubscribe link in headers\n";
}
await writeFile(ROOT + "data/manual-unsubscribe.md", md);

console.log(
  `Archive ${archiveIds.length} messages (${tally.senderLevel} by sender, ${tally.messageLevel} by message; kept ${tally.keptRecentService} recent service)\n` +
    `One-click unsubscribe: ${oneClickUnsubscribe.length} senders\n` +
    `Manual unsubscribe: ${manualUnsubscribe.length} senders → data/manual-unsubscribe.md`,
);

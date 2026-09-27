// Classifies senders with Jev (typesafe/jev-1.13) via OpenRouter's Decisions API.
//
//   pnpm -s run classify probe            one sender, prints the raw response
//   pnpm -s run classify eval             senders from data/labels.json, prints accuracy
//   pnpm -s run classify all              every sender → data/classified.jsonl (resumable)
import { readFile, appendFile } from "node:fs/promises";
import type { MessageMeta } from "./fetch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const MESSAGES = ROOT + "data/messages.jsonl";
const LABELS = ROOT + "data/labels.json";
const OUT = ROOT + "data/classified.jsonl";
const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const MODEL = "typesafe/jev-1.13";
const CONCURRENCY = 8;
const SAMPLES = 6;

export const CATEGORIES = {
  marketing:
    "Promotions, sales, newsletters, product announcements, onboarding/tips drip emails, contests, event invites, surveys and review requests",
  service:
    "Automated account notices: sign-in and security alerts, 'you shared data with an app', terms/privacy updates, app activity notifications, email confirmations, developer tool notifications",
  finance:
    "Money: receipts, invoices, bills paid, bank or card statements, transfers, deposits, payment confirmations, tax documents",
  shopping: "Orders and deliveries: order confirmations, shipping and delivery tracking, returns",
  travel: "Travel bookings: flights, itineraries, schedule changes, hotels, car rentals, trip tickets",
  personal: "A real person writing directly (friends, family, colleagues), not an automated system",
} as const;
export type Category = keyof typeof CATEGORIES;

export type Sender = {
  email: string;
  name: string;
  count: number;
  unread: number;
  inInbox: number;
  withUnsubscribe: number;
  lastDate: number;
  samples: { subject: string; snippet: string }[];
};

export type Classified = {
  email: string;
  category: Category;
  confidence: number;
  probabilities: Record<string, number>;
  mixed: number;
  cost: number;
};

function parseFrom(from: string) {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  return m ? { name: m[1].trim(), email: m[2].toLowerCase() } : { name: "", email: from.trim().toLowerCase() };
}

export async function loadSenders(): Promise<Sender[]> {
  const bySender = new Map<string, { sender: Sender; msgs: MessageMeta[] }>();
  for (const line of (await readFile(MESSAGES, "utf8")).split("\n")) {
    if (!line) continue;
    const msg: MessageMeta = JSON.parse(line);
    if (msg.labels.includes("SENT") || msg.labels.includes("DRAFT")) continue;
    const { name, email } = parseFrom(msg.from);
    let entry = bySender.get(email);
    if (!entry) {
      entry = {
        sender: { email, name, count: 0, unread: 0, inInbox: 0, withUnsubscribe: 0, lastDate: 0, samples: [] },
        msgs: [],
      };
      bySender.set(email, entry);
    }
    const s = entry.sender;
    s.count++;
    if (msg.labels.includes("UNREAD")) s.unread++;
    if (msg.labels.includes("INBOX")) s.inInbox++;
    if (msg.listUnsubscribe) s.withUnsubscribe++;
    s.lastDate = Math.max(s.lastDate, msg.date);
    if (!s.name && name) s.name = name;
    entry.msgs.push(msg);
  }
  for (const { sender, msgs } of bySender.values()) {
    // Most recent messages with distinct subjects.
    const seen = new Set<string>();
    for (const m of msgs.sort((a, b) => b.date - a.date)) {
      const key = m.subject.replace(/[\d#$.,]+/g, "").trim();
      if (seen.has(key)) continue;
      seen.add(key);
      sender.samples.push({ subject: m.subject, snippet: m.snippet.replace(/[\s͏‌﻿]+/g, " ").slice(0, 160) });
      if (sender.samples.length === SAMPLES) break;
    }
  }
  return [...bySender.values()].map((e) => e.sender).sort((a, b) => b.count - a.count);
}

function buildRequest(s: Sender) {
  return {
    model: MODEL,
    state: {
      sender: s.name ? `${s.name} <${s.email}>` : s.email,
      emails_received: s.count,
      share_with_unsubscribe_header: Number((s.withUnsubscribe / s.count).toFixed(2)),
      recent_emails: s.samples,
    },
    questions: {
      category: {
        type: "choice",
        instructions: "Which kind of emails does this sender send? Judge by the sender and the recent email subjects.",
        criteria: CATEGORIES,
      },
      mixed: {
        type: "noul",
        instructions:
          "Does this sender mix promotional emails with important personal ones (receipts, statements, bookings, security alerts) that the owner may need to keep?",
      },
    },
  };
}

class RetryableError extends Error {}

async function decide(body: unknown, attempt = 0): Promise<any> {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) throw new RetryableError(`HTTP ${res.status}`);
    const json = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
    return json;
  } catch (err) {
    if (err instanceof RetryableError && attempt < 6) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return decide(body, attempt + 1);
    }
    throw err;
  }
}

async function classify(s: Sender): Promise<Classified> {
  const res = await decide(buildRequest(s));
  const c = res.answers.category;
  return {
    email: s.email,
    category: c.choice,
    confidence: c.confidence ?? c.probabilities?.[c.choice] ?? 0,
    probabilities: c.probabilities ?? {},
    mixed: res.answers.mixed?.noul ?? 0,
    cost: res.usage?.cost ?? 0,
  };
}

async function runPool<T, R>(items: T[], fn: (item: T) => Promise<R>, onResult: (r: R, i: number) => Promise<void> | void) {
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) {
        const i = next++;
        await onResult(await fn(items[i]), i);
      }
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2] ?? "probe";
  const senders = await loadSenders();

  if (mode === "probe") {
    const s = senders[0];
    console.log(JSON.stringify(buildRequest(s), null, 2));
    console.log(JSON.stringify(await decide(buildRequest(s)), null, 2));
  } else if (mode === "eval") {
    const labels: Record<string, Category> = JSON.parse(await readFile(LABELS, "utf8"));
    const bySender = new Map(senders.map((s) => [s.email, s]));
    const items = Object.keys(labels).filter((e) => bySender.has(e)).map((e) => bySender.get(e)!);
    const results: Classified[] = [];
    await runPool(items, classify, (r) => void results.push(r));
    let cost = 0;
    const bands = [0.8, 0.5, 0].map((min) => ({ min, ok: 0, n: 0 }));
    const wrong: string[] = [];
    for (const r of results) {
      cost += r.cost;
      const ok = r.category === labels[r.email];
      const band = bands.find((b) => r.confidence >= b.min)!;
      band.n++;
      if (ok) band.ok++;
      else wrong.push(`  ${r.email}: expected ${labels[r.email]}, got ${r.category} (${r.confidence.toFixed(2)})`);
    }
    const correct = bands.reduce((a, b) => a + b.ok, 0);
    console.log(`Accuracy ${correct}/${results.length} (${((100 * correct) / results.length).toFixed(1)}%), cost $${cost.toFixed(5)}`);
    for (const b of bands) console.log(`  confidence ≥${b.min}: ${b.ok}/${b.n}`);
    if (wrong.length) console.log("Mistakes:\n" + wrong.join("\n"));
    const missing = Object.keys(labels).filter((e) => !bySender.has(e));
    if (missing.length) console.log(`Not in export yet: ${missing.length}`);
  } else if (mode === "all") {
    const done = new Set<string>();
    try {
      for (const line of (await readFile(OUT, "utf8")).split("\n")) if (line) done.add(JSON.parse(line).email);
    } catch {}
    const todo = senders.filter((s) => !done.has(s.email));
    let cost = 0;
    let n = 0;
    await runPool(todo, classify, async (r) => {
      cost += r.cost;
      await appendFile(OUT, JSON.stringify(r) + "\n");
      if (++n % 50 === 0 || n === todo.length) process.stdout.write(`\rClassified ${n}/${todo.length}, $${cost.toFixed(4)}`);
    });
    console.log(`\nDone → ${OUT}`);
  } else {
    console.error(`Unknown mode: ${mode}`);
    process.exit(1);
  }
}

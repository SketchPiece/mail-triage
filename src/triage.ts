// Triage of a single message: category (from sender knowledge or Jev), whether it needs action, how urgent.
import { config } from "./config.ts";
import { getSender, upsertTriage, type Category, type MessageRow, type TriageRow } from "./db.ts";

const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const MODEL = "typesafe/jev-1.13";

export const CATEGORIES: Record<Category, string> = {
  marketing:
    "Promotions, sales, newsletters, product announcements, onboarding/tips drip emails, contests, event invites, surveys and review requests",
  service:
    "Automated account notices: sign-in and security alerts, 'you shared data with an app', terms/privacy updates, app activity notifications, email confirmations, developer tool notifications",
  finance:
    "Money: receipts, invoices, bills paid, bank or card statements, transfers, deposits, payment confirmations, tax documents",
  shopping: "Orders and deliveries: order confirmations, shipping and delivery tracking, returns",
  travel: "Travel bookings: flights, itineraries, schedule changes, hotels, car rentals, trip tickets",
  personal: "A real person writing directly (friends, family, colleagues), not an automated system",
};

const NEEDS_ACTION = {
  type: "noul",
  instructions:
    "Does the mailbox owner need to do something because of this email (reply, confirm, pay, accept, review a change, fix a problem, act before a deadline)? Plain receipts, notices that need no response, and marketing are 'no'.",
};
const URGENCY = {
  type: "score",
  instructions: "How time-sensitive is this email for the owner?",
  criteria: ["No deadline or purely informational", "Should be handled within days", "Needs attention today or is already overdue"],
};

// Invisible filler chars that newsletters pad snippets with (soft hyphen, CGJ, zero-width, BOM, ...).
const INVISIBLE = [0x00ad, 0x034f, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0xfeff];
const NOISE = new RegExp("[\\s\\p{Cc}" + String.fromCodePoint(...INVISIBLE) + "]+", "gu");

export function clean(text: string, max: number) {
  const flat = text.replace(NOISE, " ").trim();
  return Array.from(flat).slice(0, max).join("").toWellFormed();
}

class RetryableError extends Error {}

async function decide(body: unknown, attempt = 0): Promise<any> {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openrouterKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429 || res.status >= 500) throw new RetryableError(`HTTP ${res.status}`);
    const json = await res.json();
    if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    return json;
  } catch (err) {
    if (err instanceof RetryableError && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return decide(body, attempt + 1);
    }
    throw err;
  }
}

export async function triageMessage(m: MessageRow): Promise<TriageRow> {
  const known = getSender(m.account, m.from_email);
  const trusted =
    known && (known.source === "override" || (known.confidence >= config.minConfidence && known.mixed < 0.5));

  let row: TriageRow;
  if (trusted && known.category === "marketing") {
    // Known marketing sender: no model call needed.
    row = { account: m.account, message_id: m.id, category: "marketing", confidence: known.confidence, needs_action: 0, urgency: 0, source: known.source === "override" ? "override" : "sender" };
  } else {
    const questions: Record<string, unknown> = { needs_action: NEEDS_ACTION, urgency: URGENCY };
    if (!trusted) {
      questions.category = {
        type: "choice",
        instructions: "Which kind of email is this? Judge by the sender, subject and snippet.",
        criteria: CATEGORIES,
      };
    }
    const res = await decide({
      model: MODEL,
      state: {
        from: m.from_name ? `${clean(m.from_name, 100)} <${m.from_email}>` : m.from_email,
        subject: clean(m.subject, 200),
        snippet: clean(m.snippet, 300),
        has_unsubscribe_header: Boolean(m.list_unsubscribe),
        ...(trusted ? { sender_category: known.category } : {}),
      },
      questions,
    });
    const a = res.answers;
    const category: Category = trusted ? known.category : a.category.choice;
    const confidence = trusted ? known.confidence : (a.category.confidence ?? a.category.probabilities?.[category] ?? 0);
    row = {
      account: m.account,
      message_id: m.id,
      category,
      confidence,
      needs_action: category === "marketing" ? 0 : (a.needs_action?.noul ?? 0),
      urgency: category === "marketing" ? 0 : (a.urgency?.score ?? 0),
      source: trusted ? (known.source === "override" ? "override" : "sender") : "jev",
    };
  }
  upsertTriage(row);
  return row;
}

// Gmail provider: per-account OAuth clients and the few API calls triage needs.
import { readFile } from "node:fs/promises";
import { authenticate } from "@google-cloud/local-auth";
import { auth, gmail as createGmail, type gmail_v1 } from "@googleapis/gmail";
import { config } from "./config.ts";
import { db, type MessageRow } from "./db.ts";

export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.settings.basic",
];
const METADATA_HEADERS = ["From", "Subject", "Date", "List-Unsubscribe", "List-Unsubscribe-Post"];
// Gmail caps query-cost units per user per minute; messages.get costs 5. 10 req/s stays well under.
const MIN_INTERVAL_MS = 100;

type Gmail = gmail_v1.Gmail;
const clients = new Map<string, Gmail>();

async function oauthClientInfo() {
  const { installed } = JSON.parse(await readFile(config.googleCredentials, "utf8"));
  return { clientId: installed.client_id as string, clientSecret: installed.client_secret as string };
}

export async function gmailFor(account: string): Promise<Gmail> {
  const cached = clients.get(account);
  if (cached) return cached;
  const row = db.prepare(`SELECT refresh_token FROM accounts WHERE email = ?`).get(account) as { refresh_token: string } | undefined;
  if (!row) throw new Error(`Unknown account ${account}. Add it with: npm run cli -- accounts add`);
  const { clientId, clientSecret } = await oauthClientInfo();
  const client = new auth.OAuth2(clientId, clientSecret);
  client.setCredentials({ refresh_token: row.refresh_token });
  const g = createGmail({ version: "v1", auth: client });
  clients.set(account, g);
  return g;
}

// Opens the browser consent screen and stores the account's refresh token.
export async function addAccount(): Promise<string> {
  const client = await authenticate({ scopes: SCOPES, keyfilePath: config.googleCredentials });
  const refresh = client.credentials.refresh_token;
  if (!refresh) throw new Error("Google returned no refresh token. Remove the app at myaccount.google.com/permissions and retry.");
  const g = createGmail({ version: "v1", auth: client as any });
  const { data } = await g.users.getProfile({ userId: "me" });
  const email = data.emailAddress!.toLowerCase();
  const hasDefault = db.prepare(`SELECT 1 FROM accounts WHERE is_default = 1`).get();
  db.prepare(
    `INSERT INTO accounts (email, refresh_token, is_default, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (email) DO UPDATE SET refresh_token = excluded.refresh_token`,
  ).run(email, refresh, hasDefault ? 0 : 1, Date.now());
  clients.delete(email);
  return email;
}

let nextSlot = 0;
async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL_MS;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

export async function withRetry<T>(fn: () => Promise<T>, attempt = 0): Promise<T> {
  await throttle();
  try {
    return await fn();
  } catch (err: any) {
    const status = err?.status ?? err?.code;
    if (attempt < 8 && (status === 429 || status === 403 || status >= 500)) {
      await new Promise((r) => setTimeout(r, Math.min(60_000, 2000 * 2 ** attempt)));
      return withRetry(fn, attempt + 1);
    }
    throw err;
  }
}

export function parseFrom(from: string) {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  return m ? { name: m[1].trim(), email: m[2].toLowerCase() } : { name: "", email: from.trim().toLowerCase() };
}

export async function getMetadata(account: string, id: string): Promise<MessageRow> {
  const g = await gmailFor(account);
  const { data } = await withRetry(() =>
    g.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: METADATA_HEADERS }),
  );
  const h = (name: string) => data.payload?.headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
  const from = parseFrom(h("From") ?? "");
  return {
    account,
    id,
    thread_id: data.threadId!,
    date: Number(data.internalDate),
    from_email: from.email,
    from_name: from.name,
    subject: h("Subject") ?? "",
    snippet: data.snippet ?? "",
    labels: JSON.stringify(data.labelIds ?? []),
    list_unsubscribe: h("List-Unsubscribe"),
    list_unsubscribe_post: h("List-Unsubscribe-Post"),
  };
}

export async function getLabels(account: string, id: string): Promise<string[] | null> {
  const g = await gmailFor(account);
  try {
    const { data } = await withRetry(() => g.users.messages.get({ userId: "me", id, format: "minimal" }));
    return data.labelIds ?? [];
  } catch (err: any) {
    if ((err?.status ?? err?.code) === 404) return null; // deleted
    throw err;
  }
}

export async function currentHistoryId(account: string): Promise<string> {
  const g = await gmailFor(account);
  const { data } = await withRetry(() => g.users.getProfile({ userId: "me" }));
  return data.historyId!;
}

// Changes since startHistoryId. Returns null when the id is too old and a full resync is needed.
export async function historySince(account: string, startHistoryId: string) {
  const g = await gmailFor(account);
  const added = new Set<string>();
  const labelChanged = new Set<string>();
  let pageToken: string | undefined;
  let latest = startHistoryId;
  try {
    do {
      const { data } = await withRetry(() =>
        g.users.history.list({
          userId: "me",
          startHistoryId,
          pageToken,
          historyTypes: ["messageAdded", "labelAdded", "labelRemoved"],
        }),
      );
      for (const h of data.history ?? []) {
        for (const a of h.messagesAdded ?? []) added.add(a.message!.id!);
        for (const l of [...(h.labelsAdded ?? []), ...(h.labelsRemoved ?? [])]) labelChanged.add(l.message!.id!);
      }
      latest = data.historyId ?? latest;
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err: any) {
    if ((err?.status ?? err?.code) === 404) return null;
    throw err;
  }
  for (const id of added) labelChanged.delete(id);
  return { added: [...added], labelChanged: [...labelChanged], historyId: latest };
}

export async function listIds(account: string, q: string): Promise<string[]> {
  const g = await gmailFor(account);
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const { data } = await withRetry(() => g.users.messages.list({ userId: "me", q, maxResults: 500, pageToken }));
    for (const m of data.messages ?? []) ids.push(m.id!);
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);
  return ids;
}

function decodeBody(data?: string | null) {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

function htmlToText(html: string) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Plain-text body: prefers text/plain, falls back to stripped HTML.
export async function getBodyText(account: string, id: string): Promise<string> {
  const g = await gmailFor(account);
  const { data } = await withRetry(() => g.users.messages.get({ userId: "me", id, format: "full" }));
  let plain = "";
  let html = "";
  const walk = (part?: gmail_v1.Schema$MessagePart) => {
    if (!part) return;
    if (part.mimeType === "text/plain" && !plain) plain = decodeBody(part.body?.data);
    else if (part.mimeType === "text/html" && !html) html = decodeBody(part.body?.data);
    for (const p of part.parts ?? []) walk(p);
  };
  walk(data.payload);
  const text = plain || htmlToText(html);
  return text.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}

// Removes only the UNREAD label from exactly these messages; every other label stays as is.
export async function removeUnread(account: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const g = await gmailFor(account);
  await withRetry(() => g.users.messages.batchModify({ userId: "me", requestBody: { ids, removeLabelIds: ["UNREAD"] } }));
}

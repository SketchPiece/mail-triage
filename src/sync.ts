// Incremental sync: pulls new messages via Gmail history, refreshes changed labels, triages new inbox mail.
import { db, labelsOf, setLabels, upsertMessage, type MessageRow } from "./db.ts";
import { currentHistoryId, getLabels, getMetadata, historySince, listIds } from "./gmail.ts";
import { triageMessage } from "./triage.ts";

const CONCURRENCY = 5;
// On first sync (or when history expired) look back this far.
const BOOTSTRAP_QUERY = "in:inbox newer_than:14d";

async function pool<T>(items: T[], fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

const isTriaged = (account: string, id: string) =>
  Boolean(db.prepare(`SELECT 1 FROM triage WHERE account = ? AND message_id = ?`).get(account, id));
const isKnown = (account: string, id: string) =>
  Boolean(db.prepare(`SELECT 1 FROM messages WHERE account = ? AND id = ?`).get(account, id));

async function ingest(account: string, ids: string[], stats: SyncStats) {
  await pool(ids, async (id) => {
    let m: MessageRow;
    try {
      m = await getMetadata(account, id);
    } catch (err: any) {
      if ((err?.status ?? err?.code) === 404) return; // deleted before we got to it
      throw err;
    }
    upsertMessage(m);
    stats.fetched++;
    const labels = labelsOf(m);
    if (labels.includes("INBOX") && !labels.includes("SENT") && !isTriaged(account, id)) {
      try {
        await triageMessage(m);
        stats.triaged++;
      } catch (err: any) {
        stats.errors.push(`${id}: ${String(err.message).slice(0, 150)}`);
      }
    }
  });
}

export type SyncStats = { account: string; fetched: number; triaged: number; labelUpdates: number; errors: string[] };

export async function syncAccount(account: string): Promise<SyncStats> {
  const stats: SyncStats = { account, fetched: 0, triaged: 0, labelUpdates: 0, errors: [] };
  const acc = db.prepare(`SELECT history_id FROM accounts WHERE email = ?`).get(account) as { history_id: string | null };
  const changes = acc.history_id ? await historySince(account, acc.history_id) : null;

  if (!changes) {
    const historyId = await currentHistoryId(account);
    const ids = await listIds(account, BOOTSTRAP_QUERY);
    await ingest(account, ids.filter((id) => !isKnown(account, id) || !isTriaged(account, id)), stats);
    db.prepare(`UPDATE accounts SET history_id = ?, last_sync_at = ? WHERE email = ?`).run(historyId, Date.now(), account);
    return stats;
  }

  await ingest(account, changes.added, stats);
  await pool(changes.labelChanged.filter((id) => isKnown(account, id)), async (id) => {
    const labels = await getLabels(account, id);
    if (labels) {
      setLabels(account, id, labels);
      stats.labelUpdates++;
    }
  });
  db.prepare(`UPDATE accounts SET history_id = ?, last_sync_at = ? WHERE email = ?`).run(changes.historyId, Date.now(), account);
  return stats;
}

export const listAccounts = () =>
  db.prepare(`SELECT email, is_default, last_sync_at FROM accounts ORDER BY is_default DESC, email`).all() as {
    email: string;
    is_default: number;
    last_sync_at: number | null;
  }[];

let running: Promise<SyncStats[]> | null = null;

// Syncs every account; concurrent callers share the in-flight run.
export function syncAll(): Promise<SyncStats[]> {
  running ??= (async () => {
    try {
      const out: SyncStats[] = [];
      for (const a of listAccounts()) out.push(await syncAccount(a.email));
      return out;
    } finally {
      running = null;
    }
  })();
  return running;
}

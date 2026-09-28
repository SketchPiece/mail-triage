// Marking mail read. Only messages the last digest or list showed the owner can be touched, only UNREAD is removed.
import { db, getShown, labelsOf, setLabels } from "./db.ts";
import { removeUnread } from "./gmail.ts";

// How long a shown list stays markable: the question "mark them read?" comes right after it.
export const SHOWN_TTL_MS = 30 * 60_000;
export const MAX_IDS = 50;

type Remove = (account: string, ids: string[]) => Promise<void>;

export async function markRead(opts: { ids?: string[]; account?: string }, remove: Remove = removeUnread) {
  const shown = getShown(Date.now() - SHOWN_TTL_MS).filter(
    (m) => !opts.account || m.account === opts.account.toLowerCase() || m.account.startsWith(opts.account.toLowerCase() + "@"),
  );
  if (!shown.length) throw new Error("No messages were shown to the owner in the last 30 minutes. Call digest or list first.");
  const requested = opts.ids ? [...new Set(opts.ids)] : null;
  if (requested && requested.length > MAX_IDS) throw new Error(`At most ${MAX_IDS} ids per call.`);
  const targets = requested ? shown.filter((m) => requested.includes(m.id)) : shown;
  const notShown = requested ? requested.filter((id) => !shown.some((m) => m.id === id)) : [];

  const unread = new Map<string, { id: string; labels: string[] }[]>();
  let alreadyRead = 0;
  for (const m of targets) {
    const row = db.prepare(`SELECT labels FROM messages WHERE account = ? AND id = ?`).get(m.account, m.id) as { labels: string } | undefined;
    if (!row) continue;
    const labels = labelsOf(row);
    if (!labels.includes("UNREAD")) {
      alreadyRead++;
      continue;
    }
    unread.set(m.account, [...(unread.get(m.account) ?? []), { id: m.id, labels }]);
  }

  let marked = 0;
  for (const [account, items] of unread) {
    await remove(account, items.map((i) => i.id));
    for (const i of items) setLabels(account, i.id, i.labels.filter((l) => l !== "UNREAD"));
    marked += items.length;
  }
  return { marked, already_read: alreadyRead, ...(notShown.length ? { not_shown: notShown } : {}) };
}

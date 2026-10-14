// MCP tools. Names carry no prefix: clients namespace them (Volna exposes them as mail_<tool>).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { accountsInfo, digest, list, read } from "./digest.ts";
import { markRead, MAX_IDS } from "./mark.ts";
import { syncAll } from "./sync.ts";

const CATEGORY = z.enum(["marketing", "service", "finance", "shopping", "travel", "personal"]);
const ACCOUNT = z
  .string()
  .optional()
  .describe('Mailbox address or its local part; "all" for every connected mailbox. Omit for the default mailbox.');
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const SYNC_WAIT_MS = 20_000;

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const fail = (err: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
});

export function createMcpServer() {
  const server = new McpServer({ name: "mail-triage", version: "0.1.0" });

  server.registerTool(
    "digest",
    {
      title: "Mail digest",
      description:
        "Overview of recent inbox mail, already triaged: items that need the owner's action (with urgency), notable mail grouped by category (finance, travel, shopping, personal), and counts of the rest (marketing, service notices). Call when the owner asks what's in the mail, if anything important came, or for a mail summary.",
      inputSchema: {
        account: ACCOUNT,
        since_hours: z.number().int().min(1).max(24 * 30).optional().describe("Look-back window in hours. Default 24."),
        detail: z.enum(["brief", "full"]).optional().describe("brief (default): top action items and per-category counts; full: every item."),
      },
      annotations: { title: "Mail digest", ...READ_ONLY },
    },
    async ({ account, since_hours, detail }) => {
      try {
        return json(digest({ account, sinceHours: since_hours, detail }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "list",
    {
      title: "List mail",
      description:
        "Lists inbox messages filtered by digest group, category or sender, newest first, with a short snippet. Call when the owner asks for details about a group from the digest (\"what's in finance?\", \"what needs action?\") or about mail from someone.",
      inputSchema: {
        account: ACCOUNT,
        group: z.enum(["action", "notable", "other"]).optional(),
        category: CATEGORY.optional(),
        sender: z.string().optional().describe("Part of the sender's name or address, e.g. 'delta' or 'stripe'."),
        since_hours: z.number().int().min(1).max(24 * 365).optional().describe("Default: 7 days, or 90 days when filtering by sender."),
        include_archived: z.boolean().optional().describe("Also include messages no longer in the inbox. Default false."),
        limit: z.number().int().min(1).max(30).optional().describe("Default 10."),
      },
      annotations: { title: "List mail", ...READ_ONLY },
    },
    async (args) => {
      try {
        return json(
          list({
            account: args.account,
            group: args.group,
            category: args.category,
            sender: args.sender,
            sinceHours: args.since_hours,
            includeArchived: args.include_archived,
            limit: args.limit,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "read",
    {
      title: "Read message",
      description:
        "Full plain-text body of one message by id (ids come from digest or list). Call when the owner wants to know what a specific email actually says.",
      inputSchema: { id: z.string(), account: ACCOUNT },
      annotations: { title: "Read message", ...READ_ONLY, openWorldHint: true },
    },
    async ({ id, account }) => {
      try {
        return json(await read({ id, account }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "accounts",
    {
      title: "Mail accounts",
      description: "Connected mailboxes, which one is default, and when each was last synced.",
      inputSchema: {},
      annotations: { title: "Mail accounts", ...READ_ONLY },
    },
    async () => {
      try {
        return json(accountsInfo());
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "sync",
    {
      title: "Check for new mail",
      description:
        "Fetches and triages mail that arrived since the last background sync (it runs every few minutes anyway). Call only when the owner explicitly asks to check for new mail right now.",
      inputSchema: {},
      annotations: { title: "Check for new mail", ...READ_ONLY, openWorldHint: true },
    },
    async () => {
      try {
        const run = syncAll();
        const result = await Promise.race([run, new Promise<null>((r) => setTimeout(() => r(null), SYNC_WAIT_MS))]);
        if (!result) return json({ status: "still running in background; call digest shortly" });
        return json(result.map((s) => ({ account: s.account, new_messages: s.triaged, errors: s.errors.length })));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "mark_read",
    {
      title: "Mark mail read",
      description:
        "Marks messages as read in Gmail. Works only on messages the last digest or list call showed (within 30 minutes) and only removes the unread mark: nothing is archived, moved or deleted. Call only after the owner clearly asked for it or said yes to \"mark them read?\". Pass ids to mark some of the shown messages; omit ids to mark everything the last digest or list showed.",
      inputSchema: {
        ids: z
          .array(z.string())
          .min(1)
          .max(MAX_IDS)
          .optional()
          .describe("Ids from the last digest or list. Omit to mark all messages it showed."),
        account: ACCOUNT,
      },
      annotations: {
        title: "Mark mail read",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ ids, account }) => {
      try {
        return json(await markRead({ ids, account }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}

# mail-triage

**Your Gmail, pre-sorted for an AI assistant.** mail-triage is a small self-hosted MCP server that keeps a local, triaged copy of your inbox and answers questions like "anything important in my mail?" in milliseconds, with short, speakable answers.

It syncs new mail in the background, classifies every message (category, does it need action, how urgent), and exposes the result to Claude or any other MCP client through six tools. The assistant gets a ready-made digest instead of crawling raw Gmail, so answers are fast, cheap and consistent.

```text
You:        what's in my mail?
Assistant:  Two things need you: the landlord asked to confirm Friday's
            inspection, and your domain renewal fails tomorrow. Five money
            emails, mostly receipts. One shipping update. Twelve newsletters
            and notices, nothing important. Want the finance details?
```

## Why

Plugging an assistant straight into the Gmail API works, but it is slow and noisy: every "what's new?" means listing threads, fetching dozens of messages and asking a big model to sort them, again and again. For a voice assistant, that latency and token bill kills the experience.

mail-triage moves that work out of the conversation:

- **Triage once, on arrival.** Each new message is classified once when it lands, not every time someone asks.
- **Answers are pre-shaped.** `digest` returns action items first, notable mail grouped by category and a count of the rest, about 1,000 characters, ready to be retold out loud.
- **Safe by construction.** Read-only tools, one narrowly scoped write (`mark_read`) and no way to send, delete or archive mail through MCP.

## Features

- **Incremental Gmail sync** through the History API: only new messages and label changes, every `SYNC_INTERVAL_MIN` minutes (default 10), plus a 14-day bootstrap on first run.
- **Per-message triage** into `marketing`, `service`, `finance`, `shopping`, `travel` or `personal`, with a `needs_action` probability and a 0 to 2 urgency score. Messages from known marketing senders skip the model entirely.
- **Digest groups**: `action` (needs you, sorted by urgency), `notable` (finance, travel, shopping, personal) and `other`.
- **Multiple mailboxes** with a default one; every tool takes an optional `account` (`"all"` works too).
- **Guarded `mark_read`**: it can only touch messages the assistant showed you in the last 30 minutes, and it only removes the `UNREAD` label.
- **One-off inbox cleanup toolkit** (`src/cleanup/`): export metadata, classify every sender, generate a reviewable plan, then archive and one-click unsubscribe, with a dry run and undo.
- **Zero build step**: plain TypeScript run directly by Node 24 (type stripping), SQLite via built-in `node:sqlite`, four runtime dependencies.

## MCP tools

| Tool | What it does | Annotations |
| --- | --- | --- |
| `digest` | Overview of recent inbox mail: action items with urgency, notable mail by category, counts of the rest. Options: `since_hours` (default 24), `detail: brief \| full`. | read-only |
| `list` | Inbox messages filtered by `group`, `category` or `sender`, newest first, with snippets. Optional `include_archived` and `limit`. | read-only |
| `read` | Plain-text body of one message by id (truncated at 5,000 characters). | read-only |
| `accounts` | Connected mailboxes, the default one and last sync time. | read-only |
| `sync` | Check for new mail right now instead of waiting for the background sync. | read-only |
| `mark_read` | Remove `UNREAD` from messages the last `digest` or `list` showed (all of them, or selected `ids`, up to 50). Ids that were not shown come back in `not_shown`, untouched. | write, non-destructive |

Tool names carry no prefix; MCP clients add their own namespace (e.g. `mail_digest`). `digest` and `list` return an `unread_shown` count and a `hint` telling the assistant to ask "mark them read?" and to call `mark_read` only after a clear yes.

## Architecture

```text
             ┌──────────── background, every N min ─────────────┐
Gmail API ──▶│ sync.ts ──▶ triage.ts ──▶ Jev via OpenRouter      │
 (History)   │    │            │      (category, action, urgency)│
             │    ▼            ▼                                 │
             │        db.ts: SQLite (node:sqlite, WAL)           │
             └──────────────────────┬────────────────────────────┘
                                    │
MCP client ──POST /mcp (Bearer)──▶ server.ts ──▶ mcp.ts ──▶ digest.ts / mark.ts
(Claude, voice assistant, ...)
```

| File | Role |
| --- | --- |
| `src/server.ts` | HTTP entry point: stateless Streamable HTTP MCP at `POST /mcp`, Bearer auth (constant-time compare), `GET /health`, background sync timer. |
| `src/mcp.ts` | Tool definitions, zod schemas and MCP annotations. |
| `src/sync.ts` | Incremental sync via Gmail history; concurrent callers share one in-flight run. |
| `src/triage.ts` | Classification. Sender knowledge first, otherwise a structured call to the Jev decision model (`typesafe/jev-1.13`) on OpenRouter with sender, subject and a 300-character snippet. |
| `src/digest.ts` | Read models: digest groups, filtered lists, message body, compact output formatting. |
| `src/mark.ts` | `mark_read` with its "only what was shown" guard (covered by `src/mark.test.ts`). |
| `src/gmail.ts` | Per-account OAuth clients, throttled and retried Gmail calls, HTML to text. |
| `src/db.ts` | SQLite schema: `accounts`, `messages`, `senders`, `triage`, `shown`, all scoped by mailbox. |
| `src/cli.ts` | Owner-only setup: connect or remove mailboxes, sync, re-triage, import cleanup results. |
| `src/cleanup/` | One-off inbox cleanup pipeline (see below). |
| `volna-plugin/mail/` | Plugin for the Volna voice assistant: MCP config, a skill card and routing probes (Russian). |

## Setup

Requirements: Node 24 (see `.node-version`; 22.18+ also works), pnpm, a Google account and an [OpenRouter](https://openrouter.ai) API key.

### 1. Google OAuth client

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project and enable the **Gmail API**.
2. Under **Google Auth Platform**, configure the consent screen (External) and add your address as a test user.
3. Create an **OAuth client ID** of type **Desktop app** and download the JSON as `credentials.json` in the repo root.
4. Apps in *Testing* get refresh tokens that expire after 7 days. For a long-running personal server, publish the app (Audience → Publish app). Google will show an "unverified app" warning on sign-in, which is fine for your own account.

Scopes requested: `gmail.modify` (read mail and remove the unread label) and `gmail.settings.basic` (used by the cleanup toolkit).

### 2. Configure and connect a mailbox

```sh
pnpm install
cp .env.example .env     # set OPENROUTER_API_KEY and MAIL_TRIAGE_TOKEN (openssl rand -hex 32)

pnpm cli accounts add    # opens Google sign-in in the browser
pnpm cli sync            # fetches and triages the last 14 days of inbox mail
pnpm start               # MCP server on http://127.0.0.1:8790/mcp
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | (empty) | Key for triage calls. Without it the server runs but new mail is not triaged. |
| `MAIL_TRIAGE_TOKEN` | (empty) | Bearer token clients must send. Required when `HOST` is not loopback. |
| `HOST` / `PORT` | `127.0.0.1` / `8790` | Listen address. |
| `SYNC_INTERVAL_MIN` | `10` | Background sync interval. |
| `GOOGLE_CREDENTIALS` | `credentials.json` | Path to the OAuth client file. |
| `DATA_DIR` | `data` | Where the SQLite database lives. |
| `TZ` | system | Time zone for dates in answers. |

Other CLI commands: `pnpm cli accounts`, `accounts default <email>`, `accounts remove <email>`, `retriage [days]`.

### 3. Run as a macOS launchd service

`deploy/mail-triage.example.plist` is a LaunchAgent template that keeps the server running and restarts it if it exits:

```sh
sed -e "s|__LABEL__|com.$USER.mail-triage|g" \
    -e "s|__DIR__|$PWD|g" \
    -e "s|__NODE__|$(command -v node)|g" \
    deploy/mail-triage.example.plist > ~/Library/LaunchAgents/com.$USER.mail-triage.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.$USER.mail-triage.plist
```

Logs go to `data/server.log`. Stop it with `launchctl bootout gui/$(id -u)/com.$USER.mail-triage`.

A `railway.json` (Railpack, `/health` check) is included for hosting on Railway; mount a persistent volume for `DATA_DIR` and provide the OAuth client file through `GOOGLE_CREDENTIALS`.

## Use with Claude and other MCP clients

**Claude Code:**

```sh
claude mcp add --transport http mail http://127.0.0.1:8790/mcp \
  --header "Authorization: Bearer $MAIL_TRIAGE_TOKEN"
```

Then ask: "what's in my mail today?", "anything that needs action?", "what did my bank send this week?", "read the second one", "mark them read".

**Any client with Streamable HTTP support** works the same way: point it at `http://<host>:8790/mcp` and send `Authorization: Bearer <token>`. For clients that only speak stdio, use a bridge such as `mcp-remote`.

**Volna voice assistant:** `volna-plugin/mail` contains `.mcp.json` (reads `MAIL_TRIAGE_URL` and `MAIL_TRIAGE_TOKEN`), a skill card that teaches the assistant how to retell the digest out loud and when to offer `mark_read`, and should / should-not routing probes.

## One-off inbox cleanup

For an inbox with years of backlog, `src/cleanup/` runs a reviewable, reversible cleanup before the server takes over:

```sh
pnpm cleanup:export            # metadata of every message (no bodies) → data/messages.jsonl
pnpm classify all              # classify each sender → data/classified.jsonl
pnpm cleanup:plan              # per-sender plan → data/plan.json + readable data/plan.md
pnpm classify messages         # per-message pass for senders marked "review"
pnpm cleanup:actions           # resolve concrete actions → data/actions.json
pnpm apply                     # dry run
pnpm apply --execute           # archive + RFC 8058 one-click unsubscribe
pnpm apply undo                # move everything archived back to the inbox
pnpm cli import-cleanup <email>   # reuse the sender knowledge for live triage
```

The cleanup scripts sign in through their own `token.json` (created on first run). Nothing is ever deleted; archived ids are logged so `undo` can restore them.

## Privacy and security

This tool reads personal email, so it is built to keep that data close:

- **Everything is stored locally** in `data/mail-triage.db`: message metadata (sender, subject, snippet, labels), triage results and each mailbox's Google refresh token. `data/`, `credentials.json`, `token*.json` and `.env` are gitignored. Treat the database like a password file.
- **What leaves your machine for triage**: sender name and address, subject and the first 300 characters of the snippet, sent to OpenRouter for classification. Message bodies are never sent to the triage model.
- **Bodies are fetched on demand** only when a client calls `read`, and are returned to that client (which may be an LLM provider you use).
- **No send, delete or archive through MCP.** The only write is removing `UNREAD` from messages you were just shown. Connecting or removing mailboxes is CLI-only, never exposed over MCP.
- **Auth**: the server refuses to listen beyond localhost without `MAIL_TRIAGE_TOKEN`. Keep it on loopback or behind a private network.
- To disconnect a mailbox: `pnpm cli accounts remove <email>`, then revoke access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Development

```sh
pnpm typecheck
pnpm test
```

CI runs both on every push and pull request (`.github/workflows/ci.yml`).

## License

[MIT](LICENSE) © 2026 Andrew Lubkin

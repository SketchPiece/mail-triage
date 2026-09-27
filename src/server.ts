// HTTP entry point: stateless Streamable HTTP MCP at /mcp, health check, background sync timer.
import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.ts";
import { createMcpServer } from "./mcp.ts";
import { listAccounts, syncAll } from "./sync.ts";

const LOOPBACK = ["127.0.0.1", "::1", "localhost"];
if (!config.token && !LOOPBACK.includes(config.host)) {
  console.error("MAIL_TRIAGE_TOKEN is required when listening beyond localhost.");
  process.exit(1);
}
if (!config.openrouterKey) console.warn("OPENROUTER_API_KEY is not set: new mail will not be triaged.");

function authorized(req: IncomingMessage) {
  if (!config.token) return true;
  const got = Buffer.from(req.headers.authorization ?? "");
  const want = Buffer.from(`Bearer ${config.token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

const http = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, accounts: listAccounts().length }));
    return;
  }
  if (path !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  if (!authorized(req)) {
    res.writeHead(401).end();
    return;
  }
  if (req.method !== "POST") {
    // Stateless server: no standalone SSE stream, no sessions to delete.
    res.writeHead(405, { Allow: "POST" }).end();
    return;
  }
  try {
    const body = await readBody(req);
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error("MCP request failed:", err instanceof Error ? err.message : err);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

async function backgroundSync() {
  try {
    for (const s of await syncAll()) {
      if (s.triaged || s.errors.length) console.log(`[sync] ${s.account}: +${s.triaged} triaged, ${s.errors.length} errors`);
      for (const e of s.errors.slice(0, 3)) console.warn(`[sync] ${e}`);
    }
  } catch (err) {
    console.error("[sync] failed:", err instanceof Error ? err.message : err);
  }
}

http.listen(config.port, config.host, () => {
  console.log(`mail-triage MCP on http://${config.host}:${config.port}/mcp (sync every ${config.syncIntervalMin} min)`);
  void backgroundSync();
  setInterval(backgroundSync, config.syncIntervalMin * 60_000);
});

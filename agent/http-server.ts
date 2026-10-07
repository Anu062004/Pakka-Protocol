import crypto from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRuntime, createServer } from "./mcp-server.ts";

const MAX_BODY_BYTES = 262144;

// The agent key lives in this process, so the endpoint is a capability: anyone holding the
// token can call the same tools. Tijori still bounds what those tools can do on-chain.
export function requireToken(env: NodeJS.ProcessEnv): string {
  const token = env.AGENT_HTTP_TOKEN;
  if (!token || token.length < 32) throw new Error("AGENT_HTTP_TOKEN_REQUIRED");
  return token;
}

export function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  // Compare in constant time; timingSafeEqual requires equal lengths.
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<http.Server> {
  const token = requireToken(env);
  // 0 asks the OS for an ephemeral port; anything else must stay out of the privileged range.
  const port = Number(env.AGENT_HTTP_PORT ?? 4174);
  if (!Number.isInteger(port) || port > 65535 || (port !== 0 && port < 1024)) throw new Error("INVALID_PORT");
  // Binding beyond loopback exposes a signing endpoint, so it is opt-in and never the default.
  const host = env.AGENT_HTTP_HOST ?? "127.0.0.1";

  const { getService, close: closeRuntime } = createRuntime(env);

  const server = http.createServer((req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ error: "NOT_FOUND" }));
    }
    if (!authorized(req.headers.authorization, token)) {
      res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store", "WWW-Authenticate": "Bearer" });
      return res.end(JSON.stringify({ error: "UNAUTHORIZED" }));
    }
    // The transport reads the request stream itself, so the body is bounded by its declared
    // length rather than by consuming it here.
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_BODY_BYTES) {
      res.writeHead(413, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ error: "PAYLOAD_TOO_LARGE" }));
    }
    // Stateless mode keeps per-connection protocol state out of the picture, but that state
    // lives on the server instance, so each request gets its own pair over the shared service.
    void (async () => {
      const mcp = createServer(getService);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void transport.close(); void mcp.close(); });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
      } catch (error) {
        console.error("AGENT_HTTP_REQUEST_FAILED", error);
        if (!res.headersSent) { res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ error: "AGENT_HTTP_REQUEST_FAILED" })); }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  console.log(`Pakka agent MCP endpoint: http://${host}:${port}/mcp`);

  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeRuntime();
  })();
  const stop = () => { void close().then(() => process.exit(0), () => { console.error("AGENT_SHUTDOWN_FAILED"); process.exitCode = 1; }); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error((error as Error).message === "AGENT_HTTP_TOKEN_REQUIRED"
    ? "Set AGENT_HTTP_TOKEN to a secret of at least 32 characters." : "AGENT_HTTP_STARTUP_FAILED"); process.exitCode = 1; }
}

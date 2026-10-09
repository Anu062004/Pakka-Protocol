import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { Interface, getAddress, parseUnits } from "ethers";
import { abi, loadDeployment, projectRoot, publicDeployment } from "./project.ts";
import { rpcProvider } from "./rpc.ts";
import { ReadService } from "./read-service.ts";
import type { Manifest } from "./types.ts";

const json = (res: http.ServerResponse, status: number, data: unknown): void => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
};

const DEFAULT_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

export interface CreateAppOptions {
  getService: () => ReadService | Promise<ReadService>;
  manifest: Manifest | null;
  port?: number;
  allowedHosts?: string[];
  allowedOrigins?: string[] | null;
}

// Routes return the value of their terminating res call, so the result is deliberately unused.
export type RequestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<unknown>;

// Split out so a serverless host (which has no listening socket of its own) can serve the
// same routes; resolvePort only supplies the dev-default origin allowlist when none is set.
export function createHandler({ getService, manifest, port = 4173, allowedHosts = DEFAULT_HOSTS, allowedOrigins = null }: CreateAppOptions,
  resolvePort: () => number = () => port): RequestHandler {
  return async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const host = new URL(`http://${req.headers.host ?? "localhost"}`).hostname;
      if (!allowedHosts.includes(host)) return json(res, 403, { error: "HOST_NOT_ALLOWED" });
      if (req.method !== "GET") return json(res, 405, { error: "READ_ONLY_API" });
      const boundPort = resolvePort();
      // allowedOrigins lets an operator front this with a TLS reverse proxy on a public
      // hostname; without it, only the same-origin dev defaults for the bound port are allowed.
      const origins = allowedOrigins ?? [`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`];
      if (req.headers.origin && !origins.includes(req.headers.origin)) return json(res, 403, { error: "ORIGIN_NOT_ALLOWED" });
      if (url.pathname.startsWith("/api/")) {
        if (url.pathname === "/api/deployment") {
          if (!manifest) return json(res, 503, { error: "TESTNET_DEPLOYMENT_MISSING" });
          return json(res, 200, publicDeployment(manifest));
        }
        if (url.pathname === "/api/abis") return json(res, 200, Object.fromEntries(["PakkaRouter", "YieldToken", "PrincipalToken", "Tijori", "TijoriFactory", "SeriesRegistry", "UniswapV4Market"].map((n) => [n, abi(n)])));
        if (url.pathname === "/api/agent-config") return json(res, 200, { mcpServers: { pakka: { command: process.execPath,
          args: [`--env-file-if-exists=${path.join(projectRoot, ".env")}`, path.join(projectRoot, "agent/mcp-server.ts")],
          env: { AGENT_TIJORI_ADDRESS: getAddress(url.searchParams.get("tijori") ?? ""), AGENT_PRIVATE_KEY: "REPLACE_ONLY_IN_YOUR_LOCAL_CONFIG" } } } });
        const service = await getService();
        if (url.pathname === "/api/rates") return json(res, 200, await service.rates());
        if (url.pathname === "/api/quote") {
          const ptAmount = url.searchParams.get("ptAmount");
          if (!/^\d{1,20}(\.\d{1,6})?$/.test(ptAmount ?? "")) return json(res, 400, { error: "INVALID_QUOTE_AMOUNT" });
          return json(res, 200, await service.quotes.quote({ seriesId: Number(url.searchParams.get("seriesId")), ptAmountRaw: parseUnits(ptAmount!, 6) }));
        }
        if (url.pathname === "/api/positions") return json(res, 200, await service.positions(url.searchParams.get("account") ?? ""));
        if (url.pathname === "/api/treasury") return json(res, 200, await service.treasury(url.searchParams.get("owner") ?? "", url.searchParams.get("payee")));
        if (url.pathname === "/api/activity") return json(res, 200, await service.activity({ account: url.searchParams.get("account") ?? undefined,
          tijori: url.searchParams.get("tijori") ?? undefined, fromBlock: url.searchParams.has("fromBlock") ? Number(url.searchParams.get("fromBlock")) : undefined }));
        return json(res, 404, { error: "NOT_FOUND" });
      }
      if (/^\/fonts\/[\w-]+\.woff2$/.test(url.pathname)) {
        const file = path.join(projectRoot, "frontend", url.pathname);
        if (!fs.existsSync(file)) return json(res, 404, { error: "NOT_FOUND" });
        res.writeHead(200, { "Content-Type": "font/woff2", "Cache-Control": "no-store" });
        return res.end(fs.readFileSync(file));
      }
      const files: Record<string, string> = { "/": "frontend/index.html", "/docs": "frontend/docs.html", "/landing.css": "frontend/landing.css",
        "/app": "frontend/app.html", "/app.mjs": "frontend/app.mjs", "/app.css": "frontend/app.css", "/fonts.css": "frontend/fonts.css",
        "/errors.mjs": "frontend/errors.mjs", "/wallet.mjs": "frontend/wallet.mjs",
        // Serverless bundlers trace imports, not fs reads, so the build copies ethers next to
        // the other static assets; node_modules stays the source of truth for local dev.
        "/ethers.mjs": fs.existsSync(path.join(projectRoot, "frontend/vendor/ethers.min.js"))
          ? "frontend/vendor/ethers.min.js" : "node_modules/ethers/dist/ethers.min.js" };
      const file = files[url.pathname];
      if (!file) return json(res, 404, { error: "NOT_FOUND" });
      const extension = path.extname(file);
      res.writeHead(200, { "Content-Type": extension === ".html" ? "text/html; charset=utf-8" : extension === ".css" ? "text/css" : "text/javascript", "Cache-Control": "no-store" });
      res.end(fs.readFileSync(path.join(projectRoot, file)));
    } catch (error) {
      // Error shapes here come from ethers (code/data) and plain thrown codes, not the DOM/standard Error contract.
      const e = error as { message?: string; data?: string };
      let code = e.message && /^[A-Z][A-Z_]+$/.test(e.message) ? e.message : "SERVICE_UNAVAILABLE";
      if (e.data) for (const name of ["PakkaRouter", "YieldToken", "UniswapV4Market", "Tijori"]) {
        try {
          const parsed = new Interface(abi(name)).parseError(e.data);
          if (parsed) { code = parsed.name; break; }
        } catch { /* try the next contract's ABI */ }
      }
      json(res, 503, { error: code });
    }
  };
}

export function createApp(options: CreateAppOptions): http.Server {
  const server = http.createServer();
  server.on("request", createHandler(options, () =>
    (server.address() as { port: number } | null)?.port ?? options.port ?? 4173));
  return server;
}

// A public hostname proxied by a TLS-terminating reverse proxy on the same host.
// This never changes the bind address below; it only extends the Host/Origin allowlist.
export function publicHosting(env: NodeJS.ProcessEnv): { allowedHosts: string[]; allowedOrigins: string[] | null } {
  const hosts = (env.API_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  for (const h of hosts) if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(h)) throw new Error("INVALID_ALLOWED_HOST");
  const originList = (env.API_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  for (const o of originList) {
    const u = new URL(o);
    if (u.protocol !== "https:" || (u.pathname !== "/" && u.pathname !== "") || u.search || u.username || u.password) throw new Error("INVALID_ALLOWED_ORIGIN");
  }
  return { allowedHosts: hosts.length ? [...DEFAULT_HOSTS, ...hosts] : DEFAULT_HOSTS,
    allowedOrigins: originList.length ? originList.map((o) => new URL(o).origin) : null };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<http.Server> {
  if (env.API_HOST && !["127.0.0.1", "localhost"].includes(env.API_HOST)) throw new Error("LOCALHOST_ONLY");
  const port = Number(env.API_PORT ?? 4173);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("INVALID_PORT");
  const { allowedHosts, allowedOrigins } = publicHosting(env);
  let manifest: Manifest | null = null, provider: ReturnType<typeof rpcProvider> | undefined, service: ReadService | undefined;
  try { manifest = loadDeployment(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const server = createApp({ manifest, port, allowedHosts, allowedOrigins, getService: () => {
    if (!manifest) throw new Error("TESTNET_DEPLOYMENT_MISSING");
    if (!service) { provider = rpcProvider(env); service = new ReadService({ provider, manifest }); }
    return service;
  } });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  console.log(`Pakka testnet app: http://127.0.0.1:${port}`);
  const close = () => { server.close(); provider?.destroy(); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch { console.error("APP_STARTUP_FAILED"); process.exitCode = 1; }
}

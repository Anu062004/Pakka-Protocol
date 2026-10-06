import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { quoteBounds, FACE_SQRT_PRICE_X96 } from "../backend/quotes.ts";
import { sendWithFallback } from "../backend/rpc.ts";
import { keeperAlerts } from "../backend/alerts.ts";
import { loadDeployment } from "../backend/project.ts";
import { abi } from "../backend/project.ts";
import { Interface, getAddress } from "ethers";
import type { Provider } from "ethers";
import { decodeActivity, type LogLike } from "../backend/activity.ts";
import { createApp, publicHosting } from "../backend/server.ts";
import { checkCoverage, slitherBlocking, aderynBlocking } from "../scripts/security-check.ts";
import { localForkUrl } from "../scripts/fork-e2e.ts";
import { messages, humanError } from "../frontend/errors.mjs";
import { blockAtOrBefore, observedApy, vaultObservedApy } from "../backend/variable-rate.ts";
import type { Manifest } from "../backend/types.ts";

test("shared quote math rounds spend upward, caps at face, and preserves exact output", () => {
  const q = quoteBounds(990000n, 1000000n, 31536000, 50);
  assert.equal(q.maxUsdc.raw, "994950"); assert.equal(q.suggestedMinOutRaw, "1000000");
  assert.equal(q.impliedFixedRatePercent, "1.010101"); assert.equal(q.sqrtPriceLimitX96, FACE_SQRT_PRICE_X96.toString());
  assert.equal(quoteBounds(999999n, 1000000n, 100, 50).maxUsdc.raw, "1000000");
  assert.throws(() => quoteBounds(1000001n, 1000000n, 100), /NO_DISCOUNTED_QUOTE/);
  assert.throws(() => quoteBounds(1n, 1000000n, 0), /NO_DISCOUNTED_QUOTE/);
});
test("RPC fallback verifies backup chain and replays identical bytes only on transport failure", async () => {
  const requests: [string, unknown[]][] = [];
  const primary = async (): Promise<never> => { throw Object.assign(new Error("offline"), { code: "TIMEOUT" }); };
  const backup = async (method: string, params: unknown[]) => { requests.push([method, params]); return method === "eth_chainId" ? "0x4cef52" : "hash"; };
  assert.equal(await sendWithFallback(primary, backup, "eth_sendRawTransaction", ["0x1234"], 5042002), "hash");
  assert.deepEqual(requests, [["eth_chainId", []], ["eth_sendRawTransaction", ["0x1234"]]]);
  await assert.rejects(sendWithFallback(primary, async () => "0x13b2", "eth_call", [], 5042002), /WRONG_FALLBACK_CHAIN/);
  let touched = false;
  await assert.rejects(sendWithFallback(async () => { throw Object.assign(new Error("revert"), { code: "CALL_EXCEPTION" }); }, async () => { touched = true; }, "eth_call", [], 5042002), /revert/);
  assert.equal(touched, false);
});
test("keeper alert delivery retries failures, persists cooldown, and does not send secrets", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pakka-alert-"));
  try {
    const env = { KEEPER_ALERT_WEBHOOK_URL: "https://discord.com/api/webhooks/123/token", KEEPER_ALERT_STATE_FILE: path.join(dir, "alerts.json") };
    let success = false, calls = 0, clock = 1000000;
    const notify = keeperAlerts(env, { now: () => clock, fetcher: (async (_url: unknown, options?: RequestInit) => {
      calls++; assert(!String(options!.body).includes("secret")); return { ok: success } as Response;
    }) as typeof fetch });
    const health = { ok: false, chainId: 5042002, alerts: [{ code: "SETTLEMENT_PREPARE_FAILED", seriesId: 2, error: "secret" }] };
    assert.equal((await notify(health)).error, "ALERT_DELIVERY_FAILED"); success = true;
    assert.equal((await notify(health)).sent, true); assert.equal((await notify(health)).cooldown, true);
    const restarted = keeperAlerts(env, { now: () => clock, fetcher: (async () => { throw new Error("should not send"); }) as unknown as typeof fetch });
    assert.equal((await restarted(health)).cooldown, true); clock += 300001;
    assert.equal((await notify(health)).sent, true); assert.equal(calls, 3);
    assert(!fs.readFileSync(env.KEEPER_ALERT_STATE_FILE, "utf8").includes("token"));
    assert.throws(() => keeperAlerts({ KEEPER_ALERT_WEBHOOK_URL: "http://localhost/secret" }), /INVALID_ALERT_WEBHOOK/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("deployment loader cannot enable mainnet through a filename or manifest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pakka-manifest-"));
  try {
    const file = path.join(dir, "arc-mainnet.json"); fs.writeFileSync(file, JSON.stringify({ chainId: 5042 }));
    assert.throws(() => loadDeployment(file, { chainId: 5042 }), /UNSUPPORTED_CHAIN/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("application activity deduplicates logs, ignores removed/USDC transfers, and scopes users", () => {
  const treasury = getAddress("0x0000000000000000000000000000000000000001");
  const asset = getAddress("0x0000000000000000000000000000000000000002");
  const payee = getAddress("0x0000000000000000000000000000000000000003");
  const iface = new Interface(["event Paid(address indexed caller,address indexed payee,uint256 amount)"]);
  const event = iface.encodeEventLog(iface.getEvent("Paid")!, [treasury, payee, 1_000000n]);
  const log: LogLike = { address: treasury, blockHash: "block", transactionHash: "transaction", blockNumber: 10, index: 0, ...event };
  const decoded = decodeActivity([log, { ...log }, { ...log, index: 1, removed: true }, { ...log, address: asset, index: 2 }], new Map([[treasury, iface]]), [payee]);
  assert.equal(decoded.length, 1); assert.equal(decoded[0]!.event, "Paid"); assert.equal(decoded[0]!.fields.amount, "1000000");
  assert.equal(decodeActivity([log], new Map([[treasury, iface]]), [asset]).length, 0);
});
interface TestResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
const request = (server: http.Server, url: string, { method = "GET", headers = {} }: { method?: string; headers?: Record<string, string> } = {}): Promise<TestResponse> => new Promise((resolve) => {
  const responseHeaders: Record<string, string> = {}; let status: number;
  (server as unknown as { emit: (event: string, req: unknown, res: unknown) => void }).emit("request", { url, method, headers }, { setHeader: (k: string, v: string) => { responseHeaders[k] = v; },
    writeHead: (code: number, h: Record<string, string>) => { status = code; Object.assign(responseHeaders, h); }, end: (body: string) => resolve({ status, headers: responseHeaders, body }) });
});
test("local read API exposes only public manifest fields and rejects writes, foreign origins, rebinding and secrets", async () => {
  const manifest = { chainId: 5042002, series: [], registry: "address", privateKey: "secret-never-expose", rpcUrl: "secret-rpc" } as unknown as Manifest;
  const server = createApp({ manifest, getService: () => { throw new Error("TESTNET_DEPLOYMENT_MISSING"); } });
  const deployment = await request(server, "/api/deployment"); assert.equal(deployment.status, 200); assert(!deployment.body.includes("secret"));
  assert.equal((await request(server, "/.env")).status, 404);
  assert.equal((await request(server, "/api/quote", { method: "POST" })).status, 405);
  assert.equal((await request(server, "/api/deployment", { headers: { origin: "https://foreign.example" } })).status, 403);
  assert.equal((await request(server, "/api/deployment", { headers: { host: "rebinding.example:4173" } })).status, 403);
  const failure = await request(server, "/api/rates"); assert.equal(JSON.parse(failure.body).error, "TESTNET_DEPLOYMENT_MISSING");
  const config = JSON.parse((await request(server, "/api/agent-config?tijori=0x0000000000000000000000000000000000000001")).body);
  assert.equal(config.mcpServers.pakka.env.AGENT_PRIVATE_KEY, "REPLACE_ONLY_IN_YOUR_LOCAL_CONFIG");
});
test("95% coverage is enforced per core file and static-analysis gates reject unknown reports", () => {
  const lcov = `SF:contracts/YieldToken.sol\n${Array.from({ length: 20 }, (_, i) => `DA:${i + 1},${i === 19 ? 0 : 1}`).join("\n")}\nend_of_record\n`;
  assert.equal(checkCoverage(lcov, 95, ["contracts/YieldToken.sol"]).passed, true);
  assert.equal(checkCoverage(lcov, 96, ["contracts/YieldToken.sol"]).passed, false);
  assert.equal(checkCoverage(lcov, 95, ["contracts/YieldToken.sol", "contracts/Tijori.sol"]).passed, false);
  assert.equal(slitherBlocking({ success: true, results: { detectors: [{ impact: "High" }, { impact: "Medium" }, { impact: "Low" }] } }).length, 2);
  assert.equal(aderynBlocking({ high_issues: { issues: [{}] }, low_issues: { issues: [{}] } }).length, 1);
  assert.throws(() => aderynBlocking({}), /INVALID_ADERYN_REPORT/);
  assert.throws(() => slitherBlocking({ success: false }), /INVALID_SLITHER_REPORT/);
});
test("blockAtOrBefore binary-searches chain history and reports no history past the chain's age", async () => {
  const chain = Array.from({ length: 101 }, (_, n) => ({ number: n, timestamp: n * 10 }));
  const getBlock = async (n: number) => chain[n] ?? null;
  const latest = chain.at(-1)!;
  const found = await blockAtOrBefore(getBlock, 505, latest);
  assert.equal(found!.number, 50); assert.equal(found!.timestamp, 500);
  assert.equal(await blockAtOrBefore(getBlock, -1, { number: 0, timestamp: 0 }), null);
  assert.equal(await blockAtOrBefore(getBlock, 2000, latest), null);
});
test("observedApy annualizes vault growth, allows negative rates after a loss, and rejects zero history", () => {
  assert.equal(observedApy(1_000_000n, 1_050_000n, 31536000), 5);
  assert.equal(observedApy(1_000_000n, 1_050_000n, 31536000 / 2), 10);
  assert.equal(observedApy(1_000_000n, 900_000n, 31536000), -10);
  assert.equal(observedApy(0n, 100n, 100), null);
  assert.equal(observedApy(100n, 100n, 0), null);
});
test("vaultObservedApy reports insufficient history without touching the network when there is no past block", async () => {
  const result = await vaultObservedApy({ provider: { call: () => { throw new Error("should not be called"); } } as unknown as Provider,
    vaultAddress: "0x0000000000000000000000000000000000000001", pastBlock: null, currentBlock: { number: 10, timestamp: 1000 } });
  assert.deepEqual(result, { percent: null, status: "INSUFFICIENT_HISTORY", windowSeconds: null });
});
test("publicHosting keeps localhost-only defaults and validates operator-supplied hosts/origins", () => {
  assert.deepEqual(publicHosting({}), { allowedHosts: ["127.0.0.1", "localhost", "[::1]"], allowedOrigins: null });
  const configured = publicHosting({ API_ALLOWED_HOSTS: "pakka.example.com", API_ALLOWED_ORIGINS: "https://pakka.example.com" });
  assert.deepEqual(configured.allowedHosts, ["127.0.0.1", "localhost", "[::1]", "pakka.example.com"]);
  assert.deepEqual(configured.allowedOrigins, ["https://pakka.example.com"]);
  assert.throws(() => publicHosting({ API_ALLOWED_HOSTS: "not a host!" }), /INVALID_ALLOWED_HOST/);
  for (const origin of ["http://pakka.example.com", "https://pakka.example.com/path", "https://pakka.example.com?x=1", "https://user:pass@pakka.example.com"])
    assert.throws(() => publicHosting({ API_ALLOWED_ORIGINS: origin }), /INVALID_ALLOWED_ORIGIN/);
});
test("local read API can be opened to an operator-configured public host and origin", async () => {
  const manifest = { chainId: 5042002, series: [], registry: "address" } as unknown as Manifest;
  const server = createApp({ manifest, allowedHosts: ["127.0.0.1", "pakka.example.com"], allowedOrigins: ["https://pakka.example.com"],
    getService: () => { throw new Error("TESTNET_DEPLOYMENT_MISSING"); } });
  const allowed = await request(server, "/api/deployment", { headers: { host: "pakka.example.com", origin: "https://pakka.example.com" } });
  assert.equal(allowed.status, 200);
  const foreignHost = await request(server, "/api/deployment", { headers: { host: "evil.example.com" } });
  assert.equal(foreignHost.status, 403);
  const foreignOrigin = await request(server, "/api/deployment", { headers: { host: "pakka.example.com", origin: "https://evil.example.com" } });
  assert.equal(foreignOrigin.status, 403);
});
test("fork write destinations reject public RPCs and all application custom errors have human messages", () => {
  assert.equal(localForkUrl("http://127.0.0.1:8545"), "http://127.0.0.1:8545/");
  for (const url of ["https://rpc.mainnet.arc.io", "http://example.com", "http://user:secret@localhost:8545"])
    assert.throws(() => localForkUrl(url), /FORK_WRITES_REQUIRE_LOCALHOST/);
  for (const name of ["PrincipalToken", "YieldToken", "SeriesRegistry", "UniswapV4Market", "PakkaRouter", "Tijori", "TijoriFactory"])
    for (const error of (abi(name) as { type: string; name: string }[]).filter((e) => e.type === "error")) assert(messages[error.name], `${name}.${error.name}`);
  const iface = new Interface(abi("YieldToken"));
  assert.match(humanError({ data: iface.encodeErrorResult("VaultRedeemLimit", [10, 0]) }, [iface]), /shares/);
});

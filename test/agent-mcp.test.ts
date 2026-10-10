import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import hre from "hardhat";
import { BrowserProvider, Contract, ContractFactory, HDNodeWallet, MaxUint256, Transaction, ZeroAddress, parseUnits } from "ethers";
import type { JsonRpcApiProvider, JsonRpcSigner } from "ethers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { compile } from "../scripts/compile.ts";
import { initialSqrtPrice } from "../scripts/seed-v4.ts";
import { TreasuryService, amount, projectRoot } from "../agent/treasury-service.ts";
import { agentConfig, createServer, toolDefinitions } from "../agent/mcp-server.ts";
import { lockKeeper, writeJson } from "../scripts/expiry-keeper.ts";
import type { ContractArtifact, Manifest } from "../backend/types.ts";

const provider = new BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
const wallet = HDNodeWallet.fromPhrase("test test test test test test test test test test test junk", undefined,
  "m/44'/60'/0'/0/1").connect(provider) as HDNodeWallet;
const unit = 1_000_000n;
const sent = async (tx: Promise<{ wait: () => Promise<any> }>) => (await tx).wait();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pakka-agent-"));
interface SeriesFixture {
  id: number;
  expiry: number;
  yt: Contract;
  pt: Contract;
}
interface Fixture {
  asset: Contract; vault: Contract; registry: Contract; market: Contract; router: Contract;
  factory: Contract; tijori: Contract; series: SeriesFixture[]; manifest: Manifest; stateFile: string;
}
let owner: JsonRpcSigner, payee: JsonRpcSigner, replacement: JsonRpcSigner, artifacts: Record<string, ContractArtifact>, fixture: Fixture, snapshot: string, counter = 0;

const wrapped = (overrides: Record<string, unknown>): JsonRpcApiProvider => new Proxy(provider, { get(target, key) {
  if (Object.hasOwn(overrides, key)) return overrides[key as string];
  const value = Reflect.get(target, key, target);
  return typeof value === "function" ? value.bind(target) : value;
} }) as unknown as JsonRpcApiProvider;
const rejectCode = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (e: unknown) => (e as { code?: string }).code === code);
const timeout = () => new Error("SECRET_KEY_RPC_URL_RAW_TRANSACTION_MUST_NOT_LEAK");

async function deploy(name: string, args: unknown[] = []): Promise<Contract> {
  const a = artifacts[name]!;
  const c = await new ContractFactory(a.abi, a.bytecode!, owner).deploy(...args);
  await c.waitForDeployment();
  return c as unknown as Contract;
}

before(async () => {
  artifacts = compile();
  [owner, payee, replacement] = await Promise.all([0, 2, 4].map((i) => provider.getSigner(i)));
  const asset = await deploy("MockUSDC");
  const vault = await deploy("MockVault", [asset.target, 12]);
  const registry = await deploy("SeriesRegistry", [asset.target, owner.address, ZeroAddress]);
  const manager = await deploy("TestnetPoolManager", [owner.address]);
  const market = await deploy("UniswapV4Market", [manager.target, registry.target]);
  const router = await deploy("PakkaRouter", [market.target]);
  const seeder = await deploy("PoolSeeder", [manager.target, registry.target]);
  const factory = await deploy("TijoriFactory", [router.target]);
  await sent(factory.create(wallet.address, 50n * unit));
  const tijori = new Contract(await factory.tijoriOf(owner.address), artifacts.Tijori.abi, owner);
  await sent(asset.mint(owner.address, 20_000n * unit));
  await sent(asset.approve(tijori.target, 150n * unit));
  await sent(tijori.deposit(150n * unit));
  await sent(tijori.setPayeeCap(payee.address, 40n * unit));
  await sent(asset.approve(seeder.target, MaxUint256));
  const start = (await provider.getBlock("latest"))!.timestamp;
  const series: SeriesFixture[] = [];
  for (let i = 0; i < 3; i++) {
    const expiry = start + 3600 * (i + 2);
    const yt = await deploy("YieldToken", [vault.target, expiry, `AGENT-${i}`, registry.target]);
    const pt = new Contract(await yt.principalToken(), artifacts.PrincipalToken!.abi, owner);
    await sent(registry.registerSeries(yt.target));
    const assetIs0 = BigInt(asset.target as string) < BigInt(pt.target as string);
    await sent(registry.setPoolKey(i + 1, { currency0: assetIs0 ? asset.target : pt.target,
      currency1: assetIs0 ? pt.target : asset.target, fee: 500, tickSpacing: 10, hooks: ZeroAddress }));
    await sent(seeder.initializePool(i + 1, initialSqrtPrice(asset.target as string, pt.target as string, 990_000n)));
    await sent(asset.approve(yt.target, 1000n * unit));
    await sent(yt.splitFromAssets(400n * unit, owner.address));
    await sent(pt.approve(seeder.target, MaxUint256));
    await sent(seeder.addLiquidity(i + 1, -600, 600, 10_000n * unit, 1000n * unit, 1000n * unit, start + 1000));
    series.push({ id: i + 1, expiry, yt, pt });
  }
  fixture = { asset, vault, registry, market, router, factory, tijori, series,
    manifest: { chainId: 31337, usdc: asset.target as string, registry: registry.target as string, market: market.target as string,
      router: router.target as string, tijoriFactory: factory.target as string } as Manifest } as Fixture;
  snapshot = await hre.network.provider.send("evm_snapshot");
});
beforeEach(async () => {
  await hre.network.provider.send("evm_revert", [snapshot]);
  snapshot = await hre.network.provider.send("evm_snapshot");
  fixture.stateFile = path.join(temporary, `${++counter}/state.json`);
});
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

type ServiceOptions = Partial<ConstructorParameters<typeof TreasuryService>[0]>;
const service = (options: ServiceOptions = {}): TreasuryService => new TreasuryService({ provider, signer: wallet, manifest: fixture.manifest,
  tijoriAddress: fixture.tijori.target as string, stateFile: fixture.stateFile, chainId: 31337, confirmations: 1, ...options });
const pay = (s: TreasuryService, operationId = "bill-0001", amountUsdc = "10"): Promise<any> => s.invoke("pay", { payee: payee.address, amountUsdc, operationId });
const plan = (s: TreasuryService, options: Record<string, unknown> = {}): Promise<any> => s.invoke("planTreasury", { payoutUsdc: "50", periods: 3, seriesIds: [1, 2, 3], ...options });
const advance = async (timestamp: number) => {
  await hre.network.provider.send("evm_setNextBlockTimestamp", [timestamp]);
  await hre.network.provider.send("evm_mine");
};

test("strict MCP schemas expose only scoped treasury tools and six-decimal amount parsing", () => {
  assert.equal(Object.keys(toolDefinitions).length, 8);
  for (const invalid of ["0", "-1", "1e6", "1.0000001", "NaN", 1, "99999999999999999999999999999999999"]) {
    assert.throws(() => amount(invalid));
  }
  assert.equal(amount("1.000001"), 1_000_001n);
  assert.throws(() => toolDefinitions.cashOut.schema.parse({ seriesId: 1, ptAmount: "1", operationId: "bill-0001", receiver: payee.address }));
  assert.throws(() => toolDefinitions.planTreasury.schema.parse({ payoutUsdc: "50", periods: 3, seriesIds: [1, 2, 3], intervalSeconds: 3600 }));
  assert.equal(agentConfig({}).stateFile, path.join(projectRoot, "runtime/agent-state.json"));
  assert.throws(() => agentConfig({ AGENT_CONFIRMATIONS: "NaN" }));
  assert.throws(() => service({ chainId: 5042 }), /UNSUPPORTED_CHAIN/);
});

test("quotes and plans send no transaction; explicit ladder execution retains all PT and refunds in Tijori", async () => {
  const s = service();
  const nonce = await provider.getTransactionCount(wallet.address);
  const quote = await s.invoke("quotePT", { seriesId: 1, ptAmount: "50" });
  assert(BigInt(quote.quotedCost.raw) < 50n * unit);
  const p = await plan(s);
  assert.equal(p.transactionSubmitted, false);
  assert.equal(p.schedule, "explicit-maturities");
  assert.equal(await provider.getTransactionCount(wallet.address), nonce);
  assert.equal(await fixture.asset.balanceOf(fixture.tijori.target), 150n * unit);
  assert(BigInt(p.maxTotalUsdc) <= 150n * unit);
  assert(p.legs.every((l: any) => BigInt(l.maxUsdc) <= BigInt(l.ptAmount)));
  const result = await s.invoke("executePlan", { planId: p.planId, operationId: "ladder-0001" });
  assert.equal(result.status, "confirmed");
  for (const { pt } of fixture.series) {
    assert.equal(await pt.balanceOf(fixture.tijori.target), 50n * unit);
    assert.equal(await pt.balanceOf(wallet.address), 0n);
    assert.equal(await pt.balanceOf(fixture.router.target), 0n);
  }
  assert.equal(await fixture.asset.allowance(fixture.tijori.target, fixture.router.target), 0n);
  const status = await s.invoke("treasuryStatus", { payees: [payee.address] });
  assert.equal(status.positions.length, 3);
  assert.equal(status.payees[0].remaining.raw, (40n * unit).toString());
});

test("billing windows select maturities before due dates and fail rather than invent monthly series", async () => {
  const s = service();
  const p = await s.invoke("planTreasury", { payoutUsdc: "50", periods: 3,
    firstDueTimestamp: fixture.series[0].expiry + 10, intervalSeconds: 3600 });
  assert.deepEqual(p.legs.map((l: any) => l.seriesId), [1, 2, 3]);
  assert(p.legs.every((l: any) => l.expiry <= l.dueTimestamp));
  await rejectCode(s.invoke("planTreasury", { payoutUsdc: "50", periods: 3 }), "NO_SERIES_FOR_BILLING_WINDOW");
  await rejectCode(plan(s, { seriesIds: [3, 2, 1] }), "NO_SERIES_FOR_BILLING_WINDOW");
  await rejectCode(plan(s, { maxTotalUsdc: "100" }), "INSUFFICIENT_PLAN_BUDGET");
  const nonce = await provider.getTransactionCount(wallet.address);
  await advance(p.deadline);
  await rejectCode(s.invoke("executePlan", { planId: p.planId, operationId: "expired-0001" }), "PLAN_EXPIRED");
  assert.equal(await provider.getTransactionCount(wallet.address), nonce);
});

test("matured cash-out and approved bill payment form a complete ladder workflow", async () => {
  const s = service();
  const p = await plan(s);
  await s.invoke("executePlan", { planId: p.planId, operationId: "ladder-0001" });
  await rejectCode(s.invoke("cashOut", { seriesId: 1, ptAmount: "50", operationId: "cashout-0001" }), "SERIES_NOT_MATURED");
  await advance(fixture.series[0].expiry);
  const beforeBalance = await fixture.asset.balanceOf(fixture.tijori.target);
  const result = await s.invoke("cashOut", { seriesId: 1, ptAmount: "50", operationId: "cashout-0001" });
  assert.equal(result.status, "confirmed");
  assert.equal(await fixture.series[0].pt.balanceOf(fixture.tijori.target), 0n);
  assert(await fixture.asset.balanceOf(fixture.tijori.target) >= beforeBalance + 49_999_999n);
  assert.equal((await pay(s, "bill-0001", "30")).status, "confirmed");
  assert.equal(await fixture.asset.balanceOf(payee.address), 30n * unit);
  assert.equal(await fixture.asset.balanceOf(wallet.address), 0n);
});

test("illiquid vault requires explicit share cash-out and cannot weaken the output bound", async () => {
  const s = service();
  const p = await plan(s, { periods: 1, seriesIds: [1] });
  await s.invoke("executePlan", { planId: p.planId, operationId: "ladder-0001" });
  await advance(fixture.series[0].expiry);
  await sent(fixture.vault.setIlliquid(true));
  await assert.rejects(s.invoke("cashOut", { seriesId: 1, ptAmount: "50", operationId: "illiquid-0001" }));
  assert.equal(await fixture.series[0].pt.balanceOf(fixture.tijori.target), 50n * unit);
  await rejectCode(s.invoke("cashOut", { seriesId: 1, ptAmount: "50", toAssets: false, minOutputRaw: "0", operationId: "illiquid-0001" }), "INVALID_MINIMUM_OUTPUT");
  assert.equal((await s.invoke("cashOut", { seriesId: 1, ptAmount: "50", toAssets: false, operationId: "illiquid-0001" })).status, "confirmed");
  const shares = await fixture.vault.balanceOf(fixture.tijori.target);
  assert(shares > 0n);
  const status = await s.invoke("treasuryStatus");
  assert.deepEqual(status.vaultShares, [{ vault: fixture.vault.target, sharesRaw: shares.toString(), decimals: 18 }]);
});

test("YT interest is claimed into Tijori and empty claims do not spend gas", async () => {
  const s = service();
  await rejectCode(s.invoke("claimInterest", { seriesId: 1, operationId: "interest-0001" }), "NO_CLAIMABLE_INTEREST");
  await sent(fixture.series[0].yt.transfer(fixture.tijori.target, 50n * unit));
  await sent(fixture.vault.addYield(unit));
  const beforeBalance = await fixture.asset.balanceOf(fixture.tijori.target);
  assert.equal((await s.invoke("claimInterest", { seriesId: 1, operationId: "interest-0001" })).status, "confirmed");
  assert(await fixture.asset.balanceOf(fixture.tijori.target) > beforeBalance);
  assert.equal(await fixture.asset.balanceOf(wallet.address), 0n);
});

test("read-only mode, paused/replaced agents and unauthorized payees cannot send transactions", async () => {
  assert.equal((await service({ signer: null }).invoke("treasuryStatus")).signerConfigured, false);
  await rejectCode(pay(service({ signer: null })), "AGENT_SIGNER_REQUIRED");
  await rejectCode(pay(service({ signer: owner })), "AGENT_USES_OWNER_WALLET");
  await rejectCode(service().invoke("pay", { payee: replacement.address, amountUsdc: "1", operationId: "bill-0001" }), "PAYMENT_CAP_EXCEEDED");
  await rejectCode(pay(service(), "bill-0001", "41"), "PAYMENT_CAP_EXCEEDED");
  await sent(fixture.tijori.setPaused(true));
  assert.equal((await service().invoke("treasuryStatus")).paused, true);
  await rejectCode(pay(service()), "AGENT_PAUSED");
  await sent(fixture.tijori.setPaused(false));
  await sent(fixture.tijori.setAgent(replacement.address));
  await rejectCode(pay(service()), "AGENT_KEY_NOT_AUTHORIZED");
  assert.equal(await fixture.asset.balanceOf(payee.address), 0n);
});

test("payment operation IDs survive restart, reject changed intent and cannot exploit prototype keys", async () => {
  const s = service();
  const first = await pay(s);
  assert.equal(first.status, "confirmed");
  const nonce = await provider.getTransactionCount(wallet.address);
  const retry = await pay(service());
  assert.equal(retry.transactionHash, first.transactionHash);
  assert.equal(await provider.getTransactionCount(wallet.address), nonce);
  assert.equal(await fixture.asset.balanceOf(payee.address), 10n * unit);
  await rejectCode(pay(service(), "bill-0001", "11"), "OPERATION_ID_CONFLICT");
  assert.equal((await pay(service(), "__proto__", "1")).status, "confirmed");
  assert.equal((await pay(service(), "constructor", "1")).status, "confirmed");
  assert.equal(fs.statSync(fixture.stateFile).mode & 0o777, 0o600);
});

test("journal-before-broadcast recovers identical bytes; status never broadcasts and a second bill is blocked", async () => {
  const raw: string[] = [];
  const stalled = service({ provider: wrapped({ broadcastTransaction: async (tx: string) => { raw.push(tx); throw timeout(); } }) });
  assert.equal((await pay(stalled)).status, "prepared");
  assert.equal(await fixture.asset.balanceOf(payee.address), 0n);
  const action = JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).actions["bill-0001"];
  assert.equal(action.rawTransaction, raw[0]);
  assert.equal(Transaction.from(raw[0]).to, fixture.tijori.target);
  await stalled.invoke("transactionStatus", { operationId: "bill-0001" });
  assert.equal(raw.length, 1);
  await rejectCode(pay(service(), "bill-0002"), "PENDING_OPERATION_EXISTS");
  const recovered = service({ provider: wrapped({ broadcastTransaction: async (tx: string) => {
    assert.equal(tx, raw[0]); return provider.broadcastTransaction(tx);
  } }) });
  assert.equal((await pay(recovered)).status, "confirmed");
  assert.equal(await fixture.asset.balanceOf(payee.address), 10n * unit);
});

test("lost response after a mined payment cannot duplicate payment", async () => {
  const s = service({ provider: wrapped({ broadcastTransaction: async (raw: string) => {
    await provider.broadcastTransaction(raw); throw timeout();
  } }) });
  const first = await pay(s);
  assert.equal(first.status, "confirmed");
  assert.equal((await pay(service())).transactionHash, first.transactionHash);
  assert.equal(await fixture.asset.balanceOf(payee.address), 10n * unit);
});

test("confirmation depth blocks the next operation until the first receipt is final enough", async () => {
  const s = service({ confirmations: 2 });
  assert.equal((await pay(s)).status, "pending");
  await rejectCode(pay(s, "bill-0002"), "PENDING_OPERATION_EXISTS");
  await hre.network.provider.send("evm_mine");
  assert.equal((await s.invoke("transactionStatus", { operationId: "bill-0001" })).status, "confirmed");
  assert.equal((await pay(s, "bill-0002")).status, "pending");
  await s.invoke("transactionStatus", { operationId: "bill-0001" });
  assert.equal(s.state.pendingId, "bill-0002");
});

test("unknown nonce replacement and a revoked prepared agent fail closed across restart", async () => {
  const stalled = service({ provider: wrapped({ broadcastTransaction: async () => { throw timeout(); } }) });
  await pay(stalled);
  await sent(fixture.tijori.setPaused(true));
  await rejectCode(pay(service()), "AGENT_PAUSED");
  await sent(fixture.tijori.setPaused(false));
  await (await wallet.sendTransaction({ to: wallet.address, value: 0n })).wait();
  const s = service();
  assert.equal((await s.invoke("transactionStatus", { operationId: "bill-0001" })).status, "conflict");
  await rejectCode(pay(s), "NONCE_CONFLICT_REQUIRES_REVIEW");
  await rejectCode(pay(s, "bill-0002"), "PENDING_OPERATION_EXISTS");
  assert.equal(await fixture.asset.balanceOf(payee.address), 0n);
});

test("disk failure, corrupted journal, wrong deployment and wrong RPC chain prevent writes", async () => {
  const stateFile = path.join(temporary, "not-a-directory");
  fs.writeFileSync(stateFile, "blocked");
  let broadcasts = 0;
  const s = service({ stateFile: path.join(stateFile, "state.json"), provider: wrapped({ broadcastTransaction: async () => { broadcasts++; } }) });
  await assert.rejects(pay(s));
  assert.equal(broadcasts, 0);
  const stalled = service({ provider: wrapped({ broadcastTransaction: async () => { throw timeout(); } }) });
  await pay(stalled);
  const saved = JSON.parse(fs.readFileSync(fixture.stateFile, "utf8"));
  saved.actions["bill-0001"].data = "0x";
  writeJson(fixture.stateFile, saved);
  assert.throws(() => service(), /AGENT_STATE_INVALID/);
  saved.actions = true;
  writeJson(fixture.stateFile, saved);
  assert.throws(() => service(), /AGENT_STATE_CONTEXT_MISMATCH/);
  const otherFile = path.join(temporary, "fresh/state.json");
  await rejectCode(pay(service({ stateFile: otherFile, manifest: { ...fixture.manifest, market: fixture.router.target as string } })), "AGENT_DEPLOYMENT_MISMATCH");
  const wrongChain = wrapped({ send: async (method: string, params: unknown[]) => method === "eth_chainId" ? "0x13b2" : provider.send(method, params) });
  await rejectCode(pay(service({ provider: wrongChain, stateFile: otherFile })), "WRONG_RPC_CHAIN");
});

test("gas bounds and cancelled requests cannot create a payment; single-host lock excludes duplicate processes", async () => {
  await rejectCode(pay(service({ provider: wrapped({ getFeeData: async () => ({ gasPrice: parseUnits("251", "gwei") }) }) })), "GAS_PRICE_ABOVE_CAP");
  await rejectCode(pay(service({ maxGasLimit: 1n })), "GAS_LIMIT_ABOVE_CAP");
  await rejectCode(pay(service({ provider: wrapped({ getBalance: async () => 0n }) })), "INSUFFICIENT_AGENT_GAS");
  await rejectCode(service().invoke("pay", { payee: payee.address, amountUsdc: "1", operationId: "bill-0001" }, AbortSignal.abort()), "REQUEST_CANCELLED");
  const controller = new AbortController();
  let reads = 0;
  const cancelling = wrapped({ getBlock: async (tag: string | number) => {
    const block = await provider.getBlock(tag);
    if (tag === "latest" && ++reads === 2) controller.abort();
    return block;
  } });
  await rejectCode(service({ provider: cancelling }).invoke("pay", {
    payee: payee.address, amountUsdc: "1", operationId: "cancelled-0001",
  }, controller.signal), "REQUEST_CANCELLED");
  const lock = `${fixture.stateFile}.lock`;
  const release = lockKeeper(lock);
  assert.throws(() => lockKeeper(lock), /KEEPER_ALREADY_RUNNING/);
  release();
  assert.equal(await fixture.asset.balanceOf(payee.address), 0n);
});

test("reverted prepared payments remain terminal and cannot automatically acquire another nonce", async () => {
  const stalled = service({ provider: wrapped({ broadcastTransaction: async () => { throw timeout(); } }) });
  await pay(stalled);
  const saved = JSON.parse(fs.readFileSync(fixture.stateFile, "utf8"));
  await sent(fixture.tijori.setPayeeCap(payee.address, 0n));
  // Local Hardhat reports a send error for a mined revert; the actual receipt still exists.
  try { await provider.broadcastTransaction(saved.actions["bill-0001"].rawTransaction); } catch {}
  const s = service();
  assert.equal((await s.invoke("transactionStatus", { operationId: "bill-0001" })).status, "reverted");
  const nonce = await provider.getTransactionCount(wallet.address);
  await sent(fixture.tijori.setPayeeCap(payee.address, 40n * unit));
  assert.equal((await pay(service())).status, "reverted");
  assert.equal(await provider.getTransactionCount(wallet.address), nonce);
  assert.equal(await fixture.asset.balanceOf(payee.address), 0n);
});

test("a prepared payment is simulated again after restart; revoked policy prevents broadcast and preserves its nonce", async () => {
  await pay(service({ provider: wrapped({ broadcastTransaction: async () => { throw timeout(); } }) }));
  const saved=JSON.parse(fs.readFileSync(fixture.stateFile,"utf8"));
  const nonce=await provider.getTransactionCount(wallet.address);
  await sent(fixture.tijori.setPayeeCap(payee.address,0));
  let broadcasts=0;
  const guarded=service({provider:wrapped({broadcastTransaction:async (raw: string)=>{broadcasts++;return provider.broadcastTransaction(raw);}})});
  await rejectCode(pay(guarded),"TRANSACTION_SIMULATION_FAILED");
  assert.equal(broadcasts,0);assert.equal(await provider.getTransactionCount(wallet.address),nonce);
  assert.equal(guarded.state.actions["bill-0001"].hash,saved.actions["bill-0001"].hash);
  await sent(fixture.tijori.setPayeeCap(payee.address,40n*unit));
  const recovered=await pay(service());assert.equal(recovered.status,"confirmed");assert.equal(recovered.transactionHash,saved.actions["bill-0001"].hash);
});

test("agent rotation preserves old action history but cannot replay an old unbroadcast payment", async () => {
  await pay(service({ provider: wrapped({ broadcastTransaction: async () => { throw timeout(); } }) }));
  await sent(fixture.tijori.setAgent(replacement.address));
  await rejectCode(pay(service({ signer: replacement })), "OLD_AGENT_PENDING_REQUIRES_REVIEW");
  await rejectCode(pay(service({ signer: replacement }), "bill-0002"), "PENDING_OPERATION_EXISTS");
  assert.equal(await fixture.asset.balanceOf(payee.address), 0n);
});

test("a recent confirmed receipt disappearing while another action is pending persistently halts writes", async () => {
  await pay(service());
  await pay(service({ provider: wrapped({ broadcastTransaction: async () => { throw timeout(); } }) }), "bill-0002");
  const first = service().state.actions["bill-0001"];
  const reorg = service({ provider: wrapped({ getTransactionReceipt: async (hash: string) =>
    hash === first.hash ? null : provider.getTransactionReceipt(hash) }) });
  await rejectCode(reorg.invoke("transactionStatus", { operationId: "bill-0001" }), "AGENT_HISTORY_REORG_REQUIRES_REVIEW");
  await rejectCode(pay(service(), "bill-0002"), "AGENT_HISTORY_REORG_REQUIRES_REVIEW");
  assert.equal(service().state.pendingId, "bill-0002");
});

test("unknown wallet pending transactions, request overlap and chain changes during preparation block signing", async () => {
  const nonce = await provider.getTransactionCount(wallet.address);
  await rejectCode(pay(service({ provider: wrapped({ getTransactionCount: async (_address: string, tag: string) =>
    tag === "pending" ? nonce + 1 : nonce }) })), "WALLET_HAS_UNKNOWN_PENDING_TRANSACTION");
  let checks = 0;
  const changing = wrapped({ send: async (method: string, params: unknown[]) => method === "eth_chainId" ?
    (++checks <= 2 ? "0x7a69" : "0x13b2") : provider.send(method, params) });
  await rejectCode(pay(service({ provider: changing })), "WRONG_RPC_CHAIN");
  const s = service();
  const first = s.invoke("treasuryStatus");
  await rejectCode(s.invoke("treasuryStatus"), "AGENT_BUSY");
  await first;
  assert.equal(await fixture.asset.balanceOf(payee.address), 0n);
});

test("MCP SDK client lists tools, executes scoped calls and receives sanitized failures", async () => {
  const server = createServer(() => service());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 8);
    assert.equal(tools.tools.find((t) => t.name === "pay")!.annotations!.readOnlyHint, false);
    assert.equal(((await client.callTool({ name: "treasuryStatus", arguments: {} })).structuredContent as any).usdc.raw, (150n * unit).toString());
    const result = await client.callTool({ name: "pay", arguments: { payee: payee.address, amountUsdc: "10", operationId: "bill-0001" } });
    assert.equal((result.structuredContent as any).status, "confirmed");
    assert.equal(JSON.stringify(result).includes("rawTransaction"), false);
    const invalid = await client.callTool({ name: "pay", arguments: { payee: payee.address, amountUsdc: "10", operationId: "bill-0002", receiver: owner.address } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); await server.close(); }
  const errorServer = createServer(() => { throw timeout(); });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const errorClient = new Client({ name: "error-client", version: "1" });
  await errorServer.connect(b); await errorClient.connect(a);
  try {
    const result = await errorClient.callTool({ name: "treasuryStatus", arguments: {} });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, { error: "AGENT_TOOL_FAILED" });
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
  } finally { await errorClient.close(); await errorServer.close(); }
});

test("actual stdio subprocess completes MCP handshake without a deployed treasury or network access", async () => {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(projectRoot, "agent/mcp-server.ts")], cwd: temporary,
    env: { AGENT_TIJORI_ADDRESS: "" }, stderr: "pipe" });
  const client = new Client({ name: "stdio-test", version: "1" });
  let diagnostics = "";
  transport.stderr!.on("data", (chunk) => { diagnostics += chunk; });
  await client.connect(transport);
  try {
    assert.equal((await client.listTools()).tools.length, 8);
    const result = await client.callTool({ name: "treasuryStatus", arguments: {} });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, { error: "AGENT_TIJORI_NOT_CONFIGURED" });
    assert.equal(diagnostics, "");
  } finally { await client.close(); }
});

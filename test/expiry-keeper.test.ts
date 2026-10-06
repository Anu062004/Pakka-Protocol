import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import hre from "hardhat";
import { BrowserProvider, Contract, ContractFactory, HDNodeWallet, Transaction, keccak256, parseEther, parseUnits } from "ethers";
import type { JsonRpcApiProvider, JsonRpcSigner } from "ethers";
import { compile } from "../scripts/compile.ts";
import { ExpiryKeeper, lockKeeper, writeJson, type KeeperHealth } from "../scripts/expiry-keeper.ts";
import { keeperConfig, keeperHealth, main } from "../scripts/keeper-testnet.ts";
import type { ContractArtifact } from "../backend/types.ts";

const provider = new BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
const wallet = HDNodeWallet.fromPhrase("test test test test test test test test test test test junk", undefined,
  "m/44'/60'/0'/0/6").connect(provider) as HDNodeWallet;
const ownerWallet = HDNodeWallet.fromPhrase("test test test test test test test test test test test junk").connect(provider) as HDNodeWallet;
const sent = async (tx: Promise<{ wait: () => Promise<any> }>) => (await tx).wait();
const timeout = () => Object.assign(new Error("secret error text must never appear in logs"), { code: "TIMEOUT" });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pakka-keeper-"));
let artifacts: Record<string, ContractArtifact>, owner: JsonRpcSigner, stranger: JsonRpcSigner, fixtureNumber = 0;

before(async () => {
  artifacts = compile();
  [owner, stranger] = await Promise.all([provider.getSigner(0), provider.getSigner(1)]);
});
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

function wrapped(overrides: Record<string, unknown>): JsonRpcApiProvider {
  return new Proxy(provider, { get(target, key) {
    if (Object.hasOwn(overrides, key)) return overrides[key as string];
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } }) as unknown as JsonRpcApiProvider;
}

async function deploy(name: string, args: unknown[] = []): Promise<Contract> {
  const a = artifacts[name]!;
  const c = await new ContractFactory(a.abi, a.bytecode!, owner).deploy(...args);
  await c.waitForDeployment();
  return c as unknown as Contract;
}

interface SeriesFixture {
  yt: Contract;
  expiry: number;
}

async function setup({ count = 1 }: { count?: number } = {}) {
  const asset = await deploy("MockUSDC");
  const vault = await deploy("MockVault", [asset.target, 12]);
  const registry = await deploy("SeriesRegistry", [asset.target, owner.address]);
  await hre.network.provider.send("hardhat_setBalance", [wallet.address, "0x8ac7230489e80000"]);
  const expiry = (await provider.getBlock("latest"))!.timestamp + 1000;
  const series: SeriesFixture[] = [];
  for (let i = 0; i < count; i++) {
    const yt = await deploy("YieldToken", [vault.target, expiry + i * 100, `KEEPER-${i}`, registry.target]);
    await sent(registry.registerSeries(yt.target));
    series.push({ yt, expiry: expiry + i * 100 });
  }
  const stateFile = path.join(temporary, `${++fixtureNumber}/state.json`);
  const logs: Record<string, unknown>[] = [];
  const keeper = (overrides: Record<string, unknown> = {}) => new ExpiryKeeper({ provider, signer: wallet, registryAddress: registry.target as string,
    stateFile, chainId: 31337, confirmations: 1, minGasBalance: 0n, log: (item: Record<string, unknown>) => logs.push(item), ...overrides } as any);
  const mature = async () => {
    await hre.network.provider.send("evm_setNextBlockTimestamp", [series.at(-1)!.expiry]);
    await hre.network.provider.send("evm_mine");
  };
  const nonce = await provider.getTransactionCount(wallet.address, "latest");
  return { asset, vault, registry, series, stateFile, keeper, mature, nonce, logs, yt: series[0]!.yt, expiry };
}

function alert(health: KeeperHealth, code: string) {
  assert.equal(health.ok, false);
  assert(health.alerts.some((a) => a.code === code), JSON.stringify(health));
}

async function unbroadcast(f: Awaited<ReturnType<typeof setup>>) {
  const k = f.keeper({ provider: wrapped({ broadcastTransaction: async () => { throw timeout(); } }) });
  const health = await k.tick();
  alert(health, "BROADCAST_FAILED");
  return JSON.parse(fs.readFileSync(f.stateFile, "utf8"));
}

test("future series cause no transaction; health records the block and a fresh heartbeat", async () => {
  const f = await setup();
  const health = await f.keeper().tick();
  assert.equal(health.ok, true);
  assert.equal(health.registeredSeries, 1);
  assert.equal(health.unsettledMaturedSeries, 0);
  assert.equal(health.pendingHash, null);
  assert.equal(await provider.getTransactionCount(wallet.address, "latest"), f.nonce);
  assert.equal(keeperHealth({ stateFile: f.stateFile, pollMs: 10000 }).fresh, true);
  assert.equal(keeperHealth({ stateFile: f.stateFile, pollMs: 10000 }, Date.now() + 100000).fresh, false);
});

test("permissionless keeper settles a funded PT/YT position without changing holdings or paying itself", async () => {
  const f = await setup();
  await sent(f.asset.mint(owner.address, 100_000_000n));
  await sent(f.asset.approve(f.yt.target, 100_000_000n));
  await sent(f.yt.splitFromAssets(100_000_000n, owner.address));
  await sent(f.vault.addYield(5_000_000n));
  await f.mature();
  const health = await f.keeper().tick();
  assert.equal(health.ok, true);
  assert(await f.yt.indexAtExpiry() > 0n);
  assert.equal(await f.yt.balanceOf(owner.address), 100_000_000n);
  assert.equal(await f.asset.balanceOf(wallet.address), 0n);
  assert.equal((fs.statSync(f.stateFile).mode & 0o777), 0o600);
  const index = await f.yt.indexAtExpiry();
  await sent(f.vault.addYield(5_000_000n));
  await sent(f.yt.claimInterest(owner.address, true));
  assert.equal(await f.yt.indexAtExpiry(), index);
});

test("registry discoveries include later registrations; three maturities settle in expiry order", async () => {
  const f = await setup({ count: 2 });
  const k = f.keeper();
  assert.equal((await k.tick()).registeredSeries, 2);
  const third = await deploy("YieldToken", [f.vault.target, f.expiry + 300, "KEEPER-NEW", f.registry.target]);
  await sent(f.registry.registerSeries(third.target));
  await hre.network.provider.send("evm_setNextBlockTimestamp", [f.expiry + 300]);
  await hre.network.provider.send("evm_mine");
  for (let i = 0; i < 4; i++) assert.equal((await k.tick()).ok, true);
  for (const yt of [...f.series.map((s) => s.yt), third]) assert(await yt.indexAtExpiry() > 0n);
  assert.deepEqual(f.logs.filter((l) => l.event === "prepared").map((l) => l.seriesId), [1, 2, 3]);
  assert.equal(await provider.getTransactionCount(wallet.address, "latest"), f.nonce + 3);
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile, "utf8")).pending, null);
});

test("already settled series are skipped and confirmed transactions survive a worker restart", async () => {
  const f = await setup({ count: 2 });
  await f.mature();
  await sent((f.series[0]!.yt.connect(stranger) as Contract).settleExpiry());
  await f.keeper().tick();
  const saved = JSON.parse(fs.readFileSync(f.stateFile, "utf8"));
  assert.equal(saved.pending.seriesId, 2);
  await f.keeper().tick();
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile, "utf8")).pending, null);
  assert.equal(await provider.getTransactionCount(wallet.address, "latest"), f.nonce + 1);
});

test("journal-before-broadcast failure recovers the identical signed transaction after restart", async () => {
  const f = await setup();
  await f.mature();
  const saved = await unbroadcast(f);
  assert.equal(await f.yt.indexAtExpiry(), 0n);
  assert.equal(await provider.getTransactionCount(wallet.address, "latest"), f.nonce);
  assert.equal(JSON.stringify(f.logs).includes("secret error text"), false);
  assert.equal(JSON.stringify(f.logs).includes(saved.pending.rawTransaction), false);
  const k = f.keeper();
  await k.tick();
  assert(await f.yt.indexAtExpiry() > 0n);
  assert.equal((f.logs.findLast((l: any) => l.event === "broadcast") as any).hash, saved.pending.hash);
  await k.tick();
  assert.equal(k.state!.pending, null);
});

test("a lost RPC response after mining is recovered by receipt without rebroadcasting", async () => {
  const f = await setup();
  await f.mature();
  await f.keeper({ provider: wrapped({ broadcastTransaction: async (raw: string) => {
    await provider.broadcastTransaction(raw);
    throw timeout();
  } }) }).tick();
  assert(await f.yt.indexAtExpiry() > 0n);
  let broadcasts = 0;
  const k = f.keeper({ provider: wrapped({ broadcastTransaction: async () => { broadcasts++; throw timeout(); } }) });
  assert.equal((await k.tick()).ok, true);
  assert.equal(broadcasts, 0);
  assert.equal(k.state!.pending, null);
});

test("pending and dropped transactions never create a new nonce; a dropped transaction is replayed", async () => {
  const f = await setup();
  await f.mature();
  await hre.network.provider.send("evm_setAutomine", [false]);
  try {
    const k = f.keeper({ pendingAlertSeconds: 1 });
    await k.tick();
    const hash = k.state!.pending!.hash;
    await k.tick();
    assert.equal(f.logs.filter((l) => l.event === "broadcast").length, 1);
    k.save({ ...k.state!, pending: { ...k.state!.pending!, savedAt: Math.floor(Date.now() / 1000) - 10 } });
    alert(await k.tick(), "TRANSACTION_STUCK");
    await hre.network.provider.send("hardhat_dropTransaction", [hash]);
    await f.keeper().tick();
    assert.equal(f.logs.filter((l: any) => l.event === "broadcast").length, 2);
    assert.equal((f.logs.findLast((l: any) => l.event === "broadcast") as any).hash, hash);
    await hre.network.provider.send("evm_mine");
    await f.keeper().tick();
    assert.equal(await provider.getTransactionCount(wallet.address, "latest"), f.nonce + 1);
  } finally { await hre.network.provider.send("evm_setAutomine", [true]); }
});

test("configured confirmations are required before clearing a receipt", async () => {
  const f = await setup();
  await f.mature();
  const k = f.keeper({ confirmations: 2 });
  await k.tick();
  await k.tick();
  assert(k.state!.pending);
  assert(f.logs.some((l) => l.event === "confirming"));
  await hre.network.provider.send("evm_mine");
  await k.tick();
  assert.equal(k.state!.pending, null);
});

test("a local reorg removes the receipt and replays the same journaled transaction", async () => {
  const f = await setup();
  await f.mature();
  const snapshot = await hre.network.provider.send("evm_snapshot");
  await f.keeper().tick();
  const hash = JSON.parse(fs.readFileSync(f.stateFile, "utf8")).pending.hash;
  assert(await f.yt.indexAtExpiry() > 0n);
  assert.equal(await hre.network.provider.send("evm_revert", [snapshot]), true);
  assert.equal(await f.yt.indexAtExpiry(), 0n);
  await f.keeper().tick();
  assert(await f.yt.indexAtExpiry() > 0n);
  assert.equal((f.logs.findLast((l: any) => l.event === "broadcast") as any).hash, hash);
});

test("nonce replacement halts an unsettled series, while external settlement resolves it", async () => {
  const f = await setup();
  await f.mature();
  const saved = await unbroadcast(f);
  await sent(wallet.sendTransaction({ to: stranger.address, value: 1n, nonce: saved.pending.nonce,
    gasPrice: parseUnits("25", "gwei") }));
  const k = f.keeper();
  alert(await k.tick(), "NONCE_CONFLICT");
  assert.equal(k.state!.pending!.hash, saved.pending.hash);
  assert.equal(await f.yt.indexAtExpiry(), 0n);
  await sent((f.yt.connect(stranger) as Contract).settleExpiry());
  assert.equal((await k.tick()).ok, true);
  assert.equal(k.state!.pending, null);
});

test("unknown pending wallet activity blocks signing another settlement", async () => {
  const f = await setup();
  await f.mature();
  await hre.network.provider.send("evm_setAutomine", [false]);
  try {
    await wallet.sendTransaction({ to: stranger.address, value: 1n, gasPrice: parseUnits("25", "gwei") });
    const k = f.keeper();
    alert(await k.tick(), "WALLET_HAS_UNKNOWN_PENDING_TRANSACTION");
    assert.equal(k.state!.pending, null);
    assert.equal(await f.yt.indexAtExpiry(), 0n);
    await hre.network.provider.send("evm_mine");
  } finally { await hre.network.provider.send("evm_setAutomine", [true]); }
});

test("a failed broadcast simulation retains the journal and never sends; recovery uses the same hash", async () => {
  const f=await setup();await f.mature();let calls=0,broadcasts=0;
  const k=f.keeper({provider:wrapped({call:async (tx: any)=>{
    if(tx.data.startsWith(f.yt.interface.getFunction("settleExpiry")!.selector)&&++calls===2)throw timeout();
    return provider.call(tx);
  },broadcastTransaction:async (raw: string)=>{broadcasts++;return provider.broadcastTransaction(raw);}})});
  alert(await k.tick(),"SETTLEMENT_SIMULATION_FAILED");
  assert.equal(broadcasts,0);assert(k.state!.pending);const hash=k.state!.pending!.hash;
  assert.equal(await provider.getTransactionCount(wallet.address),f.nonce);
  const recovered=f.keeper();await recovered.tick();assert.equal(recovered.state!.pending!.hash,hash);
  await recovered.tick();assert.equal(recovered.state!.pending,null);
});

test("wrong RPC chain, missing registry and privileged keeper wallet fail before sending", async () => {
  const f = await setup();
  await f.mature();
  const wrong = f.keeper({ provider: wrapped({ send: async (method: string, args: unknown[]) => method === "eth_chainId"
    ? "0x13b2" : provider.send(method, args) }) });
  const health = await wrong.tick();
  assert.equal(health.fatal, true);
  assert.equal(health.alerts[0].errorCode, "WRONG_RPC_CHAIN");
  assert.equal((await f.keeper({ registryAddress: stranger.address }).tick()).alerts[0].errorCode, "REGISTRY_NOT_DEPLOYED");
  assert.equal((await f.keeper({ signer: ownerWallet }).tick()).alerts[0].errorCode, "KEEPER_USES_OWNER_WALLET");
  assert.throws(() => f.keeper({ chainId: 5042 }), /UNSUPPORTED_CHAIN/);
  assert.equal(await provider.getTransactionCount(wallet.address, "latest"), f.nonce);
});

test("stale and failed RPC reads emit unhealthy heartbeats and recover on later cycles", async () => {
  const f = await setup();
  await f.mature();
  const stale = f.keeper({ provider: wrapped({ getBlock: async (tag: string | number) => ({ ...await provider.getBlock(tag),
    timestamp: Math.floor(Date.now() / 1000) - 1000 }) }) });
  alert(await stale.tick(), "STALE_RPC_BLOCK");
  const failed = f.keeper({ provider: wrapped({ getBlock: async () => { throw timeout(); } }) });
  alert(await failed.tick(), "KEEPER_CYCLE_FAILED");
  assert.equal(await f.yt.indexAtExpiry(), 0n);
  assert.equal((await f.keeper().tick()).ok, true);
  assert(await f.yt.indexAtExpiry() > 0n);
});

test("gas price/limit ceilings and insufficient funds prevent signing; low balance warns without stopping affordable work", async () => {
  const f = await setup();
  await f.mature();
  alert(await f.keeper({ provider: wrapped({ getFeeData: async () => ({ gasPrice: parseUnits("251", "gwei") }) }) }).tick(), "GAS_PRICE_CAP_EXCEEDED");
  alert(await f.keeper({ maxGasLimit: 21000n }).tick(), "GAS_LIMIT_CAP_EXCEEDED");
  await hre.network.provider.send("hardhat_setBalance", [wallet.address, "0x0"]);
  alert(await f.keeper().tick(), "INSUFFICIENT_GAS_FUNDS");
  assert.equal(await f.yt.indexAtExpiry(), 0n);
  assert.equal(fs.existsSync(f.stateFile), false);
  await hre.network.provider.send("hardhat_setBalance", [wallet.address, "0x8ac7230489e80000"]);
  alert(await f.keeper({ minGasBalance: parseEther("20") }).tick(), "LOW_GAS_BALANCE");
  assert(await f.yt.indexAtExpiry() > 0n);
});

test("failed estimation of an earlier series does not block another matured series", async () => {
  const f = await setup({ count: 2 });
  await f.mature();
  const k = f.keeper({ provider: wrapped({ estimateGas: async (tx: any) => {
    if (tx.to === f.yt.target) throw Object.assign(new Error("bad vault"), { code: "CALL_EXCEPTION" });
    return provider.estimateGas(tx);
  } }) });
  alert(await k.tick(), "SETTLEMENT_PREPARE_FAILED");
  assert.equal(await f.yt.indexAtExpiry(), 0n);
  assert(await f.series[1].yt.indexAtExpiry() > 0n);
});

test("invalid state context or signed transaction fields are rejected rather than rebroadcast", async () => {
  const f = await setup();
  await f.mature();
  const saved = await unbroadcast(f);
  const original = Transaction.from(saved.pending.rawTransaction);
  for (const patch of [{ to: f.asset.target }, { data: "0x" }, { value: 1n }, { chainId: 5042 },
    { gasPrice: parseUnits("251", "gwei") }, { gasLimit: 500001n }]) {
    const raw = await wallet.signTransaction({ to: original.to, data: original.data, value: 0n,
      nonce: original.nonce, chainId: 31337, type: 0, gasPrice: original.gasPrice, gasLimit: original.gasLimit, ...patch });
    writeJson(f.stateFile, { ...saved, pending: { ...saved.pending, rawTransaction: raw, hash: keccak256(raw) } });
    const health = await f.keeper().tick();
    assert.equal(health.fatal, true);
    assert.equal(health.alerts[0].errorCode, "KEEPER_PENDING_INVALID");
  }
  writeJson(f.stateFile, { ...saved, wallet: stranger.address });
  assert.equal((await f.keeper().tick()).alerts[0].errorCode, "KEEPER_STATE_CONTEXT_MISMATCH");
  writeJson(f.stateFile, { ...saved, pending: 0 });
  assert.throws(() => f.keeper(), /KEEPER_STATE_INVALID/);
  fs.writeFileSync(f.stateFile, "{invalid");
  assert.throws(() => f.keeper(), /KEEPER_STATE_INVALID/);
  assert.equal(await provider.getTransactionCount(wallet.address, "latest"), f.nonce);
});

test("journal write failure never broadcasts, and successful persistence permits a later retry", async () => {
  const f = await setup();
  await f.mature();
  fs.mkdirSync(`${f.stateFile}.tmp`, { recursive: true });
  const k = f.keeper();
  alert(await k.tick(), "SETTLEMENT_PREPARE_FAILED");
  assert.equal(k.state!.pending, null);
  assert.equal(await f.yt.indexAtExpiry(), 0n);
  fs.rmdirSync(`${f.stateFile}.tmp`);
  await k.tick();
  assert(await f.yt.indexAtExpiry() > 0n);
});

test("reverted settlement receipts clear the journal and permit a later successful retry", async () => {
  const f = await setup();
  await f.mature();
  await unbroadcast(f);
  const code = await provider.getCode(f.vault.target);
  // Change the vault after estimating/signing so the recorded settlement really reverts.
  await hre.network.provider.send("hardhat_setCode", [f.vault.target, "0x60006000fd"]);
  const k = f.keeper();
  await k.tick();
  assert.equal(await f.yt.indexAtExpiry(), 0n);
  alert(await k.tick(), "SETTLEMENT_REVERTED");
  assert.equal(k.state!.pending, null);
  await hre.network.provider.send("hardhat_setCode", [f.vault.target, code]);
  assert.equal((await k.tick()).ok, true);
  assert(await f.yt.indexAtExpiry() > 0n);
  assert.equal(await provider.getTransactionCount(wallet.address, "latest"), f.nonce + 2);
});

test("a receipt with the wrong block hash is kept pending until canonical evidence is available", async () => {
  const f = await setup();
  await f.mature();
  await f.keeper().tick();
  const k = f.keeper({ provider: wrapped({ getTransactionReceipt: async (hash: string) => ({
    ...await provider.getTransactionReceipt(hash), blockHash: `0x${"00".repeat(32)}`,
  }) }) });
  alert(await k.tick(), "RECEIPT_NOT_CANONICAL");
  assert(k.state!.pending);
  const recovered = f.keeper();
  assert.equal((await recovered.tick()).ok, true);
  assert.equal(recovered.state!.pending, null);
});

test("an overlapping tick is rejected while the original cycle can complete", async () => {
  const f = await setup();
  let entered: (() => void) | undefined, release: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const k = f.keeper({ provider: wrapped({ getBlock: async (tag: string | number) => {
    entered!();
    await gate;
    return provider.getBlock(tag);
  } }) });
  const first = k.tick();
  await ready;
  await assert.rejects(() => k.tick(), /KEEPER_TICK_OVERLAP/);
  release!();
  assert.equal((await first).ok, true);
});

test("single-process lock excludes duplicates and reclaims the lock of an exited process", () => {
  const file = path.join(temporary, "locking/state.lock");
  const release = lockKeeper(file);
  assert.throws(() => lockKeeper(file), /KEEPER_ALREADY_RUNNING/);
  release();
  const exitedPid = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }));
  fs.writeFileSync(file, JSON.stringify({ pid: exitedPid }));
  lockKeeper(file)();
  assert.equal(fs.existsSync(file), false);
});

test("CLI validates configuration, provides key-free health checks and fails safely before deployment", async () => {
  for (const env of [{ KEEPER_POLL_INTERVAL_SECONDS: "0" }, { KEEPER_POLL_INTERVAL_SECONDS: "86401" },
    { KEEPER_CONFIRMATIONS: "1.5" }, { KEEPER_MAX_GAS_PRICE_GWEI: "1" }, { KEEPER_MIN_GAS_BALANCE: "-1" }]) {
    assert.throws(() => keeperConfig(env), /Invalid|must not exceed/);
  }
  await assert.rejects(() => main(["--unknown"], {}), /Usage/);
  await assert.rejects(() => main(["--once"], {}), /dedicated, funded testnet wallet/);
  const config = keeperConfig({ KEEPER_STATE_FILE: path.join(temporary, "cli/state.json") });
  writeJson(`${config.stateFile}.health.json`, { checkedAt: new Date().toISOString(), ok: true });
  assert.equal(await main(["--health"], { KEEPER_STATE_FILE: config.stateFile }), 0);
  writeJson(`${config.stateFile}.health.json`, { checkedAt: new Date(0).toISOString(), ok: true });
  assert.equal(await main(["--health"], { KEEPER_STATE_FILE: config.stateFile }), 1);
});

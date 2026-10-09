import fs from "node:fs";
import path from "node:path";
import { Contract, Interface, Transaction, getAddress, keccak256, parseEther, parseUnits } from "ethers";
import type { JsonRpcApiProvider, Signer } from "ethers";

const registryAbi = [
  "function owner() view returns (address)",
  "function assetToken() view returns (address)",
  "function seriesCount() view returns (uint256)",
  "function getSeries(uint256) view returns (tuple(address vault,address principalToken,address yieldToken,uint256 expiry,bool hasPool,tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey))",
];
const yieldAbi = ["function indexAtExpiry() view returns (uint256)", "function settleExpiry() returns (uint256)"];
const settleData = new Interface(yieldAbi).encodeFunctionData("settleExpiry");
const canonicalUsdc = "0x3600000000000000000000000000000000000000";

interface CodedError extends Error {
  code: string;
  fatal?: boolean;
}
const fail = (code: string): never => { throw Object.assign(new Error(code), { code, fatal: true }) as CodedError; };

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  const fd = fs.openSync(temporary, "w", 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(directory); }
  finally { fs.closeSync(directory); }
}

// Single host lock; a crashed process's lock is reclaimed using its PID.
// Run one worker per dedicated wallet and persist this directory across restarts.
export function lockKeeper(file: string): () => void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); }
      finally { fs.closeSync(fd); }
      return () => fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let pid: number;
      try { pid = (JSON.parse(fs.readFileSync(file, "utf8")) as { pid: number }).pid; }
      catch { return fail("KEEPER_LOCK_INVALID"); }
      if (!Number.isSafeInteger(pid) || pid <= 0) fail("KEEPER_LOCK_INVALID");
      try { process.kill(pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") { fs.unlinkSync(file); continue; }
        throw error;
      }
      fail("KEEPER_ALREADY_RUNNING");
    }
  }
  return fail("KEEPER_LOCK_FAILED");
}

export interface KeeperOptions {
  confirmations: number;
  maxBlockAgeSeconds: number;
  pendingAlertSeconds: number;
  maxGasPrice: bigint;
  maxGasLimit: bigint;
  minGasBalance: bigint;
}

export interface PendingSettlement {
  seriesId: number;
  nonce: number;
  hash: string;
  rawTransaction: string;
  savedAt: number;
}

export interface KeeperState {
  version: 1;
  chainId: number;
  registry: string;
  wallet: string;
  pending: PendingSettlement | null;
}

export interface KeeperAlert {
  code: string;
  seriesId?: number;
  [key: string]: unknown;
}

export interface KeeperHealth {
  checkedAt: string;
  ok: boolean;
  chainId: number;
  registry: string;
  alerts: KeeperAlert[];
  pendingHash: string | null;
  wallet?: string;
  blockNumber?: number;
  blockTimestamp?: number;
  blockAgeSeconds?: number;
  gasBalanceWei?: string;
  registeredSeries?: number;
  unsettledMaturedSeries?: number;
  fatal?: boolean;
}

type DueSeries = { id: number; yt: Contract; expiry: number };

export class ExpiryKeeper {
  provider: JsonRpcApiProvider;
  signer: Signer;
  registry: Contract;
  chainId: number;
  stateFile: string;
  healthFile: string;
  options: KeeperOptions;
  log: (record: Record<string, unknown>) => void;
  running: boolean;
  state: KeeperState | null;
  address!: string;

  constructor({ provider, signer, registryAddress, stateFile, chainId = 5042002,
    confirmations = 2, maxBlockAgeSeconds = 120, pendingAlertSeconds = 120,
    maxGasPrice = parseUnits("250", "gwei"), maxGasLimit = 500_000n,
    minGasBalance = parseEther("0.1"), log = () => {} }: {
    provider: JsonRpcApiProvider;
    signer: Signer;
    registryAddress: string;
    stateFile: string;
    chainId?: number;
    confirmations?: number;
    maxBlockAgeSeconds?: number;
    pendingAlertSeconds?: number;
    maxGasPrice?: bigint;
    maxGasLimit?: bigint;
    minGasBalance?: bigint;
    log?: (record: Record<string, unknown>) => void;
  }) {
    if (![5042, 5042002, 31337].includes(chainId)) fail("UNSUPPORTED_CHAIN");
    for (const n of [confirmations, maxBlockAgeSeconds, pendingAlertSeconds]) {
      if (!Number.isSafeInteger(n) || n <= 0) fail("INVALID_KEEPER_OPTIONS");
    }
    if (maxGasPrice < parseUnits("25", "gwei") || maxGasLimit <= 0n || minGasBalance < 0n) {
      fail("INVALID_KEEPER_OPTIONS");
    }
    this.provider = provider;
    this.signer = signer;
    this.registry = new Contract(getAddress(registryAddress), registryAbi, provider);
    this.chainId = chainId;
    this.stateFile = path.resolve(stateFile);
    this.healthFile = `${this.stateFile}.health.json`;
    this.options = { confirmations, maxBlockAgeSeconds, pendingAlertSeconds, maxGasPrice, maxGasLimit, minGasBalance };
    this.log = log;
    this.running = false;
    this.state = null;
    if (fs.existsSync(this.stateFile)) {
      try { this.state = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as KeeperState; }
      catch { fail("KEEPER_STATE_INVALID"); }
      if (!this.state || this.state.version !== 1 || !Object.hasOwn(this.state, "pending") ||
        (this.state.pending !== null && (typeof this.state.pending !== "object" || Array.isArray(this.state.pending)))) {
        fail("KEEPER_STATE_INVALID");
      }
    }
  }

  emit(event: string, fields: object = {}): void {
    // Never log raw errors, RPC URLs, environment values, keys or signed transaction bytes.
    this.log({ time: new Date().toISOString(), event, ...fields });
  }

  save(next: KeeperState): void {
    // Commit before changing memory; a disk failure must never enable an unjournaled broadcast.
    writeJson(this.stateFile, next);
    this.state = next;
  }

  alert(health: KeeperHealth, code: string, fields: Record<string, unknown> = {}): void {
    health.alerts.push({ code, ...fields });
    this.emit("alert", { code, ...fields });
  }

  async checkChain(): Promise<void> {
    // Fetch the actual RPC chain every tick and before broadcasts, regardless of provider network hints.
    if (BigInt(await this.provider.send("eth_chainId", []) as string) !== BigInt(this.chainId)) fail("WRONG_RPC_CHAIN");
  }

  async tick(): Promise<KeeperHealth> {
    if (this.running) fail("KEEPER_TICK_OVERLAP");
    this.running = true;
    const health: KeeperHealth = { checkedAt: new Date().toISOString(), ok: false, chainId: this.chainId,
      registry: this.registry.target as string, alerts: [], pendingHash: null };
    try {
      await this.checkChain();
      this.address = getAddress(await this.signer.getAddress());
      health.wallet = this.address;
      if (await this.provider.getCode(this.registry.target) === "0x") fail("REGISTRY_NOT_DEPLOYED");
      if (getAddress(await this.registry.owner() as string) === this.address) fail("KEEPER_USES_OWNER_WALLET");
      const asset = getAddress(await this.registry.assetToken() as string);
      if (this.chainId !== 31337 && asset !== canonicalUsdc) fail("WRONG_REGISTRY_ASSET");
      if (this.state && (this.state.chainId !== this.chainId || this.state.registry !== this.registry.target ||
        this.state.wallet !== this.address)) fail("KEEPER_STATE_CONTEXT_MISMATCH");
      this.state ??= { version: 1, chainId: this.chainId, registry: this.registry.target as string, wallet: this.address, pending: null };
      const block = await this.provider.getBlock("latest");
      if (!block) throw Object.assign(new Error("BLOCK_UNAVAILABLE"), { code: "BLOCK_UNAVAILABLE" });
      health.blockNumber = block.number;
      health.blockTimestamp = block.timestamp;
      health.blockAgeSeconds = Math.max(0, Math.floor(Date.now() / 1000) - block.timestamp);
      if (health.blockAgeSeconds > this.options.maxBlockAgeSeconds) {
        this.alert(health, "STALE_RPC_BLOCK");
        return health;
      }
      const balance = await this.provider.getBalance(this.address);
      health.gasBalanceWei = balance.toString();
      if (balance < this.options.minGasBalance) this.alert(health, "LOW_GAS_BALANCE");
      if (this.state.pending && await this.recover(block, health)) return health;

      const count = Number(await this.registry.seriesCount());
      if (!Number.isSafeInteger(count) || count < 0) fail("INVALID_SERIES_COUNT");
      health.registeredSeries = count;
      const due: DueSeries[] = [];
      // ponytail: full registry scan is sufficient for demo-sized registries; cache metadata/events at scale.
      for (let id = 1; id <= count; id++) {
        try {
          const item = await this.registry.getSeries(id);
          if (item.expiry > BigInt(block.timestamp)) continue;
          const yt = new Contract(item.yieldToken, yieldAbi, this.provider);
          if (await yt.indexAtExpiry() === 0n) due.push({ id, yt, expiry: Number(item.expiry) });
        } catch (error) { this.alert(health, "SERIES_READ_FAILED", { seriesId: id, errorCode: (error as CodedError).code ?? "UNKNOWN" }); }
      }
      due.sort((a, b) => a.expiry - b.expiry || a.id - b.id);
      health.unsettledMaturedSeries = due.length;
      for (const item of due) {
        try {
          if (await this.prepare(item, balance, health)) break;
        } catch (error) {
          const e = error as CodedError;
          if (e.fatal || this.state.pending) throw error;
          this.alert(health, "SETTLEMENT_PREPARE_FAILED", { seriesId: item.id, errorCode: e.code ?? "UNKNOWN" });
        }
      }
    } catch (error) {
      const e = error as CodedError;
      this.alert(health, "KEEPER_CYCLE_FAILED", { errorCode: e.code ?? "UNKNOWN" });
      if (e.fatal) health.fatal = true;
    } finally {
      health.pendingHash = this.state?.pending?.hash ?? null;
      health.ok = health.alerts.length === 0;
      try { writeJson(this.healthFile, health); }
      finally { this.running = false; }
      this.emit("health", health);
    }
    return health;
  }

  async validatePending(block: { timestamp: number }) {
    const p = this.state!.pending!;
    if (!Number.isSafeInteger(p.seriesId) || p.seriesId < 1 || !Number.isSafeInteger(p.savedAt) || p.savedAt <= 0) {
      fail("KEEPER_PENDING_INVALID");
    }
    let tx: Transaction;
    try { tx = Transaction.from(p.rawTransaction); }
    catch { return fail("KEEPER_PENDING_INVALID"); }
    const item = await this.registry.getSeries(p.seriesId);
    if (!tx.isSigned() || tx.hash !== p.hash || tx.from !== this.address || tx.to !== getAddress(item.yieldToken) ||
      tx.chainId !== BigInt(this.chainId) || tx.data !== settleData || tx.value !== 0n ||
      tx.nonce !== p.nonce || tx.type !== 0 || tx.gasPrice === null || tx.gasPrice <= 0n || tx.gasPrice > this.options.maxGasPrice ||
      tx.gasLimit <= 0n || tx.gasLimit > this.options.maxGasLimit || item.expiry > BigInt(block.timestamp)) {
      fail("KEEPER_PENDING_INVALID");
    }
    return tx;
  }

  async recover(block: { number: number; timestamp: number }, health: KeeperHealth): Promise<boolean> {
    const p = this.state!.pending!;
    const tx = await this.validatePending(block);
    const receipt = await this.provider.getTransactionReceipt(p.hash);
    if (receipt) {
      const canonical = await this.provider.getBlock(receipt.blockNumber);
      if (!canonical || canonical.hash !== receipt.blockHash) {
        this.alert(health, "RECEIPT_NOT_CANONICAL", { hash: p.hash });
        return true;
      }
      if (block.number - receipt.blockNumber + 1 < this.options.confirmations) {
        this.emit("confirming", { hash: p.hash, seriesId: p.seriesId });
        return true;
      }
      if (receipt.status === 1) {
        const yt = new Contract(tx.to!, yieldAbi, this.provider);
        if (await yt.indexAtExpiry() === 0n) fail("SETTLEMENT_NOT_OBSERVED");
        this.emit("settled", { seriesId: p.seriesId, hash: p.hash, blockNumber: receipt.blockNumber });
      } else {
        this.alert(health, "SETTLEMENT_REVERTED", { seriesId: p.seriesId, hash: p.hash });
      }
      this.save({ ...this.state!, pending: null });
      return receipt.status !== 1; // Retry a reverted transaction on the next cycle, not immediately.
    }
    const consumed = await this.provider.getTransactionCount(this.address, "latest");
    if (consumed > tx.nonce) {
      const yt = new Contract(tx.to!, yieldAbi, this.provider);
      if (await yt.indexAtExpiry() as bigint > 0n) {
        this.emit("settled_elsewhere", { seriesId: p.seriesId, hash: p.hash });
        this.save({ ...this.state!, pending: null });
        return false;
      }
      this.alert(health, "NONCE_CONFLICT", { hash: p.hash, nonce: tx.nonce });
      return true; // Preserve evidence; operator must inspect a replacement before clearing it.
    }
    const age = Math.max(0, Math.floor(Date.now() / 1000) - p.savedAt);
    if (age > this.options.pendingAlertSeconds) this.alert(health, "TRANSACTION_STUCK", { hash: p.hash, ageSeconds: age });
    if (await this.provider.getTransaction(p.hash)) {
      this.emit("pending", { hash: p.hash, seriesId: p.seriesId });
      return true;
    }
    await this.broadcast(tx, health); // Same signed bytes/hash/nonce, including after a pre-broadcast crash.
    return true;
  }

  async prepare({ id, yt, expiry }: DueSeries, balance: bigint, health: KeeperHealth): Promise<boolean> {
    const nonce = await this.provider.getTransactionCount(this.address, "latest");
    if (await this.provider.getTransactionCount(this.address, "pending") !== nonce) {
      this.alert(health, "WALLET_HAS_UNKNOWN_PENDING_TRANSACTION");
      return true;
    }
    const fees = await this.provider.getFeeData();
    if (!fees.gasPrice || fees.gasPrice <= 0n) throw Object.assign(new Error("GAS_QUOTE_UNAVAILABLE"), { code: "GAS_QUOTE_UNAVAILABLE" });
    const floor = parseUnits("25", "gwei");
    const gasPrice = fees.gasPrice > floor ? fees.gasPrice : floor;
    if (gasPrice > this.options.maxGasPrice) { this.alert(health, "GAS_PRICE_CAP_EXCEEDED"); return true; }
    const call = { from: this.address, to: yt.target as string, data: settleData, value: 0n };
    await this.provider.call(call);
    const gasLimit = (await this.provider.estimateGas(call) * 120n + 99n) / 100n;
    if (gasLimit <= 0n || gasLimit > this.options.maxGasLimit) {
      this.alert(health, "GAS_LIMIT_CAP_EXCEEDED", { seriesId: id });
      return false;
    }
    if (balance < gasLimit * gasPrice) { this.alert(health, "INSUFFICIENT_GAS_FUNDS"); return true; }
    const rawTransaction = await this.signer.signTransaction({ ...call, type: 0, nonce, chainId: this.chainId, gasLimit, gasPrice });
    const pending: PendingSettlement = { seriesId: id, nonce, hash: keccak256(rawTransaction), rawTransaction,
      savedAt: Math.floor(Date.now() / 1000) };
    this.save({ ...this.state!, pending });
    const tx = await this.validatePending((await this.provider.getBlock("latest"))!);
    this.emit("prepared", { seriesId: id, hash: pending.hash, nonce, lateSeconds: Math.max(0, (health.blockTimestamp ?? 0) - expiry) });
    await this.broadcast(tx, health);
    return true;
  }

  async broadcast(tx: Transaction, health: KeeperHealth): Promise<void> {
    await this.checkChain();
    if (await this.provider.getBalance(this.address) < tx.gasLimit * tx.gasPrice!) {
      this.alert(health, "INSUFFICIENT_GAS_FUNDS");
      return;
    }
    try { await this.provider.call({ from: this.address, to: tx.to, data: tx.data, value: 0n }); }
    catch { this.alert(health, "SETTLEMENT_SIMULATION_FAILED", { seriesId: this.state!.pending!.seriesId }); return; }
    try {
      const response = await this.provider.broadcastTransaction(this.state!.pending!.rawTransaction);
      if (response.hash !== tx.hash) fail("BROADCAST_HASH_MISMATCH");
      this.emit("broadcast", { seriesId: this.state!.pending!.seriesId, hash: tx.hash });
    } catch (error) {
      const e = error as CodedError;
      if (e.fatal) throw error;
      this.alert(health, "BROADCAST_FAILED", { hash: tx.hash, errorCode: e.code ?? "UNKNOWN" });
    }
  }
}

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Contract, Transaction, formatUnits, getAddress, keccak256, parseUnits } from "ethers";
import type { Block, JsonRpcApiProvider, Signer } from "ethers";
import { writeJson } from "../scripts/expiry-keeper.ts";
import { abi, projectRoot } from "../backend/project.ts";
import { QuoteService } from "../backend/quotes.ts";
import type { Manifest } from "../backend/types.ts";

export { projectRoot };

export class AgentError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export const fail = (code: string): never => { throw new AgentError(code); };

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (a: string, b: string): boolean => getAddress(a) === getAddress(b);
const rawLimit = (1n << 127n) - 1n;
const terminal = (action: AgentAction): boolean => ["confirmed", "reverted"].includes(action.status);
const tokenAbi = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];

export function amount(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d{1,32}(\.\d{1,6})?$/.test(value)) return fail("INVALID_USDC_AMOUNT");
  const result = parseUnits(value, 6);
  if (result <= 0n || result > rawLimit) fail("INVALID_USDC_AMOUNT");
  return result;
}
const money = (value: bigint) => ({ raw: value.toString(), usdc: formatUnits(value, 6) });

export interface PlanLeg {
  seriesId: number;
  expiry: number;
  dueTimestamp: number;
  ptAmount: string;
  quotedCost: string;
  maxUsdc: string;
}

export interface Plan {
  chainId: number;
  tijori: string;
  quotedAtBlock: number;
  deadline: number;
  schedule: "explicit-maturities" | "fixed-interval-seconds";
  slippageBps: number;
  maxTotalUsdc: string;
  quotedTotalUsdc: string;
  legs: PlanLeg[];
}

export type AgentActionStatus = "prepared" | "pending" | "confirmed" | "reverted" | "conflict";

export interface AgentAction {
  fingerprint: string;
  method: string;
  data: string;
  signer: string;
  nonce: number;
  rawTransaction: string;
  hash: string;
  status: AgentActionStatus;
  blockNumber?: number | null;
  confirmations?: number;
}

export interface AgentState {
  version: 1;
  chainId: number;
  tijori: string;
  registry: string;
  plans: Record<string, Plan>;
  actions: Record<string, AgentAction>;
  pendingId: string | null;
  halted: boolean;
}

export interface AgentOptions {
  confirmations: number;
  slippageBps: number;
  planTtlSeconds: number;
  maxGasPrice: bigint;
  maxGasLimit: bigint;
}

export interface PublicAction {
  operationId: string;
  transactionHash: string;
  status: AgentActionStatus;
  method: string;
  nonce: number;
  signer: string;
  blockNumber: number | null;
  confirmations: number;
}

export class TreasuryService {
  provider: JsonRpcApiProvider;
  signer: Signer | null;
  chainId: number;
  options: AgentOptions;
  manifest: Manifest;
  tijori: Contract;
  registry: Contract;
  market: Contract;
  quotes: QuoteService;
  factory: Contract;
  asset: Contract;
  stateFile: string;
  state: AgentState;
  busy: boolean;
  idle: Promise<void>;

  constructor({ provider, signer = null, manifest, tijoriAddress, stateFile, chainId = 5042002,
    confirmations = 2, slippageBps = 50, planTtlSeconds = 300,
    maxGasPrice = parseUnits("250", "gwei"), maxGasLimit = 1_500_000n }: {
    provider: JsonRpcApiProvider;
    signer?: Signer | null;
    manifest: Manifest;
    tijoriAddress: string;
    stateFile: string;
    chainId?: number;
    confirmations?: number;
    slippageBps?: number;
    planTtlSeconds?: number;
    maxGasPrice?: bigint;
    maxGasLimit?: bigint;
  }) {
    if (![5042, 5042002, 31337].includes(chainId) || manifest.chainId !== chainId) fail("UNSUPPORTED_CHAIN");
    if (!Number.isInteger(confirmations) || confirmations < 1 || confirmations > 100 ||
      !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 1000 ||
      !Number.isInteger(planTtlSeconds) || planTtlSeconds < 10 || planTtlSeconds > 3600 ||
      maxGasPrice < parseUnits("25", "gwei") || maxGasLimit <= 0n) fail("INVALID_AGENT_OPTIONS");
    this.provider = provider;
    this.signer = signer;
    this.chainId = chainId;
    this.options = { confirmations, slippageBps, planTtlSeconds, maxGasPrice, maxGasLimit };
    this.manifest = manifest;
    this.tijori = new Contract(getAddress(tijoriAddress), abi("Tijori"), provider);
    this.registry = new Contract(getAddress(manifest.registry), abi("SeriesRegistry"), provider);
    this.market = new Contract(getAddress(manifest.market), abi("UniswapV4Market"), provider);
    this.quotes = new QuoteService({ provider, manifest });
    this.factory = new Contract(getAddress(manifest.tijoriFactory), abi("TijoriFactory"), provider);
    this.asset = new Contract(getAddress(manifest.usdc), tokenAbi, provider);
    this.stateFile = path.resolve(stateFile);
    this.state = { version: 1, chainId, tijori: this.tijori.target as string, registry: this.registry.target as string,
      plans: {}, actions: {}, pendingId: null, halted: false };
    if (fs.existsSync(this.stateFile)) {
      try { this.state = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as AgentState; }
      catch { fail("AGENT_STATE_INVALID"); }
    }
    this.validateState();
    this.busy = false;
    this.idle = Promise.resolve();
  }

  validateState(): void {
    const s = this.state;
    if (!s || s.version !== 1 || s.chainId !== this.chainId || s.tijori !== this.tijori.target ||
      s.registry !== this.registry.target || !s.plans || !s.actions || typeof s.plans !== "object" ||
      typeof s.actions !== "object" || Array.isArray(s.plans) ||
      Array.isArray(s.actions) || typeof s.halted !== "boolean" || !Object.hasOwn(s, "pendingId")) fail("AGENT_STATE_CONTEXT_MISMATCH");
    for (const [id, plan] of Object.entries(s.plans)) {
      if (id !== digest(plan)) fail("AGENT_PLAN_CORRUPTED");
    }
    let pending = 0;
    for (const [id, action] of Object.entries(s.actions)) {
      try {
        const tx = Transaction.from(action.rawTransaction);
        const call = this.tijori.interface.parseTransaction({ data: tx.data });
        if (!/^[a-zA-Z0-9_-]{8,64}$/.test(id) || !/^[a-f0-9]{64}$/.test(action.fingerprint) ||
          !["prepared", "pending", "confirmed", "reverted", "conflict"].includes(action.status) ||
          !["buildLadder", "pay", "cashOut", "claimInterest"].includes(call?.name ?? "") ||
          call?.name !== action.method || tx.data !== action.data || tx.hash !== action.hash ||
          !tx.from || !same(tx.from, action.signer) || !tx.to || !same(tx.to, this.tijori.target as string) || tx.value !== 0n ||
          tx.chainId !== BigInt(this.chainId) || tx.nonce !== action.nonce || tx.type !== 0 ||
          tx.gasPrice === null || tx.gasPrice < parseUnits("25", "gwei") || tx.gasPrice > this.options.maxGasPrice ||
          tx.gasLimit > this.options.maxGasLimit || tx.gasLimit <= 0n) fail("AGENT_STATE_INVALID");
      } catch { fail("AGENT_STATE_INVALID"); }
      if (!terminal(action)) { pending++; if (s.pendingId !== id) fail("AGENT_STATE_INVALID"); }
    }
    if (pending > 1 || (pending === 0 && s.pendingId !== null)) fail("AGENT_STATE_INVALID");
  }

  save(next: AgentState): void { writeJson(this.stateFile, next); this.state = next; }
  saveAction(id: string, action: AgentAction): void {
    this.save({ ...this.state, actions: { ...this.state.actions, [id]: action },
      pendingId: terminal(action) ? (this.state.pendingId === id ? null : this.state.pendingId) : id });
  }

  async checkChain(): Promise<void> {
    if (BigInt(await this.provider.send("eth_chainId", []) as string) !== BigInt(this.chainId)) fail("WRONG_RPC_CHAIN");
  }

  async freshBlock() {
    await this.checkChain();
    const block = await this.provider.getBlock("latest");
    if (!block) return fail("BLOCK_UNAVAILABLE");
    if (this.chainId !== 31337 && Date.now() / 1000 - block.timestamp > 120) fail("STALE_RPC_BLOCK");
    return block;
  }

  async checkContext() {
    await this.checkChain();
    const t = this.tijori;
    if (await this.provider.getCode(t.target) === "0x") fail("TIJORI_NOT_DEPLOYED");
    const owner = await t.owner() as string;
    if (!await t.initialized() || !same(await t.factory(), this.factory.target as string) ||
      !same(await this.factory.tijoriOf(owner), t.target as string) || !same(await t.router(), this.manifest.router) ||
      !same(await t.registry(), this.registry.target as string) || !same(await t.assetToken(), this.asset.target as string) ||
      !same(await this.registry.assetToken(), this.asset.target as string) ||
      !same(await this.market.registry(), this.registry.target as string) || Number(await this.asset.decimals()) !== 6 ||
      (this.chainId !== 31337 && this.asset.target !== "0x3600000000000000000000000000000000000000")) {
      fail("AGENT_DEPLOYMENT_MISMATCH");
    }
    const router = new Contract(this.manifest.router, abi("PakkaRouter"), this.provider);
    if (!same(await router.market(), this.market.target as string)) fail("AGENT_DEPLOYMENT_MISMATCH");
    return this.freshBlock();
  }

  async checkAgent(): Promise<string> {
    if (!this.signer) return fail("AGENT_SIGNER_REQUIRED");
    const address = await this.signer.getAddress();
    if (this.manifest.deployer && same(address, this.manifest.deployer)) fail("AGENT_USES_DEPLOYER_WALLET");
    if (same(address, await this.tijori.owner()) || same(address, await this.registry.owner())) fail("AGENT_USES_OWNER_WALLET");
    if (!same(address, await this.tijori.agent())) fail("AGENT_KEY_NOT_AUTHORIZED");
    if (await this.tijori.paused()) fail("AGENT_PAUSED");
    return address;
  }

  async series(seriesId: number) {
    if (!Number.isSafeInteger(seriesId) || seriesId < 1 || BigInt(seriesId) > await this.registry.seriesCount()) {
      fail("UNKNOWN_SERIES");
    }
    return this.registry.getSeries(seriesId);
  }

  // The return shape genuinely depends on `name` (status, quote, plan, ...); callers narrow per tool.
  async invoke(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<any> {
    // ponytail: one request and one pending transaction per Tijori; a queue can be added for higher throughput.
    if (this.busy) fail("AGENT_BUSY");
    if (!["treasuryStatus", "quotePT", "planTreasury", "executePlan", "cashOut", "pay", "claimInterest", "transactionStatus"].includes(name)) fail("UNKNOWN_TOOL");
    this.busy = true;
    let release!: () => void;
    this.idle = new Promise((resolve) => { release = resolve; });
    try {
      const block = await this.checkContext();
      if (signal?.aborted) fail("REQUEST_CANCELLED");
      return await (this as unknown as Record<string, (args: any, block: any, signal?: AbortSignal) => unknown>)[name](args, block, signal);
    } finally { this.busy = false; release(); }
  }

  async treasuryStatus({ payees = [] }: { payees?: string[] }, block: Block) {
    const t = this.tijori;
    const positions = [];
    const vaultShares = [];
    const seenVaults = new Set<string>();
    const count = Number(await this.registry.seriesCount());
    if (!Number.isSafeInteger(count) || count > 1000) fail("REGISTRY_SCAN_LIMIT");
    for (let id = 1; id <= count; id++) {
      const s = await this.series(id);
      const pt = new Contract(s.principalToken, tokenAbi, this.provider);
      const yt = new Contract(s.yieldToken, abi("YieldToken"), this.provider);
      const balance = await pt.balanceOf(t.target) as bigint;
      const ytBalance = await yt.balanceOf(t.target) as bigint;
      const interest = await yt.accruedInterest(t.target) as bigint;
      if (!seenVaults.has(s.vault)) {
        seenVaults.add(s.vault);
        const vault = new Contract(s.vault, tokenAbi, this.provider);
        const shares = await vault.balanceOf(t.target) as bigint;
        if (shares > 0n) vaultShares.push({ vault: s.vault, sharesRaw: shares.toString(),
          decimals: Number(await vault.decimals()) });
      }
      if (balance || ytBalance || interest) positions.push({ seriesId: id, expiry: Number(s.expiry),
        matured: s.expiry <= BigInt(block.timestamp), pt: money(balance), ytRaw: ytBalance.toString(),
        interestSharesRaw: interest.toString(), indexAtExpiry: (await yt.indexAtExpiry() as bigint).toString() });
    }
    const dailyCap = await t.dailyCap() as bigint;
    const spent = await t.dailyWindow() === BigInt(Math.floor(block.timestamp / 86400)) ? await t.dailySpent() as bigint : 0n;
    return { chainId: this.chainId, tijori: t.target, owner: await t.owner(), agent: await t.agent(),
      signerConfigured: Boolean(this.signer), paused: await t.paused(), blockNumber: block.number,
      usdc: money(await this.asset.balanceOf(t.target) as bigint), dailyRemaining: money(dailyCap > spent ? dailyCap - spent : 0n),
      payees: await Promise.all(payees.map(async (p) => ({ payee: getAddress(p),
        remaining: money(await t.paymentRemaining(p) as bigint) }))), positions, vaultShares,
      pendingOperationId: this.state.pendingId, writesHalted: this.state.halted };
  }

  async quotePT({ seriesId, ptAmount }: { seriesId: number; ptAmount: string }, block: Block) {
    await this.series(seriesId);
    try {
      return await this.quotes.quote({ seriesId, ptAmountRaw: amount(ptAmount),
        slippageBps: this.options.slippageBps, block });
    } catch (error) {
      if (error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message)) fail(error.message);
      throw error;
    }
  }

  async planTreasury({ payoutUsdc, periods, seriesIds, firstDueTimestamp, intervalSeconds = 2592000,
    maxTotalUsdc, slippageBps = this.options.slippageBps }: {
    payoutUsdc: string;
    periods: number;
    seriesIds?: number[];
    firstDueTimestamp?: number;
    intervalSeconds?: number;
    maxTotalUsdc?: string;
    slippageBps?: number;
  }, block: Block): Promise<Plan & { planId: string; transactionSubmitted: false; note: string }> {
    const face = amount(payoutUsdc);
    if (!Number.isInteger(periods) || periods < 1 || periods > 12 || slippageBps < 0 || slippageBps > 1000) fail("INVALID_PLAN");
    if (seriesIds && (seriesIds.length !== periods || new Set(seriesIds).size !== periods || firstDueTimestamp !== undefined)) fail("INVALID_PLAN");
    const firstDue = firstDueTimestamp ?? block.timestamp + intervalSeconds;
    if (!seriesIds && (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 60 ||
      !Number.isSafeInteger(firstDue) || firstDue <= block.timestamp)) fail("INVALID_PLAN");
    const count = Number(await this.registry.seriesCount());
    if (!Number.isSafeInteger(count) || count > 1000) fail("REGISTRY_SCAN_LIMIT");
    const candidates: { id: number; expiry: number }[] = [];
    for (const id of seriesIds ?? Array.from({ length: count }, (_, i) => i + 1)) {
      const s = await this.series(id);
      if (s.hasPool && s.expiry > BigInt(block.timestamp)) candidates.push({ id, expiry: Number(s.expiry) });
    }
    const legs: PlanLeg[] = [];
    for (let i = 0; i < periods; i++) {
      const due = firstDue + i * intervalSeconds;
      if (!seriesIds && !Number.isSafeInteger(due)) fail("INVALID_PLAN");
      const previous = i === 0 ? block.timestamp : due - intervalSeconds;
      const choices = seriesIds ? candidates.filter((s) => s.id === seriesIds[i]) :
        candidates.filter((s) => s.expiry > previous && s.expiry <= due).sort((a, b) => b.expiry - a.expiry || a.id - b.id);
      let selected: PlanLeg | undefined;
      for (const s of choices) {
        if (legs.length && s.expiry <= legs.at(-1)!.expiry) continue;
        try {
          const quote = await this.quotePT({ seriesId: s.id, ptAmount: payoutUsdc }, block);
          const cost = BigInt(quote.quotedCost.raw);
          const cap = (cost * BigInt(10000 + slippageBps) + 9999n) / 10000n;
          selected = { seriesId: s.id, expiry: s.expiry, dueTimestamp: seriesIds ? s.expiry : due,
            ptAmount: face.toString(), quotedCost: cost.toString(), maxUsdc: (cap < face ? cap : face).toString() };
          break;
        } catch (error) { if (seriesIds) throw error; }
      }
      if (!selected) return fail("NO_SERIES_FOR_BILLING_WINDOW");
      legs.push(selected);
    }
    const quotedTotal = legs.reduce((n, l) => n + BigInt(l.quotedCost), 0n);
    const caps = legs.reduce((n, l) => n + BigInt(l.maxUsdc), 0n);
    const balance = await this.asset.balanceOf(this.tijori.target) as bigint;
    const requested = maxTotalUsdc === undefined ? caps : amount(maxTotalUsdc);
    const budget = [caps, balance, requested].reduce((a, b) => a < b ? a : b);
    if (budget < quotedTotal) fail("INSUFFICIENT_PLAN_BUDGET");
    const plan: Plan = { chainId: this.chainId, tijori: this.tijori.target as string, quotedAtBlock: block.number,
      deadline: Math.min(block.timestamp + this.options.planTtlSeconds, legs[0]!.expiry - 1),
      schedule: seriesIds ? "explicit-maturities" : "fixed-interval-seconds", slippageBps,
      maxTotalUsdc: budget.toString(), quotedTotalUsdc: quotedTotal.toString(), legs };
    const planId = digest(plan);
    const plans = Object.fromEntries(Object.entries(this.state.plans).filter(([, p]) => p.deadline > block.timestamp));
    if (Object.keys(plans).length >= 128 && !Object.hasOwn(plans, planId)) fail("TOO_MANY_SAVED_PLANS");
    this.save({ ...this.state, plans: { ...plans, [planId]: plan } });
    return { planId, ...plan, transactionSubmitted: false,
      note: "Quotes can change. Principal redemption depends on vault solvency and liquidity." };
  }

  async executePlan(args: { planId: string; operationId: string }, block: Block, signal?: AbortSignal): Promise<PublicAction> {
    return this.submit("executePlan", args, async () => {
      if (!Object.hasOwn(this.state.plans, args.planId)) fail("UNKNOWN_PLAN");
      const plan = this.state.plans[args.planId]!;
      if (plan.deadline <= block.timestamp) fail("PLAN_EXPIRED");
      if (await this.asset.balanceOf(this.tijori.target) as bigint < BigInt(plan.maxTotalUsdc)) fail("INSUFFICIENT_USDC");
      const legs = plan.legs.map(({ seriesId, ptAmount, maxUsdc }) => ({ seriesId, ptAmount, maxUsdc }));
      return { method: "buildLadder", args: [legs, plan.maxTotalUsdc, plan.deadline] };
    }, signal);
  }

  async pay(args: { payee: string; amountUsdc: string; operationId: string }, _block: unknown, signal?: AbortSignal): Promise<PublicAction> {
    return this.submit("pay", args, async () => {
      const value = amount(args.amountUsdc);
      const payee = getAddress(args.payee);
      if (await this.tijori.paymentRemaining(payee) as bigint < value) fail("PAYMENT_CAP_EXCEEDED");
      if (await this.asset.balanceOf(this.tijori.target) as bigint < value) fail("INSUFFICIENT_USDC");
      return { method: "pay", args: [payee, value] };
    }, signal);
  }

  async cashOut(args: { seriesId: number; ptAmount: string; toAssets?: boolean; minOutputRaw?: string; operationId: string }, block: Block, signal?: AbortSignal): Promise<PublicAction> {
    return this.submit("cashOut", args, async () => {
      const s = await this.series(args.seriesId);
      if (s.expiry > BigInt(block.timestamp)) fail("SERIES_NOT_MATURED");
      const deadline = block.timestamp + this.options.planTtlSeconds;
      const methodArgs: [number, bigint, boolean, bigint, number] = [args.seriesId, amount(args.ptAmount), args.toAssets ?? true, 0n, deadline];
      const expected = await this.tijori.connect(this.signer).getFunction("cashOut").staticCall(...methodArgs) as bigint;
      methodArgs[3] = this.minimum(expected, args.minOutputRaw);
      return { method: "cashOut", args: methodArgs };
    }, signal);
  }

  async claimInterest(args: { seriesId: number; toAssets?: boolean; minOutputRaw?: string; operationId: string }, _block: unknown, signal?: AbortSignal): Promise<PublicAction> {
    return this.submit("claimInterest", args, async () => {
      await this.series(args.seriesId);
      const methodArgs: [number, boolean, bigint] = [args.seriesId, args.toAssets ?? true, 0n];
      const expected = await this.tijori.connect(this.signer).getFunction("claimInterest").staticCall(...methodArgs) as bigint;
      if (expected <= 0n) fail("NO_CLAIMABLE_INTEREST");
      methodArgs[2] = this.minimum(expected, args.minOutputRaw);
      return { method: "claimInterest", args: methodArgs };
    }, signal);
  }

  minimum(expected: bigint, requested: string | undefined): bigint {
    const bound = expected * BigInt(10000 - this.options.slippageBps) / 10000n;
    const value = requested === undefined ? bound : BigInt(requested);
    if (value < bound || value > expected) fail("INVALID_MINIMUM_OUTPUT");
    return value;
  }

  publicAction(id: string): PublicAction {
    const a = this.state.actions[id]!;
    return { operationId: id, transactionHash: a.hash, status: a.status, method: a.method,
      nonce: a.nonce, signer: a.signer, blockNumber: a.blockNumber ?? null,
      confirmations: a.confirmations ?? 0 };
  }

  async reconcile(id: string): Promise<PublicAction> {
    let a = this.state.actions[id]!;
    const receipt = await this.provider.getTransactionReceipt(a.hash);
    if (receipt) {
      const latest = await this.provider.getBlockNumber();
      const canonical = await this.provider.getBlock(receipt.blockNumber);
      const confirmations = latest - receipt.blockNumber + 1;
      if (canonical?.hash !== receipt.blockHash) fail("NONCANONICAL_RECEIPT");
      if (confirmations < this.options.confirmations && this.state.pendingId !== null && this.state.pendingId !== id) {
        this.save({ ...this.state, halted: true });
        fail("AGENT_HISTORY_REORG_REQUIRES_REVIEW");
      }
      a = { ...a, status: confirmations >= this.options.confirmations ?
        (receipt.status === 1 ? "confirmed" : "reverted") : "pending",
      blockNumber: receipt.blockNumber, confirmations };
      this.saveAction(id, a);
      return this.publicAction(id);
    }
    // A previously confirmed receipt disappearing must block new payments until reviewed.
    if (terminal(a) || await this.provider.getTransactionCount(a.signer, "latest") > a.nonce) {
      if (this.state.pendingId !== null && this.state.pendingId !== id) {
        this.save({ ...this.state, halted: true });
        fail("AGENT_HISTORY_REORG_REQUIRES_REVIEW");
      }
      this.saveAction(id, { ...a, status: "conflict", blockNumber: null, confirmations: 0 });
      return this.publicAction(id);
    }
    return this.publicAction(id);
  }

  async transactionStatus({ operationId }: { operationId: string }): Promise<PublicAction> {
    if (!Object.hasOwn(this.state.actions, operationId)) fail("UNKNOWN_OPERATION");
    return this.reconcile(operationId);
  }

  async broadcast(id: string): Promise<PublicAction> {
    if (this.state.halted) fail("AGENT_HISTORY_REORG_REQUIRES_REVIEW");
    const action = this.state.actions[id]!;
    if (action.status === "conflict") fail("NONCE_CONFLICT_REQUIRES_REVIEW");
    if (terminal(action)) return this.publicAction(id);
    const address = await this.checkAgent();
    if (!same(action.signer, address)) fail("OLD_AGENT_PENDING_REQUIRES_REVIEW");
    await this.freshBlock();
    try {
      await this.provider.call({ from: address, to: this.tijori.target as string, data: action.data, value: 0n });
    } catch { fail("TRANSACTION_SIMULATION_FAILED"); }
    // Raw bytes were committed before reaching this point. Ambiguous RPC errors leave them intact.
    try {
      await this.provider.broadcastTransaction(action.rawTransaction);
      this.saveAction(id, { ...action, status: "pending" });
    } catch {
      // Covers a lost response, "already known", or a mined/reverted transaction.
      await this.reconcile(id);
    }
    return this.reconcile(id);
  }

  async submit(tool: string, input: { operationId: string; [key: string]: unknown }, prepare: () => Promise<{ method: string; args: unknown[] }>, signal?: AbortSignal): Promise<PublicAction> {
    if (this.state.halted) fail("AGENT_HISTORY_REORG_REQUIRES_REVIEW");
    const { operationId, ...intent } = input;
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(operationId ?? "")) fail("INVALID_OPERATION_ID");
    const fingerprint = digest({ tool, ...intent });
    if (Object.hasOwn(this.state.actions, operationId)) {
      if (this.state.actions[operationId]!.fingerprint !== fingerprint) fail("OPERATION_ID_CONFLICT");
      const result = await this.reconcile(operationId);
      if (terminal(this.state.actions[operationId]!)) return result;
      return this.broadcast(operationId);
    }
    const address = await this.checkAgent();
    if (this.state.pendingId !== null) {
      await this.reconcile(this.state.pendingId);
      if (this.state.pendingId !== null) fail("PENDING_OPERATION_EXISTS");
    }
    // Recheck recently confirmed operations for receipt loss before authorizing another payment.
    for (const [id, a] of Object.entries(this.state.actions)) {
      if (terminal(a) && (a.blockNumber ?? 0) + 100 >= await this.provider.getBlockNumber()) {
        await this.reconcile(id);
        if (this.state.pendingId !== null) fail("PENDING_OPERATION_EXISTS");
      }
    }
    const { method, args } = await prepare();
    // eth_call from the actual agent, including final minOut/caps/deadline, before signing.
    await this.tijori.connect(this.signer).getFunction(method).staticCall(...args);
    const tx = await this.tijori.getFunction(method).populateTransaction(...args);
    const latestNonce = await this.provider.getTransactionCount(address, "latest");
    if (latestNonce !== await this.provider.getTransactionCount(address, "pending")) fail("WALLET_HAS_UNKNOWN_PENDING_TRANSACTION");
    const quotedGas = (await this.provider.getFeeData()).gasPrice;
    if (quotedGas === null) return fail("GAS_PRICE_UNAVAILABLE");
    const gasPrice = quotedGas > parseUnits("25", "gwei") ? quotedGas : parseUnits("25", "gwei");
    if (gasPrice > this.options.maxGasPrice) fail("GAS_PRICE_ABOVE_CAP");
    const estimate = await this.provider.estimateGas({ ...tx, from: address });
    const gasLimit = (estimate * 120n + 99n) / 100n;
    if (gasLimit > this.options.maxGasLimit) fail("GAS_LIMIT_ABOVE_CAP");
    if (await this.provider.getBalance(address) < gasLimit * gasPrice) return fail("INSUFFICIENT_AGENT_GAS");
    if (signal?.aborted) fail("REQUEST_CANCELLED");
    await this.checkAgent();
    await this.freshBlock();
    if (signal?.aborted) fail("REQUEST_CANCELLED");
    const rawTransaction = await this.signer!.signTransaction({ to: this.tijori.target as string, data: tx.data,
      value: 0n, type: 0, chainId: this.chainId, nonce: latestNonce, gasLimit, gasPrice });
    const action: AgentAction = { fingerprint, method, data: tx.data, signer: getAddress(address), nonce: latestNonce,
      rawTransaction, hash: keccak256(rawTransaction), status: "prepared" };
    this.saveAction(operationId, action);
    return this.broadcast(operationId);
  }
}

import { Contract, ZeroAddress, formatUnits, getAddress } from "ethers";
import type { Block, JsonRpcApiProvider } from "ethers";
import { abi } from "./project.ts";
import { QuoteService, type Quote } from "./quotes.ts";
import { activity, type ActivityResult } from "./activity.ts";
import { blockAtOrBefore, vaultObservedApy, type VaultApyResult } from "./variable-rate.ts";
import type { Manifest } from "./types.ts";

const VARIABLE_RATE_WINDOW_SECONDS = 86400;
const tokenAbi = ["function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)"];

export interface SeriesRate {
  seriesId: number;
  expiry: number;
  principalToken: string;
  yieldToken: string;
  vault: string;
  hasPool: boolean;
  entryOpen: boolean;
  indexHealthy: boolean;
  vaultIndexRaw: string;
  tvlUsdc: string;
  capUsdc: string;
  quote: Quote | null;
  error: string | null;
  vaultObservedApyPercent: number | null;
  vaultObservedApyStatus: VaultApyResult["status"];
  vaultObservedWindowSeconds: number | null;
}

export interface RatesResult {
  blockNumber: number;
  timestamp: number;
  series: SeriesRate[];
  variableRatePercent: number | null;
  variableRateStatus: string;
}

export interface VaultShareEntry {
  seriesId: number;
  vault: string;
  sharesRaw: string;
  shares: string;
}

export interface Position {
  seriesId: number;
  expiry: number;
  matured: boolean;
  principalToken: string;
  yieldToken: string;
  ptRaw: string;
  ptUsdc: string;
  ytRaw: string;
  interestSharesRaw: string;
  estimatedUsdc: string | null;
  availableVaultSharesRaw: string;
  shareExitAvailable: true;
}

export interface PositionsResult {
  account: string;
  blockNumber: number;
  timestamp: number;
  positions: Position[];
  vaultShares: VaultShareEntry[];
}

export type TreasuryResult =
  | { owner: string; address: null }
  | ({ owner: string; address: string; agent: string; paused: boolean; dailyCapUsdc: string; usdc: string; payeeRemaining: string | null } & PositionsResult);

export class ReadService {
  provider: JsonRpcApiProvider;
  manifest: Manifest;
  quotes: QuoteService;
  registry: Contract;
  market: Contract;
  router: Contract;
  factory: Contract;
  // Addresses are immutable once deployed, so the wiring is checked once per process, and a
  // block's rates are computed once however many visitors ask for them.
  private wired = false;
  private ratesAt: { blockNumber: number; result: Promise<RatesResult> } | null = null;

  constructor({ provider, manifest }: { provider: JsonRpcApiProvider; manifest: Manifest }) {
    this.provider = provider; this.manifest = manifest;
    this.quotes = new QuoteService({ provider, manifest });
    this.registry = this.quotes.registry; this.market = this.quotes.market;
    this.router = new Contract(manifest.router, abi("PakkaRouter"), provider);
    this.factory = new Contract(manifest.tijoriFactory, abi("TijoriFactory"), provider);
  }

  async block(): Promise<Block> {
    if (BigInt(await this.provider.send("eth_chainId", []) as string) !== BigInt(this.manifest.chainId)) throw new Error("WRONG_RPC_CHAIN");
    if (!this.wired) {
      if (getAddress(await this.registry.assetToken() as string) !== getAddress(this.manifest.usdc) ||
        getAddress(await this.market.registry() as string) !== getAddress(this.manifest.registry) ||
        getAddress(await this.market.poolManager() as string) !== getAddress(this.manifest.poolManager) ||
        getAddress(await this.router.market() as string) !== getAddress(this.manifest.market)) throw new Error("DEPLOYMENT_MISMATCH");
      this.wired = true;
    }
    const b = await this.provider.getBlock("latest");
    if (!b || (this.manifest.chainId !== 31337 && Date.now() / 1000 - b.timestamp > 120)) throw new Error("STALE_RPC_BLOCK");
    return b;
  }

  async rates(): Promise<RatesResult> {
    const block = await this.block();
    if (this.ratesAt?.blockNumber !== block.number) {
      const result = this.computeRates(block);
      this.ratesAt = { blockNumber: block.number, result };
      // A failed read must not be served to the next caller for the rest of the block.
      result.catch(() => { if (this.ratesAt?.result === result) this.ratesAt = null; });
    }
    return this.ratesAt.result;
  }

  private async computeRates(block: Block): Promise<RatesResult> {
    const count = Number(await this.registry.seriesCount());
    if (count > 1000) throw new Error("REGISTRY_SCAN_LIMIT");
    const pastBlock = await blockAtOrBefore((n) => this.provider.getBlock(n), block.timestamp - VARIABLE_RATE_WINDOW_SECONDS, block);
    const apyCache = new Map<string, VaultApyResult>();
    const vaultApy = async (vaultAddress: string): Promise<VaultApyResult> => {
      if (!apyCache.has(vaultAddress)) apyCache.set(vaultAddress, await vaultObservedApy({ provider: this.provider, vaultAddress, pastBlock, currentBlock: block }));
      return apyCache.get(vaultAddress)!;
    };
    const series: SeriesRate[] = [];
    for (let id = 1; id <= count; id++) {
      const s = await this.registry.getSeries(id);
      const yt = new Contract(s.yieldToken, abi("YieldToken"), this.provider);
      let quote: Quote | null = null, error: string | null = null;
      if (s.expiry > BigInt(block.timestamp) && s.hasPool) {
        try { quote = await this.quotes.quote({ seriesId: id, ptAmountRaw: 1_000_000n, block }); }
        catch { error = "QUOTE_UNAVAILABLE"; }
      }
      const apy = await vaultApy(s.vault);
      series.push({ seriesId: id, expiry: Number(s.expiry), principalToken: s.principalToken, yieldToken: s.yieldToken,
        vault: s.vault, hasPool: s.hasPool, entryOpen: await this.registry.entryOpen(s.yieldToken),
        indexHealthy: await yt.indexHealthy(), vaultIndexRaw: (await yt.pyIndexCurrent() as bigint).toString(),
        tvlUsdc: formatUnits(await yt.tvl() as bigint, 6), capUsdc: formatUnits(await yt.SERIES_TVL_CAP() as bigint, 6), quote, error,
        vaultObservedApyPercent: apy.percent, vaultObservedApyStatus: apy.status, vaultObservedWindowSeconds: apy.windowSeconds });
    }
    // Each vault's own trailing-window rate is observed on-chain, not fetched from a Morpho API.
    // It can be negative after a loss and says nothing about the forward-looking rate.
    const overall = series.map((s) => s.vaultObservedApyPercent).find((p) => p !== null) ?? null;
    const demoNote = this.manifest.demoVault ? "Demo vault; " : "";
    return { blockNumber: block.number, timestamp: block.timestamp, series,
      variableRatePercent: overall,
      variableRateStatus: overall !== null
        ? `${demoNote}observed trailing-window rate, not a guaranteed APY`
        : `${demoNote}not enough vault history yet for an observed rate` };
  }

  async positions(account: string): Promise<PositionsResult> {
    account = getAddress(account);
    const block = await this.block();
    const count = Number(await this.registry.seriesCount());
    if (count > 1000) throw new Error("REGISTRY_SCAN_LIMIT");
    const positions: Position[] = [], vaultShares: VaultShareEntry[] = [], seenVaults = new Set<string>();
    for (let id = 1; id <= count; id++) {
      const s = await this.registry.getSeries(id);
      const pt = new Contract(s.principalToken, tokenAbi, this.provider);
      const yt = new Contract(s.yieldToken, abi("YieldToken"), this.provider);
      if (!seenVaults.has(s.vault)) {
        seenVaults.add(s.vault);
        const share = new Contract(s.vault, tokenAbi, this.provider), shares = await share.balanceOf(account) as bigint;
        if (shares) vaultShares.push({ seriesId: id, vault: s.vault, sharesRaw: shares.toString(),
          shares: formatUnits(shares, await share.decimals() as number) });
      }
      const [balance, yieldBalance, interest]: [bigint, bigint, bigint] = await Promise.all([pt.balanceOf(account), yt.balanceOf(account), yt.accruedInterest(account)]);
      if (!balance && !yieldBalance && !interest) continue;
      const vault = new Contract(s.vault, [...tokenAbi, "function maxRedeem(address) view returns(uint256)", "function previewRedeem(uint256) view returns(uint256)"], this.provider);
      const matured = s.expiry <= BigInt(block.timestamp);
      let estimatedUsdcRaw: bigint | null = null;
      if (balance) {
        try {
          if (matured) estimatedUsdcRaw = await vault.previewRedeem(balance * await yt.INDEX_UNIT() as bigint / await yt.interestIndex() as bigint);
          else estimatedUsdcRaw = await this.market.quoteSellPT.staticCall(id, balance);
        } catch { /* leave estimatedUsdcRaw null when the quote/preview path is unavailable */ }
      }
      const redeemable = await vault.maxRedeem(s.yieldToken) as bigint;
      positions.push({ seriesId: id, expiry: Number(s.expiry), matured, principalToken: s.principalToken, yieldToken: s.yieldToken,
        ptRaw: balance.toString(), ptUsdc: formatUnits(balance, 6), ytRaw: yieldBalance.toString(),
        interestSharesRaw: interest.toString(), estimatedUsdc: estimatedUsdcRaw === null ? null : formatUnits(estimatedUsdcRaw, 6),
        availableVaultSharesRaw: redeemable.toString(), shareExitAvailable: true });
    }
    return { account, blockNumber: block.number, timestamp: block.timestamp, positions, vaultShares };
  }

  async treasury(owner: string, payee?: string | null): Promise<TreasuryResult> {
    owner = getAddress(owner);
    await this.block();
    const address = await this.factory.tijoriOf(owner) as string;
    if (address === ZeroAddress) return { owner, address: null };
    const t = new Contract(address, abi("Tijori"), this.provider);
    const asset = new Contract(this.manifest.usdc, tokenAbi, this.provider);
    return { owner, address, agent: await t.agent(), paused: await t.paused(), dailyCapUsdc: formatUnits(await t.dailyCap() as bigint, 6),
      usdc: formatUnits(await asset.balanceOf(address) as bigint, 6),
      payeeRemaining: payee ? formatUnits(await t.paymentRemaining(getAddress(payee)) as bigint, 6) : null,
      ...(await this.positions(address)) };
  }

  async activity(params: { account?: string; tijori?: string; fromBlock?: number }): Promise<ActivityResult> {
    await this.block();
    return activity({ provider: this.provider, manifest: this.manifest, ...params });
  }
}

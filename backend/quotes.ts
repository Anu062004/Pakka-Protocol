import { Contract, formatUnits, getAddress } from "ethers";
import type { Block, JsonRpcApiProvider } from "ethers";
import { abi } from "./project.ts";
import type { Manifest } from "./types.ts";

const quoterAbi = ["function poolManager() view returns (address)",
  "function quoteExactOutputSingle(tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountIn,uint256 gasEstimate)"];

export interface Money {
  raw: string;
  usdc: string;
}
const money = (n: bigint): Money => ({ raw: n.toString(), usdc: formatUnits(n, 6) });
export const FACE_SQRT_PRICE_X96 = 1n << 96n;

export interface QuoteBounds {
  maxUsdc: Money;
  suggestedMinOutRaw: string;
  sqrtPriceLimitX96: string;
  impliedFixedRatePercent: string;
  rateConvention: "simple-annualized-not-APY";
  slippageBps: number;
}

export function quoteBounds(cost: bigint, face: bigint, secondsRemaining: number, slippageBps = 50): QuoteBounds {
  if (cost <= 0n || cost >= face || secondsRemaining <= 0) throw new Error("NO_DISCOUNTED_QUOTE");
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 1000) throw new Error("INVALID_SLIPPAGE");
  const cap = (cost * BigInt(10000 + slippageBps) + 9999n) / 10000n;
  const rate = (face - cost) * 31536000n * 100_000_000n / (cost * BigInt(secondsRemaining));
  return { maxUsdc: money(cap < face ? cap : face), suggestedMinOutRaw: face.toString(),
    sqrtPriceLimitX96: FACE_SQRT_PRICE_X96.toString(), impliedFixedRatePercent: formatUnits(rate, 6),
    rateConvention: "simple-annualized-not-APY", slippageBps };
}

export interface Quote extends QuoteBounds {
  seriesId: number;
  expiry: number;
  pt: Money;
  faceValue: Money;
  quotedCost: Money;
  quotedAtBlock: number;
  source: "market-eth-call" | "uniswap-v4-quoter";
  deadline: number;
}

export class QuoteService {
  provider: JsonRpcApiProvider;
  manifest: Manifest;
  registry: Contract;
  market: Contract;
  quoter: Contract | null;

  constructor({ provider, manifest }: { provider: JsonRpcApiProvider; manifest: Manifest }) {
    this.provider = provider; this.manifest = manifest;
    this.registry = new Contract(manifest.registry, abi("SeriesRegistry"), provider);
    this.market = new Contract(manifest.market, abi("UniswapV4Market"), provider);
    this.quoter = manifest.quoter ? new Contract(manifest.quoter, quoterAbi, provider) : null;
  }

  async quote({ seriesId, ptAmountRaw, slippageBps = 50, block }: {
    seriesId: number;
    ptAmountRaw: bigint;
    slippageBps?: number;
    block?: Block | null;
  }): Promise<Quote> {
    if (BigInt(await this.provider.send("eth_chainId", []) as string) !== BigInt(this.manifest.chainId)) throw new Error("WRONG_RPC_CHAIN");
    block ??= await this.provider.getBlock("latest");
    if (!block || (this.manifest.chainId !== 31337 && Date.now() / 1000 - block.timestamp > 120)) throw new Error("STALE_RPC_BLOCK");
    if (!Number.isSafeInteger(seriesId) || seriesId <= 0 || ptAmountRaw <= 0n || ptAmountRaw > (1n << 127n) - 1n) throw new Error("INVALID_QUOTE_AMOUNT");
    const s = await this.registry.getSeries(seriesId, { blockTag: block.number });
    if (s.expiry <= BigInt(block.timestamp)) throw new Error("SERIES_MATURED");
    if (!s.hasPool) throw new Error("SERIES_HAS_NO_POOL");
    // The market simulation applies the actual entry and par-price circuit breakers.
    const guardedCost = await this.market.quoteBuyPT.staticCall(seriesId, ptAmountRaw, { blockTag: block.number }) as bigint;
    let cost = guardedCost;
    let source: Quote["source"] = "market-eth-call";
    if (this.quoter) {
      if (getAddress(await this.quoter.poolManager() as string) !== getAddress(this.manifest.poolManager)) throw new Error("QUOTER_MANAGER_MISMATCH");
      const key = { currency0: s.poolKey.currency0, currency1: s.poolKey.currency1,
        fee: s.poolKey.fee, tickSpacing: s.poolKey.tickSpacing, hooks: s.poolKey.hooks };
      [cost] = await this.quoter.quoteExactOutputSingle.staticCall({ poolKey: key,
        zeroForOne: getAddress(key.currency0) === getAddress(this.manifest.usdc), exactAmount: ptAmountRaw, hookData: "0x" }, { blockTag: block.number }) as [bigint, bigint];
      if (cost !== guardedCost) throw new Error("QUOTER_EXECUTION_MISMATCH");
      source = "uniswap-v4-quoter";
    }
    return { seriesId, expiry: Number(s.expiry), pt: money(ptAmountRaw), faceValue: money(ptAmountRaw),
      quotedCost: money(cost), quotedAtBlock: block.number, source,
      deadline: Math.min(block.timestamp + 120, Number(s.expiry) - 1),
      ...quoteBounds(cost, ptAmountRaw, Number(s.expiry) - block.timestamp, slippageBps) };
  }
}

import { Contract, ZeroAddress, getAddress } from "ethers";
import type { Signer } from "ethers";
import type { SeriesManifestEntry, SeriesPool } from "../backend/types.ts";

export function initialSqrtPrice(asset: string, pt: string, priceUsdc: bigint): bigint {
  const unit = 1_000_000n;
  if (priceUsdc <= 0n || priceUsdc > unit) throw new Error("PT_PRICE_USDC must be greater than zero and at most 1.");
  const assetIs0 = BigInt(asset) < BigInt(pt);
  const value = (1n << 192n) * (assetIs0 ? unit : priceUsdc) / (assetIs0 ? priceUsdc : unit);
  let x = value, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + value / x) / 2n; }
  return x;
}

// Also used by the local integration test; no RPC or wallet is created here.
export async function seedSeries({ asset, pt, registry, yt, seeder, market, signer, item,
  priceUsdc, maxUsdc, maxPt, deadline, overrides = {}, save = () => {} }: {
  asset: Contract;
  pt: Contract;
  registry: Contract;
  yt: Contract;
  seeder: Contract;
  market: Contract;
  signer: Signer & { address: string };
  item: SeriesManifestEntry;
  priceUsdc: bigint;
  maxUsdc: bigint;
  maxPt: bigint;
  deadline: number;
  overrides?: { gasPrice?: bigint };
  save?: () => void;
}): Promise<SeriesPool> {
  if (maxUsdc <= 0n || maxPt <= 0n) throw new Error("Pool seed budgets must be positive.");
  if (item.pool?.seeded) return item.pool;
  // A broadcast add is not replayed automatically; inspect its receipt if the previous run stopped.
  if (item.pool?.liquidityTransactionHash) throw new Error("A liquidity transaction was already broadcast; inspect its receipt before retrying.");
  const record = await registry.getSeries(item.seriesId);
  if (getAddress(record.principalToken) !== getAddress(pt.target as string) || getAddress(record.yieldToken) !== getAddress(yt.target as string)) {
    throw new Error("Manifest tokens do not match the registered series.");
  }
  const assetIs0 = BigInt(asset.target as string) < BigInt(pt.target as string);
  const key = { currency0: assetIs0 ? asset.target as string : pt.target as string, currency1: assetIs0 ? pt.target as string : asset.target as string,
    fee: 500, tickSpacing: 10, hooks: ZeroAddress };
  const price = initialSqrtPrice(asset.target as string, pt.target as string, priceUsdc);
  const pool: SeriesPool = item.pool ??= { transactions: [] };
  pool.transactions ??= [];
  async function send(label: string, promise: Promise<{ hash: string; wait: () => Promise<unknown> }>): Promise<void> {
    const tx = await promise;
    const entry = { label, hash: tx.hash, confirmed: false };
    pool.transactions!.push(entry);
    if (label === "addLiquidity") pool.liquidityTransactionHash = tx.hash;
    save();
    await tx.wait();
    entry.confirmed = true;
    save();
  }
  if (!record.hasPool) await send("setPoolKey", registry.setPoolKey(item.seriesId, key, overrides));
  const stored = (await registry.getSeries(item.seriesId)).poolKey;
  if (stored.currency0 !== key.currency0 || stored.currency1 !== key.currency1 || stored.fee !== 500n ||
      stored.tickSpacing !== 10n || stored.hooks !== ZeroAddress) throw new Error("Existing pool key differs from the demo seed configuration.");
  let state = await market.poolState(item.seriesId);
  if (state.sqrtPriceX96 === 0n) await send("initializePool", seeder.initializePool(item.seriesId, price, overrides));
  const ptBalance = await pt.balanceOf(signer.address) as bigint;
  if (ptBalance < maxPt) {
    const needed = maxPt - ptBalance;
    if (await asset.balanceOf(signer.address) as bigint < needed + maxUsdc) throw new Error("Fund the test wallet with faucet USDC for splitting and liquidity.");
    await send("approveSplit", asset.approve(yt.target, needed, overrides));
    await send("split", yt.splitFromAssets(needed, signer.address, overrides));
  }
  if (await pt.balanceOf(signer.address) as bigint < maxPt || await asset.balanceOf(signer.address) as bigint < maxUsdc) {
    throw new Error("Wallet has insufficient PT/USDC after splitting; check vault conversions and rounding.");
  }
  await send("approveUSDC", asset.approve(seeder.target, maxUsdc, overrides));
  await send("approvePT", pt.approve(seeder.target, maxPt, overrides));
  state = await market.poolState(item.seriesId);
  const lower = Math.floor(Number(state.tick) / 10) * 10 - 600;
  const upper = lower + 1200;
  const max0 = assetIs0 ? maxUsdc : maxPt;
  const max1 = assetIs0 ? maxPt : maxUsdc;
  const liquidity = await seeder.liquidityForAmounts(item.seriesId, lower, upper, max0, max1) as bigint;
  if (liquidity === 0n) throw new Error("Seed budgets are too small.");
  Object.assign(pool, { poolId: state.poolId, tickLower: lower, tickUpper: upper,
    liquidity: liquidity.toString(), maxUsdc: maxUsdc.toString(), maxPt: maxPt.toString(), initialPriceUsdc: priceUsdc.toString() });
  save();
  await send("addLiquidity", seeder.addLiquidity(item.seriesId, lower, upper, liquidity, max0, max1, deadline, overrides));
  pool.seeded = true;
  save();
  await send("clearUSDCApproval", asset.approve(seeder.target, 0, overrides));
  await send("clearPTApproval", pt.approve(seeder.target, 0, overrides));
  return pool;
}

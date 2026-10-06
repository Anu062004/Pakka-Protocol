import { Contract, type Provider } from "ethers";

interface BlockLike {
  number: number;
  timestamp: number;
}

export interface VaultApyResult {
  percent: number | null;
  status: "INSUFFICIENT_HISTORY" | "VAULT_HISTORY_UNAVAILABLE" | "OBSERVED_TRAILING_WINDOW";
  windowSeconds: number | null;
}

// Binary search for the latest block at or before a target timestamp.
// Returns null when the chain has no history that old (chain/series younger than the window).
export async function blockAtOrBefore(getBlock: (n: number) => Promise<BlockLike | null>, targetTimestamp: number, latestBlock: BlockLike): Promise<BlockLike | null> {
  if (latestBlock.timestamp <= targetTimestamp) return null;
  let lo = 0, hi = latestBlock.number;
  let result: BlockLike | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const block = await getBlock(mid);
    if (!block) { hi = mid - 1; continue; }
    if (block.timestamp <= targetTimestamp) { result = block; lo = mid + 1; }
    else hi = mid - 1;
  }
  return result;
}

// Annualizes the change in an ERC-4626 vault's share price between two samples.
// This is an observed rate over the sampled window, not a forward-looking APY
// promise and not Morpho's own rate model; it can be negative after a vault loss.
export function observedApy(past: bigint, current: bigint, elapsedSeconds: number): number | null {
  if (past <= 0n || elapsedSeconds <= 0) return null;
  const growth = Number(current - past) / Number(past);
  return Number((growth * (31536000 / elapsedSeconds) * 100).toFixed(4));
}

const INSUFFICIENT_HISTORY: VaultApyResult = { percent: null, status: "INSUFFICIENT_HISTORY", windowSeconds: null };
const VAULT_HISTORY_UNAVAILABLE: VaultApyResult = { percent: null, status: "VAULT_HISTORY_UNAVAILABLE", windowSeconds: null };

// Samples an ERC-4626 vault's convertToAssets at two blocks and reports the
// observed trailing-window rate. Caches nothing itself; callers should cache
// per vault address when multiple series share a vault.
export async function vaultObservedApy({ provider, vaultAddress, pastBlock, currentBlock }: {
  provider: Provider;
  vaultAddress: string;
  pastBlock: BlockLike | null;
  currentBlock: BlockLike;
}): Promise<VaultApyResult> {
  if (!pastBlock) return INSUFFICIENT_HISTORY;
  const elapsed = currentBlock.timestamp - pastBlock.timestamp;
  try {
    const vault = new Contract(vaultAddress,
      ["function convertToAssets(uint256) view returns(uint256)", "function decimals() view returns(uint8)"], provider);
    const probeUnit = 10n ** (BigInt(await vault.decimals() as bigint) + 18n);
    const [past, current] = await Promise.all([
      vault.convertToAssets(probeUnit, { blockTag: pastBlock.number }) as Promise<bigint>,
      vault.convertToAssets(probeUnit, { blockTag: currentBlock.number }) as Promise<bigint>]);
    const percent = observedApy(past, current, elapsed);
    return percent === null ? VAULT_HISTORY_UNAVAILABLE : { percent, status: "OBSERVED_TRAILING_WINDOW", windowSeconds: elapsed };
  } catch { return VAULT_HISTORY_UNAVAILABLE; }
}

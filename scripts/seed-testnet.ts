import { Contract, Wallet, getAddress, parseUnits } from "ethers";
import { compile } from "./compile.ts";
import { priceForRate, seedSeries } from "./seed-v4.ts";
import { canonicalUsdc, deploymentFile, loadDeployment, network } from "../backend/project.ts";
import { rpcProvider } from "../backend/rpc.ts";
import { writeJson } from "./expiry-keeper.ts";

const key = process.env.OWNER_PRIVATE_KEY;
if (!key) throw new Error("Configure the separate owner signer locally; never reuse the deployer key. Hardware-wallet owners can execute the manifest owner actions manually.");
const manifestPath = deploymentFile;
const manifest = loadDeployment(manifestPath);
if (manifest.chainId !== network().chainId || manifest.usdc !== canonicalUsdc) {
  throw new Error("Manifest must describe the selected Arc network and its canonical ERC-20 USDC.");
}
// A target rate prices each maturity for its own length; a flat price is a very different rate on each.
const targetRate = process.env.PT_TARGET_RATE_PERCENT ? parseUnits(process.env.PT_TARGET_RATE_PERCENT, 6) : null;
const priceUsdc = parseUnits(process.env.PT_PRICE_USDC ?? "0.99", 6);
const maxUsdc = parseUnits(process.env.POOL_SEED_USDC ?? "10", 6);
const maxPt = parseUnits(process.env.POOL_SEED_PT ?? "10", 6);
if (priceUsdc <= 0n || priceUsdc > 1_000_000n || maxUsdc <= 0n || maxPt <= 0n) throw new Error("Invalid seed price or budgets.");
const provider = rpcProvider();
try {
  if ((await provider.getNetwork()).chainId !== BigInt(network().chainId)) throw new Error("UNSUPPORTED_CHAIN");
  const signer = new Wallet(key, provider);
  if (getAddress(manifest.deployer) === signer.address) throw new Error("OWNER_MUST_DIFFER_FROM_DEPLOYER");
  const artifacts = compile();
  const contract = (name: string, address: string) => new Contract(getAddress(address), artifacts[name]!.abi, signer);
  const asset = contract("MockUSDC", manifest.usdc);
  const registry = contract("SeriesRegistry", manifest.registry);
  const market = contract("UniswapV4Market", manifest.market);
  const seeder = contract("PoolSeeder", manifest.poolSeeder);
  if (getAddress(await registry.owner() as string) !== signer.address || getAddress(await seeder.owner() as string) !== signer.address) {
    throw new Error("Use the registry/seeder owner wallet.");
  }
  for (const c of [market, seeder]) {
    if (getAddress(await c.registry() as string) !== getAddress(registry.target as string) ||
        getAddress(await c.poolManager() as string) !== getAddress(manifest.poolManager)) throw new Error("Manifest market dependencies do not match.");
  }
  if (getAddress(await registry.assetToken() as string) !== getAddress(asset.target as string)) throw new Error("Registry asset mismatch.");
  const fees = await provider.getFeeData();
  const floor = parseUnits("25", "gwei");
  const overrides = { gasPrice: fees.gasPrice && fees.gasPrice > floor ? fees.gasPrice : floor };
  const save = () => writeJson(manifestPath, manifest);
  for (const item of manifest.series) {
    const block = await provider.getBlock("latest");
    if (!block) throw new Error("BLOCK_UNAVAILABLE");
    // Expired series are never registered, so they carry no seriesId and cannot be seeded.
    if (item.expiry <= block.timestamp) { console.log(`Series expiring ${item.expiry} has already expired; skipped.`); continue; }
    if (!item.seriesId) throw new Error("Finish registering deployed series before seeding.");
    if (item.pool?.seeded) { console.log(`Series ${item.seriesId} is already seeded.`); continue; }
    const record = await registry.getSeries(item.seriesId);
    if (BigInt(block.timestamp) >= record.expiry) { console.log(`Series ${item.seriesId} has expired; skipped.`); continue; }
    const price = targetRate ? priceForRate(targetRate, Number(record.expiry) - block.timestamp) : priceUsdc;
    // The 0.05% pool fee is paid on top of the price, so a smaller discount leaves nothing to earn.
    if (price + (price * 500n + 999_999n) / 1_000000n >= 1_000000n) throw new Error(`Series ${item.seriesId}: the pool fee is larger than the discount at this rate and maturity.`);
    await seedSeries({ asset, registry, market, seeder, signer, item, priceUsdc: price, maxUsdc, maxPt, overrides, save,
      pt: contract("PrincipalToken", item.principalToken), yt: contract("YieldToken", item.yieldToken),
      deadline: Math.min(block.timestamp + 600, Number(record.expiry) - 1) });
    console.log(`Series ${item.seriesId}: pool ${item.pool!.poolId}, liquidity ${item.pool!.liquidity}.`);
  }
} finally {
  provider.destroy();
}

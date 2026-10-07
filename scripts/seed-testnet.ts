import { Contract, Wallet, getAddress, parseUnits } from "ethers";
import { compile } from "./compile.ts";
import { seedSeries } from "./seed-v4.ts";
import { deploymentFile, loadDeployment } from "../backend/project.ts";
import { rpcProvider } from "../backend/rpc.ts";
import { writeJson } from "./expiry-keeper.ts";

const key = process.env.OWNER_PRIVATE_KEY;
if (!key) throw new Error("Configure the separate testnet owner signer locally; never reuse the deployer key. Hardware-wallet owners can execute the manifest owner actions manually.");
const manifestPath = deploymentFile;
const manifest = loadDeployment(manifestPath);
if (manifest.chainId !== 5042002 || manifest.usdc !== "0x3600000000000000000000000000000000000000") {
  throw new Error("Manifest must describe Arc Testnet and its canonical ERC-20 USDC.");
}
const priceUsdc = parseUnits(process.env.PT_PRICE_USDC ?? "0.99", 6);
const maxUsdc = parseUnits(process.env.POOL_SEED_USDC ?? "10", 6);
const maxPt = parseUnits(process.env.POOL_SEED_PT ?? "10", 6);
if (priceUsdc <= 0n || priceUsdc > 1_000_000n || maxUsdc <= 0n || maxPt <= 0n) throw new Error("Invalid seed price or budgets.");
const provider = rpcProvider();
try {
  if ((await provider.getNetwork()).chainId !== 5042002n) throw new Error("Seeding is restricted to Arc Testnet.");
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
    await seedSeries({ asset, registry, market, seeder, signer, item, priceUsdc, maxUsdc, maxPt, overrides, save,
      pt: contract("PrincipalToken", item.principalToken), yt: contract("YieldToken", item.yieldToken),
      deadline: Math.min(block.timestamp + 600, Number(record.expiry) - 1) });
    console.log(`Series ${item.seriesId}: pool ${item.pool!.poolId}, liquidity ${item.pool!.liquidity}.`);
  }
} finally {
  provider.destroy();
}

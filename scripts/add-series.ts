import { Contract, Wallet, getAddress, parseUnits } from "ethers";
import { abi, deploymentFile, loadDeployment, network, seriesLabel } from "../backend/project.ts";
import { rpcProvider } from "../backend/rpc.ts";
import { writeJson } from "./expiry-keeper.ts";
import { syncSeries } from "./seed-v4.ts";

const key = process.env.OWNER_PRIVATE_KEY;
if (!key) throw new Error("Set OWNER_PRIVATE_KEY locally, or open the maturity from the Owner page with the owner wallet.");
// Entries close one hour before maturity (SeriesRegistry.MIN_ENTRY_WINDOW), so a shorter series could never be bought.
const durations = (process.env.SERIES_DURATION ?? process.env.SERIES_DURATIONS ?? "86400,604800,2592000").split(",").map(Number);
if (!durations.length || durations.some((n) => !Number.isSafeInteger(n) || n <= 7200) || new Set(durations).size !== durations.length) {
  throw new Error("SERIES_DURATION must be distinct integer seconds greater than 7200; entries close one hour before maturity.");
}

const manifest = loadDeployment();
if (!manifest.seriesFactory) throw new Error("This deployment has no series factory. Deploy again to open maturities.");
const provider = rpcProvider();
try {
  if (BigInt(await provider.send("eth_chainId", []) as string) !== BigInt(network().chainId)) throw new Error("UNSUPPORTED_CHAIN");
  const signer = new Wallet(key, provider);
  const registry = new Contract(manifest.registry, abi("SeriesRegistry"), provider);
  const factory = new Contract(manifest.seriesFactory, abi("SeriesFactory"), signer);
  if (getAddress(await registry.owner() as string) !== signer.address || signer.address === getAddress(manifest.deployer)) throw new Error("OWNER_SIGNER_MISMATCH");
  const fees = await provider.getFeeData();
  const floor = parseUnits("25", "gwei");
  const gasPrice = fees.gasPrice && fees.gasPrice > floor ? fees.gasPrice : floor;
  const save = () => writeJson(deploymentFile, manifest);
  // Maturities opened from the Owner page are on-chain but not yet in this file.
  if (await syncSeries(manifest, registry)) save();
  for (const duration of durations) {
    const block = await provider.getBlock("latest");
    if (!block) throw new Error("BLOCK_UNAVAILABLE");
    const expiry = block.timestamp + duration, label = seriesLabel(expiry);
    if (await provider.getTransactionCount(signer.address, "latest") !== await provider.getTransactionCount(signer.address, "pending")) throw new Error("OWNER_HAS_PENDING_TRANSACTION");
    await factory.create!.staticCall(expiry, label);
    const tx = await factory.create!(expiry, label, { gasPrice });
    await tx.wait();
    if (!await syncSeries(manifest, registry)) throw new Error("SERIES_NOT_OBSERVED");
    const item = manifest.series.at(-1)!;
    Object.assign(item, { duration, transactionHash: tx.hash });
    save();
    console.log(`Series ${item.seriesId} (${label}) opened at ${item.yieldToken}, matures ${new Date(expiry * 1000).toISOString()}.`);
  }
  manifest.status = "registered-unseeded"; manifest.ownerActions = []; save();
  console.log("Run the seed step next so the new maturities can be bought.");
} finally {
  provider.destroy();
}

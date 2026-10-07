import { Contract, Wallet, ZeroAddress, getAddress, parseUnits } from "ethers";
import { abi, deploymentFile, loadDeployment } from "../backend/project.ts";
import { rpcProvider } from "../backend/rpc.ts";
import { writeJson } from "./expiry-keeper.ts";
import type { SeriesManifestEntry } from "../backend/types.ts";

const manifest = loadDeployment();
const provider = rpcProvider();
try {
  if (BigInt(await provider.send("eth_chainId", []) as string) !== 5042002n) throw new Error("UNSUPPORTED_CHAIN");
  if (!process.env.OWNER_PRIVATE_KEY) throw new Error("Separate owner signature required. Manifest ownerActions can be signed through the owner's hardware wallet/multisig; OWNER_PRIVATE_KEY is only a local testnet convenience.");
  const signer = new Wallet(process.env.OWNER_PRIVATE_KEY, provider);
  if (signer.address !== getAddress(manifest.owner) || signer.address === getAddress(manifest.deployer)) throw new Error("OWNER_SIGNER_MISMATCH");
  const registry = new Contract(manifest.registry, abi("SeriesRegistry"), signer);
  if (getAddress(await registry.owner() as string) !== signer.address) throw new Error("OWNER_SIGNER_MISMATCH");
  const quote = (await provider.getFeeData()).gasPrice;
  const gasPrice = quote && quote > parseUnits("25", "gwei") ? quote : parseUnits("25", "gwei");
  const save = () => writeJson(deploymentFile, manifest);
  async function send<K extends "registrationTransactionHash" | "poolKeyTransactionHash">(item: SeriesManifestEntry, field: K, method: string, args: unknown[]): Promise<void> {
    if (item[field]) {
      const receipt = await provider.getTransactionReceipt(item[field]!);
      if (!receipt || receipt.status !== 1) throw new Error("OWNER_TRANSACTION_REQUIRES_REVIEW");
      return;
    }
    if (await provider.getTransactionCount(signer.address, "latest") !== await provider.getTransactionCount(signer.address, "pending")) throw new Error("OWNER_HAS_PENDING_TRANSACTION");
    await registry.getFunction(method).staticCall(...args);
    const tx = await registry.getFunction(method)(...args, { gasPrice });
    item[field] = tx.hash; save(); await tx.wait();
  }
  for (const item of manifest.series) {
    let id = await registry.seriesIdByYieldToken(item.yieldToken) as bigint;
    if (!id) {
      // registerSeries reverts with ExpiredSeries; skipping keeps later series registrable.
      const block = await provider.getBlock("latest");
      if (!block) throw new Error("BLOCK_UNAVAILABLE");
      if (item.expiry <= block.timestamp) { console.log(`Series expiring ${item.expiry} has already expired; skipped.`); continue; }
      await send(item, "registrationTransactionHash", "registerSeries", [item.yieldToken]);
      id = await registry.seriesIdByYieldToken(item.yieldToken) as bigint;
      if (!id) throw new Error("REGISTRATION_NOT_OBSERVED");
    }
    item.seriesId = Number(id); save();
    const assetIs0 = BigInt(manifest.usdc) < BigInt(item.principalToken);
    const key = { currency0: assetIs0 ? manifest.usdc : item.principalToken,
      currency1: assetIs0 ? item.principalToken : manifest.usdc, fee: 500, tickSpacing: 10, hooks: ZeroAddress };
    if (!(await registry.getSeries(id)).hasPool) await send(item, "poolKeyTransactionHash", "setPoolKey", [id, key]);
    const s = await registry.getSeries(id);
    item.poolKey = { currency0: s.poolKey.currency0, currency1: s.poolKey.currency1,
      fee: Number(s.poolKey.fee), tickSpacing: Number(s.poolKey.tickSpacing), hooks: s.poolKey.hooks };
    save();
  }
  manifest.status = "registered-unseeded"; manifest.ownerActions = []; save();
  console.log("Separate owner registered all testnet series and pool keys. Run seed:testnet next.");
} finally { provider.destroy(); }

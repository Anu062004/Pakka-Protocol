import { Contract, ContractFactory, Wallet, getAddress, parseUnits } from "ethers";
import { compile } from "./compile.ts";
import { deploymentFile, loadDeployment } from "../backend/project.ts";
import { rpcProvider } from "../backend/rpc.ts";
import { writeJson } from "./expiry-keeper.ts";

const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!key) throw new Error("Set DEPLOYER_PRIVATE_KEY in .env to a funded Arc Testnet wallet.");
const duration = Number(process.env.SERIES_DURATION ?? 86400);
if (!Number.isSafeInteger(duration) || duration < 60) throw new Error("SERIES_DURATION must be integer seconds of at least 60.");

const manifest = loadDeployment();
const provider = rpcProvider();
try {
  if ((await provider.getNetwork()).chainId !== 5042002n) throw new Error("Adding series is restricted to Arc Testnet.");
  const signer = new Wallet(key, provider);
  const block = await provider.getBlock("latest");
  if (!block) throw new Error("BLOCK_UNAVAILABLE");
  const expiry = block.timestamp + duration;
  // registerSeries keys on (vault, expiry), so an identical expiry can never be registered twice.
  if (manifest.series.some((s) => s.expiry === expiry)) throw new Error("A series with this expiry already exists.");

  const fees = await provider.getFeeData();
  const floor = parseUnits("25", "gwei");
  const gasPrice = fees.gasPrice && fees.gasPrice > floor ? fees.gasPrice : floor;
  const artifacts = compile();
  const a = artifacts.YieldToken!;
  const label = `TEST-${expiry}`;
  const yt = await new ContractFactory(a.abi, a.bytecode!, signer).deploy(
    getAddress(manifest.vault), expiry, label, getAddress(manifest.registry), { gasPrice });
  await yt.waitForDeployment();

  const registry = new Contract(manifest.registry, artifacts.SeriesRegistry!.abi, provider);
  manifest.contracts!.push({ name: "YieldToken", address: yt.target as string, transactionHash: yt.deploymentTransaction()!.hash });
  manifest.series.push({ expiry, duration, yieldToken: yt.target as string,
    principalToken: await (yt as unknown as Contract).principalToken() as string,
    transactionHash: yt.deploymentTransaction()!.hash });
  manifest.ownerActions!.push({ description: `Register ${label}`, to: manifest.registry, value: "0",
    data: registry.interface.encodeFunctionData("registerSeries", [yt.target]) });
  manifest.status = "owner-registration-required";
  writeJson(deploymentFile, manifest);
  console.log(`Series ${label} deployed at ${yt.target}, matures ${new Date(expiry * 1000).toISOString()}.`);
  console.log("Run register:testnet then seed:testnet with the separate owner.");
} finally {
  provider.destroy();
}

import fs from "node:fs";
import { Contract, ContractFactory, Wallet, getAddress, parseUnits } from "ethers";
import { compile } from "./compile.ts";
import { deploymentFile } from "../backend/project.ts";
import { rpcProvider } from "../backend/rpc.ts";
import { writeJson } from "./expiry-keeper.ts";
import type { Manifest } from "../backend/types.ts";

const chainId = 5042002n;
const usdc = "0x3600000000000000000000000000000000000000";
const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!key) throw new Error("Set DEPLOYER_PRIVATE_KEY in .env to a funded Arc Testnet wallet. See .env.example.");
const ownerAddress = getAddress(process.env.PROTOCOL_OWNER_ADDRESS || "0x0000000000000000000000000000000000000000");
if (ownerAddress === "0x0000000000000000000000000000000000000000" || ownerAddress === new Wallet(key).address) {
  throw new Error("Set PROTOCOL_OWNER_ADDRESS to a separate owner wallet (hardware wallet or verified multisig), never the deployer.");
}
const durations = (process.env.SERIES_DURATIONS ?? "3600,86400,604800").split(",").map(Number);
if (!durations.length || durations.some((n) => !Number.isSafeInteger(n) || n < 60)) {
  throw new Error("SERIES_DURATIONS must contain integer seconds of at least 60.");
}
if (new Set(durations).size !== durations.length) throw new Error("SERIES_DURATIONS must not contain duplicates.");
if (fs.existsSync(deploymentFile)) throw new Error("Deployment manifest already exists; preserve it before starting a new deployment.");
const provider = rpcProvider();
try {
  const network = await provider.getNetwork();
  if (network.chainId !== chainId) throw new Error("Deployment is restricted to Arc Testnet (5042002).");
  if (await provider.getCode(usdc) === "0x") throw new Error("Arc Testnet USDC contract was not found.");
  const signer = new Wallet(key, provider);
  const artifacts = compile();
  const fees = await provider.getFeeData();
  // Arc has a minimum gas price. Use the network quote, with a 25 gwei floor.
  const floor = parseUnits("25", "gwei");
  const gasPrice = fees.gasPrice && fees.gasPrice > floor ? fees.gasPrice : floor;
  // Built up incrementally below; fields are genuinely absent (not just empty) until each deploy() call assigns them.
  const manifest = { version: 1, chainId: Number(chainId), usdc, deployer: signer.address, owner: ownerAddress,
    deployedAtBlock: await provider.getBlockNumber(), status: "deploying",
    demoVault: !process.env.TESTNET_VAULT_ADDRESS, contracts: [], series: [], ownerActions: [] } as unknown as Manifest;
  function saveDeployment(): void {
    writeJson(deploymentFile, manifest);
  }
  async function deploy(name: string, args: unknown[]): Promise<Contract> {
    const a = artifacts[name]!;
    const c = await new ContractFactory(a.abi, a.bytecode!, signer).deploy(...args, { gasPrice });
    await c.waitForDeployment();
    manifest.contracts!.push({ name, address: c.target as string, transactionHash: c.deploymentTransaction()!.hash });
    saveDeployment();
    console.log(`${name}: ${c.target}`);
    return c as unknown as Contract;
  }
  let vaultAddress = process.env.TESTNET_VAULT_ADDRESS;
  if (!vaultAddress) vaultAddress = (await deploy("DemoVault", [usdc])).target as string;
  vaultAddress = getAddress(vaultAddress);
  manifest.vault = vaultAddress;
  const vault = new Contract(vaultAddress, artifacts.DemoVault!.abi, provider);
  if (getAddress(await vault.asset() as string) !== getAddress(usdc)) throw new Error("Vault must hold Arc Testnet USDC.");
  const registry = await deploy("SeriesRegistry", [usdc, ownerAddress]);
  manifest.registry = registry.target as string;
  manifest.registryTransactionHash = registry.deploymentTransaction()!.hash;
  let managerAddress = process.env.UNISWAP_V4_POOL_MANAGER_ADDRESS;
  const selfHostedManager = !managerAddress;
  if (managerAddress) {
    managerAddress = getAddress(managerAddress);
    if (await provider.getCode(managerAddress) === "0x") throw new Error("Configured v4 PoolManager has no code.");
  } else {
    managerAddress = (await deploy("TestnetPoolManager", [ownerAddress])).target as string;
  }
  const market = await deploy("UniswapV4Market", [managerAddress, registry.target]);
  const router = await deploy("PakkaRouter", [market.target]);
  const tijoriFactory = await deploy("TijoriFactory", [router.target]);
  const tijoriImplementation = await tijoriFactory.implementation() as string;
  manifest.contracts!.push({ name: "Tijori", address: tijoriImplementation,
    createdBy: tijoriFactory.target as string, transactionHash: tijoriFactory.deploymentTransaction()!.hash });
  Object.assign(manifest, { tijoriFactory: tijoriFactory.target, tijoriImplementation });
  saveDeployment();
  const seeder = await deploy("PoolSeeder", [managerAddress, registry.target]);
  Object.assign(manifest, { poolManager: managerAddress, selfHostedManager, market: market.target,
    router: router.target, tijoriFactory: tijoriFactory.target, tijoriImplementation, poolSeeder: seeder.target });
  if (process.env.UNISWAP_V4_QUOTER_ADDRESS) {
    const quoter = new Contract(getAddress(process.env.UNISWAP_V4_QUOTER_ADDRESS),
      ["function poolManager() view returns (address)"], provider);
    if (await provider.getCode(quoter.target as string) === "0x" || getAddress(await quoter.poolManager() as string) !== getAddress(managerAddress)) {
      throw new Error("QUOTER_MANAGER_MISMATCH");
    }
    manifest.quoter = quoter.target as string;
  }
  const series = manifest.series;
  saveDeployment();
  for (const duration of durations) {
    const block = await provider.getBlock("latest");
    const expiry = block!.timestamp + duration;
    const label = `TEST-${expiry}`;
    const yt = await deploy("YieldToken", [vaultAddress, expiry, label, registry.target]);
    const item = { expiry, duration, yieldToken: yt.target as string, principalToken: await yt.principalToken() as string,
      transactionHash: yt.deploymentTransaction()!.hash };
    series.push(item);
    // Persist each successful deployment so a later RPC failure cannot lose addresses.
    saveDeployment();
    manifest.ownerActions!.push({ description: `Register ${label}`, to: registry.target as string, value: "0",
      data: registry.interface.encodeFunctionData("registerSeries", [yt.target]) });
    saveDeployment();
    console.log(`Series deployed; registration requires separate owner: ${yt.target}`);
  }
  manifest.status = "owner-registration-required";
  saveDeployment();
  console.log("Manifest and owner registration transactions saved. Complete register:testnet with the separate owner, then seed:testnet.");
} finally {
  provider.destroy();
}

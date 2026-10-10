import fs from "node:fs";
import { Contract, ContractFactory, Wallet, getAddress, parseUnits } from "ethers";
import { compile } from "./compile.ts";
import { canonicalUsdc, deploymentFile, network } from "../backend/project.ts";
import { rpcProvider } from "../backend/rpc.ts";
import { writeJson } from "./expiry-keeper.ts";
import type { Manifest } from "../backend/types.ts";

const net = network();
const chainId = BigInt(net.chainId);
const usdc = canonicalUsdc;
const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!key) throw new Error("Set DEPLOYER_PRIVATE_KEY in .env to a funded wallet on the selected Arc network. See .env.example.");
const ownerAddress = getAddress(process.env.PROTOCOL_OWNER_ADDRESS || "0x0000000000000000000000000000000000000000");
if (ownerAddress === "0x0000000000000000000000000000000000000000" || ownerAddress === new Wallet(key).address) {
  throw new Error("Set PROTOCOL_OWNER_ADDRESS to a separate owner wallet (hardware wallet or verified multisig), never the deployer.");
}
const configuredVault = process.env.VAULT_ADDRESS || process.env.TESTNET_VAULT_ADDRESS;
// A vault with simulated yield holding real USDC must be a deliberate choice, never a default.
if (net.name === "mainnet" && !configuredVault && process.env.ALLOW_DEMO_VAULT !== "1") {
  throw new Error("Set VAULT_ADDRESS to an ERC-4626 USDC vault on Arc, or ALLOW_DEMO_VAULT=1 to deploy the simulated-yield demo vault with real USDC.");
}
if (fs.existsSync(deploymentFile)) throw new Error("Deployment manifest already exists; preserve it before starting a new deployment.");
const provider = rpcProvider();
try {
  const network = await provider.getNetwork();
  if (network.chainId !== chainId) throw new Error(`RPC is not ${net.label} (${net.chainId}).`);
  if (await provider.getCode(usdc) === "0x") throw new Error("Arc USDC contract was not found.");
  const signer = new Wallet(key, provider);
  const artifacts = compile();
  const fees = await provider.getFeeData();
  // Arc has a minimum gas price. Use the network quote, with a 25 gwei floor.
  const floor = parseUnits("25", "gwei");
  const gasPrice = fees.gasPrice && fees.gasPrice > floor ? fees.gasPrice : floor;
  // Built up incrementally below; fields are genuinely absent (not just empty) until each deploy() call assigns them.
  const manifest = { version: 1, chainId: Number(chainId), usdc, deployer: signer.address, owner: ownerAddress,
    deployedAtBlock: await provider.getBlockNumber(), status: "deploying",
    demoVault: !configuredVault, contracts: [], series: [], ownerActions: [] } as unknown as Manifest;
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
  let vaultAddress = configuredVault;
  if (!vaultAddress) vaultAddress = (await deploy("DemoVault", [usdc])).target as string;
  vaultAddress = getAddress(vaultAddress);
  manifest.vault = vaultAddress;
  const vault = new Contract(vaultAddress, artifacts.DemoVault!.abi, provider);
  if (getAddress(await vault.asset() as string) !== getAddress(usdc)) throw new Error("Vault must hold Arc USDC.");
  // The factory creates the registry and is the only source of series it will accept.
  const seriesFactory = await deploy("SeriesFactory", [usdc, ownerAddress, vaultAddress]);
  const registry = new Contract(await seriesFactory.registry() as string, artifacts.SeriesRegistry!.abi, provider);
  manifest.contracts!.push({ name: "SeriesRegistry", address: registry.target as string,
    createdBy: seriesFactory.target as string, transactionHash: seriesFactory.deploymentTransaction()!.hash });
  manifest.seriesFactory = seriesFactory.target as string;
  manifest.registry = registry.target as string;
  manifest.registryTransactionHash = seriesFactory.deploymentTransaction()!.hash;
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
  manifest.status = "owner-series-required";
  saveDeployment();
  console.log("Infrastructure deployed. The owner now opens maturities: run add:series, then the seed step, or use the Owner page.");
} finally {
  provider.destroy();
}

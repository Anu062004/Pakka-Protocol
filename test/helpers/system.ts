import { Contract, ContractFactory, HDNodeWallet } from "ethers";
import type { JsonRpcApiProvider, Provider, Signer } from "ethers";
import { compile } from "../../scripts/compile.ts";
import { seedSeries } from "../../scripts/seed-v4.ts";
import type { ContractArtifact, Manifest, PoolKey } from "../../backend/types.ts";

// These publicly known fixture accounts must never be used by a deployment/keeper/agent CLI.
export const localSigner = (index: number, provider: Provider): HDNodeWallet =>
  HDNodeWallet.fromPhrase("test test test test test test test test test test test junk",
    undefined, `m/44'/60'/0'/0/${index}`).connect(provider) as HDNodeWallet;

const sent = async (tx: Promise<{ wait: () => Promise<unknown> }>) => (await tx).wait();

export interface SystemSeries {
  seriesId: number;
  expiry: number;
  yieldToken: string;
  principalToken: string;
  poolKey: PoolKey;
  yt: Contract;
  pt: Contract;
}

export interface System {
  provider: JsonRpcApiProvider;
  artifacts: Record<string, ContractArtifact>;
  manifest: Manifest;
  owner: Signer;
  deployer: Signer;
  priya: Signer;
  treasuryOwner: Signer;
  agent: Signer;
  keeper: Signer;
  payee: Signer;
  asset: Contract;
  vault: Contract;
  registry: Contract;
  manager: Contract;
  market: Contract;
  router: Contract;
  factory: Contract;
  seeder: Contract;
  tijori: Contract;
  series: SystemSeries[];
}

export async function deploySystem({ provider, signers, realVault = null, realAsset = null, durations = [7200, 86400, 604800] }: {
  provider: JsonRpcApiProvider;
  signers: Signer[];
  realVault?: Contract | null;
  realAsset?: Contract | null;
  durations?: number[];
}): Promise<System> {
  const chainId = Number((await provider.getNetwork()).chainId);
  if (![31337, 5042, 5042002].includes(chainId)) throw new Error("UNSUPPORTED_CHAIN");
  const [owner, deployer, priya, treasuryOwner, agent, keeper, payee] = signers as [Signer, Signer, Signer, Signer, Signer, Signer, Signer];
  const artifacts = compile();
  const deploy = async (name: string, args: unknown[] = []): Promise<Contract> => {
    const a = artifacts[name]!, c = await new ContractFactory(a.abi, a.bytecode!, deployer).deploy(...args);
    await c.waitForDeployment(); return c as unknown as Contract;
  };
  const asset = realAsset ?? await deploy("MockUSDC");
  const vault = realVault ?? await deploy("MockVault", [asset.target, 12]);
  const registry = await deploy("SeriesRegistry", [asset.target, await owner.getAddress()]);
  const manager = await deploy("TestnetPoolManager", [await owner.getAddress()]);
  const market = await deploy("UniswapV4Market", [manager.target, registry.target]);
  const router = await deploy("PakkaRouter", [market.target]);
  const factory = await deploy("TijoriFactory", [router.target]);
  const seeder = (await deploy("PoolSeeder", [manager.target, registry.target])).connect(owner) as Contract;
  if (!realAsset) await sent(asset.mint(await owner.getAddress(), 2000_000000n));
  await sent((asset.connect(owner) as Contract).transfer(await priya.getAddress(), 10_000000n));
  await sent((asset.connect(owner) as Contract).transfer(await treasuryOwner.getAddress(), 30_000000n));
  const startBlock = await provider.getBlock("latest");
  const start = startBlock!.timestamp, series: SystemSeries[] = [];
  for (const [i, duration] of durations.entries()) {
    const expiry = start + duration;
    const yt = await deploy("YieldToken", [vault.target, expiry, `E2E-${i}`, registry.target]);
    const pt = new Contract(await yt.principalToken() as string, artifacts.PrincipalToken!.abi, owner);
    await sent((registry.connect(owner) as Contract).registerSeries(yt.target));
    const item = { seriesId: i + 1, expiry, yieldToken: yt.target as string, principalToken: pt.target as string };
    await seedSeries({ asset: asset.connect(owner) as Contract, pt, yt: yt.connect(owner) as Contract, registry: registry.connect(owner) as Contract, market, seeder,
      signer: owner as Signer & { address: string }, item, priceUsdc: 990000n, maxUsdc: 100_000000n, maxPt: 100_000000n, deadline: expiry - 1 });
    const key = (await registry.getSeries(item.seriesId)).poolKey;
    const poolKey: PoolKey = { currency0: key.currency0, currency1: key.currency1, fee: Number(key.fee), tickSpacing: Number(key.tickSpacing), hooks: key.hooks };
    series.push({ ...item, poolKey, yt, pt });
  }
  await sent((factory.connect(treasuryOwner) as Contract).create(await agent.getAddress(), 10_000000n));
  const tijori = new Contract(await factory.tijoriOf(await treasuryOwner.getAddress()) as string, artifacts.Tijori!.abi, treasuryOwner);
  await sent((asset.connect(treasuryOwner) as Contract).approve(tijori.target, 20_000000n)); await sent(tijori.deposit(20_000000n));
  await sent(tijori.setPayeeCap(await payee.getAddress(), 10_000000n));
  const manifest: Manifest = { version: 1, chainId, usdc: asset.target as string, vault: vault.target as string, registry: registry.target as string,
    poolManager: manager.target as string, market: market.target as string, router: router.target as string, tijoriFactory: factory.target as string,
    poolSeeder: seeder.target as string, deployer: await deployer.getAddress(), owner: await owner.getAddress(),
    deployedAtBlock: 1, demoVault: !realVault, selfHostedManager: true,
    series: series.map(({ yt, pt, ...item }) => item) };
  return { provider, artifacts, manifest, owner, deployer, priya, treasuryOwner, agent, keeper, payee, asset, vault, registry, manager, market, router, factory, seeder, tijori, series };
}

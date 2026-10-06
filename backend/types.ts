import type { InterfaceAbi } from "ethers";

export interface PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

export interface DeployedContract {
  name: string;
  address: string;
  transactionHash: string;
  createdBy?: string;
}

export interface SeriesTransaction {
  label: string;
  hash: string;
  confirmed: boolean;
}

export interface SeriesPool {
  transactions?: SeriesTransaction[];
  liquidityTransactionHash?: string;
  poolId?: string;
  tickLower?: number;
  tickUpper?: number;
  liquidity?: string;
  maxUsdc?: string;
  maxPt?: string;
  initialPriceUsdc?: string;
  seeded?: boolean;
}

export interface SeriesManifestEntry {
  expiry: number;
  // Deployment-script bookkeeping: absent on manifests built in-memory by test fixtures.
  duration?: number;
  yieldToken: string;
  principalToken: string;
  transactionHash?: string;
  registrationTransactionHash?: string;
  poolKeyTransactionHash?: string;
  seriesId?: number;
  poolKey?: PoolKey;
  pool?: SeriesPool;
}

export interface OwnerAction {
  description: string;
  to: string;
  value: string;
  data: string;
}

export interface Manifest {
  version: number;
  chainId: number;
  usdc: string;
  deployer: string;
  owner: string;
  deployedAtBlock: number;
  // Deployment-script bookkeeping: absent on manifests built in-memory by test fixtures.
  status?: string;
  demoVault: boolean;
  contracts?: DeployedContract[];
  series: SeriesManifestEntry[];
  ownerActions?: OwnerAction[];
  vault: string;
  registry: string;
  registryTransactionHash?: string;
  tijoriFactory: string;
  tijoriImplementation?: string;
  poolManager: string;
  selfHostedManager: boolean;
  market: string;
  router: string;
  poolSeeder: string;
  quoter?: string;
}

export interface PublicSeriesEntry {
  seriesId?: number;
  expiry: number;
  principalToken: string;
  yieldToken: string;
  poolKey?: PoolKey;
  pool?: SeriesPool;
}

export interface PublicManifest {
  chainId: number;
  usdc: string;
  vault: string;
  registry: string;
  poolManager: string;
  market: string;
  router: string;
  tijoriFactory: string;
  poolSeeder: string;
  quoter?: string;
  demoVault: boolean;
  selfHostedManager: boolean;
  deployedAtBlock: number;
  series: PublicSeriesEntry[];
}

export interface ContractArtifact {
  contractName: string;
  sourceName: string;
  abi: InterfaceAbi;
  bytecode?: string;
}

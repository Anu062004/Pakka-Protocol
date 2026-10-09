import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "ethers";
import type { InterfaceAbi } from "ethers";
import type { ContractArtifact, Manifest, PublicManifest } from "./types.ts";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
// Where keys, journals and locks live. The repo keeps them beside the code. An installed
// package cannot: its own directory is a disposable download cache.
export const dataRoot = process.env.PAKKA_HOME ? path.resolve(process.env.PAKKA_HOME) : projectRoot;

export const abi = (name: string): InterfaceAbi => {
  const artifact = JSON.parse(fs.readFileSync(path.join(projectRoot, `artifacts/${name}.json`), "utf8")) as ContractArtifact;
  return artifact.abi as InterfaceAbi;
};

export interface Network {
  name: "testnet" | "mainnet";
  label: string;
  chainId: number;
  rpcUrl: string;
  explorer: string;
  file: string;
}
export const canonicalUsdc = "0x3600000000000000000000000000000000000000";
export const networks: Record<Network["name"], Network> = {
  testnet: { name: "testnet", label: "Arc Testnet", chainId: 5042002, rpcUrl: "https://rpc.testnet.arc.io",
    explorer: "https://testnet.arcscan.app", file: "deployments/arc-testnet.json" },
  mainnet: { name: "mainnet", label: "Arc", chainId: 5042, rpcUrl: "https://rpc.mainnet.arc.io",
    explorer: "https://explorer.arc.io", file: "deployments/arc-mainnet.json" },
};
// Mainnet is never a default: every process stays on testnet unless PAKKA_NETWORK=mainnet is set.
export function network(env: NodeJS.ProcessEnv = process.env): Network {
  const name = env.PAKKA_NETWORK ?? "testnet";
  if (name !== "testnet" && name !== "mainnet") throw new Error("UNSUPPORTED_NETWORK");
  return networks[name];
}
export const networkFor = (chainId: number): Network | undefined => Object.values(networks).find((n) => n.chainId === chainId);
// Mainnet token symbols carry the maturity date, e.g. PT-USDC-15OCT2026.
export function seriesLabel(expiry: number, net: Network = network()): string {
  if (net.name === "testnet") return `TEST-${expiry}`;
  const d = new Date(expiry * 1000);
  const month = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][d.getUTCMonth()];
  return `USDC-${String(d.getUTCDate()).padStart(2, "0")}${month}${d.getUTCFullYear()}`;
}

export const deploymentFile = path.join(projectRoot, network().file);

export function loadDeployment(file: string = deploymentFile, { chainId = network().chainId }: { chainId?: number } = {}): Manifest {
  const m = JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
  if (![5042, 5042002, 31337].includes(chainId) || m.chainId !== chainId) throw new Error("UNSUPPORTED_CHAIN");
  for (const key of ["usdc", "vault", "registry", "poolManager", "market", "router", "tijoriFactory", "poolSeeder"] as const) {
    m[key] = getAddress(m[key]);
  }
  if (chainId !== 31337 && m.usdc !== canonicalUsdc) throw new Error("WRONG_DEPLOYMENT_ASSET");
  for (const key of ["owner", "deployer", "quoter"] as const) {
    const value = m[key];
    if (value) m[key] = getAddress(value);
  }
  if (!Array.isArray(m.series) || m.series.length > 1000) throw new Error("INVALID_DEPLOYMENT_SERIES");
  return m;
}

// Public addresses only. Never include RPC credentials, environment values or wallet keys.
export function publicDeployment(m: Manifest): PublicManifest {
  const { chainId, usdc, vault, registry, poolManager, market, router, tijoriFactory,
    poolSeeder, quoter, demoVault, selfHostedManager, deployedAtBlock, series } = m;
  const net = networkFor(chainId);
  return {
    // Public defaults only; an operator's own RPC URL may carry a credential and is never exposed.
    network: net ? { name: net.name, label: net.label, rpcUrl: net.rpcUrl, explorer: net.explorer } : undefined,
    chainId, usdc, vault, registry, poolManager, market, router, tijoriFactory,
    poolSeeder, quoter, demoVault, selfHostedManager, deployedAtBlock,
    series: series.map(({ seriesId, expiry, principalToken, yieldToken, poolKey, pool }) =>
      ({ seriesId, expiry, principalToken, yieldToken, poolKey, pool })),
  };
}

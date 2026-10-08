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

export const deploymentFile = path.join(projectRoot, "deployments/arc-testnet.json");

export function loadDeployment(file: string = deploymentFile, { chainId = 5042002 }: { chainId?: number } = {}): Manifest {
  const m = JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
  if (![5042002, 31337].includes(chainId) || m.chainId !== chainId) throw new Error("UNSUPPORTED_CHAIN");
  for (const key of ["usdc", "vault", "registry", "poolManager", "market", "router", "tijoriFactory", "poolSeeder"] as const) {
    m[key] = getAddress(m[key]);
  }
  if (chainId === 5042002 && m.usdc !== "0x3600000000000000000000000000000000000000") throw new Error("WRONG_DEPLOYMENT_ASSET");
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
  return {
    chainId, usdc, vault, registry, poolManager, market, router, tijoriFactory,
    poolSeeder, quoter, demoVault, selfHostedManager, deployedAtBlock,
    series: series.map(({ seriesId, expiry, principalToken, yieldToken, poolKey, pool }) =>
      ({ seriesId, expiry, principalToken, yieldToken, poolKey, pool })),
  };
}

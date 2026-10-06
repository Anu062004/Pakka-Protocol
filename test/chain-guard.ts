import assert from "node:assert/strict";
import fs from "node:fs";
import hre from "hardhat";
import { BrowserProvider, ContractFactory, Interface } from "ethers";
import type { ContractArtifact } from "../backend/types.ts";

// Simulate a prohibited chain locally. This script never contacts a public RPC.
hre.config.networks.hardhat.chainId = 5042;
const provider = new BrowserProvider(hre.network.provider);
const signer = await provider.getSigner(0);
async function deploy(name: string, args: unknown[] = []) {
  const a = JSON.parse(fs.readFileSync(`artifacts/${name}.json`, "utf8")) as ContractArtifact;
  const c = await new ContractFactory(a.abi, a.bytecode!, signer).deploy(...args);
  await c.waitForDeployment();
  return c;
}
assert.equal((await provider.getNetwork()).chainId, 5042n);
const usdc = await deploy("MockUSDC");
const vault = await deploy("MockVault", [usdc.target, 12]);
const block = await provider.getBlock("latest");
const specs: [string, unknown[]][] = [
  ["DemoVault", [usdc.target]], ["YieldToken", [vault.target, block!.timestamp + 3600, "TEST", "0x0000000000000000000000000000000000000000"]],
  ["SeriesRegistry", [usdc.target, signer.address]], ["TestnetPoolManager", [signer.address]],
  ["UniswapV4Market", [usdc.target, vault.target]], ["PoolSeeder", [usdc.target, vault.target]],
  ["PakkaRouter", [usdc.target]],
  ["Tijori", [usdc.target]], ["TijoriFactory", [usdc.target]],
];
for (const [name, args] of specs) {
  const a = JSON.parse(fs.readFileSync(`artifacts/${name}.json`, "utf8")) as ContractArtifact;
  const factory = new ContractFactory(a.abi, a.bytecode!, signer);
  const tx = await factory.getDeployTransaction(...args);
  await assert.rejects(signer.call(tx), (error) => {
    const decoded = new Interface(a.abi).parseError((error as { data: string }).data);
    return decoded?.name === "UnsupportedChain" && decoded.args[0] === 5042n;
  });
}
console.log("Mainnet constructors rejected on a local simulation of chain 5042.");

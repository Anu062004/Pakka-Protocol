import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, FetchRequest, JsonRpcProvider, Wallet, getAddress, parseEther } from "ethers";
import { deploySystem } from "../test/helpers/system.ts";
import { fullFlow } from "../test/helpers/full-flow.ts";

const usdc = "0x3600000000000000000000000000000000000000";

export function localForkUrl(value: string): string {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "http:" || url.username || url.password) throw new Error("FORK_WRITES_REQUIRE_LOCALHOST");
  return url.href;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!env.FORK_VAULT_ADDRESS) throw new Error("VERIFIED_FORK_VAULT_REQUIRED");
  const endpoint = localForkUrl(env.FORK_LOCAL_RPC_URL || "http://127.0.0.1:8545");
  const request = new FetchRequest(endpoint); request.timeout = 10000;
  const provider = new JsonRpcProvider(request, 31337, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pakka-real-fork-"));
  try {
    // No key from .env is used. No transaction can be sent to a public Arc RPC by this script.
    assert.equal(BigInt(await provider.send("eth_chainId", []) as string), 31337n, "Run the local Arc-aware fork with chain ID 31337");
    const metadata = await provider.send("anvil_metadata", []) as { forkedNetwork?: { chainId: number } };
    const sourceChain = Number(metadata.forkedNetwork?.chainId);
    assert([5042, 5042002].includes(sourceChain), "Anvil metadata must prove this is an Arc-state fork");
    const token = new Contract(usdc, ["function balanceOf(address) view returns(uint256)",
      "function transfer(address,uint256) returns(bool)", "function approve(address,uint256) returns(bool)",
      "function allowance(address,address) view returns(uint256)"], provider);
    const vault = new Contract(getAddress(env.FORK_VAULT_ADDRESS), ["function asset() view returns(address)", "function decimals() view returns(uint8)",
      "function totalSupply() view returns(uint256)", "function convertToAssets(uint256) view returns(uint256)"], provider);
    assert.equal(getAddress(await vault.asset() as string), usdc);
    const supply = await vault.totalSupply() as bigint, unit = 10n ** (BigInt(await vault.decimals() as number) + 18n), index = await vault.convertToAssets(unit) as bigint;
    assert(supply > 0n && index > 0n, "Verified vault must be active, not a factory or empty demo");
    const block = await provider.getBlock("latest");
    await provider.send("evm_setNextBlockTimestamp", [block!.timestamp + 86400]); await provider.send("evm_mine", []);
    assert(await vault.convertToAssets(unit) as bigint > index, "Real vault index must accrue with time and no deposit");
    assert.equal(await vault.totalSupply(), supply);
    const signers = Array.from({ length: 7 }, () => Wallet.createRandom().connect(provider)!);
    for (const signer of signers) {
      await provider.send("anvil_setBalance", [signer.address, `0x${parseEther("2000").toString(16)}`]);
      assert.equal(await token.balanceOf(signer.address), 2_000_000000n, "Fork must implement Arc's native USDC/ERC-20 balance bridge");
    }
    // Give the payee zero principal so its received amount can be asserted exactly.
    await provider.send("anvil_setBalance", [signers[6]!.address, "0x0"]);
    const system = await deploySystem({ provider, signers, realVault: vault, realAsset: token });
    const result = await fullFlow(system, { stateDirectory: directory, realVault: true,
      advance: async (timestamp: number) => { await provider.send("evm_setNextBlockTimestamp", [timestamp]); await provider.send("evm_mine", []); },
      mine: () => provider.send("evm_mine", []) });
    console.log(JSON.stringify({ sourceChain, ...result, forkVault: vault.target }));
    return 0;
  } finally { provider.destroy(); fs.rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (e) { console.error(/^[A-Z_]+$/.test((e as Error).message) ? (e as Error).message : "REAL_FORK_FLOW_FAILED"); process.exitCode = 1; }
}

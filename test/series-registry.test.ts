import assert from "node:assert/strict";
import { before, test } from "node:test";
import hre from "hardhat";
import { AbiCoder, BrowserProvider, Contract, ContractFactory, ZeroAddress, keccak256 } from "ethers";
import type { JsonRpcSigner } from "ethers";
import { compile } from "../scripts/compile.ts";
import type { ContractArtifact } from "../backend/types.ts";

const provider = new BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
let artifacts: Record<string, ContractArtifact>, owner: JsonRpcSigner, stranger: JsonRpcSigner;
const sent = async (tx: Promise<{ wait: () => Promise<any> }>) => (await tx).wait();

before(async () => {
  artifacts = compile();
  [owner, stranger] = await Promise.all([provider.getSigner(0), provider.getSigner(1)]);
});

async function deploy(name: string, args: unknown[] = []): Promise<Contract> {
  const a = artifacts[name]!;
  const c = await new ContractFactory(a.abi, a.bytecode!, owner).deploy(...args);
  await c.waitForDeployment();
  return c as unknown as Contract;
}

async function setup() {
  const asset = await deploy("MockUSDC");
  const vault = await deploy("MockVault", [asset.target, 12]);
  const registry = await deploy("SeriesRegistry", [asset.target, owner.address, ZeroAddress]);
  const expiry = (await provider.getBlock("latest"))!.timestamp + 100_000;
  const yt = await deploy("YieldToken", [vault.target, expiry, "REGISTRY", registry.target]);
  const pt = await yt.principalToken();
  return { asset, vault, registry, expiry, yt, pt };
}

async function rejects(call: Promise<unknown>, contract: Contract, name: string) {
  await assert.rejects(call, (error) => {
    assert.equal(contract.interface.parseError((error as { data: string }).data)?.name, name);
    return true;
  });
}

function poolKey(f: Awaited<ReturnType<typeof setup>>) {
  const [currency0, currency1] = [f.pt as string, f.asset.target as string].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
  return { currency0, currency1, fee: 3000, tickSpacing: 60, hooks: ZeroAddress };
}

test("owner registers three maturities with permanent IDs, metadata, events and reverse lookups", async () => {
  const f = await setup();
  assert.equal(await f.registry.owner(), owner.address);
  assert.equal(await f.registry.assetToken(), f.asset.target);
  assert.equal(await f.registry.seriesCount(), 0n);
  assert.equal(await f.registry.seriesIdFor(f.vault.target, f.expiry), 0n);
  for (let i = 0; i < 3; ++i) {
    const expiry = f.expiry + i * 86400;
    const yt = i === 0 ? f.yt : await deploy("YieldToken", [f.vault.target, expiry, `REGISTRY-${i}`, f.registry.target]);
    const pt = await yt.principalToken();
    const id = BigInt(i + 1);
    assert.equal(await f.registry.registerSeries.staticCall(yt.target), id);
    const receipt = await sent(f.registry.registerSeries(yt.target));
    const event = (receipt.logs as any[]).map((log: any) => f.registry.interface.parseLog(log)).find((log: any) => log?.name === "SeriesRegistered");
    assert.equal(event!.args.seriesId, id);
    assert.equal(event!.args.yieldToken, yt.target);
    assert.equal(event!.args.principalToken, pt);
    assert.equal(event!.args.vault, f.vault.target);
    assert.equal(event!.args.expiry, BigInt(expiry));
    const record = await (f.registry.connect(stranger) as Contract).getSeries(id);
    assert.equal(record.vault, f.vault.target);
    assert.equal(record.principalToken, pt);
    assert.equal(record.yieldToken, yt.target);
    assert.equal(record.expiry, BigInt(expiry));
    assert.equal(record.hasPool, false);
    assert.equal(record.poolKey.currency0, ZeroAddress);
    assert.equal(await f.registry.seriesIdByYieldToken(yt.target), id);
    assert.equal(await f.registry.seriesIdByPrincipalToken(pt), id);
    assert.equal(await f.registry.seriesIdFor(f.vault.target, expiry), id);
  }
  assert.equal(await f.registry.seriesCount(), 3n);
  assert.equal((await f.registry.getSeries(1)).yieldToken, f.yt.target);
});

test("non-owner cannot register or attach pools, and failed attempts leave no records", async () => {
  const f = await setup();
  await rejects((f.registry.connect(stranger) as Contract).registerSeries.staticCall(f.yt.target), f.registry, "OnlyOwner");
  assert.equal(await f.registry.seriesCount(), 0n);
  await sent(f.registry.registerSeries(f.yt.target));
  await rejects((f.registry.connect(stranger) as Contract).setPoolKey.staticCall(1, poolKey(f)), f.registry, "OnlyOwner");
  assert.equal((await f.registry.getSeries(1)).hasPool, false);
});

test("duplicate tokens and a second series for the same vault/maturity are rejected", async () => {
  const f = await setup();
  await sent(f.registry.registerSeries(f.yt.target));
  await rejects(f.registry.registerSeries.staticCall(f.yt.target), f.registry, "SeriesAlreadyRegistered");
  await rejects(f.registry.registerSeries.staticCall(f.pt), f.registry, "SeriesAlreadyRegistered");
  const second = await deploy("YieldToken", [f.vault.target, f.expiry, "DUPLICATE", f.registry.target]);
  await rejects(f.registry.registerSeries.staticCall(second.target), f.registry, "VaultExpiryAlreadyRegistered");
  assert.equal(await f.registry.seriesCount(), 1n);
  assert.equal(await f.registry.seriesIdByYieldToken(second.target), 0n);
  assert.equal(await f.registry.seriesIdByPrincipalToken(await second.principalToken()), 0n);
});

test("different vaults may share a maturity without colliding", async () => {
  const f = await setup();
  const vault = await deploy("MockVault", [f.asset.target, 0]);
  const yt = await deploy("YieldToken", [vault.target, f.expiry, "OTHER-VAULT", f.registry.target]);
  await sent(f.registry.registerSeries(f.yt.target));
  await sent(f.registry.registerSeries(yt.target));
  assert.equal(await f.registry.seriesIdFor(f.vault.target, f.expiry), 1n);
  assert.equal(await f.registry.seriesIdFor(vault.target, f.expiry), 2n);
});

test("constructor rejects zero owner and unsupported asset addresses/decimals", async () => {
  const f = await setup();
  await rejects(deploy("SeriesRegistry", [f.asset.target, ZeroAddress, ZeroAddress]), f.registry, "InvalidOwner");
  for (const asset of [ZeroAddress, stranger.address, f.vault.target]) {
    await rejects(deploy("SeriesRegistry", [asset, owner.address, ZeroAddress]), f.registry, "InvalidAsset");
  }
});

test("invalid contracts and mismatched asset/vault metadata cannot be registered", async () => {
  const f = await setup();
  for (const address of [ZeroAddress, stranger.address]) {
    await rejects(f.registry.registerSeries.staticCall(address), f.registry, "InvalidSeries");
  }
  await assert.rejects(f.registry.registerSeries.staticCall(f.asset.target)); // Missing series ABI.
  const otherAsset = await deploy("MockUSDC");
  const otherVault = await deploy("MockVault", [otherAsset.target, 12]);
  const otherSeries = await deploy("YieldToken", [otherVault.target, f.expiry, "OTHER-ASSET", ZeroAddress]);
  await rejects(f.registry.registerSeries.staticCall(otherSeries.target), f.registry, "InvalidAsset");
  for (const [vault, asset] of [[f.vault.target, otherAsset.target], [otherVault.target, f.asset.target]]) {
    const wrong = await deploy("MockSeries", [vault, asset, f.expiry, 6]);
    await rejects(f.registry.registerSeries.staticCall(wrong.target), f.registry, "InvalidAsset");
  }
  assert.equal(await f.registry.seriesCount(), 0n);
});

test("incorrect PT issuer, missing contracts and token decimals are rejected", async () => {
  const f = await setup();
  const wrong = await deploy("MockSeries", [f.vault.target, f.asset.target, f.expiry, 6]);
  await sent(wrong.setPrincipalToken(f.pt));
  await rejects(f.registry.registerSeries.staticCall(wrong.target), f.registry, "InvalidSeries");
  await sent(wrong.setPrincipalToken(ZeroAddress));
  await rejects(f.registry.registerSeries.staticCall(wrong.target), f.registry, "InvalidSeries");
  const decimals = await deploy("MockSeries", [f.vault.target, f.asset.target, f.expiry, 18]);
  await rejects(f.registry.registerSeries.staticCall(decimals.target), f.registry, "InvalidSeries");
  const noVault = await deploy("MockSeries", [stranger.address, f.asset.target, f.expiry, 6]);
  await rejects(f.registry.registerSeries.staticCall(noVault.target), f.registry, "InvalidSeries");
  assert.equal(await f.registry.seriesCount(), 0n);
});

test("one pool key can be attached and its event carries the canonical v4 pool ID", async () => {
  const f = await setup();
  await sent(f.registry.registerSeries(f.yt.target));
  const key = poolKey(f);
  const receipt = await sent(f.registry.setPoolKey(1, key));
  const record = await f.registry.getSeries(1);
  assert.equal(record.hasPool, true);
  for (const name of ["currency0", "currency1", "hooks"] as const) assert.equal(record.poolKey[name], key[name]);
  assert.equal(record.poolKey.fee, BigInt(key.fee));
  assert.equal(record.poolKey.tickSpacing, BigInt(key.tickSpacing));
  const event = (receipt.logs as any[]).map((log: any) => f.registry.interface.parseLog(log)).find((log: any) => log?.name === "PoolKeySet");
  const encoded = AbiCoder.defaultAbiCoder().encode([
    "tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)",
  ], [key]);
  assert.equal(event!.args.poolId, keccak256(encoded));
  await rejects(f.registry.setPoolKey.staticCall(1, { ...key, fee: 500 }), f.registry, "PoolAlreadySet");
  assert.equal((await f.registry.getSeries(1)).poolKey.fee, 3000n);
  assert.equal(record.yieldToken, f.yt.target);
});

test("pool keys reject wrong currencies, order, fees, tick spacing and hooks", async () => {
  const f = await setup();
  await sent(f.registry.registerSeries(f.yt.target));
  const key = poolKey(f);
  const invalid = [
    { ...key, currency0: key.currency1, currency1: key.currency0 },
    { ...key, currency0: ZeroAddress },
    { ...key, currency1: f.yt.target },
    { ...key, fee: 1_000_001 }, { ...key, fee: 0x800000 },
    { ...key, tickSpacing: 0 }, { ...key, tickSpacing: -1 },
    { ...key, tickSpacing: 32768 }, { ...key, hooks: f.vault.target },
  ];
  for (const candidate of invalid) await rejects(f.registry.setPoolKey.staticCall(1, candidate), f.registry, "InvalidPoolKey");
  assert.equal((await f.registry.getSeries(1)).hasPool, false);
  await sent(f.registry.setPoolKey(1, { ...key, fee: 0, tickSpacing: 1 }));
});

test("unknown IDs revert and expiry preserves history while rejecting new registration/pools", async () => {
  const f = await setup();
  for (const id of [0, 1, 999]) {
    await rejects(f.registry.getSeries(id), f.registry, "UnknownSeries");
    await rejects(f.registry.setPoolKey.staticCall(id, poolKey(f)), f.registry, "UnknownSeries");
  }
  await sent(f.registry.registerSeries(f.yt.target));
  const second = await deploy("YieldToken", [f.vault.target, f.expiry, "EXPIRES", f.registry.target]);
  await hre.network.provider.send("evm_setNextBlockTimestamp", [f.expiry]);
  await hre.network.provider.send("evm_mine");
  await rejects(f.registry.registerSeries.staticCall(second.target), f.registry, "ExpiredSeries");
  await rejects(f.registry.setPoolKey.staticCall(1, poolKey(f)), f.registry, "ExpiredSeries");
  assert.equal(await f.registry.seriesCount(), 1n);
  assert.equal((await f.registry.getSeries(1)).expiry, BigInt(f.expiry));
  assert.equal(await f.registry.seriesIdFor(f.vault.target, f.expiry), 1n);
});

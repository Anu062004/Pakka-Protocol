import assert from "node:assert/strict";
import { before, test } from "node:test";
import hre from "hardhat";
import { BrowserProvider, Contract, ContractFactory } from "ethers";
import { deploySystem, localSigner } from "./helpers/system.ts";
import type { System } from "./helpers/system.ts";

const provider = new BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
const sent = async (tx: Promise<{ wait: () => Promise<unknown> }>) => (await tx).wait();
let system: System, snapshot: string;
const address = (signer: unknown) => (signer as { address: string }).address;

async function rejects(call: () => Promise<unknown>, contract: Contract, name: string) {
  await assert.rejects(call, (error: unknown) => {
    assert.equal(contract.interface.parseError((error as { data: string }).data)?.name, name);
    return true;
  });
}
async function fresh() {
  await hre.network.provider.send("evm_revert", [snapshot]);
  snapshot = await hre.network.provider.send("evm_snapshot");
}

before(async () => {
  system = await deploySystem({ provider, signers: Array.from({ length: 7 }, (_, i) => localSigner(i, provider)) });
  snapshot = await hre.network.provider.send("evm_snapshot");
});

test("a deployed registry accepts only series its factory created, even from the owner", async () => {
  await fresh();
  const { artifacts, registry, seriesFactory, vault, owner, deployer } = system;
  assert.equal(await registry.seriesFactory(), seriesFactory.target);
  assert.equal(await seriesFactory.vault(), vault.target);
  const expiry = (await provider.getBlock("latest"))!.timestamp + 50_000;
  // Canonical bytecode over the canonical vault, but not deployed by the factory.
  const yt = await new ContractFactory(artifacts.YieldToken!.abi, artifacts.YieldToken!.bytecode!, deployer)
    .deploy(vault.target, expiry, "ROGUE", registry.target);
  await yt.waitForDeployment();
  await rejects(() => (registry.connect(owner) as Contract).registerSeries(yt.target), registry, "InvalidSeries");
  assert.equal(await seriesFactory.isSeries(yt.target), false);
  // Nor can a registry be pointed at a factory that did not create it.
  const standalone = new ContractFactory(artifacts.SeriesRegistry!.abi, artifacts.SeriesRegistry!.bytecode!, deployer);
  await rejects(() => standalone.deploy(system.asset.target, address(owner), seriesFactory.target), registry, "InvalidFactory");
});

test("only the owner opens a maturity, and one call deploys, registers and attaches the pool", async () => {
  await fresh();
  const { registry, seriesFactory, owner, priya, asset } = system;
  const now = (await provider.getBlock("latest"))!.timestamp;
  await rejects(() => (seriesFactory.connect(priya) as Contract).create(now + 50_000, "X"), seriesFactory, "OnlyOwner");
  // Entries close an hour before maturity, so anything that short could never be bought.
  await rejects(() => (seriesFactory.connect(owner) as Contract).create(now + 3600, "X"), seriesFactory, "InvalidExpiry");
  await sent((seriesFactory.connect(owner) as Contract).create(now + 50_000, "NEW"));
  assert.equal(await registry.seriesCount(), 4n);
  const s = await registry.getSeries(4);
  assert.equal(await seriesFactory.isSeries(s.yieldToken), true);
  assert.equal(s.hasPool, true);
  assert.equal(s.poolKey.fee, 500n);
  assert.equal(s.poolKey.hooks, "0x0000000000000000000000000000000000000000");
  assert([s.poolKey.currency0, s.poolKey.currency1].includes(asset.target as string));
  assert.equal(await registry.entryOpen(s.yieldToken), true);
});

test("ownership moves in two steps and the liquidity follows the new owner", async () => {
  await fresh();
  const { registry, seeder, market, owner, priya, payee, asset } = system;
  const [ranges, liquidity] = await seeder.positions(1);
  assert.equal(ranges.length, 1);
  assert.equal(liquidity[0], (await market.poolState(1)).liquidity);
  await rejects(() => (registry.connect(priya) as Contract).transferOwnership(address(priya)), registry, "OnlyOwner");
  await sent((registry.connect(owner) as Contract).transferOwnership(address(payee)));
  // Nothing changes until the new owner proves it can act.
  assert.equal(await registry.owner(), address(owner));
  await rejects(() => (registry.connect(priya) as Contract).acceptOwnership(), registry, "OnlyOwner");
  await sent((registry.connect(payee) as Contract).acceptOwnership());
  assert.equal(await registry.owner(), address(payee));
  assert.equal(await seeder.owner(), address(payee));
  assert.equal(await registry.pendingOwner(), "0x0000000000000000000000000000000000000000");
  await rejects(() => (registry.connect(owner) as Contract).setEntriesPaused(true), registry, "OnlyOwner");
  const deadline = (await provider.getBlock("latest"))!.timestamp + 600;
  const remove = [1, ranges[0].tickLower, ranges[0].tickUpper, liquidity[0], 0, 0, deadline];
  await rejects(() => (seeder.connect(owner) as Contract).removeLiquidity(...remove), seeder, "OnlyOwner");
  const before = await asset.balanceOf(address(payee));
  await sent((seeder.connect(payee) as Contract).removeLiquidity(...remove));
  assert(await asset.balanceOf(address(payee)) > before);
  assert.equal((await seeder.positions(1))[1][0], 0n);
});

test("a vault that stops answering blocks new entries but not settlement or share exits", async () => {
  await fresh();
  const { series, vault, asset, priya } = system;
  const { yt, pt, expiry } = series[0]!;
  await sent((asset.connect(priya) as Contract).approve(yt.target, 2_000000n));
  await sent((yt.connect(priya) as Contract).splitFromAssets(2_000000n, address(priya)));
  const stored = await yt.pyIndexStored();
  const code = await provider.getCode(vault.target as string);
  await hre.network.provider.send("hardhat_setCode", [vault.target, "0x60006000fd"]);
  assert.equal(await yt.indexHealthy(), false);
  assert.equal(await yt.pyIndexCurrent(), stored);
  await rejects(() => (yt.connect(priya) as Contract).splitFromAssets(1_000000n, address(priya)), yt, "IndexCircuitBreaker");
  await hre.network.provider.send("evm_setNextBlockTimestamp", [expiry]);
  await hre.network.provider.send("evm_mine");
  await sent(yt.settleExpiry());
  assert.equal(await yt.indexAtExpiry(), stored);
  // The vault is restored only so its share token can be transferred out.
  await hre.network.provider.send("hardhat_setCode", [vault.target, code]);
  const shares = await vault.balanceOf(address(priya));
  await sent((yt.connect(priya) as Contract).redeemPT(2_000000n, address(priya), false));
  assert(await vault.balanceOf(address(priya)) > shares);
  assert.equal(await pt.balanceOf(address(priya)), 0n);
});

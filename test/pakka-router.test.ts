import assert from "node:assert/strict";
import { before, test } from "node:test";
import hre from "hardhat";
import { BrowserProvider, Contract, ContractFactory, MaxUint256, ZeroAddress } from "ethers";
import type { JsonRpcSigner } from "ethers";
import { compile } from "../scripts/compile.ts";
import { initialSqrtPrice } from "../scripts/seed-v4.ts";
import type { ContractArtifact } from "../backend/types.ts";

const provider = new BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
const unit = 1_000_000n;
const sent = async (tx: Promise<{ wait: () => Promise<any> }>) => (await tx).wait();
let artifacts: Record<string, ContractArtifact>, owner: JsonRpcSigner, user: JsonRpcSigner, receiver: JsonRpcSigner;

before(async () => {
  artifacts = compile();
  [owner, user, receiver] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
});

async function deploy(name: string, args: unknown[] = []): Promise<Contract> {
  const a = artifacts[name]!;
  const c = await new ContractFactory(a.abi, a.bytecode!, owner).deploy(...args);
  await c.waitForDeployment();
  return c as unknown as Contract;
}

interface SeriesFixture {
  id: number;
  expiry: number;
  yt: Contract;
  pt: Contract;
}

async function setup({ count = 1, seed = true, assetName = "MockUSDC" }: { count?: number; seed?: boolean; assetName?: string } = {}) {
  const asset = await deploy(assetName);
  const vault = await deploy("MockVault", [asset.target, 12]);
  const registry = await deploy("SeriesRegistry", [asset.target, owner.address, ZeroAddress]);
  const manager = await deploy("TestnetPoolManager", [owner.address]);
  const market = await deploy("UniswapV4Market", [manager.target, registry.target]);
  const seeder = await deploy("PoolSeeder", [manager.target, registry.target]);
  const router = await deploy("PakkaRouter", [market.target]);
  const deadline = (await provider.getBlock("latest"))!.timestamp + 99_000;
  await sent(asset.mint(owner.address, 20_000n * unit));
  await sent(asset.approve(seeder.target, MaxUint256));
  const series: SeriesFixture[] = [];
  for (let i = 0; i < count; i++) {
    const expiry = deadline + 1000 + i * 86400;
    const yt = await deploy("YieldToken", [vault.target, expiry, `ROUTER-${i}`, registry.target]);
    const pt = new Contract(await yt.principalToken(), artifacts.PrincipalToken!.abi, owner);
    await sent(registry.registerSeries(yt.target));
    const id = i + 1;
    if (seed) {
      const assetIs0 = BigInt(asset.target as string) < BigInt(pt.target as string);
      await sent(registry.setPoolKey(id, { currency0: assetIs0 ? asset.target : pt.target,
        currency1: assetIs0 ? pt.target : asset.target, fee: 500, tickSpacing: 10, hooks: ZeroAddress }));
      await sent(seeder.initializePool(id, initialSqrtPrice(asset.target as string, pt.target as string, 990_000n)));
      await sent(asset.approve(yt.target, 1_000n * unit));
      await sent(yt.splitFromAssets(400n * unit, owner.address));
      await sent(pt.approve(seeder.target, MaxUint256));
      await sent(seeder.addLiquidity(id, -600, 600, 10_000n * unit, 1_000n * unit, 1_000n * unit, deadline));
    }
    await sent((pt.connect(user) as Contract).approve(router.target, MaxUint256));
    series.push({ id, expiry, yt, pt });
  }
  await sent(asset.mint(user.address, 1_000n * unit));
  await sent((asset.connect(user) as Contract).approve(router.target, MaxUint256));
  return { asset, vault, registry, manager, market, seeder, router, deadline, series, ...series[0]! };
}

async function rejects(call: () => Promise<unknown>, contract: Contract, name: string) {
  await assert.rejects(call, (error: unknown) => {
    assert.equal(contract.interface.parseError((error as { data: string }).data)?.name, name);
    return true;
  });
}

async function states(f: Awaited<ReturnType<typeof setup>>) {
  return Promise.all(f.series.map(async ({ id }) => (await f.market.poolState(id)).toArray()));
}

async function clean(f: Awaited<ReturnType<typeof setup>>) {
  assert.equal(await f.asset.balanceOf(f.router.target), 0n);
  assert.equal(await f.asset.allowance(f.router.target, f.market.target), 0n);
  for (const { pt, yt } of f.series) {
    assert.equal(await pt.balanceOf(f.router.target), 0n);
    assert.equal(await yt.balanceOf(f.router.target), 0n);
    assert.equal(await pt.allowance(f.router.target, f.market.target), 0n);
    assert.equal(await f.asset.allowance(f.router.target, yt.target), 0n);
  }
}

async function mature(f: Awaited<ReturnType<typeof setup>>) {
  await hre.network.provider.send("evm_setNextBlockTimestamp", [f.expiry]);
  await hre.network.provider.send("evm_mine");
  return f.expiry + 1000;
}

test("lock buys exact PT with a router-only approval and refunds the caller, not the receiver", async () => {
  const f = await setup();
  const amount = 10n * unit;
  const quote = await f.market.quoteBuyPT.staticCall(1, amount);
  const before = await f.asset.balanceOf(user.address);
  const receipt = await sent((f.router.connect(user) as Contract).lock(1, amount, amount, receiver.address, f.deadline));
  assert.equal(before - await f.asset.balanceOf(user.address), quote);
  assert.equal(await f.pt.balanceOf(receiver.address), amount);
  assert.equal(await f.asset.balanceOf(receiver.address), 0n);
  assert.equal(await f.asset.allowance(user.address, f.market.target), 0n);
  const event = (receipt.logs as any[]).map((l: any) => { try { return f.router.interface.parseLog(l); } catch { return null; } })
    .find((l: any) => l?.name === "Locked");
  assert.equal(event!.args.caller, user.address);
  assert.equal(event!.args.usdcSpent, quote);
  await clean(f);
});

test("one atomic ladder buys three maturities at their target payouts under a shared budget", async () => {
  const f = await setup({ count: 3 });
  const amounts = [10n * unit, 20n * unit, 30n * unit];
  const quotes = await Promise.all(amounts.map((amount, i) => f.market.quoteBuyPT.staticCall(i + 1, amount)));
  const total = quotes.reduce((a, b) => a + b, 0n);
  const legs = amounts.map((amount, i) => ({ seriesId: i + 1, ptAmount: amount, maxUsdc: amount }));
  const before = await f.asset.balanceOf(user.address);
  const receipt = await sent((f.router.connect(user) as Contract).buildLadder(legs, total + unit, receiver.address, f.deadline));
  assert.equal(before - await f.asset.balanceOf(user.address), total);
  for (let i = 0; i < 3; i++) assert.equal(await f.series[i].pt.balanceOf(receiver.address), amounts[i]);
  const events = (receipt.logs as any[]).map((l: any) => { try { return f.router.interface.parseLog(l); } catch { return null; } })
    .filter((l): l is NonNullable<typeof l> => l !== null);
  assert.equal(events.filter((e) => e.name === "Locked").length, 3);
  const ladder = events.find((e) => e.name === "LadderBuilt");
  assert.equal(ladder!.args.legs, 3n);
  assert.equal(ladder!.args.usdcSpent, total);
  assert.equal(ladder!.args.usdcRefunded, unit);
  await clean(f);
});

test("a second-leg slippage failure rolls back the first pool, all balances and all approvals", async () => {
  const f = await setup({ count: 3 });
  const amount = 10n * unit;
  const quotes = await Promise.all(f.series.map(({ id }) => f.market.quoteBuyPT.staticCall(id, amount)));
  const before = await states(f);
  const balance = await f.asset.balanceOf(user.address);
  const legs = quotes.map((quote, i) => ({ seriesId: i + 1, ptAmount: amount, maxUsdc: i === 1 ? quote - 1n : quote }));
  await rejects(() => (f.router.connect(user) as Contract).buildLadder(legs, 50n * unit, user.address, f.deadline), f.market, "SlippageExceeded");
  assert.deepEqual(await states(f), before);
  assert.equal(await f.asset.balanceOf(user.address), balance);
  await clean(f);
});

test("the aggregate cap is enforced even with donated USDC already in the router", async () => {
  const f = await setup({ count: 2 });
  await sent(f.asset.mint(f.router.target, 100n * unit));
  const quotes = await Promise.all(f.series.map(({ id }) => f.market.quoteBuyPT.staticCall(id, unit)));
  const total = quotes[0] + quotes[1] - 1n;
  const before = await states(f);
  const legs = quotes.map((quote, i) => ({ seriesId: i + 1, ptAmount: unit, maxUsdc: unit }));
  await rejects(() => (f.router.connect(user) as Contract).buildLadder(legs, total, user.address, f.deadline), f.market, "SlippageExceeded");
  assert.deepEqual(await states(f), before);
  assert.equal(await f.asset.balanceOf(f.router.target), 100n * unit);
  assert.equal(await f.asset.balanceOf(user.address), 1_000n * unit);
});

test("an exhausted budget or an empty later pool rolls back an otherwise valid first purchase", async () => {
  const f = await setup({ count: 2 });
  const quote = await f.market.quoteBuyPT.staticCall(1, unit);
  const legs = [1, 2].map((id) => ({ seriesId: id, ptAmount: unit, maxUsdc: unit }));
  const before = await states(f);
  await rejects(() => (f.router.connect(user) as Contract).buildLadder(legs, quote, user.address, f.deadline), f.router, "BudgetExceeded");
  assert.deepEqual(await states(f), before);
  await sent(f.seeder.removeLiquidity(2, -600, 600, 10_000n * unit, 0, 0, f.deadline));
  const afterWithdrawal = await states(f);
  await rejects(() => (f.router.connect(user) as Contract).buildLadder(legs, 4n * unit, user.address, f.deadline), f.market, "IncompleteFill");
  assert.deepEqual(await states(f), afterWithdrawal);
  assert.equal(await f.asset.balanceOf(user.address), 1_000n * unit);
  await clean(f);
});

test("ladders reject empty, duplicate, unordered and zero-sized legs before moving funds", async () => {
  const f = await setup({ count: 2 });
  const leg = (id: number, amount = unit, cap = amount) => ({ seriesId: id, ptAmount: amount, maxUsdc: cap });
  for (const legs of [[], [leg(1), leg(1)], [leg(2), leg(1)]]) {
    await rejects(() => (f.router.connect(user) as Contract).buildLadder(legs, 10n * unit, user.address, f.deadline), f.router, "InvalidLadder");
  }
  for (const legs of [[leg(1, 0n)], [leg(1, unit, 0n)]]) {
    await rejects(() => (f.router.connect(user) as Contract).buildLadder(legs, 10n * unit, user.address, f.deadline), f.router, "InvalidAmount");
  }
  await rejects(() => (f.router.connect(user) as Contract).buildLadder([leg(1)], 0, user.address, f.deadline), f.router, "InvalidAmount");
  assert.equal(await f.asset.balanceOf(user.address), 1_000n * unit);
  await clean(f);
});

test("early exit pulls only approved PT and sends quoted USDC to the specified receiver", async () => {
  const f = await setup();
  await sent((f.router.connect(user) as Contract).lock(1, 10n * unit, 10n * unit, user.address, f.deadline));
  const quote = await f.market.quoteSellPT.staticCall(1, 5n * unit);
  await sent((f.router.connect(user) as Contract).sellEarly(1, 5n * unit, quote, receiver.address, f.deadline));
  assert.equal(await f.asset.balanceOf(receiver.address), quote);
  assert.equal(await f.pt.balanceOf(user.address), 5n * unit);
  assert.equal(await f.pt.allowance(user.address, f.market.target), 0n);
  await clean(f);
});

test("early-exit slippage or missing PT approval preserves both the position and pool", async () => {
  const f = await setup();
  await sent((f.router.connect(user) as Contract).lock(1, unit, unit, user.address, f.deadline));
  const quote = await f.market.quoteSellPT.staticCall(1, unit);
  const before = await states(f);
  await rejects(() => (f.router.connect(user) as Contract).sellEarly(1, unit, quote + 1n, user.address, f.deadline), f.market, "SlippageExceeded");
  await sent((f.pt.connect(user) as Contract).approve(f.router.target, 0));
  await assert.rejects(() => (f.router.connect(user) as Contract).sellEarly(1, unit, 0, user.address, f.deadline));
  assert.equal(await f.pt.balanceOf(user.address), unit);
  assert.deepEqual(await states(f), before);
  await clean(f);
});

test("cash-out burns caller-approved PT at maturity and pays USDC without a YT approval", async () => {
  const f = await setup();
  await sent((f.router.connect(user) as Contract).lock(1, 10n * unit, 10n * unit, user.address, f.deadline));
  const deadline = await mature(f);
  await sent((f.router.connect(user) as Contract).cashOut(1, 10n * unit, receiver.address, true, 10n * unit, deadline));
  assert.equal(await f.asset.balanceOf(receiver.address), 10n * unit);
  assert.equal(await f.pt.balanceOf(user.address), 0n);
  assert.equal(await f.pt.allowance(user.address, f.yt.target), 0n);
  assert(await f.yt.indexAtExpiry() > 0n);
  await clean(f);
});

test("cash-out works for a registered series without any market pool", async () => {
  const f = await setup({ seed: false });
  await sent((f.asset.connect(user) as Contract).approve(f.yt.target, 10n * unit));
  await sent((f.yt.connect(user) as Contract).splitFromAssets(10n * unit, user.address));
  const deadline = await mature(f);
  await sent((f.router.connect(user) as Contract).cashOut(1, 10n * unit, user.address, true, 10n * unit, deadline));
  assert.equal(await f.asset.balanceOf(user.address), 1_000n * unit);
  assert.equal(await f.yt.balanceOf(user.address), 10n * unit);
});

test("USDC illiquidity leaves PT intact, while a bounded share cash-out still succeeds", async () => {
  const f = await setup();
  await sent((f.router.connect(user) as Contract).lock(1, 10n * unit, 10n * unit, user.address, f.deadline));
  await sent(f.vault.setIlliquid(true));
  const deadline = await mature(f);
  await rejects(() => (f.router.connect(user) as Contract).cashOut(1, 10n * unit, receiver.address, true, 0, deadline), f.router, "VaultIlliquid");
  assert.equal(await f.pt.balanceOf(user.address), 10n * unit);
  assert.equal(await f.yt.indexAtExpiry(), 0n);
  const shares = await (f.router.connect(user) as Contract).cashOut.staticCall(1, 10n * unit, receiver.address, false, 0, deadline);
  await sent((f.router.connect(user) as Contract).cashOut(1, 10n * unit, receiver.address, false, shares, deadline));
  assert.equal(await f.vault.balanceOf(receiver.address), shares);
  await clean(f);
});

test("minimum redemption output protects against vault loss and rolls back the burn and settlement", async () => {
  const f = await setup();
  await sent((f.router.connect(user) as Contract).lock(1, 10n * unit, 10n * unit, user.address, f.deadline));
  await sent(f.vault.simulateLoss(100n * unit));
  const deadline = await mature(f);
  const supply = await f.pt.totalSupply();
  const assets = await f.asset.balanceOf(f.vault.target);
  await rejects(() => (f.router.connect(user) as Contract).cashOut(1, 10n * unit, receiver.address, true, 10n * unit, deadline), f.router, "SlippageExceeded");
  assert.equal(await f.pt.totalSupply(), supply);
  assert.equal(await f.pt.balanceOf(user.address), 10n * unit);
  assert.equal(await f.asset.balanceOf(f.vault.target), assets);
  assert.equal(await f.asset.balanceOf(receiver.address), 0n);
  assert.equal(await f.yt.indexAtExpiry(), 0n);
  const output = await (f.router.connect(user) as Contract).cashOut.staticCall(1, 10n * unit, receiver.address, true, 0, deadline);
  assert(output < 10n * unit);
  await sent((f.router.connect(user) as Contract).cashOut(1, 10n * unit, receiver.address, true, output, deadline));
  assert.equal(await f.asset.balanceOf(receiver.address), output);
  await clean(f);
});

test("yield purchase atomically splits, sells PT, returns sale proceeds to caller and delivers YT", async () => {
  const f = await setup();
  const amount = 10n * unit;
  const quote = await f.market.quoteSellPT.staticCall(1, amount);
  const before = await f.asset.balanceOf(user.address);
  await sent((f.router.connect(user) as Contract).buyYield(1, amount, amount, quote, receiver.address, f.deadline));
  assert.equal(before - await f.asset.balanceOf(user.address), amount - quote);
  assert.equal(await f.yt.balanceOf(receiver.address), amount);
  assert.equal(await f.pt.balanceOf(user.address), 0n);
  assert.equal(await f.asset.balanceOf(receiver.address), 0n);
  await sent(f.vault.addYield(unit));
  assert(await f.yt.accruedInterest(receiver.address) > 0n);
  await sent(f.yt.claimInterest(receiver.address, true));
  assert(await f.asset.balanceOf(receiver.address) > 0n);
  await clean(f);
});

test("yield minimums and sale failure roll back the deposit, token mint and vault/pool state", async () => {
  const f = await setup();
  const amount = 10n * unit;
  const quote = await f.market.quoteSellPT.staticCall(1, amount);
  const before = await states(f);
  const assets = await f.vault.totalAssets();
  const supply = await f.pt.totalSupply();
  await rejects(() => (f.router.connect(user) as Contract).buyYield(1, amount, amount + 1n, 0, user.address, f.deadline), f.router, "SlippageExceeded");
  await rejects(() => (f.router.connect(user) as Contract).buyYield(1, amount, amount, quote + 1n, user.address, f.deadline), f.market, "SlippageExceeded");
  assert.equal(await f.vault.totalAssets(), assets);
  assert.equal(await f.pt.totalSupply(), supply);
  assert.equal(await f.asset.balanceOf(user.address), 1_000n * unit);
  assert.deepEqual(await states(f), before);
  await clean(f);
});

test("unsolicited USDC/PT/YT cannot be swept, refunded or spent by another caller", async () => {
  const f = await setup();
  await sent(f.asset.mint(f.router.target, 7n * unit));
  await sent(f.pt.transfer(f.router.target, unit));
  await sent(f.yt.transfer(f.router.target, unit));
  const quote = await f.market.quoteBuyPT.staticCall(1, unit);
  await sent((f.router.connect(user) as Contract).lock(1, unit, unit, user.address, f.deadline));
  assert.equal(await f.asset.balanceOf(user.address), 1_000n * unit - quote);
  await sent((f.router.connect(user) as Contract).buyYield(1, unit, unit, 0, user.address, f.deadline));
  assert.equal(await f.asset.balanceOf(f.router.target), 7n * unit);
  assert.equal(await f.pt.balanceOf(f.router.target), unit);
  assert.equal(await f.yt.balanceOf(f.router.target), unit);
  await sent((f.pt.connect(user) as Contract).approve(f.router.target, 0));
  const deadline = await mature(f);
  await assert.rejects(() => (f.router.connect(receiver) as Contract).cashOut(1, unit, receiver.address, true, 0, deadline));
  assert.equal(await f.pt.balanceOf(f.router.target), unit);
});

test("wrong-time operations, unknown/unfunded series and missing USDC approval move no funds", async () => {
  const f = await setup({ seed: false });
  await rejects(() => (f.router.connect(user) as Contract).cashOut(1, unit, user.address, true, 0, f.deadline), f.router, "SeriesNotExpired");
  await assert.rejects(() => (f.router.connect(user) as Contract).lock(999, unit, unit, user.address, f.deadline));
  await rejects(() => (f.router.connect(user) as Contract).lock(1, unit, unit, user.address, f.deadline), f.market, "PoolNotSet");
  await sent((f.asset.connect(user) as Contract).approve(f.router.target, 0));
  await assert.rejects(() => (f.router.connect(user) as Contract).lock(1, unit, unit, user.address, f.deadline));
  const deadline = await mature(f);
  for (const call of [
    () => (f.router.connect(user) as Contract).lock(1, unit, unit, user.address, deadline),
    () => (f.router.connect(user) as Contract).sellEarly(1, unit, 0, user.address, deadline),
    () => (f.router.connect(user) as Contract).buyYield(1, unit, 0, 0, user.address, deadline),
  ]) await rejects(call, f.router, "SeriesExpired");
  assert.equal(await f.asset.balanceOf(user.address), 1_000n * unit);
  await clean(f);
});

test("all entrypoints enforce deadlines and receiver validation; zero amounts are rejected", async () => {
  const f = await setup();
  const calls = (to: string, deadline: number) => [
    () => (f.router.connect(user) as Contract).lock(1, unit, unit, to, deadline),
    () => (f.router.connect(user) as Contract).buildLadder([{ seriesId: 1, ptAmount: unit, maxUsdc: unit }], 2n * unit, to, deadline),
    () => (f.router.connect(user) as Contract).sellEarly(1, unit, 0, to, deadline),
    () => (f.router.connect(user) as Contract).cashOut(1, unit, to, true, 0, deadline),
    () => (f.router.connect(user) as Contract).buyYield(1, unit, 0, 0, to, deadline),
  ];
  for (const call of calls(user.address, 0)) await rejects(call, f.router, "DeadlineExpired");
  for (const to of [ZeroAddress, f.router.target as string, f.market.target as string, f.manager.target as string]) {
    for (const call of calls(to, f.deadline)) await rejects(call, f.router, "InvalidReceiver");
  }
  await rejects(() => (f.router.connect(user) as Contract).buyYield(1, unit, 0, 0, f.yt.target, f.deadline), f.router, "InvalidReceiver");
  for (const call of [
    () => (f.router.connect(user) as Contract).lock(1, 0, unit, user.address, f.deadline),
    () => (f.router.connect(user) as Contract).sellEarly(1, 0, 0, user.address, f.deadline),
    () => (f.router.connect(user) as Contract).cashOut(1, 0, user.address, true, 0, f.deadline),
    () => (f.router.connect(user) as Contract).buyYield(1, 0, 0, 0, user.address, f.deadline),
  ]) await rejects(call, f.router, "InvalidAmount");
});

test("token callback reentry is blocked and short-credit deposits cannot consume donated balances", async () => {
  const f = await setup({ assetName: "AdversarialUSDC" });
  const data = f.router.interface.encodeFunctionData("lock", [1, unit, 2n * unit, user.address, f.deadline]);
  await sent(f.asset.configure(f.router.target, data, false));
  await sent((f.router.connect(user) as Contract).lock(1, unit, unit, user.address, f.deadline));
  assert.equal(await f.asset.reentryBlocked(), true);
  await sent(f.asset.mint(f.router.target, 7n * unit));
  await sent(f.asset.configure(f.router.target, "0x", true));
  const balance = await f.asset.balanceOf(user.address);
  const before = await states(f);
  await rejects(() => (f.router.connect(user) as Contract).lock(1, unit, unit, user.address, f.deadline), f.router, "UnexpectedTransferAmount");
  assert.equal(await f.asset.balanceOf(user.address), balance);
  assert.equal(await f.asset.balanceOf(f.router.target), 7n * unit);
  assert.deepEqual(await states(f), before);
});

test("constructor derives immutable market/registry/USDC and rejects nonexistent markets", async () => {
  const f = await setup();
  assert.equal(await f.router.market(), f.market.target);
  assert.equal(await f.router.registry(), f.registry.target);
  assert.equal(await f.router.assetToken(), f.asset.target);
  const factory = new ContractFactory(artifacts.PakkaRouter!.abi, artifacts.PakkaRouter!.bytecode!, owner);
  await rejects(() => factory.deploy(ZeroAddress), factory as unknown as Contract, "InvalidConfiguration");
  await rejects(() => factory.deploy(receiver.address), factory as unknown as Contract, "InvalidConfiguration");
  await assert.rejects(() => factory.deploy(f.asset.target));
});

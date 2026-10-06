import assert from "node:assert/strict";
import { before, test } from "node:test";
import hre from "hardhat";
import { BrowserProvider, Contract, ContractFactory, MaxUint256, ZeroAddress } from "ethers";
import type { JsonRpcSigner } from "ethers";
import { compile } from "../scripts/compile.ts";
import { initialSqrtPrice, seedSeries } from "../scripts/seed-v4.ts";
import type { ContractArtifact, PoolKey } from "../backend/types.ts";

const provider = new BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
const unit = 1_000_000n;
const lp = 10_000n * unit;
const sent = async (tx: Promise<{ wait: () => Promise<any> }>) => (await tx).wait();
let artifacts: Record<string, ContractArtifact>, owner: JsonRpcSigner, buyer: JsonRpcSigner, other: JsonRpcSigner;

before(async () => {
  artifacts = compile();
  [owner, buyer, other] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
});

async function deploy(name: string, args: unknown[] = []): Promise<Contract> {
  const a = artifacts[name]!;
  const c = await new ContractFactory(a.abi, a.bytecode!, owner).deploy(...args);
  await c.waitForDeployment();
  return c as unknown as Contract;
}

function sqrt(value: bigint): bigint {
  if (value < 2n) return value;
  let x = value, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + value / x) / 2n; }
  return x;
}

async function setup({ seed = true }: { seed?: boolean } = {}) {
  const asset = await deploy("MockUSDC");
  const vault = await deploy("MockVault", [asset.target, 12]);
  const registry = await deploy("SeriesRegistry", [asset.target, owner.address]);
  const manager = await deploy("TestnetPoolManager", [owner.address]);
  const market = await deploy("UniswapV4Market", [manager.target, registry.target]);
  const seeder = await deploy("PoolSeeder", [manager.target, registry.target]);
  const expiry = (await provider.getBlock("latest"))!.timestamp + 100_000;
  const yt = await deploy("YieldToken", [vault.target, expiry, "V4", registry.target]);
  const pt = new Contract(await yt.principalToken(), artifacts.PrincipalToken!.abi, owner);
  await sent(registry.registerSeries(yt.target));
  const assetIs0 = BigInt(asset.target as string) < BigInt(pt.target as string);
  const key: PoolKey = { currency0: (assetIs0 ? asset.target : pt.target) as string, currency1: (assetIs0 ? pt.target : asset.target) as string,
    fee: 500, tickSpacing: 10, hooks: ZeroAddress };
  const price = sqrt(((1n << 192n) * (assetIs0 ? 100n : 99n)) / (assetIs0 ? 99n : 100n));
  const deadline = expiry - 1;
  if (seed) {
    await sent(registry.setPoolKey(1, key));
    await sent(seeder.initializePool(1, price));
    await sent(asset.mint(owner.address, 10_000n * unit));
    await sent(asset.approve(yt.target, 1_000n * unit));
    await sent(yt.splitFromAssets(400n * unit, owner.address));
    await sent(asset.approve(seeder.target, MaxUint256));
    await sent(pt.approve(seeder.target, MaxUint256));
    await sent(seeder.addLiquidity(1, -600, 600, lp, 1_000n * unit, 1_000n * unit, deadline));
  }
  await sent(asset.mint(buyer.address, 1_000n * unit));
  await sent((asset.connect(buyer) as Contract).approve(market.target, MaxUint256));
  await sent((pt.connect(buyer) as Contract).approve(market.target, MaxUint256));
  return { asset, vault, registry, manager, market, seeder, expiry, yt, pt, key, price, deadline, assetIs0 };
}

async function rejects(call: () => Promise<unknown>, contract: Contract, name: string) {
  await assert.rejects(call, (error: unknown) => {
    assert.equal(contract.interface.parseError((error as { data: string }).data)?.name, name);
    return true;
  });
}

test("real v4 pool is initialized and seeded at discounted PT price", async () => {
  const f = await setup();
  const state = await f.market.poolState(1);
  assert.equal(state.sqrtPriceX96, f.price);
  assert.equal(state.liquidity, lp);
  assert.equal(state.lpFee, 500n);
  assert.equal(await f.pt.balanceOf(f.manager.target) > 0n, true);
  assert.equal(await f.asset.balanceOf(f.manager.target) > 0n, true);
  assert.equal(await f.pt.balanceOf(f.seeder.target), 0n);
});

test("quotes need no balance or approval and preserve pool state, including a quote transaction", async () => {
  const f = await setup();
  const before = await f.market.poolState(1);
  assert.equal(await f.asset.balanceOf(other.address), 0n);
  const buy = await (f.market.connect(other) as Contract).quoteBuyPT.staticCall(1, 10n * unit);
  const sell = await (f.market.connect(other) as Contract).quoteSellPT.staticCall(1, 10n * unit);
  assert(buy > 0n && buy < 10n * unit && sell > 0n && sell < buy);
  await sent((f.market.connect(other) as Contract).quoteBuyPT(1, 10n * unit));
  assert.deepEqual((await f.market.poolState(1)).toArray(), before.toArray());
  assert.equal(await f.asset.balanceOf(f.market.target), 0n);
  assert.equal(await f.pt.balanceOf(f.market.target), 0n);
});

test("buy pulls only quoted USDC and delivers exact PT to the specified receiver", async () => {
  const f = await setup();
  const amount = 10n * unit;
  const quote = await f.market.quoteBuyPT.staticCall(1, amount);
  const before = await f.asset.balanceOf(buyer.address);
  const receipt = await sent((f.market.connect(buyer) as Contract).buyPT(1, amount, amount, other.address, f.deadline));
  assert.equal(before - await f.asset.balanceOf(buyer.address), quote);
  assert.equal(await f.pt.balanceOf(other.address), amount);
  assert.equal(await f.pt.balanceOf(buyer.address), 0n);
  const event = (receipt.logs as any[]).map((l: any) => { try { return f.market.interface.parseLog(l); } catch { return null; } })
    .find((l: any) => l?.name === "PTBought");
  assert.equal(event!.args.usdc, quote);
  assert.equal(event!.args.pt, amount);
  assert.equal(await f.asset.balanceOf(f.market.target), 0n);
  assert.equal(await f.pt.balanceOf(f.market.target), 0n);
});

test("early sale returns the quoted USDC and consumes the exact seller PT amount", async () => {
  const f = await setup();
  await sent((f.market.connect(buyer) as Contract).buyPT(1, 10n * unit, 10n * unit, buyer.address, f.deadline));
  const amount = 5n * unit;
  const quote = await f.market.quoteSellPT.staticCall(1, amount);
  const before = await f.asset.balanceOf(other.address);
  await sent((f.market.connect(buyer) as Contract).sellPT(1, amount, quote, other.address, f.deadline));
  assert.equal(await f.asset.balanceOf(other.address) - before, quote);
  assert.equal(await f.pt.balanceOf(buyer.address), amount);
});

test("both PT address orderings trade correctly", async () => {
  const seen = new Set();
  for (let i = 0; i < 12 && seen.size < 2; i++) {
    const f = await setup();
    seen.add(f.assetIs0);
    const quote = await f.market.quoteBuyPT.staticCall(1, unit);
    await sent((f.market.connect(buyer) as Contract).buyPT(1, unit, quote, buyer.address, f.deadline));
    const sell = await f.market.quoteSellPT.staticCall(1, unit);
    await sent((f.market.connect(buyer) as Contract).sellPT(1, unit, sell, buyer.address, f.deadline));
    assert.equal(await f.pt.balanceOf(buyer.address), 0n);
  }
  assert.equal(seen.size, 2);
});

test("slippage failures roll back pool price, balances and token transfers", async () => {
  const f = await setup();
  const quote = await f.market.quoteBuyPT.staticCall(1, unit);
  const state = await f.market.poolState(1);
  const balance = await f.asset.balanceOf(buyer.address);
  await rejects(() => (f.market.connect(buyer) as Contract).buyPT(1, unit, quote - 1n, buyer.address, f.deadline), f.market, "SlippageExceeded");
  assert.deepEqual((await f.market.poolState(1)).toArray(), state.toArray());
  assert.equal(await f.asset.balanceOf(buyer.address), balance);
  await sent((f.market.connect(buyer) as Contract).buyPT(1, unit, quote, buyer.address, f.deadline));
  const sale = await f.market.quoteSellPT.staticCall(1, unit);
  const afterBuy = await f.market.poolState(1);
  await rejects(() => (f.market.connect(buyer) as Contract).sellPT(1, unit, sale + 1n, buyer.address, f.deadline), f.market, "SlippageExceeded");
  assert.deepEqual((await f.market.poolState(1)).toArray(), afterBuy.toArray());
  assert.equal(await f.pt.balanceOf(buyer.address), unit);
});

test("missing allowances and balances revert the whole swap", async () => {
  const f = await setup();
  const state = await f.market.poolState(1);
  await sent((f.asset.connect(buyer) as Contract).approve(f.market.target, 0));
  await assert.rejects(() => (f.market.connect(buyer) as Contract).buyPT(1, unit, unit, buyer.address, f.deadline));
  await assert.rejects(() => (f.market.connect(other) as Contract).sellPT(1, unit, 0, other.address, f.deadline));
  assert.deepEqual((await f.market.poolState(1)).toArray(), state.toArray());
  assert.equal(await f.pt.balanceOf(buyer.address), 0n);
});

test("invalid amounts, receivers, deadlines and unsolicited callbacks are rejected", async () => {
  const f = await setup();
  await rejects(() => (f.market.connect(buyer) as Contract).buyPT(1, 0, unit, buyer.address, f.deadline), f.market, "InvalidAmount");
  await rejects(() => f.market.quoteBuyPT.staticCall(1, 1n << 127n), f.market, "InvalidAmount");
  await rejects(() => (f.market.connect(buyer) as Contract).buyPT(1, unit, 0, buyer.address, f.deadline), f.market, "InvalidAmount");
  for (const receiver of [ZeroAddress, f.market.target, f.manager.target]) {
    await rejects(() => (f.market.connect(buyer) as Contract).buyPT(1, unit, unit, receiver, f.deadline), f.market, "InvalidReceiver");
  }
  await rejects(() => (f.market.connect(buyer) as Contract).sellPT(1, unit, 0, buyer.address, 0), f.market, "DeadlineExpired");
  for (const client of [f.market, f.seeder]) {
    await rejects(() => client.unlockCallback("0x1234"), client, "UnauthorizedCallback");
    await rejects(() => provider.call({ from: f.manager.target, to: client.target,
      data: client.interface.encodeFunctionData("unlockCallback", ["0x1234"]) }), client, "UnauthorizedCallback");
  }
});

test("unknown, unattached and uninitialized pools cannot trade; quotes bubble core errors", async () => {
  const f = await setup({ seed: false });
  await assert.rejects(() => f.market.quoteBuyPT.staticCall(999, unit));
  await rejects(() => f.market.quoteBuyPT.staticCall(1, unit), f.market, "PoolNotSet");
  await sent(f.registry.setPoolKey(1, f.key));
  await assert.rejects(() => f.market.quoteBuyPT.staticCall(1, unit));
  await sent(f.seeder.initializePool(1, f.price));
  await rejects(() => f.market.quoteBuyPT.staticCall(1, unit), f.market, "IncompleteFill");
});

test("insufficient pool liquidity rejects partial fills without spending user funds", async () => {
  const f = await setup();
  const state = await f.market.poolState(1);
  await rejects(() => f.market.quoteBuyPT.staticCall(1, 100_000n * unit), f.market, "IncompleteFill");
  await rejects(() => (f.market.connect(buyer) as Contract).buyPT(1, 100_000n * unit, 100_000n * unit, buyer.address, f.deadline), f.market, "IncompleteFill");
  await rejects(() => f.market.quoteSellPT.staticCall(1, 100_000n * unit), f.market, "IncompleteFill");
  assert.deepEqual((await f.market.poolState(1)).toArray(), state.toArray());
  assert.equal(await f.asset.balanceOf(buyer.address), 1_000n * unit);
});

test("only owner can initialize/add/remove LP and LP bounds prevent unwanted spending or exits", async () => {
  const f = await setup();
  await rejects(() => (f.seeder.connect(buyer) as Contract).initializePool(1, f.price), f.seeder, "OnlyOwner");
  await rejects(() => (f.seeder.connect(buyer) as Contract).addLiquidity(1, -600, 600, lp, MaxUint256, MaxUint256, f.deadline), f.seeder, "OnlyOwner");
  await rejects(() => (f.seeder.connect(buyer) as Contract).removeLiquidity(1, -600, 600, lp, 0, 0, f.deadline), f.seeder, "OnlyOwner");
  await rejects(() => f.seeder.addLiquidity(1, -600, 600, lp, 0, 0, f.deadline), f.seeder, "SlippageExceeded");
  await rejects(() => f.seeder.removeLiquidity(1, -600, 600, lp, MaxUint256, MaxUint256, f.deadline), f.seeder, "SlippageExceeded");
  await assert.rejects(() => f.seeder.addLiquidity(1, -601, 600, lp, MaxUint256, MaxUint256, f.deadline));
  assert.equal((await f.market.poolState(1)).liquidity, lp);
  await sent((f.market.connect(buyer) as Contract).buyPT(1, 10n * unit, 10n * unit, buyer.address, f.deadline));
  await sent(f.seeder.removeLiquidity(1, -600, 600, 0, 0, 0, f.deadline));
  assert.equal((await f.market.poolState(1)).liquidity, lp);
});

test("at maturity trades stop, owner can withdraw LP, and purchased PT redeems principal", async () => {
  const f = await setup();
  await sent((f.market.connect(buyer) as Contract).buyPT(1, 10n * unit, 10n * unit, buyer.address, f.deadline));
  await hre.network.provider.send("evm_setNextBlockTimestamp", [f.expiry]);
  await hre.network.provider.send("evm_mine");
  await rejects(() => f.market.quoteBuyPT.staticCall(1, unit), f.market, "SeriesExpired");
  await rejects(() => (f.market.connect(buyer) as Contract).sellPT(1, unit, 0, buyer.address, f.expiry + 100), f.market, "SeriesExpired");
  await rejects(() => f.seeder.addLiquidity(1, -600, 600, lp, MaxUint256, MaxUint256, f.expiry + 100), f.seeder, "SeriesExpired");
  await sent(f.seeder.removeLiquidity(1, -600, 600, lp, 0, 0, f.expiry + 100));
  assert.equal((await f.market.poolState(1)).liquidity, 0n);
  const before = await f.asset.balanceOf(buyer.address);
  await sent((f.yt.connect(buyer) as Contract).redeemPT(10n * unit, buyer.address, true));
  assert.equal(await f.asset.balanceOf(buyer.address) - before, 10n * unit);
  assert.equal(await f.pt.balanceOf(buyer.address), 0n);
});

test("liquidity calculations respect both budgets and reject invalid ranges", async () => {
  const f = await setup();
  const budget = 10n * unit;
  const liquidity = await f.seeder.liquidityForAmounts(1, -600, 600, budget, budget);
  const quote = await f.seeder.addLiquidity.staticCall(1, -600, 600, liquidity, budget, budget, f.deadline);
  assert(quote[0] <= 0n && quote[0] >= -budget && quote[1] <= 0n && quote[1] >= -budget);
  await sent(f.seeder.addLiquidity(1, -600, 600, liquidity, budget, budget, f.deadline));
  assert.equal((await f.market.poolState(1)).liquidity, lp + liquidity);
  await rejects(() => f.seeder.liquidityForAmounts(1, 600, -600, budget, budget), f.seeder, "InvalidAmount");
  await rejects(() => f.seeder.liquidityForAmounts(1, -601, 600, budget, budget), f.seeder, "InvalidAmount");
});

test("the deployment seed helper creates inventory, attaches/initializes a pool and does not seed twice", async () => {
  const f = await setup({ seed: false });
  await sent(f.asset.mint(owner.address, 100n * unit));
  const item = { seriesId: 1, expiry: f.expiry, yieldToken: f.yt.target as string, principalToken: f.pt.target as string };
  const pool = await seedSeries({ ...f, signer: owner, item, priceUsdc: 990_000n,
    maxUsdc: 10n * unit, maxPt: 10n * unit, deadline: f.deadline });
  assert.equal(pool.seeded, true);
  assert.equal((await f.registry.getSeries(1)).hasPool, true);
  assert.equal((await f.market.poolState(1)).liquidity, BigInt(pool.liquidity!));
  assert.equal(await f.yt.balanceOf(owner.address), 10n * unit);
  assert.equal(await f.asset.allowance(owner.address, f.seeder.target), 0n);
  assert.equal(await f.pt.allowance(owner.address, f.seeder.target), 0n);
  assert.equal(await f.market.quoteBuyPT.staticCall(1, unit) > 0n, true);
  const state = (await f.market.poolState(1)).toArray();
  await seedSeries({ ...f, signer: owner, item, priceUsdc: 990_000n,
    maxUsdc: 10n * unit, maxPt: 10n * unit, deadline: f.deadline });
  assert.deepEqual((await f.market.poolState(1)).toArray(), state);
  assert.throws(() => initialSqrtPrice(f.asset.target as string, f.pt.target as string, 0n));
  assert.throws(() => initialSqrtPrice(f.asset.target as string, f.pt.target as string, 1_000_001n));
  assert.equal(initialSqrtPrice(f.asset.target as string, f.pt.target as string, 1_000_000n), 1n << 96n);
  await assert.rejects(() => seedSeries({ ...f, signer: owner, item: { ...item, pool: { liquidityTransactionHash: "0x123" } },
    priceUsdc: 990_000n, maxUsdc: unit, maxPt: unit, deadline: f.deadline }), /already broadcast/);
});

test("market and seeder constructors reject nonexistent dependencies", async () => {
  const f = await setup({ seed: false });
  for (const name of ["UniswapV4Market", "PoolSeeder"]) {
    const factory = new ContractFactory(artifacts[name]!.abi, artifacts[name]!.bytecode!, owner);
    await rejects(() => factory.deploy(ZeroAddress, f.registry.target), factory as unknown as Contract, "InvalidConfiguration");
    await rejects(() => factory.deploy(f.manager.target, other.address), factory as unknown as Contract, "InvalidConfiguration");
  }
});

test("multiple real v4 unlocks compose in one transaction without leaving transient debt", async () => {
  const f = await setup();
  const batch = await deploy("V4BatchHarness");
  await sent(f.asset.mint(batch.target, 10n * unit));
  await sent(batch.buyTwice(f.market.target, 1, unit, 2n * unit, 2n * unit, buyer.address, f.deadline));
  assert.equal(await f.pt.balanceOf(buyer.address), 2n * unit);
  assert.equal(await f.asset.allowance(batch.target, f.market.target), 0n);
  const quote = await f.market.quoteBuyPT.staticCall(1, unit);
  await sent((f.market.connect(buyer) as Contract).buyPT(1, unit, quote, buyer.address, f.deadline));
  assert.equal(await f.pt.balanceOf(buyer.address), 3n * unit);
});

test("a failed second swap rolls back the entire batch including the first swap", async () => {
  const f = await setup();
  const batch = await deploy("V4BatchHarness");
  await sent(f.asset.mint(batch.target, 10n * unit));
  const quote = await f.market.quoteBuyPT.staticCall(1, unit);
  const state = (await f.market.poolState(1)).toArray();
  await rejects(() => batch.buyTwice(f.market.target, 1, unit, quote, quote, buyer.address, f.deadline), f.market, "SlippageExceeded");
  assert.deepEqual((await f.market.poolState(1)).toArray(), state);
  assert.equal(await f.asset.balanceOf(batch.target), 10n * unit);
  assert.equal(await f.pt.balanceOf(buyer.address), 0n);
});

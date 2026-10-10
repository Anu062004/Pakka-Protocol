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
const day = 86400;
const sent = async (tx: Promise<{ wait: () => Promise<any> }>) => (await tx).wait();
let artifacts: Record<string, ContractArtifact>, owner: JsonRpcSigner, agent: JsonRpcSigner, payee: JsonRpcSigner, stranger: JsonRpcSigner, replacement: JsonRpcSigner;

before(async () => {
  artifacts = compile();
  [owner, agent, payee, stranger, replacement] = await Promise.all([0, 1, 2, 3, 4].map((i) => provider.getSigner(i)));
});

async function deploy(name: string, args: unknown[] = []): Promise<Contract> {
  const a = artifacts[name]!;
  const c = await new ContractFactory(a.abi, a.bytecode!, owner).deploy(...args);
  await c.waitForDeployment();
  return c as unknown as Contract;
}

async function rejects(call: () => Promise<unknown>, contract: Contract, name: string) {
  await assert.rejects(call, (error: unknown) => {
    assert.equal(contract.interface.parseError((error as { data: string }).data)?.name, name);
    return true;
  });
}

async function advance(timestamp: number) {
  await hre.network.provider.send("evm_setNextBlockTimestamp", [timestamp]);
  await hre.network.provider.send("evm_mine");
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
  const router = await deploy("PakkaRouter", [market.target]);
  const seeder = await deploy("PoolSeeder", [manager.target, registry.target]);
  const factory = await deploy("TijoriFactory", [router.target]);
  await sent(factory.create(agent.address, 50n * unit));
  const tijori = new Contract(await factory.tijoriOf(owner.address), artifacts.Tijori!.abi, owner);
  const deadline = (await provider.getBlock("latest"))!.timestamp + 90_000;
  await sent(asset.mint(owner.address, 20_000n * unit));
  await sent(asset.approve(seeder.target, MaxUint256));
  await sent(asset.approve(tijori.target, 150n * unit));
  await sent(tijori.deposit(150n * unit));
  const series: SeriesFixture[] = [];
  for (let i = 0; i < count; i++) {
    const expiry = deadline + 1000 + i * day;
    const yt = await deploy("YieldToken", [vault.target, expiry, `TIJORI-${i}`, registry.target]);
    const pt = new Contract(await yt.principalToken(), artifacts.PrincipalToken!.abi, owner);
    await sent(registry.registerSeries(yt.target));
    const id = i + 1;
    if (seed) {
      const assetIs0 = BigInt(asset.target as string) < BigInt(pt.target as string);
      await sent(registry.setPoolKey(id, { currency0: assetIs0 ? asset.target : pt.target,
        currency1: assetIs0 ? pt.target : asset.target, fee: 500, tickSpacing: 10, hooks: ZeroAddress }));
      await sent(seeder.initializePool(id, initialSqrtPrice(asset.target as string, pt.target as string, 990_000n)));
      await sent(asset.approve(yt.target, 1000n * unit));
      await sent(yt.splitFromAssets(400n * unit, owner.address));
      await sent(pt.approve(seeder.target, MaxUint256));
      await sent(seeder.addLiquidity(id, -600, 600, 10_000n * unit, 1000n * unit, 1000n * unit, deadline));
    }
    series.push({ id, expiry, yt, pt });
  }
  return { asset, vault, registry, manager, market, router, seeder, factory, tijori, deadline, series, ...series[0]! };
}

async function clean(f: Awaited<ReturnType<typeof setup>>) {
  assert.equal(await f.asset.allowance(f.tijori.target, f.router.target), 0n);
  assert.equal(await f.asset.balanceOf(f.router.target), 0n);
  for (const { pt, yt } of f.series) {
    assert.equal(await pt.allowance(f.tijori.target, f.router.target), 0n);
    assert.equal(await pt.balanceOf(f.router.target), 0n);
    assert.equal(await yt.balanceOf(f.router.target), 0n);
  }
}

test("factory creates initialized 45-byte clones with independent owners, keys, caps and balances", async () => {
  const f = await setup({ seed: false });
  const implementation = await f.factory.implementation();
  assert.equal((await provider.getCode(f.tijori.target)).length, 2 + 45 * 2);
  assert.equal((await provider.getCode(f.tijori.target)).slice(22, 62).toLowerCase(), implementation.slice(2).toLowerCase());
  assert.equal(await f.tijori.owner(), owner.address);
  assert.equal(await f.tijori.agent(), agent.address);
  assert.equal(await f.tijori.factory(), f.factory.target);
  assert.equal(await f.tijori.router(), f.router.target);
  assert.equal(await f.tijori.registry(), f.registry.target);
  assert.equal(await f.tijori.assetToken(), f.asset.target);
  assert.equal(await f.tijori.initialized(), true);
  await rejects(() => f.factory.create(ZeroAddress, 0), f.factory, "AlreadyExists");
  const receipt = await sent((f.factory.connect(stranger) as Contract).create(ZeroAddress, 0));
  const other = new Contract(await f.factory.tijoriOf(stranger.address), artifacts.Tijori!.abi, stranger);
  assert.notEqual(other.target, f.tijori.target);
  assert.equal(await other.owner(), stranger.address);
  assert.equal(await other.agent(), ZeroAddress);
  assert.equal(await other.dailyCap(), 0n);
  assert.equal(await f.asset.balanceOf(other.target), 0n);
  await rejects(() => (other.connect(agent) as Contract).pay(payee.address, unit), other, "Unauthorized");
  const event = (receipt.logs as any[]).map((l: any) => { try { return f.factory.interface.parseLog(l); } catch { return null; } })
    .find((e: any) => e?.name === "TijoriCreated");
  assert.equal(event!.args.owner, stranger.address);
  assert.equal(event!.args.tijori, other.target);
});

test("implementation and initialized clones cannot be initialized or taken over", async () => {
  const f = await setup({ seed: false });
  const implementation = new Contract(await f.factory.implementation(), artifacts.Tijori!.abi, stranger);
  await rejects(() => implementation.initialize(stranger.address, stranger.address, MaxUint256), implementation, "AlreadyInitialized");
  await rejects(() => (f.tijori.connect(stranger) as Contract).initialize(stranger.address, stranger.address, MaxUint256), f.tijori, "AlreadyInitialized");
  await rejects(() => implementation.withdraw(f.asset.target, unit), implementation, "Unauthorized");
  assert.equal(await f.tijori.owner(), owner.address);
});

test("agent and strangers cannot change policy, withdraw assets, or approve downstream spenders", async () => {
  const f = await setup({ seed: false });
  for (const signer of [agent, stranger]) {
    const t = f.tijori.connect(signer) as Contract;
    for (const call of [() => t.setAgent(stranger.address), () => t.setPaused(false),
      () => t.setDailyCap(MaxUint256), () => t.setPayeeCap(stranger.address, MaxUint256),
      () => t.withdraw(f.asset.target, unit), () => t.deposit(unit)]) {
      await rejects(call, f.tijori, "Unauthorized");
    }
  }
  for (const method of ["approve", "execute", "setRouter", "sellEarly", "buyYield"]) {
    assert.equal(f.tijori.interface.hasFunction(method), false);
  }
  for (const method of ["lock", "buildLadder", "cashOut", "claimInterest"]) {
    assert.equal(f.tijori.interface.getFunction(method)!.inputs.some((i) => i.type === "address"), false);
  }
  assert.equal(await f.asset.balanceOf(f.tijori.target), 150n * unit);
});

test("pause and key replacement cover every agent entrypoint; owner retains control", async () => {
  const f = await setup({ seed: false });
  const calls = (signer: JsonRpcSigner) => {
    const t = f.tijori.connect(signer) as Contract;
    return [() => t.lock(1, unit, unit, f.deadline),
      () => t.buildLadder([{ seriesId: 1, ptAmount: unit, maxUsdc: unit }], unit, f.deadline),
      () => t.cashOut(1, unit, true, 0, f.deadline), () => t.claimInterest(1, true, 0),
      () => t.pay(payee.address, unit)];
  };
  for (const call of calls(stranger)) await rejects(call, f.tijori, "Unauthorized");
  await sent(f.tijori.setPaused(true));
  for (const call of calls(agent)) await rejects(call, f.tijori, "AgentPaused");
  await sent(f.tijori.setAgent(replacement.address));
  await sent(f.tijori.setPaused(false));
  for (const call of calls(agent)) await rejects(call, f.tijori, "Unauthorized");
  await sent(f.tijori.setPayeeCap(payee.address, 10n * unit));
  await sent((f.tijori.connect(replacement) as Contract).pay(payee.address, unit));
  await sent(f.tijori.setAgent(ZeroAddress));
  for (const call of calls(replacement)) await rejects(call, f.tijori, "Unauthorized");
  await sent(f.tijori.setPaused(true));
  await sent(f.tijori.withdraw(f.asset.target, unit));
  await sent(f.tijori.pay(payee.address, unit));
});

test("approved payments obey per-payee and aggregate daily caps with exact accounting", async () => {
  const f = await setup({ seed: false });
  await sent(f.tijori.setDailyCap(5n * unit));
  await sent(f.tijori.setPayeeCap(payee.address, 4n * unit));
  await sent(f.tijori.setPayeeCap(stranger.address, 4n * unit));
  await rejects(() => (f.tijori.connect(agent) as Contract).pay(replacement.address, 1), f.tijori, "PaymentCapExceeded");
  await rejects(() => (f.tijori.connect(agent) as Contract).pay(payee.address, 4n * unit + 1n), f.tijori, "PaymentCapExceeded");
  const receipt = await sent((f.tijori.connect(agent) as Contract).pay(payee.address, 4n * unit));
  await rejects(() => (f.tijori.connect(agent) as Contract).pay(payee.address, 1), f.tijori, "PaymentCapExceeded");
  assert.equal(await f.tijori.paymentRemaining(stranger.address), unit);
  await rejects(() => (f.tijori.connect(agent) as Contract).pay(stranger.address, unit + 1n), f.tijori, "PaymentCapExceeded");
  await sent((f.tijori.connect(agent) as Contract).pay(stranger.address, unit));
  assert.equal(await f.tijori.dailySpent(), 5n * unit);
  assert.equal((await f.tijori.payeeLimits(payee.address)).spent, 4n * unit);
  assert.equal(await f.asset.balanceOf(payee.address), 4n * unit);
  assert.equal(await f.asset.balanceOf(f.tijori.target), 145n * unit);
  const event = (receipt.logs as any[]).map((l: any) => { try { return f.tijori.interface.parseLog(l); } catch { return null; } })
    .find((e: any) => e?.name === "Paid");
  assert.equal(event!.args.caller, agent.address);
  assert.equal(event!.args.payee, payee.address);
});

test("the daily cap rolls over 24 hours, midnight does not reset it, and the 30-day payee spend is preserved", async () => {
  const f = await setup({ seed: false });
  await sent(f.tijori.setDailyCap(unit));
  await sent(f.tijori.setPayeeCap(payee.address, 2n * unit));
  // Choose a day well inside a payee period so this tests only the daily window.
  const now = (await provider.getBlock("latest"))!.timestamp;
  const period = Math.floor(now / (30 * day)) + 1;
  await advance(period * 30 * day + 3 * day + 100);
  await sent((f.tijori.connect(agent) as Contract).pay(payee.address, unit));
  assert.equal(await f.tijori.paymentRemaining(payee.address), 0n);
  // UTC midnight is 100 seconds short of 24 hours later: a calendar-day cap would pay again here.
  await advance(period * 30 * day + 4 * day);
  assert.equal(await f.tijori.paymentRemaining(payee.address), 0n);
  await rejects(() => (f.tijori.connect(agent) as Contract).pay(payee.address, 1), f.tijori, "PaymentCapExceeded");
  await advance(period * 30 * day + 4 * day + 3600);
  assert.equal(await f.tijori.dailySpent(), 0n);
  assert.equal(await f.tijori.paymentRemaining(payee.address), unit);
  await sent((f.tijori.connect(agent) as Contract).pay(payee.address, unit));
  await advance(period * 30 * day + 5 * day);
  assert.equal(await f.tijori.paymentRemaining(payee.address), 0n);
  await rejects(() => (f.tijori.connect(agent) as Contract).pay(payee.address, 1), f.tijori, "PaymentCapExceeded");
  await advance(period * 30 * day + 33 * day + 101);
  assert.equal(await f.tijori.paymentRemaining(payee.address), unit);
  await sent((f.tijori.connect(agent) as Contract).pay(payee.address, unit));
  assert.equal((await f.tijori.payeeLimits(payee.address)).spent, 2n * unit);
});

test("policy edits, revocation and reapproval do not reset already-used allowances", async () => {
  const f = await setup({ seed: false });
  await sent(f.tijori.setDailyCap(10n * unit));
  await sent(f.tijori.setPayeeCap(payee.address, 10n * unit));
  await sent((f.tijori.connect(agent) as Contract).pay(payee.address, 4n * unit));
  await sent(f.tijori.setDailyCap(2n * unit));
  assert.equal(await f.tijori.paymentRemaining(payee.address), 0n);
  await sent(f.tijori.setDailyCap(10n * unit));
  await sent(f.tijori.setPayeeCap(payee.address, 0));
  assert.equal(await f.tijori.paymentRemaining(payee.address), 0n);
  await sent(f.tijori.setPayeeCap(payee.address, 2n * unit));
  assert.equal(await f.tijori.paymentRemaining(payee.address), 0n);
  await sent(f.tijori.setPayeeCap(payee.address, 10n * unit));
  await sent(f.tijori.setAgent(replacement.address));
  assert.equal(await f.tijori.paymentRemaining(payee.address), 6n * unit);
  await sent((f.tijori.connect(replacement) as Contract).pay(payee.address, 6n * unit));
  await rejects(() => (f.tijori.connect(replacement) as Contract).pay(payee.address, 1), f.tijori, "PaymentCapExceeded");
});

test("failed USDC transfers roll back both cap counters and zero payments/payees are rejected", async () => {
  const f = await setup({ seed: false });
  await sent(f.tijori.setPayeeCap(payee.address, 10n * unit));
  await sent(f.tijori.withdraw(f.asset.target, 150n * unit));
  await assert.rejects(() => (f.tijori.connect(agent) as Contract).pay(payee.address, unit));
  assert.equal(await f.tijori.dailySpent(), 0n);
  assert.equal((await f.tijori.payeeLimits(payee.address)).spent, 0n);
  assert.equal(await f.tijori.paymentRemaining(payee.address), 10n * unit);
  for (const address of [ZeroAddress, f.tijori.target]) {
    await rejects(() => f.tijori.setPayeeCap(address, unit), f.tijori, "InvalidPayee");
  }
  for (const call of [() => f.tijori.pay(payee.address, 0), () => f.tijori.deposit(0),
    () => f.tijori.withdraw(f.asset.target, 0)]) await rejects(call, f.tijori, "InvalidAmount");
});

test("agent lock keeps exact PT and all budget refunds in Tijori, with no standing approval", async () => {
  const f = await setup();
  const quote = await f.market.quoteBuyPT.staticCall(1, 10n * unit);
  assert(quote < 10n * unit);
  await sent((f.tijori.connect(agent) as Contract).lock(1, 10n * unit, 10n * unit, f.deadline));
  assert.equal(await f.pt.balanceOf(f.tijori.target), 10n * unit);
  assert.equal(await f.asset.balanceOf(f.tijori.target), 150n * unit - quote);
  for (const token of [f.asset, f.pt]) assert.equal(await token.balanceOf(agent.address), 0n);
  await clean(f);
});

test("agent ladder buys three owned maturities atomically and preserves the unspent budget", async () => {
  const f = await setup({ count: 3 });
  const amount = 10n * unit;
  const quotes = await Promise.all(f.series.map(({ id }) => f.market.quoteBuyPT.staticCall(id, amount)));
  const total = quotes.reduce((a, b) => a + b, 0n);
  const legs = f.series.map(({ id }) => ({ seriesId: id, ptAmount: amount, maxUsdc: amount }));
  await sent((f.tijori.connect(agent) as Contract).buildLadder(legs, 30n * unit, f.deadline));
  assert.equal(await f.asset.balanceOf(f.tijori.target), 150n * unit - total);
  for (const { pt } of f.series) assert.equal(await pt.balanceOf(f.tijori.target), amount);
  await clean(f);
});

test("agent cannot overpay face value; later-leg slippage leaves all treasury and pool state intact", async () => {
  const f = await setup({ count: 2 });
  await rejects(() => (f.tijori.connect(agent) as Contract).lock(1, unit, unit + 1n, f.deadline), f.tijori, "PurchaseCapExceeded");
  await rejects(() => (f.tijori.connect(agent) as Contract).buildLadder([{ seriesId: 1, ptAmount: unit, maxUsdc: unit + 1n }], 2n * unit, f.deadline), f.tijori, "PurchaseCapExceeded");
  const states = await Promise.all(f.series.map(async ({ id }) => (await f.market.poolState(id)).toArray()));
  const quotes = await Promise.all(f.series.map(({ id }) => f.market.quoteBuyPT.staticCall(id, unit)));
  const legs = f.series.map(({ id }, i) => ({ seriesId: id, ptAmount: unit, maxUsdc: quotes[i] - BigInt(i) }));
  await rejects(() => (f.tijori.connect(agent) as Contract).buildLadder(legs, 2n * unit, f.deadline), f.market, "SlippageExceeded");
  assert.deepEqual(await Promise.all(f.series.map(async ({ id }) => (await f.market.poolState(id)).toArray())), states);
  assert.equal(await f.asset.balanceOf(f.tijori.target), 150n * unit);
  for (const { pt } of f.series) assert.equal(await pt.balanceOf(f.tijori.target), 0n);
  await clean(f);
});

test("unregistered series, expired deadlines and invalid ladders cannot spend treasury funds", async () => {
  const f = await setup();
  await assert.rejects(() => (f.tijori.connect(agent) as Contract).lock(999, unit, unit, f.deadline));
  await assert.rejects(() => (f.tijori.connect(agent) as Contract).cashOut(999, unit, true, 0, f.deadline));
  await assert.rejects(() => (f.tijori.connect(agent) as Contract).claimInterest(999, true, 0));
  await rejects(() => (f.tijori.connect(agent) as Contract).lock(1, unit, unit, 0), f.router, "DeadlineExpired");
  await rejects(() => (f.tijori.connect(agent) as Contract).buildLadder([], unit, f.deadline), f.router, "InvalidLadder");
  await rejects(() => (f.tijori.connect(agent) as Contract).lock(1, 0, unit, f.deadline), f.tijori, "InvalidAmount");
  await advance(f.expiry);
  await rejects(() => (f.tijori.connect(agent) as Contract).lock(1, unit, unit, f.expiry + 100), f.router, "SeriesExpired");
  assert.equal(await f.asset.balanceOf(f.tijori.target), 150n * unit);
  await clean(f);
});

test("agent redeems a matured ticket into Tijori then pays an approved bill", async () => {
  const f = await setup();
  const amount = 10n * unit;
  await sent((f.tijori.connect(agent) as Contract).lock(1, amount, amount, f.deadline));
  const before = await f.asset.balanceOf(f.tijori.target);
  await rejects(() => (f.tijori.connect(agent) as Contract).cashOut(1, amount, true, amount, f.deadline), f.router, "SeriesNotExpired");
  await advance(f.expiry);
  await sent((f.tijori.connect(agent) as Contract).cashOut(1, amount, true, amount, f.expiry + 100));
  assert.equal(await f.asset.balanceOf(f.tijori.target), before + amount);
  assert.equal(await f.pt.balanceOf(f.tijori.target), 0n);
  assert.equal(await f.asset.balanceOf(agent.address), 0n);
  await sent(f.tijori.setPayeeCap(payee.address, amount));
  await sent((f.tijori.connect(agent) as Contract).pay(payee.address, amount));
  assert.equal(await f.asset.balanceOf(payee.address), amount);
  await clean(f);
});

test("illiquid cash-out preserves PT, while vault-share redemption stays in Tijori for owner recovery", async () => {
  const f = await setup();
  await sent((f.tijori.connect(agent) as Contract).lock(1, unit, unit, f.deadline));
  await sent(f.vault.setIlliquid(true));
  await advance(f.expiry);
  await rejects(() => (f.tijori.connect(agent) as Contract).cashOut(1, unit, true, 0, f.expiry + 100), f.router, "VaultIlliquid");
  assert.equal(await f.pt.balanceOf(f.tijori.target), unit);
  assert.equal(await f.pt.allowance(f.tijori.target, f.router.target), 0n);
  const shares = await (f.tijori.connect(agent) as Contract).cashOut.staticCall(1, unit, false, 0, f.expiry + 100);
  await sent((f.tijori.connect(agent) as Contract).cashOut(1, unit, false, shares, f.expiry + 100));
  assert.equal(await f.vault.balanceOf(f.tijori.target), shares);
  await sent(f.tijori.setPaused(true));
  await sent(f.tijori.withdrawVaultShares(1, shares));
  assert.equal(await f.vault.balanceOf(owner.address), shares);
  await clean(f);
});

test("YT claims retain proceeds and enforce minimum output with rollback, including share claims", async () => {
  const f = await setup();
  await sent(f.yt.transfer(f.tijori.target, 10n * unit));
  await sent(f.vault.addYield(unit));
  const accrued = await f.yt.accruedInterest(f.tijori.target);
  assert(accrued > 0n);
  const output = await (f.tijori.connect(agent) as Contract).claimInterest.staticCall(1, true, 0);
  await rejects(() => (f.tijori.connect(agent) as Contract).claimInterest(1, true, output + 1n), f.tijori, "SlippageExceeded");
  assert.equal(await f.yt.accruedInterest(f.tijori.target), accrued);
  assert.equal(await f.asset.balanceOf(f.tijori.target), 150n * unit);
  await sent((f.tijori.connect(agent) as Contract).claimInterest(1, true, output));
  assert.equal(await f.asset.balanceOf(f.tijori.target), 150n * unit + output);
  assert.equal(await f.asset.balanceOf(agent.address), 0n);
  await sent(f.vault.addYield(unit));
  await sent(f.vault.setIlliquid(true));
  const shares = await (f.tijori.connect(agent) as Contract).claimInterest.staticCall(1, false, 0);
  await sent((f.tijori.connect(agent) as Contract).claimInterest(1, false, shares));
  assert.equal(await f.vault.balanceOf(f.tijori.target), shares);
});

test("owner can recover USDC, PT and YT while agent is paused without spending payment allowance", async () => {
  const f = await setup();
  await sent(f.pt.transfer(f.tijori.target, unit));
  await sent(f.yt.transfer(f.tijori.target, unit));
  await sent(f.tijori.setPaused(true));
  for (const token of [f.asset, f.pt, f.yt]) {
    const amount = await token.balanceOf(f.tijori.target);
    const before = await token.balanceOf(owner.address);
    await sent(f.tijori.withdraw(token.target, amount));
    assert.equal(await token.balanceOf(f.tijori.target), 0n);
    assert.equal(await token.balanceOf(owner.address), before + amount);
  }
  assert.equal(await f.tijori.dailySpent(), 0n);
});

test("clone reentrancy guard protects first deposit and rejects short-credit funding", async () => {
  const f = await setup({ seed: false, assetName: "AdversarialUSDC" });
  // Use a fresh clone: its ReentrancyGuard constructor storage starts at zero.
  await sent((f.factory.connect(stranger) as Contract).create(agent.address, unit));
  const t = new Contract(await f.factory.tijoriOf(stranger.address), artifacts.Tijori.abi, stranger);
  await sent(f.asset.mint(stranger.address, 10n * unit));
  await sent((f.asset.connect(stranger) as Contract).approve(t.target, 10n * unit));
  await sent(f.asset.configure(t.target, t.interface.encodeFunctionData("pay", [payee.address, unit]), false));
  await sent(t.deposit(unit));
  assert.equal(await f.asset.reentryBlocked(), true);
  await sent(f.asset.configure(t.target, "0x", true));
  await rejects(() => t.deposit(unit), t, "UnexpectedTransferAmount");
  assert.equal(await f.asset.balanceOf(t.target), unit);
  assert.equal(await f.asset.balanceOf(stranger.address), 9n * unit);
});

test("factory rejects absent router code and operations cannot receive native currency", async () => {
  const f = await setup({ seed: false });
  const factory = new ContractFactory(artifacts.TijoriFactory!.abi, artifacts.TijoriFactory!.bytecode!, owner);
  await rejects(() => factory.deploy(ZeroAddress), f.tijori, "InvalidConfiguration");
  await rejects(() => factory.deploy(stranger.address), f.tijori, "InvalidConfiguration");
  await assert.rejects(() => owner.sendTransaction({ to: f.tijori.target, value: 1n }));
  await assert.rejects(() => f.factory.create(agent.address, unit, { value: 1n }));
});

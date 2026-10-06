import assert from "node:assert/strict";
import { before, test } from "node:test";
import { execFileSync } from "node:child_process";
import hre from "hardhat";
import { BrowserProvider, Contract, ContractFactory, MaxUint256, ZeroAddress } from "ethers";
import type { JsonRpcSigner } from "ethers";
import { compile } from "../scripts/compile.ts";
import type { ContractArtifact } from "../backend/types.ts";

const provider = new BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
let artifacts: Record<string, ContractArtifact>, users: JsonRpcSigner[];
const usd = (n: number | bigint) => BigInt(n) * 1_000_000n;
const sent = async (tx: Promise<{ wait: () => Promise<any> }>) => (await tx).wait();
const address = (user: JsonRpcSigner) => user.address;

before(async () => {
  artifacts = compile();
  users = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
});

async function deploy(name: string, args: unknown[] = []): Promise<Contract> {
  const a = artifacts[name]!;
  const contract = await new ContractFactory(a.abi, a.bytecode!, users[0]).deploy(...args);
  await contract.waitForDeployment();
  return contract as unknown as Contract;
}

async function setup(offset = 12, harness = false) {
  const usdc = await deploy("MockUSDC");
  const vault = await deploy("MockVault", [usdc.target, offset]);
  const block = await provider.getBlock("latest");
  const expiry = block!.timestamp + 100_000;
  const yt = await deploy(harness ? "YieldTokenHarness" : "YieldToken", harness
    ? [vault.target, expiry] : [vault.target, expiry, "TEST", ZeroAddress]);
  const pt = new Contract(await yt.principalToken(), artifacts.PrincipalToken!.abi, users[0]);
  for (const user of users) {
    await sent(usdc.mint(address(user), usd(100_000)));
    await sent((usdc.connect(user) as Contract).approve(yt.target, MaxUint256));
    await sent((usdc.connect(user) as Contract).approve(vault.target, MaxUint256));
    await sent((vault.connect(user) as Contract).approve(yt.target, MaxUint256));
  }
  return { usdc, vault, yt, pt, expiry };
}

async function mature(f: Awaited<ReturnType<typeof setup>>) {
  await hre.network.provider.send("evm_setNextBlockTimestamp", [f.expiry]);
  await sent(f.yt.settleExpiry());
}

function close(actual: bigint, expected: bigint, tolerance = 2n) {
  assert.ok(actual >= expected - tolerance && actual <= expected + tolerance,
    `expected ${expected} ± ${tolerance}, got ${actual}`);
}

async function solvent(f: Awaited<ReturnType<typeof setup>>) {
  const backing = await f.yt.sharesForPT(await f.pt.totalSupply());
  const claims: bigint[] = await Promise.all(users.map((u) => f.yt.accruedInterest(address(u))));
  assert.ok(await f.vault.balanceOf(f.yt.target) >= backing + claims.reduce((a, b) => a + b, 0n));
}

test("1,000 USDC mints equal PT/YT with asset decimals and 18-decimal shares", async () => {
  const f = await setup();
  await sent(f.yt.splitFromAssets(usd(1000), address(users[0])));
  assert.equal(await f.pt.balanceOf(address(users[0])), usd(1000));
  assert.equal(await f.yt.balanceOf(address(users[0])), usd(1000));
  assert.equal(await f.pt.decimals(), 6n);
  assert.equal(await f.yt.decimals(), 6n);
  assert.equal(await f.vault.decimals(), 18n);
  assert.equal(await f.yt.INDEX_UNIT(), 10n ** 36n);
  assert.equal(await f.usdc.allowance(f.yt.target, f.vault.target), 0n);
  await solvent(f);
});

test("5% growth pays YT interest only to its holder, even when a third party claims", async () => {
  const f = await setup();
  await sent(f.yt.splitFromAssets(usd(1000), address(users[0])));
  await sent(f.vault.addYield(usd(50)));
  const before: bigint = await f.usdc.balanceOf(address(users[0]));
  const stranger = await f.usdc.balanceOf(address(users[2]));
  await sent((f.yt.connect(users[2]) as Contract).claimInterest(address(users[0]), true));
  close(await f.usdc.balanceOf(address(users[0])) - before, usd(50));
  assert.equal(await f.usdc.balanceOf(address(users[2])), stranger);
  // ERC-4626 redemption rounds the asset payout down, slightly raising its index.
  assert.ok(await f.vault.convertToAssets(await f.yt.accruedInterest(address(users[0]))) <= 1n);
  await solvent(f);
});

test("transferFrom settles seller and existing buyer; late buyer cannot take past yield", async () => {
  const f = await setup();
  await sent(f.yt.splitFromAssets(usd(1000), address(users[0])));
  await sent(f.vault.addYield(usd(50)));
  const earned = await f.yt.accruedInterest(address(users[0]));
  await sent(f.yt.approve(address(users[2]), usd(1000)));
  await sent((f.yt.connect(users[2]) as Contract).transferFrom(address(users[0]), address(users[1]), usd(1000)));
  assert.equal(await f.yt.accruedInterest(address(users[0])), earned);
  assert.equal(await f.yt.accruedInterest(address(users[1])), 0n);
  await sent(f.vault.addYield(usd(50)));
  assert.equal(await f.yt.accruedInterest(address(users[0])), earned);
  assert.ok(await f.yt.accruedInterest(address(users[1])) > 0n);
  await solvent(f);
});

test("additional mint and self-transfer preserve the receiver's existing interest", async () => {
  const f = await setup();
  await sent(f.yt.splitFromAssets(usd(1000), address(users[0])));
  await sent(f.vault.addYield(usd(50)));
  const earned = await f.yt.accruedInterest(address(users[0]));
  await sent((f.yt.connect(users[1]) as Contract).splitFromAssets(usd(100), address(users[0])));
  // Deposit's rounding can donate at most a few share base units to old holders.
  close(await f.yt.interestShares(address(users[0])), earned, 3n);
  await sent(f.yt.transfer(address(users[0]), usd(10)));
  close(await f.yt.interestShares(address(users[0])), earned, 3n);
  await solvent(f);
});

test("merge burns matching PT/YT and principal plus interest returns full value", async () => {
  const f = await setup();
  await sent(f.yt.splitFromAssets(usd(1000), address(users[0])));
  await sent(f.vault.addYield(usd(50)));
  const before: bigint = await f.usdc.balanceOf(address(users[0]));
  await sent(f.yt.merge(usd(1000), address(users[0]), true));
  assert.equal(await f.pt.totalSupply(), 0n);
  assert.equal(await f.yt.totalSupply(), 0n);
  await sent(f.yt.claimInterest(address(users[0]), true));
  close(await f.usdc.balanceOf(address(users[0])) - before, usd(1050));
});

test("PT redeems independently at expiry; YT freezes and subsequent yield belongs to PT", async () => {
  const f = await setup();
  await sent(f.yt.splitFromAssets(usd(1000), address(users[0])));
  await sent(f.yt.transfer(address(users[1]), usd(1000)));
  await sent(f.vault.addYield(usd(50)));
  await mature(f);
  const expiryIndex = await f.yt.indexAtExpiry();
  const earned = await f.yt.accruedInterest(address(users[1]));
  await sent(f.vault.addYield(usd(105))); // Another 10% after expiry.
  assert.equal(await f.yt.accruedInterest(address(users[1])), earned);
  await sent(f.yt.settleExpiry());
  assert.equal(await f.yt.indexAtExpiry(), expiryIndex);
  const before: bigint = await f.usdc.balanceOf(address(users[0]));
  await sent(f.yt.redeemPT(usd(1000), address(users[0]), true));
  close(await f.usdc.balanceOf(address(users[0])) - before, usd(1100));
  await sent((f.yt.connect(users[3]) as Contract).claimInterest(address(users[1]), false));
  assert.equal(await f.yt.accruedInterest(address(users[1])), 0n);
});

test("PT redeems face value on a healthy vault; YT holder retains the pre-expiry interest", async () => {
  const f = await setup();
  await sent(f.yt.splitFromAssets(usd(1000), address(users[0])));
  await sent(f.yt.transfer(address(users[1]), usd(1000)));
  await sent(f.vault.addYield(usd(50)));
  await mature(f);
  const before: bigint = await f.usdc.balanceOf(address(users[0]));
  await sent(f.yt.redeemPT(usd(1000), address(users[0]), true));
  close(await f.usdc.balanceOf(address(users[0])) - before, usd(1000));
  const yieldBefore: bigint = await f.usdc.balanceOf(address(users[1]));
  await sent(f.yt.claimInterest(address(users[1]), true));
  close(await f.usdc.balanceOf(address(users[1])) - yieldBefore, usd(50));
});

test("10% vault loss creates no new interest, does not revert, and reduces PT assets", async () => {
  const f = await setup();
  await sent(f.yt.splitFromAssets(usd(1000), address(users[0])));
  const high = await f.yt.pyIndexCurrent();
  await sent(f.vault.simulateLoss(usd(100)));
  assert.equal(await f.yt.pyIndexCurrent(), high);
  assert.equal(await f.yt.accruedInterest(address(users[0])), 0n);
  await mature(f);
  const before: bigint = await f.usdc.balanceOf(address(users[0]));
  await sent(f.yt.redeemPT(usd(1000), address(users[0]), true));
  close(await f.usdc.balanceOf(address(users[0])) - before, usd(900));
});

test("YT resumes only above the last observed high-water mark", async () => {
  const f = await setup();
  await sent(f.yt.splitFromAssets(usd(1000), address(users[0])));
  await sent(f.vault.addYield(usd(100)));
  await sent(f.yt.claimInterest(address(users[0]), false));
  const mark = await f.yt.pyIndexStored();
  await sent(f.vault.simulateLoss(usd(100)));
  await sent(f.vault.addYield(usd(99)));
  assert.equal(await f.yt.accruedInterest(address(users[0])), 0n);
  assert.equal(await f.yt.pyIndexCurrent(), mark);
  await sent(f.vault.addYield(usd(2)));
  assert.ok(await f.yt.accruedInterest(address(users[0])) > 0n);
  await solvent(f);
});

test("unavailable vault liquidity rolls back USDC exit; share exit remains available", async () => {
  const f = await setup();
  await sent(f.yt.splitFromAssets(usd(1000), address(users[0])));
  await mature(f);
  await sent(f.vault.setIlliquid(true));
  await assert.rejects(f.yt.redeemPT.staticCall(usd(1000), address(users[0]), true));
  assert.equal(await f.pt.balanceOf(address(users[0])), usd(1000));
  await sent(f.yt.redeemPT(usd(1000), address(users[0]), false));
  assert.equal(await f.pt.balanceOf(address(users[0])), 0n);
  assert.ok(await f.vault.balanceOf(address(users[0])) > 0n);
});

test("invalid amounts, receivers, missing approvals and wrong-time operations revert", async () => {
  const f = await setup();
  await assert.rejects((f.pt.connect(users[1]) as Contract).mint.staticCall(address(users[1]), 1n));
  await assert.rejects((f.pt.connect(users[1]) as Contract).burn.staticCall(address(users[0]), 1n));
  await assert.rejects(f.yt.splitFromAssets.staticCall(0n, address(users[0])));
  await assert.rejects(f.yt.splitFromAssets.staticCall(1n, ZeroAddress));
  await assert.rejects(f.yt.splitFromAssets.staticCall(1n, f.yt.target));
  await assert.rejects(f.yt.redeemPT.staticCall(1n, address(users[0]), false));
  await assert.rejects(f.yt.settleExpiry.staticCall());
  await sent(f.usdc.approve(f.yt.target, 0n));
  await assert.rejects(f.yt.splitFromAssets.staticCall(usd(1), address(users[0])));
  await mature(f);
  await assert.rejects(f.yt.split.staticCall(1n, address(users[0])));
  await assert.rejects(f.yt.merge.staticCall(1n, address(users[0]), false));
});

test("runtime share decimals support both 6 and 18 decimal vaults", async () => {
  const f = await setup(0);
  await sent(f.vault.deposit(usd(1000), address(users[0])));
  const shares = await f.vault.balanceOf(address(users[0]));
  assert.equal(await f.yt.previewSplit(shares), usd(1000));
  await sent(f.yt.split(shares, address(users[0])));
  assert.equal(await f.pt.totalSupply(), usd(1000));
  await sent(f.vault.addYield(usd(50)));
  await solvent(f);
  await mature(f);
  for (const user of users) await sent(f.yt.claimInterest(address(user), false));
  await sent(f.yt.redeemPT(usd(1000), address(users[0]), false));
  assert.ok(await f.vault.balanceOf(f.yt.target) <= 2n);
});

test("mainnet constructors are rejected by the contracts themselves", () => {
  const result = execFileSync(process.execPath, ["test/chain-guard.ts"], { encoding: "utf8" });
  assert.match(result, /Mainnet constructors rejected/);
});

test("lazy expiry freezes on the first post-expiry interaction and stays immutable", async () => {
  const f = await setup();
  await sent(f.yt.splitFromAssets(usd(1000), address(users[0])));
  await hre.network.provider.send("evm_setNextBlockTimestamp", [f.expiry + 60]);
  await sent(f.vault.addYield(usd(50)));
  assert.equal(await f.yt.indexAtExpiry(), 0n);
  await sent(f.yt.transfer(address(users[1]), usd(500)));
  const index = await f.yt.indexAtExpiry();
  assert.ok(index > 0n);
  const sellerEarned = await f.yt.accruedInterest(address(users[0]));
  assert.equal(await f.yt.accruedInterest(address(users[1])), 0n);
  await sent(f.vault.addYield(usd(50)));
  assert.equal(await f.yt.accruedInterest(address(users[0])), sellerEarned);
  await sent(f.yt.settleExpiry());
  assert.equal(await f.yt.indexAtExpiry(), index);
  await solvent(f);
});

test("single-rounding interest equals the exact bigint formula for extreme and random indices", async () => {
  const f = await setup(12, true);
  const unit = await f.yt.INDEX_UNIT();
  const cases = [[1n, unit, unit + 1n], [usd(1000), 10n ** 24n, 105n * 10n ** 22n],
    [10n ** 40n, 10n ** 60n, 2n * 10n ** 60n], [10n ** 50n, 10n ** 40n, 10n ** 60n]];
  for (let i = 1n; i <= 200n; ++i) cases.push([i * 123456789123n, i * 123456789n + 7n, i * 987654321n + 17n]);
  for (const [balance, previous, current] of cases) {
    const exact = balance * unit * (current - previous) / (previous * current);
    assert.equal(await f.yt.interestFor(balance, previous, current), exact);
  }
});

test("2,000 deterministic random operations remain solvent and all holders exit", async () => {
  const f = await setup();
  let seed = 0x5042002;
  const random = (n: number) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
  for (let i = 0; i < 2000; ++i) {
    const user = users[random(users.length)];
    const who = address(user);
    switch (random(7)) {
      case 0: await sent((f.yt.connect(user) as Contract).splitFromAssets(usd(random(20) + 1), who)); break;
      case 1: {
        const balance = await f.yt.balanceOf(who);
        await sent((f.yt.connect(user) as Contract).transfer(address(users[random(users.length)]), balance / BigInt(random(4) + 1)));
        break;
      }
      case 2: await sent(f.vault.addYield(usd(random(5)))); break;
      case 3: {
        const assets = await f.vault.totalAssets();
        if (assets > usd(10)) await sent(f.vault.simulateLoss(usd(random(5))));
        break;
      }
      case 4: await sent(f.yt.claimInterest(who, random(2) === 0)); break;
      case 5: {
        const amount = (await f.pt.balanceOf(who)) < (await f.yt.balanceOf(who))
          ? await f.pt.balanceOf(who) : await f.yt.balanceOf(who);
        if (amount > 0n) await sent((f.yt.connect(user) as Contract).merge(amount, who, random(2) === 0));
        break;
      }
      case 6: {
        const shares = await f.vault.balanceOf(who);
        if (shares > 0n && await f.yt.previewSplit(shares) > 0n) await sent((f.yt.connect(user) as Contract).split(shares, who));
        break;
      }
    }
    await solvent(f);
  }
  await mature(f);
  for (const user of users) {
    await sent(f.yt.claimInterest(address(user), false));
    const amount = await f.pt.balanceOf(address(user));
    if (amount > 0n) await sent((f.yt.connect(user) as Contract).redeemPT(amount, address(user), false));
  }
  assert.equal(await f.pt.totalSupply(), 0n);
  assert.equal(await f.yt.totalAccruedInterest(), 0n);
  assert.ok(await f.vault.balanceOf(f.yt.target) < 10n ** 18n, "only rounding dust should remain");
});

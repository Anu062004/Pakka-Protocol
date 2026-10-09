import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";
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
interface Fixture {
  asset: Contract; vault: Contract; registry: Contract; manager: Contract; market: Contract;
  router: Contract; seeder: Contract; factory: Contract; tijori: Contract; expiry: number; yt: Contract; pt: Contract;
}
let artifacts: Record<string, ContractArtifact>, owner: JsonRpcSigner, agent: JsonRpcSigner, payee: JsonRpcSigner, other: JsonRpcSigner, f: Fixture, snapshot: string;
const rejection = (promise: Promise<unknown>, contract: Contract, code: string) => assert.rejects(promise, (e) => {
  assert.equal(contract.interface.parseError((e as { data: string }).data)?.name, code); return true;
});
async function deploy(name: string, args: unknown[] = []): Promise<Contract> {
  const a = artifacts[name]!;
  const c = await new ContractFactory(a.abi, a.bytecode!, owner).deploy(...args);
  await c.waitForDeployment(); return c as unknown as Contract;
}
const advance = async (timestamp: number) => {
  await hre.network.provider.send("evm_setNextBlockTimestamp", [timestamp]);
  await hre.network.provider.send("evm_mine");
};
before(async () => {
  artifacts = compile();
  [owner, agent, payee, other] = await Promise.all([0,1,2,3].map(i=>provider.getSigner(i)));
  const asset = await deploy("MockUSDC");
  const vault = await deploy("MockVault", [asset.target,12]);
  const registry = await deploy("SeriesRegistry", [asset.target,owner.address]);
  const manager = await deploy("TestnetPoolManager", [owner.address]);
  const market = await deploy("UniswapV4Market", [manager.target,registry.target]);
  const router = await deploy("PakkaRouter", [market.target]);
  const seeder = await deploy("PoolSeeder", [manager.target,registry.target]);
  const factory = await deploy("TijoriFactory", [router.target]);
  const expiry = (await provider.getBlock("latest"))!.timestamp + 100000;
  const yt = await deploy("YieldToken", [vault.target,expiry,"HARDENED",registry.target]);
  const pt = new Contract(await yt.principalToken(),artifacts.PrincipalToken.abi,owner);
  await sent(registry.registerSeries(yt.target));
  await sent(asset.mint(owner.address,2000n*unit));
  await sent(asset.approve(yt.target,MaxUint256));
  await sent(asset.approve(vault.target,MaxUint256));
  await sent(vault.approve(yt.target,MaxUint256));
  await sent(yt.splitFromAssets(400n*unit,owner.address));
  const assetIs0 = BigInt(asset.target as string) < BigInt(pt.target as string);
  await sent(registry.setPoolKey(1,{currency0:assetIs0?asset.target:pt.target,
    currency1:assetIs0?pt.target:asset.target,fee:500,tickSpacing:10,hooks:ZeroAddress}));
  await sent(seeder.initializePool(1,initialSqrtPrice(asset.target as string,pt.target as string,990000n)));
  await sent(asset.approve(seeder.target,MaxUint256));
  await sent(pt.approve(seeder.target,MaxUint256));
  await sent(seeder.addLiquidity(1,-600,600,10000n*unit,400n*unit,400n*unit,expiry-1));
  await sent(factory.create(agent.address,50n*unit));
  const tijori = new Contract(await factory.tijoriOf(owner.address),artifacts.Tijori.abi,owner);
  await sent(asset.approve(tijori.target,100n*unit));
  await sent(tijori.deposit(100n*unit));
  await sent(tijori.setPayeeCap(payee.address,10n*unit));
  await sent(tijori.setPayeeCap(other.address,10n*unit));
  await sent(asset.approve(router.target,MaxUint256));
  await sent(asset.approve(market.target,MaxUint256));
  f={asset,vault,registry,manager,market,router,seeder,factory,tijori,expiry,yt,pt};
  snapshot = await hre.network.provider.send("evm_snapshot");
});
beforeEach(async()=>{
  await hre.network.provider.send("evm_revert",[snapshot]);
  snapshot = await hre.network.provider.send("evm_snapshot");
});

test("registered series cap applies to direct USDC and share splits, and yields do not prevent exits",async()=>{
  await rejection(f.yt.splitFromAssets(MaxUint256,owner.address),f.yt,"SeriesCapExceeded");
  await sent(f.yt.splitFromAssets(100n*unit,owner.address));
  assert.equal(await f.yt.tvl(),500n*unit);
  await rejection(f.yt.splitFromAssets(1,owner.address),f.yt,"SeriesCapExceeded");
  await sent(f.vault.deposit(unit,owner.address));
  await rejection(f.yt.split(await f.vault.balanceOf(owner.address),owner.address),f.yt,"SeriesCapExceeded");
  await sent(f.yt.merge(unit,owner.address,false));
  await sent(f.yt.splitFromAssets(unit,owner.address));
  assert.equal(await f.yt.tvl(),500n*unit);
});

test("vault capacity errors are explicit and occur before funds or approvals change",async()=>{
  await sent(f.vault.setDepositCap(0));
  const balance=await f.asset.balanceOf(owner.address);
  await rejection(f.yt.splitFromAssets(unit,owner.address),f.yt,"VaultDepositLimit");
  assert.equal(await f.asset.balanceOf(owner.address),balance);
  assert.equal(await f.asset.allowance(f.yt.target,f.vault.target),0n);
  await sent(f.vault.setIlliquid(true));
  await rejection(f.yt.merge(unit,owner.address,true),f.yt,"VaultRedeemLimit");
  await sent(f.yt.merge(unit,owner.address,false));
});

test("global and series pause block entry routes but cannot block merge, claims or mature share redemption",async()=>{
  await sent(f.registry.setSeriesEntriesPaused(1,true));
  await rejection(f.yt.splitFromAssets(unit,owner.address),f.yt,"SeriesInactive");
  await rejection(f.router.lock(1,unit,unit,owner.address,f.expiry-1),f.router,"SeriesInactive");
  await rejection(f.market.buyPT(1,unit,unit,owner.address,f.expiry-1),f.market,"SeriesInactive");
  await sent(f.yt.merge(unit,owner.address,false));
  await sent(f.yt.claimInterest(owner.address,false));
  await sent(f.registry.setEntriesPaused(true));
  await advance(f.expiry);
  await sent(f.yt.redeemPT(unit,owner.address,false));
  assert.equal(f.registry.interface.hasFunction("withdraw"),false);
});

test("sudden upward and downward index movements block entries without poisoning the accepted index or closing exits",async()=>{
  const index=await f.yt.pyIndexStored();
  await sent(f.vault.addYield(10n*unit));
  assert.equal(await f.yt.indexHealthy(),false);
  await rejection(f.yt.splitFromAssets(unit,owner.address),f.yt,"IndexCircuitBreaker");
  await rejection(f.router.lock(1,unit,unit,owner.address,f.expiry-1),f.router,"IndexCircuitBreaker");
  await sent(f.yt.checkpointIndex());
  await sent(f.yt.transfer(other.address,unit));
  assert.equal(await f.yt.pyIndexStored(),index);
  await sent(f.yt.merge(unit,owner.address,false));
  await sent(f.vault.simulateLoss(20n*unit));
  assert.equal(await f.yt.indexHealthy(),false);
  await rejection(f.yt.splitFromAssets(unit,owner.address),f.yt,"IndexCircuitBreaker");
  await sent(f.yt.merge(unit,owner.address,false));
  assert.equal(await f.yt.pyIndexStored(),index);
});

test("multiple updates in one block cannot ratchet the index beyond the observation bound",async()=>{
  await hre.network.provider.send("evm_setAutomine",[false]);
  try {
    const nonce=await provider.getTransactionCount(owner.address);
    const txs=[];
    for(const [i,tx] of [
      ()=>f.vault.addYield(2n*unit,{nonce}),
      ()=>f.yt.checkpointIndex({nonce:nonce+1}),
      ()=>f.vault.addYield(2n*unit,{nonce:nonce+2}),
      ()=>f.yt.checkpointIndex({nonce:nonce+3}),
      ()=>f.vault.addYield(2n*unit,{nonce:nonce+4}),
      ()=>f.yt.checkpointIndex({nonce:nonce+5}),
    ].entries()) txs.push(await tx());
    await hre.network.provider.send("evm_mine");
    for(const tx of txs) await tx.wait();
    const live=await f.vault.convertToAssets(await f.yt.INDEX_UNIT());
    assert(live>await f.yt.pyIndexStored());
    assert.equal(await f.yt.indexHealthy(),false);
  } finally { await hre.network.provider.send("evm_setAutomine",[true]); }
});

test("the index band widens with time, so a real jump is accepted later instead of freezing the series for good",async()=>{
  const start=(await provider.getBlock("latest"))!.timestamp,index=await f.yt.pyIndexStored();
  await sent(f.vault.addYield(4_800_000n)); // 1.2% of the 400 USDC vault: outside the 1% band.
  await sent(f.yt.checkpointIndex());
  assert.equal(await f.yt.indexHealthy(),false);
  assert.equal(await f.yt.pyIndexStored(),index);
  assert.equal(await f.yt.accruedInterest(owner.address),0n);
  await rejection(f.yt.splitFromAssets(unit,owner.address),f.yt,"IndexCircuitBreaker");
  // 0.25% per day: after 80,000 seconds the band is about 1.23%, so the same price is now accepted.
  await advance(start+80_000);
  assert.equal(await f.yt.indexHealthy(),true);
  await sent(f.yt.checkpointIndex());
  assert(await f.yt.pyIndexStored()>index);
  assert(await f.yt.accruedInterest(owner.address)>0n);
  await sent(f.yt.splitFromAssets(unit,owner.address));
});

test("entries close one hour before maturity while merge and early sale stay open",async()=>{
  assert.equal(await f.registry.entryOpen(f.yt.target),true);
  await advance(f.expiry-3600);
  assert.equal(await f.registry.entryOpen(f.yt.target),false);
  await rejection(f.yt.splitFromAssets(unit,owner.address),f.yt,"SeriesInactive");
  await rejection(f.router.lock(1,unit,unit,owner.address,f.expiry-1),f.router,"SeriesInactive");
  await rejection(f.market.buyPT(1,unit,unit,owner.address,f.expiry-1),f.market,"SeriesInactive");
  await sent(f.yt.merge(unit,owner.address,false));
  await sent(f.pt.approve(f.router.target,unit));
  await sent(f.router.sellEarly(1,unit,1,owner.address,f.expiry-1));
});

test("face cap is enforced for router, direct market and ladder callers",async()=>{
  await rejection(f.router.lock(1,unit,unit+1n,owner.address,f.expiry-1),f.router,"PurchaseCapExceeded");
  await rejection(f.market.buyPT(1,unit,unit+1n,owner.address,f.expiry-1),f.market,"PurchaseCapExceeded");
  await rejection(f.router.buildLadder([{seriesId:1,ptAmount:unit,maxUsdc:unit+1n}],unit+1n,owner.address,f.expiry-1),f.router,"PurchaseCapExceeded");
  const quote=await f.market.quoteBuyPT.staticCall(1,unit);
  await sent(f.router.lock(1,unit,quote,other.address,f.expiry-1));
  assert.equal(await f.pt.balanceOf(other.address),unit);
  assert.equal(await f.asset.allowance(f.router.target,f.market.target),0n);
});

test("rolling payee cap cannot reset at a month/epoch boundary and only actual aged payments expire",async()=>{
  const now=(await provider.getBlock("latest"))!.timestamp;
  const boundary=(Math.floor(now/(30*day))+1)*30*day;
  await advance(boundary-100);
  await sent((f.tijori.connect(agent) as Contract).pay(payee.address,10n*unit));
  const paidAt=(await provider.getBlock("latest"))!.timestamp;
  await advance(boundary+10);
  assert.equal(await f.tijori.paymentRemaining(payee.address),0n);
  await rejection((f.tijori.connect(agent) as Contract).pay(payee.address,1),f.tijori,"PaymentCapExceeded");
  await advance(paidAt+30*day-1);
  assert.equal(await f.tijori.paymentRemaining(payee.address),0n);
  await advance(paidAt+30*day);
  assert.equal(await f.tijori.paymentRemaining(payee.address),10n*unit);
});

test("blacklisted payee fails cleanly without spending counters or blocking another payee",async()=>{
  await sent(f.asset.setBlacklisted(payee.address,true));
  await rejection((f.tijori.connect(agent) as Contract).pay(payee.address,unit),f.tijori,"PayeeBlacklisted");
  assert.equal(await f.tijori.dailySpent(),0n);
  await sent((f.tijori.connect(agent) as Contract).pay(other.address,unit));
  assert.equal(await f.asset.balanceOf(other.address),unit);
  await sent(f.asset.setBlacklisted(f.tijori.target,true));
  await rejection((f.tijori.connect(agent) as Contract).pay(other.address,unit),f.tijori,"TreasuryBlacklisted");
});

test("Tijori token handling is allowlisted and retained registered vault shares have a separate owner exit",async()=>{
  const stray=await deploy("MockUSDC");
  await sent(stray.mint(f.tijori.target,unit));
  await rejection(f.tijori.withdraw(stray.target,unit),f.tijori,"UnsupportedToken");
  await sent(f.pt.transfer(f.tijori.target,unit));
  await sent(f.tijori.setPaused(true));
  await sent(f.tijori.withdraw(f.pt.target,unit));
  await sent(f.yt.merge(unit,f.tijori.target,false));
  const shares=await f.vault.balanceOf(f.tijori.target);
  await sent(f.tijori.withdrawVaultShares(1,shares));
  assert.equal(await f.vault.balanceOf(f.tijori.target),0n);
});

test("whole-system state-machine invariants span router, Tijori, v4 pool, pauses, yield and payments",async()=>{
  const actors=[owner.address,agent.address,payee.address,other.address,f.tijori.target,f.manager.target,
    f.vault.target,f.yt.target,f.router.target,f.market.target,f.seeder.target,f.factory.target,f.registry.target];
  let random=1776;
  const next=()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random;};
  async function invariant() {
    const balances=await Promise.all(actors.map(a=>f.asset.balanceOf(a)));
    assert.equal(balances.reduce((a,b)=>a+b,0n),await f.asset.totalSupply(),"USDC conservation");
    const ptBalances=await Promise.all(actors.map(a=>f.pt.balanceOf(a)));
    assert.equal(ptBalances.reduce((a,b)=>a+b,0n),await f.pt.totalSupply(),"PT conservation");
    const pending=(await Promise.all(actors.map(a=>f.yt.accruedInterest(a)))).reduce((a,b)=>a+b,0n);
    const principal=await f.pt.totalSupply()*await f.yt.INDEX_UNIT()/await f.yt.pyIndexCurrent();
    assert(await f.vault.balanceOf(f.yt.target)>=principal+pending,"principal and accrued yield backed by shares");
    for(const [token,source,destination] of [[f.asset,f.yt,f.vault],[f.asset,f.tijori,f.router],
      [f.asset,f.router,f.market],[f.pt,f.tijori,f.router],[f.pt,f.router,f.market]]) {
      assert.equal(await token.allowance(source.target,destination.target),0n,"temporary approval cleared");
    }
    for(const contract of [f.router,f.market]) for(const token of [f.asset,f.pt,f.yt]) {
      assert.equal(await token.balanceOf(contract.target),0n,"intermediaries retain no user assets");
    }
    assert(await f.tijori.paymentRemaining(payee.address)<=10n*unit,"rolling payee cap bounded");
  }
  for(let i=0;i<80;i++) {
    const action=(next()>>>16)%8;
    if(action===0) await sent(f.router.lock(1,unit,unit,other.address,f.expiry-1));
    if(action===1 && await f.pt.balanceOf(other.address)>=unit) {
      await sent((f.pt.connect(other) as Contract).approve(f.router.target,unit));
      await sent((f.router.connect(other) as Contract).sellEarly(1,unit,1,other.address,f.expiry-1));
    }
    if(action===2) await sent((f.tijori.connect(agent) as Contract).lock(1,unit,unit,f.expiry-1));
    if(action===3 && await f.tijori.paymentRemaining(payee.address)>=unit) await sent((f.tijori.connect(agent) as Contract).pay(payee.address,unit));
    if(action===4) {await sent(f.vault.addYield(1000));await sent(f.yt.checkpointIndex());}
    if(action===5) await sent(f.yt.claimInterest(owner.address,false));
    if(action===6) {
      await sent(f.registry.setEntriesPaused(true));
      await rejection(f.router.lock(1,unit,unit,other.address,f.expiry-1),f.router,"SeriesInactive");
      if(await f.yt.balanceOf(owner.address)>=unit) await sent(f.yt.merge(unit,owner.address,false));
      await sent(f.registry.setEntriesPaused(false));
    }
    if(action===7) await sent(f.yt.transfer(other.address,1000));
    await invariant();
  }
  await advance(f.expiry);
  await sent(f.yt.settleExpiry());
  await sent(f.registry.setEntriesPaused(true));
  const treasuryPt=await f.pt.balanceOf(f.tijori.target);
  if(treasuryPt) await sent((f.tijori.connect(agent) as Contract).cashOut(1,treasuryPt,true,1,f.expiry+100));
  const userPt=await f.pt.balanceOf(other.address);
  if(userPt) {
    await sent((f.pt.connect(other) as Contract).approve(f.router.target,userPt));
    await sent((f.router.connect(other) as Contract).cashOut(1,userPt,other.address,true,1,f.expiry+100));
  }
  await invariant();
});

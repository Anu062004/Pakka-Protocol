import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import hre from "hardhat";
import { BrowserProvider } from "ethers";
import { deploySystem,localSigner } from "./helpers/system.ts";
import { fullFlow } from "./helpers/full-flow.ts";
import { ReadService } from "../backend/read-service.ts";
import { TreasuryService } from "../agent/treasury-service.ts";

test("deploy → seed → Priya lock → real MCP ladder → keeper maturities → cash out → pay",async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"pakka-flow-"));
  const provider=new BrowserProvider(hre.network.provider,undefined,{cacheTimeout:-1});
  try{
    const system=await deploySystem({provider,signers:Array.from({length:7},(_,i)=>localSigner(i,provider))});
    const reads=new ReadService({provider,manifest:system.manifest});
    assert.equal((await reads.rates()).series.length,3);
    const agent=new TreasuryService({provider,signer:system.agent,manifest:system.manifest,tijoriAddress:system.tijori.target as string,
      chainId:31337,confirmations:1,stateFile:path.join(directory,"quote-only.json")});
    const frontendQuote=await reads.quotes.quote({seriesId:1,ptAmountRaw:1_000000n});
    const botQuote=await agent.invoke("quotePT",{seriesId:1,ptAmount:"1"}) as any;
    assert.equal(frontendQuote.quotedCost.raw,botQuote.quotedCost.raw);
    assert.equal(frontendQuote.impliedFixedRatePercent,botQuote.impliedFixedRatePercent);
    assert.equal(frontendQuote.suggestedMinOutRaw,botQuote.suggestedMinOutRaw);
    const result=await fullFlow(system,{stateDirectory:directory,
      advance:async timestamp=>{await hre.network.provider.send("evm_setNextBlockTimestamp",[timestamp]);await hre.network.provider.send("evm_mine");},
      mine:()=>hre.network.provider.send("evm_mine")});
    assert.equal(result.realVault,false);assert.equal(result.series,3);assert.equal(result.steps.length,8);
    const feed=await reads.activity({account:(system.treasuryOwner as any).address,tijori:system.tijori.target as string});
    assert.equal(feed.items.filter(e=>e.event==="Paid").length,3);
    assert.equal(feed.items.some(e=>e.event==="Transfer"),false);
  }finally{provider.destroy();fs.rmSync(directory,{recursive:true,force:true});}
});

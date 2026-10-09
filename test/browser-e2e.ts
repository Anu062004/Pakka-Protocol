import assert from "node:assert/strict";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { before,after,beforeEach,afterEach,test } from "node:test";
import hre from "hardhat";
import { BrowserProvider, Wallet } from "ethers";
import { chromium,expect } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { createApp } from "../backend/server.ts";
import { ReadService } from "../backend/read-service.ts";
import { deploySystem,localSigner } from "./helpers/system.ts";
import type { System } from "./helpers/system.ts";
import { findAuthorization } from "../scripts/agent-cli.ts";

let browser: Browser, context: BrowserContext | null, page: Page, server: Server, provider: BrowserProvider, system: System, snapshot: string, baseURL: string;
const sent=async (tx: Promise<{ wait: () => Promise<unknown> }>)=>(await tx).wait();
before(async()=>{
  // Failure to launch/listen is a failed browser gate, never an automatic skip or fake pass.
  browser=await chromium.launch({headless:true});
  provider=new BrowserProvider(hre.network.provider,undefined,{cacheTimeout:-1});
  system=await deploySystem({provider,signers:Array.from({length:7},(_,i)=>localSigner(i,provider))});
  const service=new ReadService({provider,manifest:system.manifest});
  server=createApp({manifest:system.manifest,port:0,getService:()=>service});
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",()=>resolve());});
  baseURL=`http://127.0.0.1:${(server.address() as AddressInfo).port}/app`;
  snapshot=await hre.network.provider.send("evm_snapshot");
});
beforeEach(async()=>{
  await hre.network.provider.send("evm_revert",[snapshot]);snapshot=await hre.network.provider.send("evm_snapshot");
  context=await browser.newContext({viewport:{width:1280,height:900}});page=await context.newPage();
  await page.exposeFunction("pakkaRpc",async (payload: { method: string; params?: unknown[] })=>{
    try{return {result:await hre.network.provider.request(payload)};}
    catch(e){const error=e as {code?:number; message:string; data?:unknown}; return {error:{code:error.code??-32603,message:error.message,data:error.data}};}
  });
  await page.addInitScript(({account}: {account: string})=>{
    let selected=account;const handlers: Record<string, ((...args: unknown[])=>void)[]>={};
    (window as any).ethereum={on:(name: string,fn: (...args: unknown[])=>void)=>(handlers[name]??=[]).push(fn),request:async({method,params=[]}: {method: string; params?: unknown[]})=>{
      if(["eth_accounts","eth_requestAccounts"].includes(method))return [selected];
      if(method==="wallet_getCapabilities")throw Object.assign(new Error("not supported"),{code:4200});
      const response=await (window as any).pakkaRpc({method,params});if(response.error)throw Object.assign(new Error(response.error.message),response.error);return response.result;
    }};
    (window as any).pakkaSelectAccount=(address: string)=>{selected=address;for(const handler of handlers.accountsChanged??[])handler([address]);};
  },{account:await system.priya.getAddress()});
  await page.goto(baseURL);await expect(page.locator("#notice")).toContainText("Rates refreshed",{timeout:30000});
});
afterEach(async()=>{await context?.close();context=null;});
after(async()=>{await context?.close();await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));provider?.destroy();});

test("four pages are usable at 320, 375, 414 and 768 px with no horizontal overflow",async()=>{
  const errors: string[]=[];page.on("pageerror",e=>errors.push(e.message));
  for(const width of [320,375,414,768]){
    await page.setViewportSize({width,height:850});
    for(const section of ["rates","lock","positions","tijori"]){
      await page.locator(`nav a[href='#${section}']`).click();
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await expect(page.locator(`#${section}`)).toBeVisible();
      const wrapping=await page.locator("nav a,button:visible").evaluateAll(items=>items.some(e=>{
        const r=document.createRange();r.selectNodeContents(e);return r.getClientRects().length>1;
      }));assert.equal(wrapping,false,"Clickable labels must stay on one line");
    }
  }
  fs.mkdirSync("test-results",{recursive:true});await page.screenshot({path:"test-results/pakka-mobile.png",fullPage:true});
  assert.deepEqual(errors,[]);
});

test("Priya reviews a shared quote, locks, reaches maturity, and cashes out with no standing approval",async()=>{
  await page.locator("#connect").click();await expect(page.locator("#notice")).toHaveText("Wallet connected on testnet.");
  await page.locator("nav a[href='#lock']").click();await page.locator("#maturity").selectOption("1");
  await page.locator("#get-quote").click();await expect(page.locator("#lock-submit")).toBeEnabled();
  await page.locator("#lock-submit").click();
  await expect.poll(()=>system.series[0]!.pt.balanceOf((system.priya as any).address),{timeout:30000}).toBe(1_000000n);
  await expect(page.locator("#positions-list")).toContainText("1 USDC face");
  assert.equal(await system.asset.allowance((system.priya as any).address,system.router.target),0n);
  await hre.network.provider.send("evm_setNextBlockTimestamp",[system.series[0]!.expiry+1]);await hre.network.provider.send("evm_mine");
  await sent(system.series[0]!.yt.settleExpiry());
  await page.locator("#refresh-positions").click();await expect(page.locator("#positions-list")).toContainText("Matured");
  await page.getByRole("button",{name:"Cash out",exact:true}).click();
  await expect.poll(()=>system.series[0]!.pt.balanceOf((system.priya as any).address),{timeout:30000}).toBe(0n);
  assert.equal(await system.series[0]!.pt.allowance((system.priya as any).address,system.router.target),0n);
  await expect(page.locator("#transaction")).toContainText("gas");
});

test("Tijori owner can pause the agent, withdraw, and generate a browser-only agent key",async()=>{
  await page.evaluate((address: string)=>(window as any).pakkaSelectAccount(address),(system.treasuryOwner as any).address);
  await page.locator("#connect").click();await expect(page.locator("#notice")).toHaveText("Wallet connected on testnet.");
  await page.locator("nav a[href='#tijori']").click();await expect(page.locator("#treasury-controls")).toBeVisible();
  await page.locator("#pause-agent").click();await expect.poll(()=>system.tijori.paused()).toBe(true);
  await page.locator("#withdraw-form button").click();await expect.poll(()=>system.asset.balanceOf(system.tijori.target)).toBe(19_000000n);
  await page.locator("#connect-agent").click();await expect(page.locator("#agent-secret")).toBeVisible();
  await expect(page.locator("#notice")).toContainText("Agent authorized");
  assert.equal(await page.locator("#one-time-key").evaluate(e=>/^0x[\da-f]{64}$/.test((e as HTMLInputElement).value)),true);
  assert.equal(await page.evaluate(()=>(document.getElementById("mcp-config") as HTMLInputElement).value.includes((document.getElementById("one-time-key") as HTMLInputElement).value)),false);
  assert.equal(await page.evaluate(()=>Object.values(localStorage).some(v=>/0x[\da-f]{64}/i.test(v))),false);
  await page.locator("#hide-key").click();await expect(page.locator("#one-time-key")).toHaveValue("");
});

test("a new owner following the terminal setup link creates, funds gas and deposits without seeing a key",async()=>{
  const agent=Wallet.createRandom().address,owner=(system.priya as any).address as string,start=await provider.getBlockNumber();
  await page.goto(`${baseURL}?agent=${agent}#tijori`);await expect(page.locator("#notice")).toContainText("Rates refreshed",{timeout:30000});
  await expect(page.locator("#treasury-status")).toContainText("terminal setup");
  await page.locator("#connect").click();await expect(page.locator("#create-form")).toBeVisible();
  // The address comes from the terminal; the browser must neither replace it nor mint a key of its own.
  await expect(page.locator("#initial-agent")).toHaveValue(agent);
  assert.equal(await page.locator("#initial-agent").evaluate(e=>(e as HTMLInputElement).readOnly),true);
  await expect(page.locator("#generate-agent")).toBeHidden();await expect(page.locator("#new-agent-secret")).toBeHidden();
  await page.locator("#initial-deposit").fill("2");await page.locator("#create-form button.cta").click();
  await expect(page.locator("#notice")).toContainText("Return to your terminal",{timeout:30000});
  const tijori=await system.factory.tijoriOf(owner) as string;
  assert.equal(await findAuthorization(provider,system.manifest,agent,start),tijori);
  assert.equal(await system.asset.balanceOf(tijori),2_000000n);
  assert.equal(await provider.getBalance(agent),10n**18n);
  assert.equal(await system.asset.allowance(owner,tijori),0n);
  await expect(page.locator("#setup-authorize-text")).toContainText("authorized and has gas");
  await expect(page.locator("#setup-authorize-button")).toBeHidden();
});

test("an existing owner following the setup link swaps in the terminal's agent and funds it once",async()=>{
  const agent=Wallet.createRandom().address,start=await provider.getBlockNumber();
  await page.evaluate((address: string)=>(window as any).pakkaSelectAccount(address),(system.treasuryOwner as any).address);
  await page.goto(`${baseURL}?agent=${agent}#tijori`);await expect(page.locator("#notice")).toContainText("Rates refreshed",{timeout:30000});
  await page.evaluate((address: string)=>(window as any).pakkaSelectAccount(address),(system.treasuryOwner as any).address);
  await page.locator("#connect").click();await expect(page.locator("#setup-authorize")).toBeVisible();
  // The owner is trusting a value from a link, so the whole address must be on screen.
  await expect(page.locator("#setup-authorize-text")).toContainText(agent);
  assert.equal(await findAuthorization(provider,system.manifest,agent,start),null);
  await page.locator("#setup-authorize-button").click();
  await expect(page.locator("#notice")).toContainText("Return to your terminal",{timeout:30000});
  assert.equal(await system.tijori.agent(),agent);
  assert.equal(await findAuthorization(provider,system.manifest,agent,start),system.tijori.target);
  assert.equal(await provider.getBalance(agent),10n**18n);
  assert.equal(await system.asset.balanceOf(system.tijori.target),20_000000n);
  await expect(page.locator("#setup-authorize-button")).toBeHidden();
});

test("a malformed agent in the link is ignored rather than offered for approval",async()=>{
  await page.goto(`${baseURL}?agent=0x1234#tijori`);await expect(page.locator("#notice")).toContainText("Rates refreshed",{timeout:30000});
  await page.locator("#connect").click();await expect(page.locator("#create-form")).toBeVisible();
  await expect(page.locator("#initial-agent")).toHaveValue("");await expect(page.locator("#generate-agent")).toBeVisible();
  await expect(page.locator("#setup-fields")).toBeHidden();
});

test("atomic wallet request requires atomicity and preserves an ambiguous batch instead of resending",async()=>{
  const result=await page.evaluate(async({account,manifest}: {account: string; manifest: any})=>{
    // @ts-expect-error browser-only runtime module served by the app itself, not resolvable by Node's TS
    const {AppWallet}=await import("/wallet.mjs");const requests: any[]=[];
    const injected={request:async({method,params}: {method: string; params?: any[]}): Promise<any>=>{
      if(method==="eth_chainId")return "0x7a69";if(method==="eth_accounts")return [account];
      if(method==="wallet_getCapabilities")return {"0x7a69":{atomic:{status:"supported"}}};
      if(method==="wallet_sendCalls"){requests.push(params![0]);throw new Error("lost response");}
      throw new Error("unexpected request");
    }};
    const w=new AppWallet(injected,manifest);w.account=account;
    const c={target:manifest.router,interface:{encodeFunctionData:()=>"0x1234"}};
    let code;try{await w.approved(c,"lock",[],manifest.usdc,1n,{batch:true,deadline:1000});}catch(e){code=(e as any).code;}
    const pending=await w.pending();try{await w.approved(c,"lock",[],manifest.usdc,1n,{batch:true,deadline:1000});}catch{}
    // Once the chain is past the batch's deadline it can no longer land, so the note stops blocking the wallet.
    const time=(t: number)=>{const inner=injected.request;injected.request=async(r: any)=>r.method==="eth_getBlockByNumber"?{timestamp:`0x${t.toString(16)}`}:inner(r);};
    time(1000);const live=Boolean(await w.pending());time(1001);const expired=await w.pending();
    return {code,pending:Boolean(pending),live,expired,count:requests.length,atomicRequired:requests[0].atomicRequired,calls:requests[0].calls.length};
  },{account:(system.priya as any).address,manifest:system.manifest});
  assert.deepEqual(result,{code:"BATCH_PENDING",pending:true,live:true,expired:null,count:1,atomicRequired:true,calls:4});
});

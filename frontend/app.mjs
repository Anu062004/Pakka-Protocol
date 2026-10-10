import { Contract, Interface, Wallet, ZeroAddress, ZeroHash, formatUnits, getAddress, parseUnits, solidityPackedKeccak256 } from "/ethers.mjs";
import { AppWallet } from "/wallet.mjs";
import { humanError } from "/errors.mjs";

const $=id=>document.getElementById(id);
const state={manifest:null,abis:null,wallet:null,rates:[],quote:null,yieldQuote:null,treasury:null,owner:false,busy:false};
const pages=["rates","lock","yield","positions","tijori","owner"];
// The terminal setup command keeps the agent key on the user's machine and passes only its
// address here, so the owner's wallet can approve it without the key ever reaching a browser.
const setupAgent=(()=>{try{return getAddress(new URLSearchParams(location.search).get("agent")??"");}catch{return null;}})();
const agentGas=parseUnits("1",18);
const tokenAbi=["function balanceOf(address) view returns(uint256)","function approve(address,uint256) returns(bool)","function allowance(address,address) view returns(uint256)"];
const short=a=>`${a.slice(0,6)}…${a.slice(-4)}`;
const date=t=>new Date(t*1000).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"});
const usdc=n=>`${Number(n).toLocaleString(undefined,{maximumFractionDigits:6})} USDC`;
const amount=(value,allowZero=false)=>{
  if(!/^\d{1,20}(\.\d{1,6})?$/.test(value)) throw new Error("INVALID_QUOTE_AMOUNT");
  const n=parseUnits(value,6);if(n<0n||(!allowZero&&n===0n))throw new Error("INVALID_QUOTE_AMOUNT");return n;
};
const node=(tag,text,attributes={})=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;for(const [k,v]of Object.entries(attributes))e.setAttribute(k,v);return e;};
const button=(text,action,attributes={})=>{const e=node("button",text,{type:"button",...attributes});e.addEventListener("click",()=>run(action));return e;};
const notice=(text,kind="neutral")=>{$("notice").textContent=text;$("notice").dataset.state=kind;$("notice").setAttribute("role",kind==="error"?"alert":"status");};
const interfaces=()=>Object.values(state.abis??{}).map(a=>new Interface(a));
const contract=(name,address)=>new Contract(address,state.abis[name],state.wallet.provider);
async function api(url){const r=await fetch(url,{cache:"no-store"});const data=await r.json();if(!r.ok)throw new Error(data.error);return data;}
function requireWallet(){if(!state.wallet)throw new Error("WALLET_REQUIRED");return state.wallet;}
async function run(action){
  if(state.busy)return;state.busy=true;
  const buttons=[...document.querySelectorAll("button")].map(e=>[e,e.disabled]);
  buttons.forEach(([e])=>{e.disabled=true;e.setAttribute("aria-busy","true");});
  notice("Checking the latest state. Your wallet will ask before any transaction.");
  try{await action();}catch(e){notice(humanError(e,interfaces()),"error");}
  finally{state.busy=false;buttons.forEach(([e,was])=>{e.disabled=was;e.removeAttribute("aria-busy");});$("lock-submit").disabled=!state.quote;$("yield-submit").disabled=!state.yieldQuote;$("show-key").disabled=!$("one-time-key").value||$("one-time-key").type==="text";}
}
function navigate(){
  const hash=location.hash.slice(1),id=pages.includes(hash)&&(hash!=="owner"||state.owner)?hash:"rates";
  for(const p of pages)$(p).hidden=p!==id;
  for(const link of document.querySelectorAll("nav a")){if(link.hash===`#${id}`)link.setAttribute("aria-current","page");else link.removeAttribute("aria-current");}
  if(state.wallet&&id==="positions")void run(refreshPositions);
  if(state.wallet&&id==="tijori")void run(refreshTreasury);
  if(state.owner&&id==="owner")void run(refreshOwner);
}
async function showReceipt(receipt,wallet=state.wallet){
  if(!receipt)return;
  const hash=receipt.hash??receipt.transactionHash;
  $("transaction").replaceChildren(node("p",`Confirmed · gas ${await wallet.gasUsdc(receipt)} USDC`));
  if(state.manifest.network)$("transaction").append(node("a","View transaction",{href:`${state.manifest.network.explorer}/tx/${hash}`,target:"_blank",rel:"noopener noreferrer"}));
  else $("transaction").append(node("p",`Local transaction: ${hash}`));
  notice("Transaction confirmed.","success");
}
async function refreshRates(){
  const result=await api("/api/rates");state.rates=result.series;
  $("variable-rate").textContent=result.variableRatePercent===null?`— · ${result.variableRateStatus}`:`${result.variableRatePercent}% variable APY`;
  $("rates-list").replaceChildren();for(const id of ["maturity","yield-maturity"])$(id).replaceChildren(node("option","Choose a date",{value:""}));
  let availableMaturities=0;
  for(const s of state.rates){
    const row=node("div",undefined,{class:"rate-row"});
    const label=node("div");label.append(node("h3",date(s.expiry)),node("p",`Series ${s.seriesId} · ${usdc(s.tvlUsdc)} / ${usdc(s.capUsdc)} entry TVL`,{class:"helper"}));row.append(label);
    const rate=node("div",undefined,{class:"stat"});rate.append(node("strong",s.quote?`${Number(s.quote.impliedFixedRatePercent).toLocaleString(undefined,{maximumFractionDigits:2})}%`:"—"),node("span","Simple annualized rate"));row.append(rate);
    const price=node("div",undefined,{class:"stat"});price.append(node("strong",s.quote?usdc(s.quote.quotedCost.usdc):"—"),node("span","Cost per 1 USDC face"));row.append(price);
    const active=s.entryOpen&&s.indexHealthy&&s.hasPool&&s.quote;
    const b=button(active?"Choose date":s.expiry<=result.timestamp?"Matured":"Unavailable",async()=>{$("maturity").value=String(s.seriesId);invalidateQuote();location.hash="lock";notice("Enter a face value, then request a quote.");});b.disabled=!active;row.append(b);
    if(!active)label.append(node("p",s.expiry<=result.timestamp?"Cash out your mature ticket in Positions.":!s.indexHealthy?"Vault index safety limit reached.":!s.entryOpen?"New purchases paused.":"Pool liquidity is currently unavailable.",{class:"helper"}));
    $("rates-list").append(row);
    if(s.expiry>result.timestamp){for(const id of ["maturity","yield-maturity"]){const option=node("option",`${date(s.expiry)} · Series ${s.seriesId}`,{value:s.seriesId});option.disabled=!active;$(id).append(option);}availableMaturities++;}
  }
  if(!state.rates.length)$("rates-list").append(node("p","No registered maturities yet. Rates appear after owner registration and pool seeding."));
  $("lock-unavailable").hidden=availableMaturities>0;
  $("face").disabled=$("maturity").disabled=$("get-quote").disabled=availableMaturities===0;
  $("yield-amount").disabled=$("yield-maturity").disabled=$("yield-preview").disabled=availableMaturities===0;
  $("block-status").textContent=`Block ${Number(result.blockNumber).toLocaleString("en-US")}`;
  invalidateQuote();invalidateYield();notice(`Rates refreshed at block ${result.blockNumber}.`);
}
function invalidateQuote(){state.quote=null;$("lock-submit").disabled=true;$("quote-details").replaceChildren(node("h2","Your quote"),node("p","Request a fresh quote for this amount and date."));}
async function getQuote(){
  const seriesId=Number($("maturity").value),face=$("face").value;amount(face);
  if(!seriesId)throw new Error("INVALID_QUOTE_AMOUNT");
  const quote=await api(`/api/quote?seriesId=${seriesId}&ptAmount=${encodeURIComponent(face)}`);
  if(seriesId!==Number($("maturity").value)||amount(face)!==amount($("face").value))return;
  state.quote=quote;
  const dl=node("dl");for(const [label,value]of [["Pay today",usdc(quote.quotedCost.usdc)],["Maximum spend",usdc(quote.maxUsdc.usdc)],["Face value at maturity",usdc(quote.faceValue.usdc)],["Simple annualized rate",`${quote.impliedFixedRatePercent}%`],["Maturity",date(quote.expiry)]])dl.append(node("dt",label),node("dd",value));
  $("quote-details").replaceChildren(node("h2","Your quote"),dl,node("p",`0.50% slippage allowance · exact ticket output · quote expires ${date(quote.deadline)}`,{class:"helper"}));
  $("lock-submit").disabled=false;notice("Quote ready. Review the cost and maturity before locking.");
}
async function lock(){
  const wallet=requireWallet(),quote=state.quote;
  if(!quote||quote.seriesId!==Number($("maturity").value)||BigInt(quote.pt.raw)!==amount($("face").value))throw new Error("QUOTE_CHANGED");
  const fresh=await api(`/api/quote?seriesId=${quote.seriesId}&ptAmount=${encodeURIComponent(quote.pt.usdc)}`);
  if(BigInt(fresh.quotedCost.raw)>BigInt(quote.maxUsdc.raw)) {invalidateQuote();throw new Error("QUOTE_CHANGED");}
  const router=contract("PakkaRouter",state.manifest.router);
  const deadline=Math.min(quote.deadline,fresh.deadline);
  const receipt=await wallet.approved(router,"lock",[quote.seriesId,quote.pt.raw,quote.maxUsdc.raw,wallet.account,
    deadline],state.manifest.usdc,BigInt(quote.maxUsdc.raw),{batch:true,deadline});
  invalidateQuote();await showReceipt(receipt,wallet);await refreshPositions();location.hash="positions";
}
function invalidateYield(){state.yieldQuote=null;$("yield-submit").disabled=true;$("yield-details").replaceChildren(node("h2","Your preview"),node("p","Request a fresh preview for this amount and date."));}
async function previewYield(){
  const wallet=requireWallet(),seriesId=Number($("yield-maturity").value),assets=amount($("yield-amount").value);
  const s=state.rates.find(s=>s.seriesId===seriesId);if(!s)throw new Error("INVALID_QUOTE_AMOUNT");
  // The split mints one PT and one YT per USDC of deposit, and the router sells that PT back to the pool.
  const returned=await contract("UniswapV4Market",state.manifest.market).quoteSellPT.staticCall(seriesId,assets);
  if(returned>=assets)throw new Error("InvalidQuote");
  state.yieldQuote={seriesId,assets,account:wallet.account};
  const dl=node("dl");for(const [label,value]of [["You deposit",usdc(formatUnits(assets,6))],["Returned to you now",`≈ ${usdc(formatUnits(returned,6))}`],["Net cost of the yield token",`≈ ${usdc(formatUnits(assets-returned,6))}`],["Yield tokens received",`≈ ${Number(formatUnits(assets,6)).toLocaleString(undefined,{maximumFractionDigits:6})} YT`],["Collects interest until",date(s.expiry)]])dl.append(node("dt",label),node("dd",value));
  $("yield-details").replaceChildren(node("h2","Your preview"),dl,node("p","Estimate from the current pool price. The purchase is stopped if either amount comes in more than 0.50% lower.",{class:"helper"}));
  $("yield-submit").disabled=false;notice("Preview ready. Review the net cost before buying.");
}
async function buyYield(){
  const wallet=requireWallet(),quote=state.yieldQuote;
  if(!quote||quote.account!==wallet.account||quote.seriesId!==Number($("yield-maturity").value)||quote.assets!==amount($("yield-amount").value))throw new Error("QUOTE_CHANGED");
  const router=contract("PakkaRouter",state.manifest.router);
  const current=await api(`/api/positions?account=${wallet.account}`);
  const args=[quote.seriesId,quote.assets,0,0,wallet.account,current.timestamp+120];
  const prepare=async()=>{const [minted,returned]=await router.connect(wallet.signer).buyYield.staticCall(...args);args[2]=minted*9950n/10000n;args[3]=returned*9950n/10000n;return args;};
  const receipt=await wallet.approved(router,"buyYield",args,state.manifest.usdc,quote.assets,{prepare});
  invalidateYield();await showReceipt(receipt,wallet);await refreshPositions();location.hash="positions";
}
async function exitPosition(position,{treasury=false,toAssets=true,claim=false,merge=false}={}){
  const wallet=requireWallet();const s=state.rates.find(s=>s.seriesId===position.seriesId);
  if(!s)throw new Error("UnknownSeries");
  let target,method,args,receipt;
  if(claim){
    target=treasury?contract("Tijori",state.treasury.address):contract("YieldToken",s.yieldToken);
    method="claimInterest";args=treasury?[position.seriesId,toAssets,0]:[wallet.account,toAssets];
    if(treasury){const expected=await target.connect(wallet.signer)[method].staticCall(...args);args[2]=expected*9950n/10000n;}
    receipt=await wallet.write(target,method,args);
  }else if(merge){
    target=contract("YieldToken",s.yieldToken);method="merge";
    const paired=BigInt(position.ptRaw)<BigInt(position.ytRaw)?BigInt(position.ptRaw):BigInt(position.ytRaw);
    receipt=await wallet.write(target,method,[paired,wallet.account,toAssets]);
  }else{
    target=treasury?contract("Tijori",state.treasury.address):contract("PakkaRouter",state.manifest.router);
    method=position.matured?"cashOut":"sellEarly";
    if(treasury&&!position.matured)throw new Error("SeriesNotExpired");
    const current=await api(`/api/positions?account=${treasury?state.treasury.address:wallet.account}`);
    const deadline=current.timestamp+120;
    if(position.matured)args=treasury?[position.seriesId,position.ptRaw,toAssets,0,deadline]:[position.seriesId,position.ptRaw,wallet.account,toAssets,0,deadline];
    else args=[position.seriesId,position.ptRaw,0,wallet.account,deadline];
    const prepare=async()=>{const expected=await target.connect(wallet.signer)[method].staticCall(...args);const min=expected*9950n/10000n;args[method==="sellEarly"?2:treasury?3:4]=min;return args;};
    if(treasury)receipt=await wallet.write(target,method,await prepare());
    else receipt=await wallet.approved(target,method,args,s.principalToken,BigInt(position.ptRaw),{prepare});
  }
  await showReceipt(receipt,wallet);if(treasury)await refreshTreasury();else await refreshPositions();
}
function renderPositions(container,result,treasury=false){
  container.replaceChildren();if(!result.positions.length)container.append(node("p","No positions yet. Choose a maturity on Rates to get started."));
  for(const p of result.positions){
    const row=node("div",undefined,{class:"position-row"});
    const seconds=Math.max(0,p.expiry-result.timestamp),countdown=seconds>=86400?`${Math.ceil(seconds/86400)} days left`:`${Math.ceil(seconds/60)} minutes left`;
    const holdings=[];
    if(BigInt(p.ptRaw)>0n)holdings.push(`${usdc(p.ptUsdc)} face`);
    if(BigInt(p.ytRaw)>0n)holdings.push(`${Number(formatUnits(p.ytRaw,6)).toLocaleString(undefined,{maximumFractionDigits:6})} YT`);
    holdings.push(p.matured?"Matured":countdown);
    if(BigInt(p.ptRaw)>0n)holdings.push(`Estimated exit value ${p.estimatedUsdc===null?"unavailable":usdc(p.estimatedUsdc)}`);
    row.append(node("h3",`Series ${p.seriesId} · ${date(p.expiry)}`),node("p",holdings.join(" · ")));
    const actions=node("div",undefined,{class:"actions"});
    if(BigInt(p.ptRaw)>0n&&(p.matured||!treasury))actions.append(button(p.matured?"Cash out":"Sell early",()=>exitPosition(p,{treasury}),p.matured?{class:"cta"}:{}));
    if(p.matured&&BigInt(p.ptRaw)>0n)actions.append(button("Take vault shares",()=>exitPosition(p,{treasury,toAssets:false})));
    if(!treasury&&!p.matured&&BigInt(p.ptRaw)>0n&&BigInt(p.ytRaw)>0n)actions.append(button("Merge tickets",()=>exitPosition(p,{merge:true})),button("Merge to shares",()=>exitPosition(p,{merge:true,toAssets:false})));
    if(BigInt(p.interestSharesRaw)>0n)actions.append(button("Claim interest",()=>exitPosition(p,{treasury,claim:true})),button("Claim as shares",()=>exitPosition(p,{treasury,claim:true,toAssets:false})));
    row.append(actions);container.append(row);
  }
  for(const shares of result.vaultShares??[]){
    const row=node("div",undefined,{class:"position-row"});row.append(node("h3","Vault shares"),node("p",`${shares.shares} shares · ${short(shares.vault)}`));
    if(treasury)row.append(button("Recover to owner",()=>treasuryWrite("withdrawVaultShares",[shares.seriesId,shares.sharesRaw])));
    else row.append(button("Redeem vault shares",async()=>{
      const wallet=requireWallet(),vault=new Contract(shares.vault,["function redeem(uint256,address,address) returns(uint256)"],wallet.provider);
      await showReceipt(await wallet.write(vault,"redeem",[shares.sharesRaw,wallet.account,wallet.account]),wallet);await refreshPositions();
    }));
    container.append(row);
  }
}
async function refreshPositions(){const wallet=requireWallet();renderPositions($("positions-list"),await api(`/api/positions?account=${wallet.account}`));notice("Positions refreshed.");}
async function refreshTreasury(){
  const wallet=requireWallet();const t=await api(`/api/treasury?owner=${wallet.account}`);state.treasury=t;
  $("create-form").hidden=Boolean(t.address);$("treasury-controls").hidden=!t.address;
  await renderSetup();
  $("treasury-status").replaceChildren(node("p",t.address?`${short(t.address)} · ${usdc(t.usdc)} available · Agent ${short(t.agent)} · ${t.paused?"Agent paused":"Agent active"}`:"You do not have a Tijori yet. Choose an agent address and payment limit to create one."));
  if(!t.address)return;
  $("daily-cap").value=t.dailyCapUsdc;$("pause-agent").textContent=t.paused?"Resume agent":"Pause agent";
  renderPositions($("treasury-positions"),t,true);renderBills();
  const feed=await api(`/api/activity?account=${wallet.account}&tijori=${t.address}`);$("activity").replaceChildren();
  for(const item of feed.items){const row=node("div",undefined,{class:"activity-row"});row.append(node("p",`${item.event} · block ${item.blockNumber}`));
    const detail=Object.entries(item.fields).filter(([k])=>["amount","ptAmount","usdcSpent","payee","seriesId","output"].includes(k)).map(([k,v])=>`${k}: ${/^0x/.test(v)?short(v):v}`).join(" · ");
    row.append(node("p",detail,{class:"helper"}));if(state.manifest.network)row.append(node("a","View transaction",{href:`${state.manifest.network.explorer}/tx/${item.transactionHash}`,target:"_blank",rel:"noopener noreferrer"}));$("activity").append(row);}
  if(!feed.items.length)$("activity").append(node("p","No recent activity. This feed reads application events from the most recent 5,000 blocks."));
  notice("Tijori refreshed.");
}
const agentFunded=async wallet=>await wallet.provider.getBalance(setupAgent)>=agentGas/2n;
async function renderSetup(){
  if(!setupAgent)return;const t=state.treasury;
  $("setup-authorize").hidden=!t.address;
  if(!t.address){
    $("initial-agent").value=setupAgent;$("initial-agent").readOnly=true;$("generate-agent").hidden=true;$("setup-fields").hidden=false;
    $("create-helper").textContent="This agent address came from your terminal setup command. Its key stays on your computer. Only continue if it matches the address your terminal printed.";
    return;
  }
  const authorized=getAddress(t.agent)===setupAgent,funded=await agentFunded(state.wallet);
  // The full address is shown because the owner is being asked to trust a value from a link.
  $("setup-authorize-text").textContent=!authorized?`Your terminal setup command made agent ${setupAgent}. Authorizing it replaces the current agent ${short(t.agent)}, which stops working at once. Only continue if this matches the address your terminal printed.`
    :funded?`Agent ${setupAgent} is authorized and has gas. Return to your terminal — setup finishes there.`
    :`Agent ${setupAgent} is authorized but has no gas, so its transactions would fail.`;
  $("setup-authorize-button").hidden=authorized&&funded;$("setup-authorize-button").textContent=authorized?"Send agent 1 USDC of gas":"Authorize agent";
}
async function fundAgent(wallet){if(!await agentFunded(wallet))await showReceipt(await wallet.send(setupAgent,agentGas),wallet);}
async function authorizeSetup(){
  const wallet=requireWallet();
  try{
    if(getAddress(state.treasury.agent)!==setupAgent)await showReceipt(await wallet.write(contract("Tijori",state.treasury.address),"setAgent",[setupAgent]),wallet);
    await fundAgent(wallet);
  }finally{await refreshTreasury();}
  notice("Agent ready. Return to your terminal — setup finishes there.","success");
}
async function createTreasury(){
  const wallet=requireWallet(),factory=contract("TijoriFactory",state.manifest.tijoriFactory);
  const deposit=setupAgent?amount($("initial-deposit").value,true):0n;
  await showReceipt(await wallet.write(factory,"create",[getAddress($("initial-agent").value),amount($("initial-daily").value,true)]),wallet);
  if(!setupAgent)return refreshTreasury();
  // The treasury exists from here on, so a declined later step must still land on its page.
  try{
    await fundAgent(wallet);
    // Read from the wallet's own node: the API may not have seen the new treasury yet.
    if(deposit>0n)await showReceipt(await wallet.approved(contract("Tijori",await factory.tijoriOf(wallet.account)),"deposit",[deposit],state.manifest.usdc,deposit),wallet);
  }finally{await refreshTreasury();}
  notice("Treasury ready. Return to your terminal — setup finishes there.","success");
}
async function treasuryWrite(method,args){const wallet=requireWallet();const receipt=await wallet.write(contract("Tijori",state.treasury.address),method,args);await showReceipt(receipt,wallet);await refreshTreasury();}
function clearKey(){$("one-time-key").value="";$("one-time-key").type="password";$("mcp-config").value="";$("agent-secret").hidden=true;
  $("new-agent-key").value="";$("new-agent-key").type="password";$("new-agent-secret").hidden=true;$("show-new-key").disabled=false;}
// A treasury cannot be created without an agent address, so the wallet is generated here
// rather than leaving a first-time owner with nothing valid to enter.
function generateAgent(){
  const generated=Wallet.createRandom();
  $("initial-agent").value=generated.address;
  $("new-agent-key").value=generated.privateKey;$("new-agent-key").type="password";
  $("new-agent-secret").hidden=false;$("show-new-key").disabled=false;
  notice("Agent wallet generated in this browser. Save the key, then create your treasury.");
}
async function connectAgent(){
  const wallet=requireWallet();if(!state.treasury?.address)throw new Error("AlreadyExists");
  clearKey();const generated=Wallet.createRandom();
  $("one-time-key").value=generated.privateKey;$("agent-public").textContent=`Agent public address: ${generated.address}`;$("agent-secret").hidden=false;
  const config=await api(`/api/agent-config?tijori=${state.treasury.address}`);$("mcp-config").value=JSON.stringify(config,null,2);
  await treasuryWrite("setAgent",[generated.address]);
  notice("Agent authorized. Save its key locally and add the MCP config to Claude Desktop. Fund the agent's gas.","success");
}
const billsKey=()=>`pakka-bills-${state.wallet.account.toLowerCase()}`;
function readBills(){try{const b=JSON.parse(localStorage.getItem(billsKey())??"[]");return Array.isArray(b)?b.slice(0,100):[];}catch{return [];}}
function renderBills(){
  $("bills").replaceChildren();const bills=readBills().sort((a,b)=>a.date.localeCompare(b.date));
  for(const bill of bills){const row=node("div",undefined,{class:"bill-row"});row.append(node("p",`${bill.date} · ${usdc(bill.amount)} · ${short(bill.payee)}`));
    row.append(button("Pay bill",async()=>{await treasuryWrite("pay",[getAddress(bill.payee),amount(bill.amount)]);localStorage.setItem(billsKey(),JSON.stringify(readBills().filter(b=>b.id!==bill.id)));renderBills();}),button("Remove bill",async()=>{localStorage.setItem(billsKey(),JSON.stringify(readBills().filter(b=>b.id!==bill.id)));renderBills();}));$("bills").append(row);}
  if(!bills.length)$("bills").append(node("p","No upcoming bills. Add a date, amount and approved payee."));
}
// Owner tools. Hiding them is a convenience only: every call below is onlyOwner on-chain.
async function detectOwner(){
  state.owner=getAddress(await contract("SeriesRegistry",state.manifest.registry).owner())===state.wallet.account;
  $("owner-link").hidden=!state.owner;
}
function dropOwner(){state.owner=false;$("owner-link").hidden=true;navigate();}
// Same static-fee, hook-free key the registration script attaches.
const poolKey=pt=>{const usdc0=BigInt(state.manifest.usdc)<BigInt(pt);return {currency0:usdc0?state.manifest.usdc:pt,currency1:usdc0?pt:state.manifest.usdc,fee:500,tickSpacing:10,hooks:ZeroAddress};};
function sqrtPrice(usdc0,price){
  const unit=1_000000n,value=(1n<<192n)*(usdc0?unit:price)/(usdc0?price:unit);
  let x=value,y=(x+1n)/2n;while(y<x){x=y;y=(x+value/x)/2n;}return x;
}
// Simple annualized, the convention the quotes use: price = face / (1 + rate × time).
function priceForRate(percent,seconds){
  const rate=amount(percent);if(seconds<=0)throw new Error("SeriesExpired");
  return 1_000000n*100_000000n*31536000n/(100_000000n*31536000n+rate*BigInt(seconds));
}
// The pool's swap fee is paid on top of the price, so a discount smaller than the fee is no discount.
const feeAdjusted=price=>price+(price*500n+999_999n)/1_000000n;
function seedNote(){
  const expiry=state.ownerSeries?.get(Number($("seed-series").value));let text="Choose a series to see the PT price this rate opens at.";
  try{if(expiry){const price=priceForRate($("seed-rate").value,expiry-Math.floor(Date.now()/1000));
    text=feeAdjusted(price)>=1_000000n?"At this rate and maturity the 0.05% pool fee is larger than the discount. Use a higher rate or a longer maturity."
      :`Opens PT at ${formatUnits(price,6)} USDC. Buyers also pay the 0.05% pool fee.`;}}catch{}
  $("seed-price-note").textContent=text;
}
// Liquidity is held by the seeder under the range it was added with. A current seeder reports its
// own positions. One deployed before that cannot, so for those the deployment manifest supplies
// script-seeded ranges and ranges seeded from this page are remembered on this device.
async function positions(id,poolId){
  try{const [list,liquidity]=await contract("PoolSeeder",state.manifest.poolSeeder).positions(id);
    return list.map((r,i)=>[Number(r.tickLower),Number(r.tickUpper),liquidity[i]]);}
  catch{return Promise.all(ranges(id).map(async([lower,upper])=>[lower,upper,await positionLiquidity(poolId,lower,upper)]));}
}
const monthNames=["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
// Token symbols carry the maturity date on mainnet, e.g. PT-USDC-15OCT2026, as the scripts name them.
function seriesLabel(expiry){
  if(state.manifest.network?.name!=="mainnet")return `TEST-${expiry}`;
  const d=new Date(expiry*1000);return `USDC-${String(d.getUTCDate()).padStart(2,"0")}${monthNames[d.getUTCMonth()]}${d.getUTCFullYear()}`;
}
async function openMaturity(){
  const wallet=requireWallet(),days=Number($("open-days").value);if(!Number.isInteger(days)||days<1)throw new Error("InvalidExpiry");
  const expiry=(await wallet.provider.getBlock("latest")).timestamp+days*86400;
  const receipt=await wallet.write(contract("SeriesFactory",state.manifest.seriesFactory),"create",[expiry,seriesLabel(expiry)]);
  await ownerDone(receipt);
  $("seed-series").value=String(await contract("SeriesRegistry",state.manifest.registry).seriesCount());seedNote();
}
const rangesKey=()=>`pakka-lp-${state.manifest.chainId}-${state.manifest.poolSeeder.toLowerCase()}`;
function savedRanges(){try{const r=JSON.parse(localStorage.getItem(rangesKey())??"[]");return Array.isArray(r)?r:[];}catch{return [];}}
function ranges(id){
  const found=new Map();
  for(const m of state.manifest.series)if(m.seriesId===id&&Number.isInteger(m.pool?.tickLower))found.set(`${m.pool.tickLower}:${m.pool.tickUpper}`,[m.pool.tickLower,m.pool.tickUpper]);
  for(const r of savedRanges())if(r.id===id&&Number.isInteger(r.lower)&&Number.isInteger(r.upper))found.set(`${r.lower}:${r.upper}`,[r.lower,r.upper]);
  return [...found.values()];
}
// Mirrors v4 StateLibrary.getPositionLiquidity: pools[poolId].positions[key].liquidity.
async function positionLiquidity(poolId,lower,upper){
  const manager=new Contract(state.manifest.poolManager,["function extsload(bytes32) view returns(bytes32)"],state.wallet.provider);
  const positions=BigInt(solidityPackedKeccak256(["bytes32","uint256"],[poolId,6]))+6n;
  const key=solidityPackedKeccak256(["address","int24","int24","bytes32"],[state.manifest.poolSeeder,lower,upper,ZeroHash]);
  return BigInt(await manager.extsload(solidityPackedKeccak256(["bytes32","uint256"],[key,positions])))&((1n<<128n)-1n);
}
async function withdrawLiquidity(id,lower,upper,liquidity){
  const wallet=requireWallet(),seeder=contract("PoolSeeder",state.manifest.poolSeeder);
  const deadline=(await wallet.provider.getBlock("latest")).timestamp+600;
  const [out0,out1]=await seeder.connect(wallet.signer).removeLiquidity.staticCall(id,lower,upper,liquidity,0,0,deadline);
  await ownerDone(await wallet.write(seeder,"removeLiquidity",[id,lower,upper,liquidity,out0*9950n/10000n,out1*9950n/10000n,deadline]));
}
async function refreshOwner(){
  const wallet=requireWallet(),registry=contract("SeriesRegistry",state.manifest.registry),market=contract("UniswapV4Market",state.manifest.market);
  const now=(await wallet.provider.getBlock("latest")).timestamp,count=Number(await registry.seriesCount()),allPaused=await registry.entriesPaused();
  $("owner-entries").textContent=allPaused?"New entries are paused for every series.":"New entries are open.";
  $("owner-pause-all").textContent=allPaused?"Resume all entries":"Pause all entries";
  $("owner-series").replaceChildren();$("seed-series").replaceChildren(node("option","Choose a series",{value:""}));state.ownerSeries=new Map();
  $("open-form").hidden=!state.manifest.seriesFactory;
  for(const m of state.manifest.series){
    if(m.expiry<=now||await registry.seriesIdByYieldToken(m.yieldToken)!==0n)continue;
    const row=node("div",undefined,{class:"position-row"}),actions=node("div",undefined,{class:"actions"});
    row.append(node("h3",`New maturity · ${date(m.expiry)}`),node("p",`Deployed at ${short(m.yieldToken)} · not registered, so nobody can buy it yet`));
    actions.append(button("Register series",()=>registerSeries(m),{class:"cta"}));row.append(actions);$("owner-series").append(row);
  }
  for(let id=1;id<=count;id++){
    const s=await registry.getSeries(id),live=Number(s.expiry)>now,paused=await registry.seriesEntriesPaused(id);
    const pool=s.hasPool?await market.poolState(id):null;
    let status="Matured";
    if(live&&!s.hasPool)status="Registered · no pool attached";
    else if(live&&pool.sqrtPriceX96===0n)status="Pool attached · not opened";
    else if(live){
      const ratio=(Number(pool.sqrtPriceX96)/2**96)**2,price=BigInt(state.manifest.usdc)<BigInt(s.principalToken)?1/ratio:ratio;
      status=`${pool.liquidity===0n?"Pool opened · no liquidity":"Seeded"} · PT at ${price.toLocaleString(undefined,{maximumFractionDigits:4})} USDC`;
    }
    const row=node("div",undefined,{class:"position-row"}),actions=node("div",undefined,{class:"actions"});
    row.append(node("h3",`Series ${id} · ${date(Number(s.expiry))}`),node("p",live?`${status} · ${allPaused||paused?"Entries paused":"Entries open"}`:status));
    if(live&&!s.hasPool)actions.append(button("Attach pool",()=>ownerWrite("setPoolKey",[id,poolKey(s.principalToken)]),{class:"cta"}));
    if(live)actions.append(button(paused?"Resume entries":"Pause entries",()=>ownerWrite("setSeriesEntriesPaused",[id,!paused])));
    if(live&&s.hasPool){$("seed-series").append(node("option",`Series ${id} · ${date(Number(s.expiry))}`,{value:id}));state.ownerSeries.set(id,Number(s.expiry));}
    if(pool)for(const [lower,upper,liquidity]of await positions(id,pool.poolId)){
      if(liquidity>0n)actions.append(button(live?"Withdraw liquidity":"Withdraw liquidity and fees",()=>withdrawLiquidity(id,lower,upper,liquidity),live?{}:{class:"cta"}));
    }
    row.append(actions);$("owner-series").append(row);
  }
  seedNote();
  if(!$("owner-series").children.length)$("owner-series").append(node("p",state.manifest.seriesFactory?"No series yet. Open a maturity above.":"No series yet. Deploy a maturity with the add:series command, then register it here."));
}
// The public pages read the same registry, so they are refreshed before the receipt is shown.
async function ownerDone(receipt){try{await refreshRates();}catch{}await refreshOwner();await showReceipt(receipt);}
async function ownerWrite(method,args){const wallet=requireWallet();await ownerDone(await wallet.write(contract("SeriesRegistry",state.manifest.registry),method,args));}
async function registerSeries(m){
  const wallet=requireWallet(),registry=contract("SeriesRegistry",state.manifest.registry);let receipt;
  try{
    receipt=await wallet.write(registry,"registerSeries",[m.yieldToken]);
    receipt=await wallet.write(registry,"setPoolKey",[await registry.seriesIdByYieldToken(m.yieldToken),poolKey(m.principalToken)]);
  }finally{await ownerDone(receipt);}
}
// Exact approval for one call, cleared afterwards whether or not the call lands.
async function spend(wallet,token,spender,value,action){
  await wallet.write(token,"approve",[spender,value]);
  try{return await action();}
  finally{if(await token.allowance(wallet.account,spender)>0n)await wallet.write(token,"approve",[spender,0]);}
}
async function seedPool(){
  const wallet=requireWallet(),id=Number($("seed-series").value);if(!id)throw new Error("UnknownSeries");
  const maxPt=amount($("seed-pt").value),maxUsdc=amount($("seed-usdc").value);
  const registry=contract("SeriesRegistry",state.manifest.registry),market=contract("UniswapV4Market",state.manifest.market),seeder=contract("PoolSeeder",state.manifest.poolSeeder);
  const s=await registry.getSeries(id),usdc0=BigInt(state.manifest.usdc)<BigInt(s.principalToken);
  const price=priceForRate($("seed-rate").value,Number(s.expiry)-(await wallet.provider.getBlock("latest")).timestamp);
  if(feeAdjusted(price)>=1_000000n)throw new Error("SEED_RATE_TOO_LOW");
  const asset=new Contract(state.manifest.usdc,tokenAbi,wallet.provider),pt=new Contract(s.principalToken,tokenAbi,wallet.provider),yt=contract("YieldToken",s.yieldToken);
  const held=await pt.balanceOf(wallet.account),needed=held<maxPt?maxPt-held:0n;
  if(await asset.balanceOf(wallet.account)<needed+maxUsdc)throw new Error("INSUFFICIENT_SEED_FUNDS");
  let receipt;
  try{
    if((await market.poolState(id)).sqrtPriceX96===0n)receipt=await wallet.write(seeder,"initializePool",[id,sqrtPrice(usdc0,price)]);
    if(needed>0n)receipt=await spend(wallet,asset,yt.target,needed,()=>wallet.write(yt,"splitFromAssets",[needed,wallet.account]));
    // A 1,200-tick band around the current price, as the seeding script uses.
    const lower=Math.floor(Number((await market.poolState(id)).tick)/10)*10-600,upper=lower+1200;
    const [max0,max1]=usdc0?[maxUsdc,maxPt]:[maxPt,maxUsdc];
    const liquidity=await seeder.liquidityForAmounts(id,lower,upper,max0,max1);if(liquidity===0n)throw new Error("InvalidAmount");
    const deadline=Math.min((await wallet.provider.getBlock("latest")).timestamp+600,Number(s.expiry)-1);
    receipt=await spend(wallet,asset,seeder.target,maxUsdc,()=>spend(wallet,pt,seeder.target,maxPt,
      ()=>wallet.write(seeder,"addLiquidity",[id,lower,upper,liquidity,max0,max1,deadline])));
    localStorage.setItem(rangesKey(),JSON.stringify([...savedRanges().filter(r=>r.id!==id||r.lower!==lower),{id,lower,upper}].slice(-200)));
  }finally{await ownerDone(receipt);}
}
function form(id,action){$(id).addEventListener("submit",e=>{e.preventDefault();void run(action);});}
$("connect").addEventListener("click",()=>run(async()=>{
  if(!window.ethereum)throw new Error("WALLET_REQUIRED");if(!state.manifest)throw new Error("TESTNET_DEPLOYMENT_MISSING");
  const wallet=new AppWallet(window.ethereum,state.manifest);await wallet.connect();state.wallet=wallet;$("connect").textContent=short(wallet.account);$("connect").classList.add("account");$("tijori-intro").hidden=true;
  await detectOwner();navigate();
  if(await wallet.pending()){const receipt=await wallet.status();await showReceipt(receipt,wallet);}
  await refreshPositions();await refreshTreasury();if(state.owner)await refreshOwner();notice("Wallet connected.");
}));
$("tijori-connect").onclick=()=>$("connect").click();
$("refresh-rates").onclick=()=>run(refreshRates);$("get-quote").onclick=()=>run(getQuote);form("lock-form",lock);
$("face").oninput=invalidateQuote;$("maturity").onchange=invalidateQuote;
$("yield-preview").onclick=()=>run(previewYield);form("yield-form",buyYield);$("yield-amount").oninput=invalidateYield;$("yield-maturity").onchange=invalidateYield;
$("refresh-positions").onclick=()=>run(refreshPositions);$("refresh-treasury").onclick=()=>run(refreshTreasury);
form("create-form",createTreasury);$("setup-authorize-button").onclick=()=>run(authorizeSetup);
form("deposit-form",async()=>{const wallet=requireWallet(),value=amount($("deposit-amount").value);await showReceipt(await wallet.approved(contract("Tijori",state.treasury.address),"deposit",[value],state.manifest.usdc,value),wallet);await refreshTreasury();});
form("payee-form",()=>treasuryWrite("setPayeeCap",[getAddress($("payee-address").value),amount($("payee-cap").value,true)]));
form("policy-form",()=>treasuryWrite("setDailyCap",[amount($("daily-cap").value,true)]));
$("pause-agent").onclick=()=>run(()=>treasuryWrite("setPaused",[!state.treasury.paused]));$("rotate-agent").onclick=()=>run(()=>treasuryWrite("setAgent",[getAddress($("new-agent").value)]));
form("withdraw-form",()=>treasuryWrite("withdraw",[state.manifest.usdc,amount($("withdraw-amount").value)]));
$("connect-agent").onclick=()=>run(connectAgent);$("hide-key").onclick=clearKey;$("show-key").onclick=()=>{$("one-time-key").type="text";$("show-key").disabled=true;};
$("generate-agent").onclick=()=>run(async()=>generateAgent());
$("show-new-key").onclick=()=>{$("new-agent-key").type="text";$("show-new-key").disabled=true;};
$("copy-new-key").onclick=()=>run(async()=>{if(!$("new-agent-key").value)return;await navigator.clipboard.writeText($("new-agent-key").value);notice("Agent key copied. Save it before creating the treasury.");});
$("copy-key").onclick=()=>run(async()=>{if(!$("one-time-key").value)return;await navigator.clipboard.writeText($("one-time-key").value);$("one-time-key").value="";notice("Key copied and cleared from the field. Save it in your local configuration.");});
$("refresh-owner").onclick=()=>run(async()=>{await refreshOwner();notice("Owner view refreshed.");});form("seed-form",seedPool);form("open-form",openMaturity);
$("seed-rate").oninput=seedNote;$("seed-series").onchange=seedNote;
$("owner-pause-all").onclick=()=>run(async()=>ownerWrite("setEntriesPaused",[!await contract("SeriesRegistry",state.manifest.registry).entriesPaused()]));
$("copy-config").onclick=()=>run(async()=>{await navigator.clipboard.writeText($("mcp-config").value);notice("MCP config copied. Replace the key placeholder only in your local file.");});
form("bill-form",async()=>{const bills=readBills();if(bills.length>=100)throw new Error("InvalidAmount");const bill={id:crypto.randomUUID(),payee:getAddress($("bill-payee").value),amount:formatUnits(amount($("bill-amount").value),6),date:$("bill-date").value};localStorage.setItem(billsKey(),JSON.stringify([...bills,bill]));renderBills();notice("Bill added to this device's calendar.");});
window.addEventListener("hashchange",navigate);window.addEventListener("pagehide",clearKey);
window.ethereum?.on?.("accountsChanged",()=>{clearKey();state.wallet=null;state.treasury=null;$("connect").textContent="Connect wallet";$("connect").classList.remove("account");$("tijori-intro").hidden=false;$("treasury-controls").hidden=true;$("create-form").hidden=true;$("setup-authorize").hidden=true;$("positions-list").replaceChildren(node("p","Wallet changed. Reconnect to refresh positions."));dropOwner();notice("Wallet changed. Reconnect before continuing.");});
window.ethereum?.on?.("chainChanged",()=>{clearKey();state.wallet=null;$("connect").textContent="Connect wallet";$("connect").classList.remove("account");$("tijori-intro").hidden=false;invalidateQuote();invalidateYield();dropOwner();notice("Network changed. Reconnect on the Arc network this app uses.");});
navigate();
if(setupAgent)$("treasury-status").textContent="Connect your wallet to approve the agent from your terminal setup.";
try{
  const [manifest,abis]=await Promise.all([api("/api/deployment"),api("/api/abis")]);state.manifest=manifest;state.abis=abis;
  const mainnet=manifest.network?.name==="mainnet";
  $("network-status").textContent=manifest.network?.label??"Local test chain";
  // Real funds change what the user needs to be told, so the standing notes follow the deployment.
  $("network-name").textContent=manifest.network?.label??"Local test chain";
  $("network-note").textContent=mainnet?"Unaudited · real funds at risk":"Faucet funds only";
  $("build-note").textContent=mainnet?"Unaudited build":"Testnet build";
  await refreshRates();
}catch(e){notice(humanError(e,interfaces()),"error");$("rates-list").replaceChildren(node("p","Rates are unavailable until the deployment and pools are ready."));}

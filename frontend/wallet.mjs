import { BrowserProvider, Contract, formatUnits, getAddress } from "/ethers.mjs";
const tokenAbi=["function approve(address,uint256) returns(bool)","function allowance(address,address) view returns(uint256)"];
const batchKey="pakka-pending-wallet-batch";
const fail=code=>{throw Object.assign(new Error(code),{code});};
export class AppWallet {
  constructor(injected,manifest){this.injected=injected;this.manifest=manifest;this.provider=new BrowserProvider(injected,undefined,{cacheTimeout:-1});}
  async connect(){await this.injected.request({method:"eth_requestAccounts"});await this.network();this.signer=await this.provider.getSigner();this.account=await this.signer.getAddress();return this.account;}
  async network(){
    const chainId=this.manifest.chainId;
    if(![5042002,31337].includes(chainId)) fail("WRONG_WALLET_NETWORK");
    const hex=`0x${chainId.toString(16)}`;
    if(BigInt(await this.injected.request({method:"eth_chainId"}))!==BigInt(chainId)) {
      try{await this.injected.request({method:"wallet_switchEthereumChain",params:[{chainId:hex}]});}
      catch(e){if(e.code!==4902 || chainId!==5042002) throw e;
        await this.injected.request({method:"wallet_addEthereumChain",params:[{chainId:hex,chainName:"Arc Testnet",nativeCurrency:{name:"USDC",symbol:"USDC",decimals:18},rpcUrls:["https://rpc.testnet.arc.io"],blockExplorerUrls:["https://testnet.arcscan.app"]}]});
      }
    }
    if(BigInt(await this.injected.request({method:"eth_chainId"}))!==BigInt(chainId)) fail("WRONG_WALLET_NETWORK");
  }
  async check(){await this.network();const accounts=await this.injected.request({method:"eth_accounts"});if(!accounts[0]||getAddress(accounts[0])!==this.account)fail("ACCOUNT_CHANGED");}
  pending(){return JSON.parse(localStorage.getItem(batchKey)??"null");}
  async write(contract,method,args){
    if(this.pending()) fail("BATCH_PENDING");await this.check();
    const connected=contract.connect(this.signer);await connected[method].staticCall(...args);
    const tx=await connected[method](...args);return tx.wait();
  }
  async send(to,value){
    if(this.pending()) fail("BATCH_PENDING");await this.check();
    const tx=await this.signer.sendTransaction({to,value});return tx.wait();
  }
  async status(){
    const pending=this.pending();if(!pending)return null;
    if(pending.account!==this.account || pending.chainId!==this.manifest.chainId) fail("BATCH_PENDING");
    const result=await this.injected.request({method:"wallet_getCallsStatus",params:[pending.id]});
    if(result.status>=200&&result.status<300){
      if(!result.atomic || BigInt(result.chainId)!==BigInt(this.manifest.chainId))fail("BATCH_NOT_ATOMIC");
      if(!result.receipts?.length || result.receipts.some(r=>BigInt(r.status)!==1n))fail("BATCH_FAILED");
      const receipt=await this.provider.getTransactionReceipt(result.receipts.at(-1).transactionHash);
      if(!receipt || receipt.status!==1) fail("BATCH_PENDING");
      const block=await this.provider.getBlock(receipt.blockNumber);
      if(block?.hash!==receipt.blockHash) fail("BATCH_PENDING");
      localStorage.removeItem(batchKey);
      return receipt;
    }
    if(result.status===400){localStorage.removeItem(batchKey);fail("BATCH_FAILED");}
    if(result.status>=500){
      if(result.status===500 && result.atomic && result.receipts?.length &&
        result.receipts.every(r=>BigInt(r.status)===0n)) localStorage.removeItem(batchKey);
      fail("BATCH_FAILED");
    }
    fail("BATCH_PENDING");
  }
  async approved(contract,method,args,tokenAddress,spend,{batch=false,prepare}={}){
    if(this.pending())fail("BATCH_PENDING");await this.check();
    const token=new Contract(tokenAddress,tokenAbi,this.signer);
    if(batch){
      let capabilities;try{capabilities=await this.injected.request({method:"wallet_getCapabilities",params:[this.account,[`0x${this.manifest.chainId.toString(16)}`]]});}catch{}
      const atomic=capabilities?.[`0x${this.manifest.chainId.toString(16)}`]?.atomic?.status;
      if(["supported","ready"].includes(atomic)){
        const id=`0x${Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,"0")).join("")}`;
        localStorage.setItem(batchKey,JSON.stringify({id,account:this.account,chainId:this.manifest.chainId}));
        try{
          const result=await this.injected.request({method:"wallet_sendCalls",params:[{version:"2.0.0",id,from:this.account,
            chainId:`0x${this.manifest.chainId.toString(16)}`,atomicRequired:true,calls:[
              {to:tokenAddress,data:token.interface.encodeFunctionData("approve",[contract.target,0]),value:"0x0"},
              {to:tokenAddress,data:token.interface.encodeFunctionData("approve",[contract.target,spend]),value:"0x0"},
              {to:contract.target,data:contract.interface.encodeFunctionData(method,args),value:"0x0"},
              {to:tokenAddress,data:token.interface.encodeFunctionData("approve",[contract.target,0]),value:"0x0"}]}]});
          if(result.id!==id) fail("BATCH_PENDING");
        }catch(e){if(e.code===4001){localStorage.removeItem(batchKey);throw e;}fail("BATCH_PENDING");}
        for(let i=0;i<60;i++){try{return await this.status();}catch(e){if(e.code!=="BATCH_PENDING")throw e;}await new Promise(r=>setTimeout(r,1000));}
        fail("BATCH_PENDING");
      }
    }
    // Two wallet transactions when atomic batching is unsupported. Exact approval, then cleanup.
    if(await token.allowance(this.account,contract.target)>0n)await this.write(token,"approve",[contract.target,0]);
    await this.write(token,"approve",[contract.target,spend]);
    try{return await this.write(contract,method,prepare?await prepare():args);}
    finally{if(await token.allowance(this.account,contract.target)>0n)await this.write(token,"approve",[contract.target,0]);}
  }
  async gasUsdc(receipt){
    if(!receipt)return "—";
    const tx=await this.provider.getTransaction(receipt.hash);
    const price=receipt.gasPrice??tx?.gasPrice;
    return price===null||price===undefined?"—":formatUnits(receipt.gasUsed*price,18);
  }
}

// The landing page and guide are static, so the network they describe is read from the
// deployment. The markup's own wording is network-neutral and stays if this cannot load.
try{
  const r=await fetch("/api/deployment",{cache:"no-store"});
  if(r.ok){
    const net=(await r.json()).network;
    if(net){
      const mainnet=net.name==="mainnet";
      for(const e of document.querySelectorAll("[data-network]"))e.textContent=mainnet?"Arc mainnet":net.label;
      for(const e of document.querySelectorAll("[data-network-note]"))e.textContent=mainnet
        ?"Live on Arc mainnet — unaudited and capped at 500 USDC per series. Real funds are at risk."
        :"Live on Arc Testnet — unaudited, demo liquidity, testnet funds only.";
    }
  }
}catch{}

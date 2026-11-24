require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs/promises");

const app = express();
const PORT = Number(process.env.PORT || 8080);
const ME_BASE = "https://api-mainnet.magiceden.dev/v2";
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const HELIUS_RPC = HELIUS_API_KEY ? "https://mainnet.helius-rpc.com/?api-key=" + encodeURIComponent(HELIUS_API_KEY) : "";
const TOKEN_METADATA_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const MAGIC_EDEN_PROGRAMS = ["M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K", "mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc"];
const TENSOR_PROGRAMS = ["TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp", "TAMM6ub33ij1mbetoMyVBLeKY5iP41i4UPUJQGkhfsg"];
const globalSales = new Map(), tensorSales = new Map(), recentMints = new Map();
const seenMagic = new Set(), seenTensor = new Set(), seenMints = new Set();
let magicLastPollAt=null, magicPollError=null, tensorLastPollAt=null, tensorPollError=null, mintLastPollAt=null, mintPollError=null;
let magicBaselineReady=false, magicBusy=false, tensorBusy=false, mintBusy=false;
let collectionsCache=null, collectionsCacheAt=0, directoryCache=null, directoryCacheAt=0, collectionMintCache=null, collectionMintCacheAt=0;

app.use(express.static(path.join(__dirname,"public")));
app.use(express.json());

const sol = value => {
  if (value===null || value===undefined || value==="") return null;
  const n=Number(value); if(!Number.isFinite(n)) return null;
  return n>100000 ? n/1e9 : n;
};
async function meGet(route) {
  const response=await fetch(ME_BASE+route,{headers:{accept:"application/json",...(process.env.MAGIC_EDEN_API_KEY?{Authorization:"Bearer "+process.env.MAGIC_EDEN_API_KEY}:{})},signal:AbortSignal.timeout(12000)});
  if(!response.ok) throw new Error("Magic Eden API returned "+response.status);
  return response.json();
}
async function heliusRpc(method,params) {
  if(!HELIUS_RPC) throw new Error("HELIUS_API_KEY is not configured in Railway Variables.");
  const response=await fetch(HELIUS_RPC,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:"nft-monitor",method,params}),signal:AbortSignal.timeout(12000)});
  if(!response.ok) throw new Error("Helius RPC returned "+response.status);
  const json=await response.json(); if(json.error) throw new Error(json.error.message||"Helius RPC error");
  return json.result;
}
async function parseTransactions(signatures) {
  if(!signatures.length) return [];
  const response=await fetch("https://api-mainnet.helius-rpc.com/v0/transactions?api-key="+encodeURIComponent(HELIUS_API_KEY),{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({transactions:signatures}),signal:AbortSignal.timeout(15000)
  });
  if(!response.ok) throw new Error("Helius transaction parser returned "+response.status);
  const parsed=await response.json(); if(!Array.isArray(parsed)) throw new Error("Unexpected Helius parsed-transactions response");
  return parsed;
}
function trimMap(map,limit,cutoff) {
  for(const [key,value] of map) if(cutoff && value.time<cutoff) map.delete(key);
  while(map.size>limit) map.delete(map.keys().next().value);
}
async function pollGlobalSales() {
  if(magicBusy||!HELIUS_API_KEY)return; magicBusy=true;
  try {
    const groups=await Promise.all(MAGIC_EDEN_PROGRAMS.map(address=>heliusRpc("getSignaturesForAddress",[address,{limit:50,commitment:"confirmed"}])));
    const signatures=groups.flat().filter(x=>x?.signature);
    if(!magicBaselineReady){signatures.forEach(x=>seenMagic.add(x.signature));magicBaselineReady=true;magicLastPollAt=new Date().toISOString();magicPollError=null;return;}
    const fresh=signatures.filter(x=>!seenMagic.has(x.signature)).slice(0,100);
    if(fresh.length){
      const parsed=await parseTransactions(fresh.map(x=>x.signature));
      fresh.forEach(x=>seenMagic.add(x.signature));
      for(const tx of parsed){
        if(!String(tx.source||"").toUpperCase().includes("MAGIC_EDEN")||String(tx.type||"").toUpperCase()!=="NFT_SALE")continue;
        const nft=tx.events?.nft||{}, amount=Number(nft.amount??nft.saleAmount), timestamp=Number(tx.timestamp||nft.timestamp);
        const first=(Array.isArray(nft.nfts)?nft.nfts:[])[0]||{}, collection=first.collection||nft.collection||{}, signature=tx.signature;
        if(!signature||!Number.isFinite(amount)||amount<=0||!Number.isFinite(timestamp)||timestamp<=0)continue;
        const mint=first.mint||first.assetId||first.id||"", symbol=String(collection.symbol||collection.name||"Magic Eden");
        let assetName=first.name||first.metadata?.name||first.content?.metadata?.name||"";
        if(!assetName&&mint){try{const asset=await heliusRpc("getAsset",{id:mint});assetName=asset?.content?.metadata?.name||asset?.content?.metadata?.symbol||"";}catch{}}
        globalSales.set(signature,{id:signature,name:assetName||"NFT",symbol,collection:collection.name||symbol,mint,time:timestamp*1000,price:amount>100000?amount/1e9:amount,marketplace:"Magic Eden",signature});
      }
    }
    trimMap(seenMagic,10000);trimMap(globalSales,500,Date.now()-12*60*60*1000);
    magicLastPollAt=new Date().toISOString();magicPollError=null;
  }catch(error){magicPollError=error.message;}finally{magicBusy=false;}
}
async function pollTensorSales() {
  if(tensorBusy||!HELIUS_API_KEY)return;tensorBusy=true;
  try{
    const groups=await Promise.all(TENSOR_PROGRAMS.map(address=>heliusRpc("getSignaturesForAddress",[address,{limit:50,commitment:"confirmed"}])));
    const fresh=groups.flat().filter(x=>x?.signature&&!seenTensor.has(x.signature)).slice(0,100);
    if(fresh.length){
      const parsed=await parseTransactions(fresh.map(x=>x.signature));fresh.forEach(x=>seenTensor.add(x.signature));
      for(const tx of parsed){
        if(String(tx.source||"").toUpperCase()!=="TENSOR"||String(tx.type||"").toUpperCase()!=="NFT_SALE")continue;
        const nft=tx.events?.nft||{},amount=Number(nft.amount??nft.saleAmount),timestamp=Number(tx.timestamp||nft.timestamp),id=tx.signature;
        if(!id||!Number.isFinite(amount)||amount<=0||!Number.isFinite(timestamp)||timestamp<=0)continue;
        const first=(Array.isArray(nft.nfts)?nft.nfts:[])[0]||{},mint=first.mint||first.assetId||"";
        let asset=null,assetName="",symbol="",collection="";
        if(mint){try{asset=await heliusRpc("getAsset",{id:mint});}catch{}}
        const metadata=asset?.content?.metadata||{};
        assetName=metadata.name||asset?.content?.files?.[0]?.name||"";
        const grouping=Array.isArray(asset?.grouping)?asset.grouping.find(x=>x.group_key==="collection"):null;
        symbol=asset?.content?.metadata?.symbol||"";
        collection=grouping?.group_value||symbol||"Tensor";
        const price=amount>100000?amount/1e9:amount;
        tensorSales.set(id,{id,name:assetName||"NFT",symbol,collection,mint,time:timestamp*1000,price,marketplace:"Tensor",signature:id});
      }
    }
    trimMap(seenTensor,10000);trimMap(tensorSales,500,Date.now()-12*60*60*1000);
    tensorLastPollAt=new Date().toISOString();tensorPollError=null;
  }catch(error){tensorPollError=error.message;}finally{tensorBusy=false;}
}
async function pollNewMints() {
  if(mintBusy||!HELIUS_API_KEY)return;mintBusy=true;
  try{
    const signatures=await heliusRpc("getSignaturesForAddress",[TOKEN_METADATA_PROGRAM,{limit:50,commitment:"confirmed"}]);
    const fresh=(Array.isArray(signatures)?signatures:[]).filter(x=>x?.signature&&!seenMints.has(x.signature)).slice(0,50);
    if(fresh.length){
      const parsed=await parseTransactions(fresh.map(x=>x.signature));fresh.forEach(x=>seenMints.add(x.signature));
      for(const tx of parsed){
        const type=String(tx.type||"").toUpperCase();if(type!=="NFT_MINT"&&type!=="COMPRESSED_NFT_MINT")continue;
        const nft=tx.events?.nft||{},items=Array.isArray(nft.nfts)?nft.nfts:[nft],compressed=[].concat(tx.events?.compressed||[]);
        for(const asset of (type==="COMPRESSED_NFT_MINT"?compressed:items)){
          const mint=asset.mint||asset.mintAddress||asset.assetId||asset.address;if(!mint||recentMints.has(mint))continue;
          const metadata=asset.metadata||asset.content?.metadata||{};
          recentMints.set(mint,{mint,name:asset.name||metadata.name||"New NFT mint",symbol:asset.symbol||metadata.symbol||"",collection:asset.collection?.name||asset.collectionName||"",signature:tx.signature||"",time:Number(tx.timestamp||Date.now()/1000)*1000,standard:type==="COMPRESSED_NFT_MINT"?"Compressed NFT":"NFT"});
        }
      }
    }
    trimMap(seenMints,5000);trimMap(recentMints,150,Date.now()-24*60*60*1000);
    mintLastPollAt=new Date().toISOString();mintPollError=null;
  }catch(error){mintPollError=error.message;}finally{mintBusy=false;}
}
function volumeWindow(map,minutes){
  const cutoff=Date.now()-minutes*60000,items=[...map.values()].filter(x=>x.time>=cutoff);
  return {sol:items.reduce((sum,x)=>sum+x.price,0),sales:items.length};
}
const windows=()=>({"5m":5,"10m":10,"15m":15,"1h":60,"4h":240,"6h":360,"12h":720});

app.get("/api/health",(_req,res)=>res.json({ok:true,marketplaces:["Magic Eden","Tensor"],helius:HELIUS_API_KEY?"configured":"missing",tensorApi:"not_configured",timestamp:new Date().toISOString(),lastPollAt:magicLastPollAt,warning:magicPollError,tensorLastPollAt,tensorWarning:tensorPollError}));
app.get("/api/collections",async(_req,res)=>{
  try{
    if(collectionsCache&&Date.now()-collectionsCacheAt<60000)return res.json(collectionsCache);
    const raw=await meGet("/collections?offset=0&limit=100");
    const collections=(Array.isArray(raw)?raw:[]).filter(c=>c?.symbol).map(c=>({symbol:c.symbol,name:c.name||c.symbol,image:c.image||c.imageURI||"",floorPrice:sol(c.floorPrice),listedCount:c.listedCount??null,volume24h:sol(c.volume24hr??c.volume24h),highestBid:null,volumeAll:sol(c.volumeAll),source:"Magic Eden"}));
    for(let i=0;i<Math.min(collections.length,30);i+=5)await Promise.all(collections.slice(i,i+5).map(async c=>{try{const s=await meGet("/collections/"+encodeURIComponent(c.symbol)+"/stats");c.floorPrice=sol(s.floorPrice)??c.floorPrice;c.highestBid=sol(s.highestBid??s.highestOffer??s.highestBidPrice);c.listedCount=s.listedCount??c.listedCount;c.volume24h=sol(s.volume24hr??s.volume24h)??c.volume24h;}catch{}}));
    collectionsCache={collections,source:"Magic Eden collection stats"};collectionsCacheAt=Date.now();res.json(collectionsCache);
  }catch(error){res.status(502).json({collections:[],error:error.message});}
});
app.get("/api/collections/search",async(req,res)=>{
  try{
    const q=String(req.query.q||"").trim().toLowerCase();if(!q)return res.json({collections:[]});
    if(!directoryCache||Date.now()-directoryCacheAt>10*60*1000){
      const raw=await meGet("/collections?offset=0&limit=500");
      directoryCache=(Array.isArray(raw)?raw:[]).filter(c=>c?.symbol).map(c=>({symbol:c.symbol,name:c.name||c.symbol,image:c.image||c.imageURI||"",floorPrice:sol(c.floorPrice),listedCount:c.listedCount??null,volume24h:sol(c.volume24hr??c.volume24h),source:"Magic Eden"}));directoryCacheAt=Date.now();
    }
    res.json({collections:directoryCache.filter(c=>(c.name+" "+c.symbol).toLowerCase().includes(q)).slice(0,30),indexed:directoryCache.length});
  }catch(error){res.status(502).json({collections:[],error:error.message});}
});
app.get("/api/collection/:symbol/stats",async(req,res)=>{
  try{const s=await meGet("/collections/"+encodeURIComponent(req.params.symbol)+"/stats");res.json({floorPrice:sol(s.floorPrice),listedCount:s.listedCount??null,volume24h:sol(s.volume24hr??s.volume24h),volume7d:sol(s.volume7d),highestBid:sol(s.highestBid??s.highestOffer??s.highestBidPrice)});}
  catch(error){res.status(502).json({error:error.message});}
});
app.get("/api/collection/:symbol/activities",async(req,res)=>{
  try{const limit=Math.min(500,Math.max(1,Number(req.query.limit||100))),data=await meGet("/collections/"+encodeURIComponent(req.params.symbol)+"/activities?offset=0&limit="+limit);res.json({activities:Array.isArray(data)?data:(data.activities||data.results||[]),source:"Magic Eden"});}
  catch(error){res.status(502).json({activities:[],error:error.message});}
});
app.get("/api/collection/:symbol/listings",async(req,res)=>{
  try{const limit=Math.min(100,Math.max(1,Number(req.query.limit||50))),offset=Math.max(0,Number(req.query.offset||0));const data=await meGet("/collections/"+encodeURIComponent(req.params.symbol)+"/listings?offset="+offset+"&limit="+limit+"&sort=listPrice&sort_direction=asc&listingAggMode=true");res.json({listings:Array.isArray(data)?data:[],source:"Magic Eden"});}
  catch(error){res.status(502).json({listings:[],error:error.message});}
});
app.get("/api/live-sales",(_req,res)=>{const sales=[...globalSales.values(),...tensorSales.values()].sort((a,b)=>b.time-a.time).slice(0,100);res.json({sales,source:"Magic Eden + Tensor on-chain via Helius",lastPollAt:magicLastPollAt,tensorLastPollAt,warning:magicPollError,tensorWarning:tensorPollError,note:"Observed sales since this monitor started; not historical backfill. Tensor floor and bid quotes require Tensor API access."});});
app.get("/api/new-mints",(_req,res)=>res.json({mints:[...recentMints.values()].sort((a,b)=>b.time-a.time),source:"Helius Mainnet",lastPollAt:mintLastPollAt,warning:mintPollError,note:"Only Helius-classified NFT mint transactions are shown; this is not a complete mint index."}));
app.get("/api/collection-mints",async(req,res)=>{
  try{
    if(!req.query.refresh&&collectionMintCache&&Date.now()-collectionMintCacheAt<5*60*1000)return res.json(collectionMintCache);
    const base=await meGet("/collections?offset=0&limit=100");
    const list=(Array.isArray(base)?base:[]).filter(c=>c?.symbol),rows=[];
    for(let i=0;i<list.length;i+=5){
      const batch=await Promise.all(list.slice(i,i+5).map(async c=>{
        let detail={},stats={};
        try{[detail,stats]=await Promise.all([
          meGet("/collections/"+encodeURIComponent(c.symbol)),
          meGet("/collections/"+encodeURIComponent(c.symbol)+"/stats")
        ]);}catch{}
        const pick=(obj,keys)=>{for(const k of keys){const v=obj?.[k];if(v!==undefined&&v!==null&&v!==""){const n=Number(v);return Number.isFinite(n)?n:v;}}return null;};
        // Total cap and currently minted/indexed supply are separate source fields.
        const totalNfts=pick(detail,["maxSupply","max_supply","totalSupply","total_supply","size"])??pick(stats,["maxSupply","max_supply","totalSupply","total_supply","size"]);
        const minted=pick(detail,["totalItems","total_items","minted","mintedCount","minted_count"])??pick(stats,["totalItems","total_items","minted","mintedCount","minted_count","supply"]);
        const mintPrice=pick(detail,["mintPrice","mintPriceSol","mint_price","mint_price_sol"])??pick(stats,["mintPrice","mintPriceSol","mint_price","mint_price_sol"]);
        return {symbol:c.symbol,name:c.name||detail.name||c.symbol,image:c.image||detail.image||detail.imageURI||"",totalNfts,minted,mintPrice};
      }));
      rows.push(...batch);
    }
    const data={collections:rows,collectionsWithMintData:rows.filter(c=>c.totalNfts!==null||c.minted!==null||c.mintPrice!==null).length,source:"Magic Eden collection metadata and stats",warning:"A — means Magic Eden did not publish that field for the collection; it is not estimated."};
    collectionMintCache=data;collectionMintCacheAt=Date.now();res.json(data);
  }catch(error){res.status(502).json({collections:[],error:error.message,warning:"Could not retrieve collection mint details."});}
});
app.get("/api/volume",(_req,res)=>{
  const combined=new Map([...globalSales,...tensorSales]),result={};
  for(const [label,mins] of Object.entries(windows()))result[label]=volumeWindow(combined,mins);
  res.json({windows:result,lastPollAt:magicLastPollAt,tensorLastPollAt,warning:magicPollError,tensorWarning:tensorPollError,source:"Observed Magic Eden + Tensor sales"});
});
app.get("/api/tensor/volume",(_req,res)=>{
  const result={};for(const [label,mins] of Object.entries(windows()))result[label]=volumeWindow(tensorSales,mins);
  res.json({windows:result,lastPollAt:tensorLastPollAt,warning:tensorPollError,source:"Helius parsed Tensor sales",note:"Read-only observed activity; no Tensor API key or bid functionality used."});
});
app.get("/api/new",async(_req,res)=>{
  try{const raw=await meGet("/collections?offset=0&limit=500");const collections=(Array.isArray(raw)?raw:[]).filter(c=>c.symbol&&c.createdAt&&Number.isFinite(new Date(c.createdAt).getTime())).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,20).map(c=>({symbol:c.symbol,name:c.name||c.symbol,image:c.image||c.imageURI||"",floorPrice:sol(c.floorPrice),createdAt:c.createdAt}));res.json({collections,source:"Magic Eden"});}
  catch(error){res.status(502).json({collections:[],error:error.message});}
});

async function removeLegacyBotData(){
  for(const file of ["/data/sniper-rules.json","/data/bid-rules.json"]){
    try{await fs.unlink(file);}catch(error){if(error.code!=="ENOENT")console.error("Could not remove legacy bot data:",error.message);}
  }
}
removeLegacyBotData();

app.listen(PORT,()=>console.log("NFT Monitor running on port "+PORT));
setInterval(()=>{pollGlobalSales();pollTensorSales();pollNewMints();},12000);
pollGlobalSales();pollTensorSales();pollNewMints();

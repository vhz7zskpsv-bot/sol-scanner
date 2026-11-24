require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ME_BASE = "https://api-mainnet.magiceden.dev/v2";
const HELIUS_RPC = process.env.HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
  : null;

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || null;
const TOKEN_METADATA_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const recentMints = new Map();
const seenMintSignatures = new Set();
let lastMintPollAt = null;
let mintPollError = null;

async function heliusRpc(method, params) {
  if (!HELIUS_RPC) throw new Error("HELIUS_API_KEY is not configured");
  const response = await fetch(HELIUS_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "sol-scanner", method, params }),
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`Helius RPC returned ${response.status}`);
  const json = await response.json();
  if (json.error) throw new Error(json.error.message || "Helius RPC error");
  return json.result;
}

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const meHeaders = () => ({
  accept: "application/json",
  ...(process.env.MAGIC_EDEN_API_KEY ? { Authorization: `Bearer ${process.env.MAGIC_EDEN_API_KEY}` } : {})
});

async function meGet(route) {
  const response = await fetch(ME_BASE + route, { headers: meHeaders(), signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Magic Eden API returned ${response.status}`);
  return response.json();
}

const sol = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n > 100000 ? n / 1e9 : n;
};

const sales = new Map();
const tensorSales = new Map();
const tensorSeenSignatures = new Set();
const TENSOR_PROGRAMS = [
  "TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp",
  "TAMM6ub33ij1mbetoMyVBLeKY5iP41i4UPUJQGkhfsg"
];
let tensorLastPollAt = null;
let tensorPollError = null;
const tracked = new Set();
let collectionPollCursor = 0;
let marketplaceCollections = [];
let collectionListFetchedAt = 0;
let salesPollBusy = false;

async function pollTensorSales() {
  if (!HELIUS_API_KEY) {
    tensorPollError = "Helius API key is not configured";
    return;
  }
  try {
    const signatureGroups = await Promise.all(TENSOR_PROGRAMS.map(address =>
      heliusRpc("getSignaturesForAddress", [address, { limit: 25, commitment: "confirmed" }])
    ));
    const fresh = signatureGroups.flat()
      .filter(item => item.signature && !tensorSeenSignatures.has(item.signature))
      .slice(0, 50);
    if (fresh.length) {
      const response = await fetch(
        `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${encodeURIComponent(HELIUS_API_KEY)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ transactions: fresh.map(item => item.signature) }),
          signal: AbortSignal.timeout(15000)
        }
      );
      if (!response.ok) throw new Error(`Helius transaction parser returned ${response.status}`);
      const parsed = await response.json();
      if (!Array.isArray(parsed)) throw new Error("Unexpected Helius parsed-transactions response");
      for (const item of fresh) tensorSeenSignatures.add(item.signature);
      for (const tx of parsed) {
        if (String(tx.source || "").toUpperCase() !== "TENSOR" ||
            String(tx.type || "").toUpperCase() !== "NFT_SALE") continue;
        const nftEvent = tx.events?.nft;
        const amountLamports = Number(nftEvent?.amount ?? nftEvent?.saleAmount);
        const timestamp = Number(tx.timestamp || nftEvent?.timestamp);
        if (!Number.isFinite(amountLamports) || amountLamports <= 0 ||
            !Number.isFinite(timestamp) || timestamp <= 0) continue;
        const id = tx.signature || nftEvent?.signature;
        if (!id || tensorSales.has(id)) continue;
        tensorSales.set(id, {
          id, time: timestamp * 1000, price: amountLamports / 1e9,
          source: "Helius parsed on-chain Tensor NFT sale"
        });
      }
    }
    while (tensorSeenSignatures.size > 5000) tensorSeenSignatures.delete(tensorSeenSignatures.values().next().value);
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const [id, sale] of tensorSales) if (sale.time < cutoff) tensorSales.delete(id);
    tensorLastPollAt = new Date().toISOString();
    tensorPollError = null;
  } catch (error) {
    tensorPollError = error.message;
  }
}
function tensorVolumeFor(minutes) {
  const cutoff = Date.now() - minutes * 60 * 1000;
  const recent = [...tensorSales.values()].filter(x => x.time >= cutoff);
  return { sol: recent.reduce((sum, x) => sum + x.price, 0), sales: recent.length };
}
let lastPollAt = null;
let pollError = null;

function activityTime(a) {
  const raw = a.blockTime ?? a.createdAt ?? a.timestamp ?? a.time;
  if (raw == null) return null;
  const n = Number(raw);
  const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}
function isSale(a) {
  const t = String(a.type ?? a.txType ?? a.activityType ?? "").toLowerCase();
  return ["buynow", "sale", "buy"].some(k => t.includes(k));
}
function recordActivity(symbol, a) {
  if (!isSale(a)) return;
  const time = activityTime(a);
  const price = sol(a.price ?? a.price_sol ?? a.salePrice ?? a.sale_price ?? a.amount);
  if (!time || price == null || price <= 0) return;
  const id = a.signature ?? a.transaction_id ?? a.txSignature ?? a.txid ??
    `${symbol}:${a.tokenMint ?? a.token_mint ?? "sale"}:${time}:${price}`;
  if (sales.has(id)) return;
  sales.set(id, { id, symbol, time, price });
}
async function pollSales() {
  if (salesPollBusy) return;
  salesPollBusy = true;
  try {
    // Refresh the collection universe infrequently; rotate through it continuously.
    if (!marketplaceCollections.length || Date.now() - collectionListFetchedAt > 5 * 60 * 1000) {
      const raw = await meGet("/collections?offset=0&limit=100");
      marketplaceCollections = (Array.isArray(raw) ? raw : []).filter(c => c.symbol).slice(0, 100);
      collectionListFetchedAt = Date.now();
    }
    if (!marketplaceCollections.length) throw new Error("Magic Eden returned no collections to scan");

    const batchSize = Math.min(8, marketplaceCollections.length);
    const batch = Array.from({ length: batchSize }, (_, i) =>
      marketplaceCollections[(collectionPollCursor + i) % marketplaceCollections.length]
    );
    collectionPollCursor = (collectionPollCursor + batch.length) % marketplaceCollections.length;
    let failed = 0;

    for (const c of batch) {
      try {
        tracked.add(c.symbol);
        const data = await meGet(`/collections/${encodeURIComponent(c.symbol)}/activities?offset=0&limit=50`);
        const activities = Array.isArray(data) ? data : (data?.activities ?? data?.results ?? []);
        activities.forEach(a => recordActivity(c.symbol, a));
      } catch (error) {
        failed++;
        pollError = error.message;
      }
      // 8 sequential requests with a 650ms gap stay below the public API burst limit.
      await new Promise(resolve => setTimeout(resolve, 650));
    }

    if (failed) pollError = `${failed} collection activity feeds unavailable in latest batch`;
    else pollError = null;
    lastPollAt = new Date().toISOString();
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const [id, sale] of sales) if (sale.time < cutoff) sales.delete(id);
  } catch (error) {
    pollError = error.message;
  } finally {
    salesPollBusy = false;
  }
}
function volumeFor(minutes) {
  const cutoff = Date.now() - minutes * 60 * 1000;
  const recent = [...sales.values()].filter(x => x.time >= cutoff);
  return { sol: recent.reduce((sum, x) => sum + x.price, 0), sales: recent.length };
}

async function pollNewMints() {
  if (!HELIUS_API_KEY) {
    mintPollError = "HELIUS_API_KEY is not configured";
    return;
  }
  try {
    const signatures = await heliusRpc("getSignaturesForAddress", [
      TOKEN_METADATA_PROGRAM,
      { limit: 50, commitment: "confirmed" }
    ]);
    const fresh = (Array.isArray(signatures) ? signatures : [])
      .filter(item => item.signature && !seenMintSignatures.has(item.signature))
      .slice(0, 50);
    if (!fresh.length) {
      lastMintPollAt = new Date().toISOString();
      mintPollError = null;
      return;
    }
    const response = await fetch(
      `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${encodeURIComponent(HELIUS_API_KEY)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transactions: fresh.map(item => item.signature) }),
        signal: AbortSignal.timeout(15000)
      }
    );
    if (!response.ok) throw new Error(`Helius transaction parser returned ${response.status}`);
    const parsed = await response.json();
    if (!Array.isArray(parsed)) throw new Error("Unexpected Helius parsed-transactions response");
    for (let i = 0; i < fresh.length; i++) seenMintSignatures.add(fresh[i].signature);
    for (const tx of parsed) {
      const txType = String(tx.type || tx.parsed?.type || "").toUpperCase();
      const nftEvents = [].concat(tx.events?.nft || tx.events?.nfts || tx.parsed?.events?.nft || []);
      const tokenTransfers = [].concat(tx.tokenTransfers || tx.events?.tokenTransfers || tx.parsed?.tokenTransfers || []);
      if (!txType.includes("MINT") && !nftEvents.length) continue;
      const candidates = nftEvents.length ? nftEvents : tokenTransfers;
      for (const nft of candidates) {
        const mint = nft.mint || nft.mintAddress || nft.tokenMint || nft.address;
        if (!mint) continue;
        const blockTime = Number(tx.timestamp || tx.blockTime || tx.parsed?.timestamp || Date.now() / 1000);
        const event = {
          mint,
          name: nft.name || nft.metadata?.name || nft.content?.metadata?.name || "New NFT mint",
          symbol: nft.symbol || nft.metadata?.symbol || "",
          collection: nft.collection?.name || nft.collectionName || "",
          signature: tx.signature || fresh.find(x => !recentMints.has(mint))?.signature || "",
          time: Number.isFinite(blockTime) ? blockTime * 1000 : Date.now(),
          source: "Helius Mainnet"
        };
        if (!recentMints.has(mint)) recentMints.set(mint, event);
      }
    }
    while (seenMintSignatures.size > 5000) seenMintSignatures.delete(seenMintSignatures.values().next().value);
    while (recentMints.size > 100) recentMints.delete(recentMints.keys().next().value);
    lastMintPollAt = new Date().toISOString();
    mintPollError = null;
  } catch (error) {
    mintPollError = error.message;
  }
}

app.get("/api/health", async (_req, res) => {
  let helius = "not_configured";
  if (HELIUS_RPC) {
    try {
      const r = await fetch(HELIUS_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
        signal: AbortSignal.timeout(8000)
      });
      const j = await r.json();
      helius = j.result === "ok" ? "connected" : "error";
    } catch { helius = "error"; }
  }
  res.json({ ok: true, helius, marketplace: "Magic Eden", timestamp: new Date().toISOString(), lastPollAt, pollError });
});

let collectionsCache = null;
let collectionsCacheAt = 0;

app.get("/api/collections", async (_req, res) => {
  try {
    if (collectionsCache && Date.now() - collectionsCacheAt < 60000) {
      return res.json(collectionsCache);
    }
    const raw = await meGet("/collections?offset=0&limit=100");
    const collections = (Array.isArray(raw) ? raw : []).map((c) => ({
      symbol: c.symbol,
      name: c.name || c.symbol || "Unnamed collection",
      image: c.image || c.imageURI || "",
      floorPrice: sol(c.floorPrice),
      listedCount: c.listedCount ?? null,
      volume24h: sol(c.volume24hr ?? c.volume24h),
      highestBid: null,
      volumeAll: sol(c.volumeAll),
      source: "Magic Eden"
    }));

    // Keep this list endpoint light; collection-specific stats load on demand.
    collectionsCache = { collections, source: "Magic Eden" };
    collectionsCacheAt = Date.now();
    res.json(collectionsCache);
  } catch (error) {
    res.status(502).json({ collections: [], error: error.message, hint: "Check marketplace API access and try again." });
  }
});


app.get("/api/new-mints", (_req, res) => {
  res.json({
    mints: [...recentMints.values()].sort((a, b) => b.time - a.time),
    source: "Helius Mainnet",
    lastPollAt: lastMintPollAt,
    warning: mintPollError,
    note: "Recent mint transactions involving the Metaplex Token Metadata program; not a complete index of every Solana token launch."
  });
});

app.get("/api/volume", (_req, res) => {
  const windows = { "5m": volumeFor(5), "15m": volumeFor(15), "1h": volumeFor(60) };
  const perCollection = {};
  for (const symbol of tracked) {
    const recent = [...sales.values()].filter(x => x.symbol === symbol);
    const volume = (minutes) => {
      const cutoff = Date.now() - minutes * 60 * 1000;
      const items = recent.filter(x => x.time >= cutoff);
      return { sol: items.reduce((sum, item) => sum + item.price, 0), sales: items.length };
    };
    perCollection[symbol] = { "5m": volume(5), "15m": volume(15), "1h": volume(60) };
  }
  res.json({
    windows, perCollection,
    trackedCollections: tracked.size,
    lastPollAt,
    note: "Observed Magic Eden sale activity from the rotating tracked collection set; not historical backfill.",
    warning: pollError
  });
});

app.get("/api/tensor/volume", (_req, res) => {
  res.json({
    windows: { "5m": tensorVolumeFor(5), "15m": tensorVolumeFor(15), "1h": tensorVolumeFor(60) },
    lastPollAt: tensorLastPollAt,
    source: "Helius parsed on-chain Tensor Marketplace + AMM program sales",
    note: "Only confirmed NFT_SALE transactions attributed to Tensor by Helius are counted; this is observed activity since polling began, not historical backfill.",
    warning: tensorPollError
  });
});

app.get("/api/collection/:symbol/stats", async (req, res) => {
  try {
    const stats = await meGet(`/collections/${encodeURIComponent(req.params.symbol)}/stats`);
    res.json({
      floorPrice: sol(stats.floorPrice),
      listedCount: stats.listedCount ?? null,
      volume24h: sol(stats.volume24hr ?? stats.volume24h),
      volume7d: sol(stats.volume7d),
      highestBid: sol(stats.highestBid ?? stats.highestOffer ?? stats.highestBidPrice)
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/collection/:symbol/listings", async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
    const offset = Math.max(0, Number(req.query.offset || 0));
    const listings = await meGet(`/collections/${encodeURIComponent(req.params.symbol)}/listings?offset=${offset}&limit=${limit}&sort=listPrice&sort_direction=asc&listingAggMode=true`);
    res.json({ listings: Array.isArray(listings) ? listings : [], source: "Magic Eden" });
  } catch (error) {
    res.status(502).json({ listings: [], error: error.message });
  }
});

app.get("/api/collection/:symbol/activities", async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
    const activities = await meGet(`/collections/${encodeURIComponent(req.params.symbol)}/activities?offset=0&limit=${limit}`);
    res.json({ activities: Array.isArray(activities) ? activities : [] });
  } catch (error) {
    res.status(502).json({ activities: [], error: error.message });
  }
});

app.get("/api/new", async (_req, res) => {
  try {
    // Only call a collection "recent" when the marketplace supplies a real creation timestamp.
    const raw = await meGet("/collections?offset=0&limit=500");
    const collections = (Array.isArray(raw) ? raw : [])
      .filter(c => c.symbol && c.createdAt && Number.isFinite(new Date(c.createdAt).getTime()))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 20)
      .map(c => ({
        symbol: c.symbol,
        name: c.name || c.symbol,
        image: c.image || c.imageURI || "",
        floorPrice: sol(c.floorPrice),
        createdAt: c.createdAt,
        verified: null
      }));
    res.json({
      collections,
      source: "Magic Eden",
      note: "Sorted by marketplace creation timestamps when supplied; verification is not inferred."
    });
  } catch (error) {
    res.status(502).json({ collections: [], error: error.message });
  }
});

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`SOL SCANNER running on port ${PORT}`);
  pollSales();
  pollNewMints();
  pollTensorSales();
  setInterval(pollSales, 6000);
  setInterval(pollNewMints, 30000);
  setInterval(pollTensorSales, 60000);
});

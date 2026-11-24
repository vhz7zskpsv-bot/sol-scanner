require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ME_BASE = "https://api-mainnet.magiceden.dev/v2";
const HELIUS_RPC = process.env.HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
  : null;

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
  res.json({ ok: true, helius, marketplace: "Magic Eden", timestamp: new Date().toISOString() });
});

app.get("/api/collections", async (_req, res) => {
  try {
    const raw = await meGet("/collections?offset=0&limit=100");
    const collections = (Array.isArray(raw) ? raw : []).map((c) => ({
      symbol: c.symbol,
      name: c.name || c.symbol || "Unnamed collection",
      image: c.image || c.imageURI || "",
      floorPrice: sol(c.floorPrice),
      listedCount: c.listedCount ?? null,
      volume24h: sol(c.volume24hr ?? c.volume24h),
      volumeAll: sol(c.volumeAll),
      source: "Magic Eden"
    }));
    res.json({ collections, source: "Magic Eden" });
  } catch (error) {
    res.status(502).json({ collections: [], error: error.message, hint: "Check marketplace API access and try again." });
  }
});

app.get("/api/collection/:symbol/stats", async (req, res) => {
  try {
    const stats = await meGet(`/collections/${encodeURIComponent(req.params.symbol)}/stats`);
    res.json({
      floorPrice: sol(stats.floorPrice),
      listedCount: stats.listedCount ?? null,
      volume24h: sol(stats.volume24hr ?? stats.volume24h),
      volume7d: sol(stats.volume7d),
      highestBid: null,
      raw: stats
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
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
    const raw = await meGet("/collections?offset=0&limit=100");
    const collections = (Array.isArray(raw) ? raw : [])
      .filter((c) => c.symbol && (c.createdAt || c.updatedAt || c.name))
      .slice(0, 20)
      .map((c) => ({
        symbol: c.symbol,
        name: c.name || c.symbol,
        image: c.image || c.imageURI || "",
        floorPrice: sol(c.floorPrice),
        createdAt: c.createdAt || null
      }));
    res.json({ collections, note: "Marketplace collection discovery feed; not a complete on-chain mint index." });
  } catch (error) {
    res.status(502).json({ collections: [], error: error.message });
  }
});

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`SOL SCANNER running on port ${PORT}`));

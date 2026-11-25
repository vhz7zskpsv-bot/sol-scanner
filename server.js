require("dotenv").config();
const express = require("express");
const path = require("path");
const app = express();
const PORT = Number(process.env.PORT || 8080);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

require("./sol-signals").attach(app);
require("./manual-trades").attach(app);
const meme = require("./meme-scanner");
const memePaper = require("./meme-paper-trading");
memePaper.attach(app);
meme.attach(app, memePaper);

app.get("/api/health", (_req, res) => res.json({
  ok: true,
  services: ["SOL signals", "SOL paper trading", "Solana meme scanner", "meme paper trading"],
  nftModules: false,
  heliusRequired: false,
  solanaRpc: process.env.SOLANA_RPC_URL ? "custom RPC configured" : "public RPC fallback",
  timestamp: new Date().toISOString()
}));

app.listen(PORT, "0.0.0.0", () => console.log("SOL Scanner listening on " + PORT));

require("dotenv").config();
const express = require("express");
const path = require("path");
const app = express();
const PORT = Number(process.env.PORT || 8080);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

require("./sol-signals").attach(app);
const meme = require("./meme-scanner");
const memePaper = require("./meme-paper-trading");
memePaper.attach(app);
meme.attach(app, memePaper);

app.get("/api/health", (_req, res) => res.json({
  ok: true,
  services: ["SOL signals", "SOL paper trading", "Solana meme scanner", "meme paper trading"],
  nftModules: false,
  helius: process.env.HELIUS_API_KEY ? "configured" : "missing",
  timestamp: new Date().toISOString()
}));

app.listen(PORT, "0.0.0.0", () => console.log("SOL Scanner listening on " + PORT));

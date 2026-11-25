const fs = require("fs");
const path = require("path");
const FILE = process.env.MANUAL_TRADES_FILE || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "sol-manual-trades.json") : "/data/sol-manual-trades.json");
let trades = [];
let queue = Promise.resolve();
function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (Array.isArray(parsed)) trades = parsed;
  } catch (e) {
    if (e.code !== "ENOENT") console.error("Manual trade state load failed:", e.message);
  }
}
function save() {
  queue = queue.then(async () => {
    await fs.promises.mkdir(path.dirname(FILE), { recursive: true });
    const tmp = FILE + ".tmp";
    await fs.promises.writeFile(tmp, JSON.stringify(trades, null, 2));
    await fs.promises.rename(tmp, FILE);
  }).catch(e => console.error("Manual trade state save failed:", e.message));
  return queue;
}
function positive(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }
function attach(app) {
  load();
  app.get("/api/manual-trades", (_req, res) => res.json({ trades }));
  app.post("/api/manual-trades", async (req, res) => {
    const entryPrice = positive(req.body && req.body.entryPrice);
    const quantity = positive(req.body && req.body.quantity);
    const stopLoss = req.body && req.body.stopLoss !== "" && req.body.stopLoss != null ? positive(req.body.stopLoss) : null;
    const targetPrice = req.body && req.body.targetPrice !== "" && req.body.targetPrice != null ? positive(req.body.targetPrice) : null;
    if (!entryPrice || !quantity || (req.body.stopLoss && !stopLoss) || (req.body.targetPrice && !targetPrice)) {
      return res.status(400).json({ error: "Enter a valid entry price and SOL amount. Stop loss/target must be positive when supplied." });
    }
    const trade = { id: "manual-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8), status: "OPEN", entryPrice, quantity, stopLoss, targetPrice, createdAt: new Date().toISOString() };
    trades.unshift(trade);
    await save();
    res.status(201).json({ trade });
  });
  app.post("/api/manual-trades/:id/close", async (req, res) => {
    const trade = trades.find(t => t.id === req.params.id && t.status === "OPEN");
    if (!trade) return res.status(404).json({ error: "Open manual trade not found" });
    const exitPrice = positive(req.body && req.body.exitPrice);
    if (!exitPrice) return res.status(400).json({ error: "A valid exit price is required" });
    trade.status = "CLOSED";
    trade.exitPrice = exitPrice;
    trade.closedAt = new Date().toISOString();
    trade.pnl = (exitPrice - trade.entryPrice) * trade.quantity;
    trade.pnlPercent = ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100;
    await save();
    res.json({ trade });
  });
}
module.exports = { attach };

const fs = require("fs");
const path = require("path");
const FILE = process.env.MEME_PAPER_FILE || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "meme-paper-trading.json") : "/data/meme-paper-trading.json");
const START = 1000, NOTIONAL = 25, FEE = 0.001, SLIPPAGE = 0.01, STOP = 0.15, TARGET = 0.30, MAX_HOLD_MS = 4 * 60 * 60 * 1000;
let state = { cash: START, realizedPnl: 0, open: {}, trades: [], confirmations: {} };
let queue = Promise.resolve();
function load() {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (s && Number.isFinite(s.cash)) state = { ...state, ...s, open: s.open || {}, trades: s.trades || [], confirmations: s.confirmations || {} };
  } catch (e) { if (e.code !== "ENOENT") console.error("Meme paper state load:", e.message); }
}
function save() {
  queue = queue.then(async () => {
    await fs.promises.mkdir(path.dirname(FILE), { recursive: true });
    const tmp = FILE + ".tmp";
    await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.promises.rename(tmp, FILE);
  }).catch(e => console.error("Meme paper state save:", e.message));
  return queue;
}
function close(mint, price, reason) {
  const t = state.open[mint]; if (!t) return;
  const exit = price * (1 - SLIPPAGE), proceeds = t.quantity * exit, exitFee = proceeds * FEE;
  const pnl = proceeds - exitFee - t.cost;
  state.cash += proceeds - exitFee; state.realizedPnl += pnl;
  t.exit = exit; t.exitAt = new Date().toISOString(); t.exitReason = reason; t.pnl = pnl;
  t.pnlPct = (pnl / t.cost) * 100; t.status = "CLOSED";
  state.trades.unshift(t); delete state.open[mint];
  if (state.trades.length > 500) state.trades.length = 500;
}
function observe(token) {
  if (!token || !token.mint || !Number.isFinite(Number(token.priceUsd)) || Number(token.priceUsd) <= 0) return;
  const mint = token.mint, price = Number(token.priceUsd), open = state.open[mint];
  if (open) {
    if (price <= open.stop) close(mint, price, "STOP_LOSS");
    else if (price >= open.target) close(mint, price, "TAKE_PROFIT");
    else if (Date.now() - new Date(open.openedAt).getTime() >= MAX_HOLD_MS) close(mint, price, "MAX_HOLD");
  }
  if (!token.eligible || state.open[mint]) { state.confirmations[mint] = 0; save(); return; }
  state.confirmations[mint] = (state.confirmations[mint] || 0) + 1;
  if (state.confirmations[mint] >= 2 && Object.keys(state.open).length < 3 && !state.trades.some(t => t.mint === mint && Date.now() - new Date(t.exitAt).getTime() < 60 * 60 * 1000)) {
    const entry = price * (1 + SLIPPAGE), cost = NOTIONAL, fee = cost * FEE, spend = cost + fee;
    if (state.cash >= spend) {
      const qty = cost / entry;
      state.cash -= spend;
      state.open[mint] = {
        mint, name: token.name || token.symbol || "Unknown", symbol: token.symbol || "",
        openedAt: new Date().toISOString(), entry, quantity: qty, cost: spend,
        stop: entry * (1 - STOP), target: entry * (1 + TARGET),
        lastPrice: price, status: "OPEN", source: "GeckoTerminal + RugCheck screening",
        entryFee: fee, exit: null, pnl: null
      };
    }
    state.confirmations[mint] = 0;
  }
  save();
}
function snapshot() {
  const wins = state.trades.filter(t => t.pnl > 0).length, total = state.trades.length;
  return {
    startingBalance: START, cash: Number(state.cash.toFixed(2)), realizedPnl: Number(state.realizedPnl.toFixed(2)),
    openTrades: Object.values(state.open), trades: state.trades.slice(0, 30),
    stats: { completedTrades: total, wins, losses: total - wins, winRate: total ? Number((wins / total * 100).toFixed(1)) : null, openPositions: Object.keys(state.open).length },
    rules: { notionalUsd: NOTIONAL, stopLossPct: STOP * 100, takeProfitPct: TARGET * 100, maxOpenPositions: 3, confirmationScans: 2 },
    disclaimer: "Demo only. $25 fixed notional per trade; 1% estimated slippage each side and 0.1% fees. Price feed gaps and real execution can differ. No wallet or real orders."
  };
}
function attach(app) {
  load();
  app.get("/api/meme-paper-trading", (_req, res) => res.json(snapshot()));
  app.memePaperObserve = observe;
}
module.exports = { attach, observe, snapshot };

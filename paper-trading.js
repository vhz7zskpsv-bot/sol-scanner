const fs = require("fs");
const path = require("path");

const FILE = process.env.PAPER_TRADING_FILE || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "sol-paper-trading.json") : "/data/sol-paper-trading.json");
const STARTING_BALANCE = 1000;
const FEE_RATE = 0.001;
const SLIPPAGE_RATE = 0.0005;
const RISK_FRACTION = 0.01;
const MAX_NOTIONAL_FRACTION = 0.25;
const MODES = ["scalp", "intraday", "swing"];
let state = { startingBalance: STARTING_BALANCE, cash: STARTING_BALANCE, realizedPnl: 0, trades: [], open: {}, confirmations: {}, lastCandle: {} };
let writeQueue = Promise.resolve();

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (saved && Number.isFinite(saved.cash) && Array.isArray(saved.trades)) {
      state = { ...state, ...saved, open: saved.open || {}, confirmations: saved.confirmations || {}, lastCandle: saved.lastCandle || {} };
    }
  } catch (e) {
    if (e.code !== "ENOENT") console.error("Paper trading state load failed:", e.message);
  }
}
function save() {
  writeQueue = writeQueue.then(async () => {
    await fs.promises.mkdir(path.dirname(FILE), { recursive: true });
    const tmp = FILE + ".tmp";
    await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.promises.rename(tmp, FILE);
  }).catch(e => console.error("Paper trading state save failed:", e.message));
  return writeQueue;
}
function round(n) { return Number(Number(n).toFixed(4)); }
function closeTrade(mode, price, reason, candleTime) {
  const trade = state.open[mode];
  if (!trade) return;
  const exit = price * (1 - SLIPPAGE_RATE);
  const gross = (exit - trade.entry) * trade.quantity;
  const exitFee = exit * trade.quantity * FEE_RATE;
  const pnl = gross - exitFee - trade.entryFee;
  state.cash += exit * trade.quantity - exitFee;
  state.realizedPnl += pnl;
  trade.status = "CLOSED";
  trade.exit = round(exit);
  trade.exitTime = new Date().toISOString();
  trade.exitCandleTime = candleTime;
  trade.exitReason = reason;
  trade.pnl = round(pnl);
  trade.pnlPercent = round((pnl / (trade.entry * trade.quantity)) * 100);
  state.trades.unshift(trade);
  delete state.open[mode];
  if (state.trades.length > 500) state.trades.length = 500;
}
function tick(mode, data) {
  if (!MODES.includes(mode) || !data || !data.signal || !data.timeframes) return;
  const primary = data.timeframes.primary;
  const confirm = data.timeframes.confirm;
  const trend = data.timeframes.trend;
  if (!primary || !confirm || !trend || !Number.isFinite(primary.price) || !Number.isFinite(primary.candleTime)) return;
  const candleKey = String(primary.candleTime);
  if (state.lastCandle[mode] === candleKey) return;
  state.lastCandle[mode] = candleKey;

  const signal = data.signal;
  const confirmed = signal.score === 7 && signal.total === 7 &&
    confirm.price > confirm.ema20 && confirm.price > confirm.ema50 &&
    trend.ema50 > trend.ema200 && primary.rsi >= 45 && primary.rsi <= 70;
  state.confirmations[mode] = confirmed ? (state.confirmations[mode] || 0) + 1 : 0;

  const open = state.open[mode];
  if (open) {
    const stopHit = Number.isFinite(primary.low) && primary.low <= open.stopLoss;
    const targetHit = Number.isFinite(primary.high) && primary.high >= open.target;
    // Conservative assumption if both levels trade within the same candle: stop first.
    if (stopHit) closeTrade(mode, open.stopLoss, "STOP_LOSS", candleKey);
    else if (targetHit) closeTrade(mode, open.target, "TAKE_PROFIT", candleKey);
    // A weaker/new market signal does not close an existing position. Keep tracking until SL/TP.
  }

  if (!state.open[mode] && state.confirmations[mode] >= 2 && confirmed) {
    const rawEntry = primary.price;
    const entry = rawEntry * (1 + SLIPPAGE_RATE);
    const stopLoss = Number(signal.stopLoss);
    const target = Number(signal.targets && signal.targets[0]);
    if (stopLoss > 0 && stopLoss < rawEntry && target > rawEntry) {
      const equity = state.cash + Object.values(state.open).reduce((sum, t) => sum + t.quantity * primary.price, 0);
      const riskBudget = equity * RISK_FRACTION;
      const qtyByRisk = riskBudget / (entry - stopLoss);
      const qtyByCap = (equity * MAX_NOTIONAL_FRACTION) / entry;
      const quantity = Math.max(0, Math.min(qtyByRisk, qtyByCap));
      const notional = quantity * entry;
      const entryFee = notional * FEE_RATE;
      const cost = notional + entryFee;
      if (quantity > 0 && cost <= state.cash) {
        state.cash -= cost;
        state.open[mode] = {
          id: mode + "-" + candleKey,
          mode, status: "OPEN", openedAt: new Date().toISOString(),
          candleTime: primary.candleTime, entry: round(entry), quantity: round(quantity),
          notional: round(notional), entryFee: round(entryFee), stopLoss: round(stopLoss),
          target: round(target), score: signal.score, total: signal.total,
          source: data.source || "Kraken SOL/USD"
        };
        state.confirmations[mode] = 0;
      }
    }
  }
  save();
}
function snapshot() {
  const openTrades = Object.values(state.open);
  const openValue = openTrades.reduce((sum, t) => sum + t.quantity * t.entry, 0);
  const unrealized = openTrades.reduce((sum, t) => sum - t.entryFee, 0);
  const wins = state.trades.filter(t => t.pnl > 0).length;
  const losses = state.trades.filter(t => t.pnl <= 0).length;
  const closed = state.trades.length;
  return {
    startingBalance: state.startingBalance,
    cash: round(state.cash),
    realizedPnl: round(state.realizedPnl),
    openTrades,
    trades: state.trades,
    stats: { completedTrades: closed, wins, losses, winRate: closed ? round(wins / closed * 100) : null, openPositions: openTrades.length, fees: round(state.trades.reduce((s,t)=>s+(t.entryFee||0)+(t.exitFee||0),0) + openTrades.reduce((s,t)=>s+t.entryFee,0)) },
    disclaimer: "Simulation only. Uses closed Kraken SOL/USD candles, estimated fees and slippage. Intrabar fills and execution quality may differ from real markets. No real orders or wallet access."
  };
}
function attach(app) {
  load();
  app.get("/api/paper-trading", (_req, res) => res.json(snapshot()));
  app.get("/api/paper-trading/reset-info", (_req, res) => res.json({ resetAvailable: false, note: "Demo account is persistent; reset is intentionally disabled to protect trade history." }));
  app.paperTradingTick = tick;
}
module.exports = { attach, tick };

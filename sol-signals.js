const MODES = {
  scalp: { label: "Scalp · 2–3 hours", primary: 5, confirm: 15, trend: 60, refreshMs: 60_000, hold: "2–3 hours", risk: 0.012, reward: [1, 1.6, 2.2] },
  intraday: { label: "Intraday · same day", primary: 15, confirm: 60, trend: 240, refreshMs: 180_000, hold: "same day", risk: 0.02, reward: [1.2, 2, 2.8] },
  swing: { label: "Swing · 2–3 weeks", primary: 240, confirm: 1440, trend: 1440, refreshMs: 300_000, hold: "2–3 weeks", risk: 0.035, reward: [1.5, 2.5, 3.5] }
};
const caches = Object.fromEntries(Object.keys(MODES).map(k => [k, { data: null, at: 0, error: null }]));
const labels = { 5: "5m", 15: "15m", 60: "1H", 240: "4H", 1440: "1D" };
async function candles(interval, limit = 220) {
  const seconds = interval * 60;
  const since = Math.floor(Date.now() / 1000) - seconds * (limit + 5);
  const url = "https://api.kraken.com/0/public/OHLC?pair=SOLUSD&interval=" + interval + "&since=" + since;
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("Kraken market data provider returned HTTP " + response.status);
  const payload = await response.json();
  if (payload.error && payload.error.length) throw new Error("Kraken market data error: " + payload.error.join(", "));
  const rowsKey = Object.keys(payload.result || {}).find(k => k !== "last");
  const rows = rowsKey ? payload.result[rowsKey] : null;
  if (!Array.isArray(rows) || rows.length < 60) throw new Error("Kraken returned insufficient SOL/USD " + (labels[interval] || interval) + " candle history");
  return rows.map(r => ({ time: Number(r[0]) * 1000, open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[6] }));
}
function ema(values, period) {
  const k = 2 / (period + 1); let out = values[0];
  for (let i = 1; i < values.length; i++) out = values[i] * k + out * (1 - k);
  return out;
}
function rsi(values, period = 14) {
  let gain = 0, loss = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1]; if (d >= 0) gain += d; else loss -= d;
  }
  if (loss === 0) return 100;
  const rs = (gain / period) / (loss / period);
  return 100 - 100 / (1 + rs);
}
function macd(values) {
  const fast = ema(values.slice(-80), 12), slow = ema(values.slice(-160), 26);
  const previousFast = ema(values.slice(-81, -1), 12), previousSlow = ema(values.slice(-161, -1), 26);
  return { value: fast - slow, previous: previousFast - previousSlow };
}
function analyze(rows) {
  const closed = rows.slice(0, -1), closes = closed.map(x => x.close), last = closed.at(-1);
  const e20 = ema(closes.slice(-80), 20), e50 = ema(closes.slice(-120), 50), e200 = ema(closes.slice(-220), 200);
  const r = rsi(closes), m = macd(closes), recent = closed.slice(-20);
  const avgVol = recent.slice(0, -1).reduce((s, x) => s + x.volume, 0) / Math.max(1, recent.length - 1);
  const volRatio = last.volume / Math.max(avgVol, 1e-9);
  const support = Math.min(...closed.slice(-30).map(x => x.low));
  const resistance = Math.max(...closed.slice(-30).map(x => x.high));
  return { price: last.close, candleTime: last.time, high: last.high, low: last.low, rsi: r, ema20: e20, ema50: e50, ema200: e200, macd: m.value, macdPrevious: m.previous, volumeRatio: volRatio, support, resistance, bullishTrend: last.close > e50 && e50 > e200, reclaim20: last.close > e20 };
}
function makeSignal(primary, confirm, trend, cfg) {
  const checks = [
    primary.price > primary.ema20,
    primary.price > primary.ema50,
    confirm.price > confirm.ema20,
    confirm.price > confirm.ema50,
    trend.ema50 > trend.ema200,
    primary.rsi >= 45 && primary.rsi <= 70,
    primary.macd > primary.macdPrevious && primary.volumeRatio >= 1.0
  ];
  const score = checks.filter(Boolean).length, price = primary.price;
  const recentSupport = Math.min(primary.support, confirm.support);
  const invalidation = Math.min(recentSupport * 0.995, price * (1 - cfg.risk));
  const risk = Math.max(price - invalidation, price * cfg.risk);
  const entryLow = price * 0.997, entryHigh = price * 1.003;
  const targets = cfg.reward.map(mult => price + risk * mult);
  let status = "WAIT";
  if (score >= 6 && primary.rsi >= 45 && primary.rsi <= 70) status = "BUY";
  else if (score >= 5 && primary.price > primary.ema20 && confirm.price > confirm.ema20) status = "WATCH";
  const reasons = [
    [checks[0], labels[Object.keys(labels).find(k => labels[k] === cfg.primaryLabel)] + " close above EMA20"],
    [checks[1], labels[Object.keys(labels).find(k => labels[k] === cfg.primaryLabel)] + " close above EMA50"],
    [checks[2], labels[Object.keys(labels).find(k => labels[k] === cfg.confirmLabel)] + " close above EMA20"],
    [checks[3], labels[Object.keys(labels).find(k => labels[k] === cfg.confirmLabel)] + " close above EMA50"],
    [checks[4], "Higher-timeframe EMA50 above EMA200"],
    [checks[5], "Momentum RSI in healthy range (45–70)"],
    [checks[6], "MACD improving + volume at/above average"]
  ].map(([ok, label]) => ({ ok, label }));
  return { status, score, total: checks.length, entry: { low: entryLow, high: entryHigh }, stopLoss: invalidation, targets, riskReward: targets.map(t => (t - price) / risk), reasons, invalidationNote: "A confirmed candle close below stop-loss invalidates this setup; do not average down." };
}
async function refresh(mode) {
  const cfg = MODES[mode], cache = caches[mode];
  try {
    const intervals = [...new Set([cfg.primary, cfg.confirm, cfg.trend])];
    const rows = await Promise.all(intervals.map(i => candles(i)));
    const data = Object.fromEntries(intervals.map((i, n) => [i, analyze(rows[n])]));
    const primary = data[cfg.primary], confirm = data[cfg.confirm], trend = data[cfg.trend];
    const signal = makeSignal(primary, confirm, trend, { ...cfg, primaryLabel: labels[cfg.primary], confirmLabel: labels[cfg.confirm] });
    cache.data = { mode, modeLabel: cfg.label, hold: cfg.hold, symbol: "SOLUSD", quote: "USD", updatedAt: new Date().toISOString(), source: "Kraken public SOL/USD OHLC candles", monitoring: "refreshes on demand at mode-specific cadence", timeframes: { primary, confirm, trend }, timeframeLabels: { primary: labels[cfg.primary], confirm: labels[cfg.confirm], trend: labels[cfg.trend] }, signal, disclaimer: "Technical indicator signal only; not a prediction or guarantee. No wallet access or automatic trading." };
    cache.error = null; cache.at = Date.now();
    if (typeof appPaperTick === "function") appPaperTick(mode, cache.data);
  } catch (e) { cache.error = e.message; }
}
let appPaperTick = null;
function attach(app) {
  const paper = require("./paper-trading");
  paper.attach(app);
  appPaperTick = paper.tick;
  app.get("/api/sol-signals", async (req, res) => {
    const mode = MODES[req.query.mode] ? req.query.mode : "swing";
    const cache = caches[mode], cfg = MODES[mode];
    if (!cache.data || Date.now() - cache.at > cfg.refreshMs) await refresh(mode);
    if (!cache.data) return res.status(502).json({ error: cache.error || "SOL market data unavailable", updatedAt: null, mode });
    res.json({ ...cache.data, dataAgeSeconds: Math.floor((Date.now() - cache.at) / 1000), warning: cache.error });
  });
  for (const mode of Object.keys(MODES)) refresh(mode);
}
module.exports = { attach };

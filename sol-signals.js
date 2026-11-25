const INTERVALS = { "4h": 240, "1d": 1440 };
const cache = { data: null, at: 0, error: null };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
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
  if (!Array.isArray(rows) || rows.length < 60) throw new Error("Kraken returned insufficient SOL/USD candle history");
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
  return { price: last.close, candleTime: last.time, rsi: r, ema20: e20, ema50: e50, ema200: e200, macd: m.value, macdPrevious: m.previous, volumeRatio: volRatio, support, resistance, bullishTrend: last.close > e50 && e50 > e200, reclaim20: last.close > e20 };
}
function makeSignal(h4, daily) {
  const checks = [
    daily.price > daily.ema20,
    daily.price > daily.ema50,
    daily.ema50 > daily.ema200,
    daily.rsi >= 42 && daily.rsi <= 68,
    h4.price > h4.ema20,
    h4.macd > h4.macdPrevious,
    h4.volumeRatio >= 1.15
  ];
  const score = checks.filter(Boolean).length;
  const price = h4.price;
  const recentSupport = Math.min(h4.support, daily.support);
  const invalidation = recentSupport * 0.985;
  const entryLow = price * 0.99, entryHigh = price * 1.005;
  const risk = Math.max(price - invalidation, price * 0.025);
  const targets = [price + risk * 1.5, price + risk * 2.5, price + risk * 3.5];
  let status = "WAIT";
  if (score >= 6 && h4.rsi >= 45 && h4.rsi <= 68) status = "BUY";
  else if (score >= 5 && daily.price > daily.ema50 && h4.price > h4.ema20) status = "WATCH";
  const reasons = [
    [daily.price > daily.ema20, "Daily close above EMA20"],
    [daily.price > daily.ema50, "Daily close above EMA50"],
    [daily.ema50 > daily.ema200, "Daily EMA50 above EMA200"],
    [daily.rsi >= 42 && daily.rsi <= 68, "Daily RSI in healthy momentum range"],
    [h4.price > h4.ema20, "4H close above EMA20"],
    [h4.macd > h4.macdPrevious, "4H MACD momentum improving"],
    [h4.volumeRatio >= 1.15, "4H volume above recent average"]
  ].map(([ok, label]) => ({ ok, label }));
  return { status, score, total: checks.length, entry: { low: entryLow, high: entryHigh }, stopLoss: invalidation, targets, riskReward: targets.map(t => (t - price) / risk), reasons, invalidationNote: "A confirmed 4H close below the stop invalidates this setup; recalculate rather than averaging down." };
}
async function refresh() {
  try {
    const [h4Rows, dRows] = await Promise.all([candles(INTERVALS["4h"]), candles(INTERVALS["1d"])]);
    const h4 = analyze(h4Rows), daily = analyze(dRows);
    cache.data = { symbol: "SOLUSDT", quote: "USDT", horizon: "2–3 weeks", updatedAt: new Date().toISOString(), source: "Kraken public SOL/USD OHLC candles", monitoring: "server cache refresh every 5 minutes", timeframes: { "4h": h4, "1d": daily }, signal: makeSignal(h4, daily), disclaimer: "Technical indicator signal only; not a prediction or guarantee. No wallet access or automatic trading. Whale accumulation is not measured in this version." };
    cache.error = null; cache.at = Date.now();
  } catch (e) { cache.error = e.message; }
}
function attach(app) {
  app.get("/api/sol-signals", async (_req, res) => {
    if (!cache.data || Date.now() - cache.at > 5 * 60 * 1000) await refresh();
    if (!cache.data) return res.status(502).json({ error: cache.error || "SOL market data unavailable", updatedAt: null });
    res.json({ ...cache.data, dataAgeSeconds: Math.floor((Date.now() - cache.at) / 1000), warning: cache.error });
  });
  refresh();
  setInterval(refresh, 5 * 60 * 1000);
}
module.exports = { attach };

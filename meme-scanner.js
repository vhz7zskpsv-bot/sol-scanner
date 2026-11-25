// No Helius dependency. Use a no-key public RPC first, then Solana's public endpoint.
const RPC_ENDPOINTS = [...new Set([
  process.env.SOLANA_RPC_URL,
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet.solana.com"
].filter(Boolean))];
let activeRpc = RPC_ENDPOINTS[0] || null;
let rpcStatus = { endpoint: activeRpc, state: "NOT_TESTED", lastError: null };
const pools = new Map(), reportCache = new Map();
let lastScanAt = null, scanError = null, busy = false;
const MAX_CANDIDATES = 3;
const MIN_LIQ = 20000, MIN_VOL5 = 2000, MIN_AGE = 2, MAX_AGE = 120;
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
async function json(url, options = {}, timeout = 12000) {
  const r = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout), headers: { accept: "application/json", ...(options.headers || {}) } });
  if (!r.ok) throw new Error("HTTP " + r.status + " from " + new URL(url).hostname);
  return r.json();
}
async function rpc(method, params) {
  let lastError = new Error("No public Solana RPC endpoints configured");
  const ordered = [...RPC_ENDPOINTS].sort((a, b) => (a === activeRpc ? -1 : b === activeRpc ? 1 : 0));
  for (const endpoint of ordered) {
    try {
      const data = await json(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
      }, 12000);
      if (data.error) throw new Error(data.error.message || "Solana RPC error");
      activeRpc = endpoint;
      rpcStatus = { endpoint, state: "ONLINE", lastError: null };
      return data.result;
    } catch (e) {
      lastError = e;
      rpcStatus = { endpoint, state: "DEGRADED", lastError: e.message };
    }
  }
  throw lastError;
}
function includedMap(items) { return new Map((items || []).map(x => [x.id, x.attributes || {}])); }
function getMint(pool, included) {
  const rel = pool.relationships || {};
  const id = rel.base_token && rel.base_token.data && rel.base_token.data.id;
  const attrs = id && included.get(id);
  if (attrs && attrs.address) return { mint: attrs.address, name: attrs.name || "", symbol: attrs.symbol || "" };
  const direct = pool.attributes && pool.attributes.base_token_address;
  return direct ? { mint: direct, name: "", symbol: "" } : null;
}
function makeChecks(pair, report, summary, bundle) {
  const a = pair.attributes || {}, token = report.token || {};
  const top = Array.isArray(report.topHolders) ? report.topHolders : [];
  const creator = report.creator || report.tokenMeta?.updateAuthority || "";
  const dev = creator && top.length ? top.find(x => x.address === creator || x.owner === creator) : null;
  const devPct = dev ? num(dev.pct ?? dev.percentage) : null;
  const top10 = top.length >= 10 ? top.slice(0, 10).reduce((s, x) => s + (num(x.pct ?? x.percentage) || 0), 0) : null;
  const age = a.pool_created_at ? (Date.now() - new Date(a.pool_created_at).getTime()) / 60000 : null;
  const liq = num(a.reserve_in_usd);
  const vol = num(a.volume_usd?.m5);
  const tx = a.transactions?.m5 || {};
  const buys = num(tx.buys), sells = num(tx.sells);
  const risk = num(report.score_normalised ?? summary.score_normalised);
  const lp = num(summary.lpLockedPct ?? report.lpLockedPct);
  const mintAuth = token.mintAuthority ?? report.mintAuthority;
  const freezeAuth = token.freezeAuthority ?? report.freezeAuthority;
  const rows = [
    ["Token age 2–120m", age !== null && age >= MIN_AGE && age <= MAX_AGE],
    ["Liquidity ≥ $20k", liq !== null && liq >= MIN_LIQ],
    ["5m volume ≥ $2k", vol !== null && vol >= MIN_VOL5],
    ["5m buys > sells", buys !== null && sells !== null && buys > sells],
    ["Mint authority revoked", mintAuth === null || mintAuth === ""],
    ["Freeze authority revoked", freezeAuth === null || freezeAuth === ""],
    ["Developer holding ≤ 3%", devPct !== null && devPct <= 3],
    ["Top 10 holders ≤ 20%", top10 !== null && top10 <= 20],
    ["LP locked ≥ 90%", lp !== null && lp >= 90],
    ["RugCheck score ≤ 20", risk !== null && risk <= 20],
    ["Bundle sample check", bundle.status === "PASS"]
  ];
  return rows.map(([label, ok]) => ({ label, status: ok ? "PASS" : "FAIL/UNKNOWN", ok: !!ok, detail: label.startsWith("Developer") ? (devPct === null ? "Not verified" : devPct.toFixed(2) + "%") : label.startsWith("Top 10") ? (top10 === null ? "Not verified" : top10.toFixed(2) + "%") : label.startsWith("LP") ? (lp === null ? "Not verified" : lp.toFixed(1) + "%") : label.startsWith("RugCheck") ? (risk === null ? "Not verified" : String(risk)) : label.startsWith("Bundle") ? bundle.detail : "" }));
}
async function bundleSample(pairAddress, mint) {
  try {
    const sigs = await rpc("getSignaturesForAddress", [pairAddress, { limit: 18, commitment: "confirmed" }]);
    if (!Array.isArray(sigs) || sigs.length < 8) return { status: "UNKNOWN", detail: "Not enough pool transactions to inspect" };
    const sample = await Promise.all(sigs.slice(0, 12).map(async s => {
      try { return await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]); }
      catch { return null; }
    }));
    const groups = new Map(); let parsed = 0, buys = 0;
    for (const tx of sample) {
      if (!tx || !tx.meta || tx.meta.err) continue;
      parsed++;
      const pre = tx.meta.preTokenBalances || [], post = tx.meta.postTokenBalances || [];
      const before = new Map(pre.filter(x => x.mint === mint).map(x => [x.accountIndex, Number(x.uiTokenAmount?.uiAmountString || 0)]));
      for (const b of post.filter(x => x.mint === mint)) {
        const delta = Number(b.uiTokenAmount?.uiAmountString || 0) - (before.get(b.accountIndex) || 0);
        if (delta > 0.0000001 && b.owner) {
          buys++;
          const slot = String(tx.slot);
          if (!groups.has(slot)) groups.set(slot, new Set());
          groups.get(slot).add(b.owner);
        }
      }
    }
    if (parsed < 6 || buys < 5) return { status: "UNKNOWN", detail: "Insufficient parsed buy sample (" + buys + " buys)" };
    const maxCluster = Math.max(0, ...[...groups.values()].map(s => s.size));
    if (maxCluster >= 4) return { status: "FAIL", detail: maxCluster + " distinct buyers in one slot; suspicious cluster" };
    return { status: "PASS", detail: buys + " buys inspected; no 4+ buyer same-slot cluster detected (heuristic only)" };
  } catch (e) {
    return { status: "UNKNOWN", detail: e.message.includes("429") ? "RPC rate limit / credits" : e.message };
  }
}
async function inspectCandidate(pool, token, included) {
  const mint = token.mint, a = pool.attributes || {};
  const cache = reportCache.get(mint);
  let report, summary;
  if (cache && Date.now() - cache.at < 10 * 60 * 1000) ({ report, summary } = cache);
  else {
    [report, summary] = await Promise.all([
      json("https://api.rugcheck.xyz/v1/tokens/" + encodeURIComponent(mint) + "/report"),
      json("https://api.rugcheck.xyz/v1/tokens/" + encodeURIComponent(mint) + "/report/summary")
    ]);
    reportCache.set(mint, { report, summary, at: Date.now() });
  }
  const pairAddress = String(pool.id || "").split("_").slice(1).join("_") || a.address;
  const bundle = await bundleSample(pairAddress, mint);
  const checks = makeChecks(pool, report, summary, bundle);
  const age = a.pool_created_at ? Math.round((Date.now() - new Date(a.pool_created_at).getTime()) / 60000) : null;
  return {
    mint, name: token.name || report.tokenMeta?.name || "Unknown", symbol: token.symbol || report.tokenMeta?.symbol || "",
    priceUsd: num(a.base_token_price_usd), liquidityUsd: num(a.reserve_in_usd), volume5m: num(a.volume_usd?.m5),
    buys5m: num(a.transactions?.m5?.buys), sells5m: num(a.transactions?.m5?.sells), ageMinutes: age,
    pairAddress, dex: (pool.relationships?.dex?.data?.id || "").replace("solana_", ""),
    url: "https://dexscreener.com/solana/" + pairAddress, checks,
    eligible: checks.every(x => x.ok), status: checks.every(x => x.ok) ? "PAPER BUY WATCH" : "BLOCKED",
    updatedAt: new Date().toISOString()
  };
}
async function scan(paper) {
  if (busy) return; busy = true;
  try {
    const data = await json("https://api.geckoterminal.com/api/v2/networks/solana/new_pools?include=base_token,quote_token,dex&page=1", { headers: { accept: "application/json;version=20230203" } }, 15000);
    const included = includedMap(data.included);
    const candidates = (data.data || []).map(pool => ({ pool, token: getMint(pool, included) })).filter(x => {
      if (!x.token) return false;
      const a = x.pool.attributes || {}, age = a.pool_created_at ? (Date.now() - new Date(a.pool_created_at).getTime()) / 60000 : null;
      const prior = pools.get(x.token.mint);
      return age !== null && age >= 0 && age <= MAX_AGE && num(a.reserve_in_usd) >= MIN_LIQ && (!prior || Date.now() - new Date(prior.updatedAt).getTime() >= 55000);
    }).slice(0, MAX_CANDIDATES);
    for (const item of candidates) {
      try {
        const result = await inspectCandidate(item.pool, item.token, included);
        pools.set(result.mint, result);
        paper.observe(result);
      } catch (e) {
        pools.set(item.token.mint, { mint: item.token.mint, name: item.token.name || "Unknown", symbol: item.token.symbol || "", status: "BLOCKED", eligible: false, checks: [{ label: "Security report", status: "FAIL/UNKNOWN", ok: false, detail: e.message }], updatedAt: new Date().toISOString() });
      }
    }
    // Refresh live prices for open demo positions so stop-loss / take-profit can execute.
    const openPositions = paper.snapshot().openTrades || [];
    const openMints = openPositions.map(t => t.mint).filter(Boolean).slice(0, 30);
    if (openMints.length) {
      try {
        const livePairs = await json("https://api.dexscreener.com/tokens/v1/solana/" + openMints.join(","), {}, 12000);
        for (const position of openPositions) {
          const pair = (Array.isArray(livePairs) ? livePairs : [])
            .filter(x => x.baseToken?.address === position.mint && num(x.priceUsd) > 0)
            .sort((a, b) => (num(b.liquidity?.usd) || 0) - (num(a.liquidity?.usd) || 0))[0];
          if (pair) paper.observe({
            mint: position.mint, name: pair.baseToken?.name || position.name,
            symbol: pair.baseToken?.symbol || position.symbol,
            priceUsd: num(pair.priceUsd), eligible: false
          });
        }
      } catch (e) { console.warn("Open meme position price refresh:", e.message); }
    }
    lastScanAt = new Date().toISOString(); scanError = null;
    while (pools.size > 100) pools.delete(pools.keys().next().value);
  } catch (e) { scanError = e.message; }
  finally { busy = false; }
}
function attach(app, paper) {
  app.get("/api/meme-coins", (_req, res) => res.json({
    tokens: [...pools.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    lastScanAt, error: scanError, scanning: busy,
    rpc: { state: rpcStatus.state, endpoint: rpcStatus.endpoint, lastError: rpcStatus.lastError, heliusRequired: false },
    config: { minLiquidityUsd: MIN_LIQ, minVolume5mUsd: MIN_VOL5, ageMinutes: [MIN_AGE, MAX_AGE], paperTradingOnly: true },
    note: "New-pool discovery is an indexer feed, not every mint. Bundle check is a limited same-slot buyer heuristic, not proof that all coordinated wallets are absent. Unknown checks block paper entries."
  }));
  scan(paper);
  setInterval(() => scan(paper), 60000);
}
module.exports = { attach };

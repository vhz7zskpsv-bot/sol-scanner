require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");

const app = express();
const SNIPER_DATA_DIR = "/data";
const SNIPER_RULES_FILE = path.join(SNIPER_DATA_DIR, "sniper-rules.json");
const sniperChallenges = new Map();
const sniperSessions = new Map();
let persistedSniperRules = [];
let sniperRulesLoaded = false;
let sniperRulesStorageError = null;
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

const EXPECTED_SNIPER_WALLET = process.env.SNIPER_WALLET_ADDRESS || "AU7azG5gd8LTbmTxv1ia5k8ShpeasW87A7X4D3J9MaQW";
function decodeBase58(value) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error("invalid_base58");
    number = number * 58n + BigInt(digit);
  }
  const bytes = [];
  while (number > 0n) {
    bytes.unshift(Number(number & 255n));
    number >>= 8n;
  }
  let zeroes = 0;
  while (zeroes < value.length && value[zeroes] === "1") zeroes++;
  return Buffer.concat([Buffer.alloc(zeroes), Buffer.from(bytes)]);
}
function signerKeyBytes(raw) {
  const value = String(raw || "").trim();
  if (!value) throw new Error("missing_key");
  if (value.startsWith("[")) {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new Error("invalid_key_format");
    }
    return Buffer.from(parsed);
  }
  return decodeBase58(value);
}
function deriveEd25519PublicKey(seed) {
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const privateKey = require("crypto").createPrivateKey({
    key: Buffer.concat([prefix, seed]), format: "der", type: "pkcs8"
  });
  const publicDer = require("crypto").createPublicKey(privateKey).export({
    format: "der", type: "spki"
  });
  return Buffer.from(publicDer).subarray(-32);
}
function getSniperSignerStatus() {
  const base = {
    walletAddress: EXPECTED_SNIPER_WALLET,
    signerConfigured: false,
    liveBuyingEnabled: false,
    autoBuyImplemented: false
  };
  const raw = process.env.SNIPER_WALLET_PRIVATE_KEY;
  if (!raw) return { ...base, state: "awaiting_private_key", message: "Add the sniper wallet private key in Railway Variables to verify this signer." };
  try {
    const expected = decodeBase58(EXPECTED_SNIPER_WALLET);
    if (expected.length !== 32) return { ...base, state: "invalid_expected_address", message: "Configured sniper wallet address is invalid." };
    const secret = signerKeyBytes(raw);
    if (secret.length !== 32 && secret.length !== 64) {
      return { ...base, state: "invalid_key_length", message: "Private key format must decode to 32 or 64 bytes." };
    }
    const publicKey = deriveEd25519PublicKey(secret.subarray(0, 32));
    if (secret.length === 64 && !require("crypto").timingSafeEqual(secret.subarray(32), publicKey)) {
      return { ...base, state: "invalid_key_pair", message: "Private key bytes do not form a valid Solana keypair." };
    }
    if (!require("crypto").timingSafeEqual(expected, publicKey)) {
      return { ...base, state: "address_mismatch", message: "The Railway private key does not match the selected sniper wallet address." };
    }
    return { ...base, signerConfigured: true, state: "signer_verified", message: "Signer matches the sniper wallet. Live purchases remain disabled until marketplace execution tests pass." };
  } catch {
    return { ...base, state: "invalid_private_key", message: "Private key could not be parsed or verified. Check its format in Railway Variables." };
  }
}



function normalizeSniperRules(input) {
  if (!Array.isArray(input) || input.length > 50) throw new Error("Rules must be an array with at most 50 entries.");
  return input.map((rule) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new Error("Invalid rule.");
    const symbol = String(rule.symbol || "").trim().slice(0, 100);
    if (!symbol) throw new Error("Every rule needs a collection symbol.");
    const minPrice = Number(rule.minPrice ?? 0);
    const maxPrice = Number(rule.maxPrice ?? 0);
    const maxSpend = Number(rule.maxSpend ?? 0);
    const jitoTipSol = Number(rule.jitoTipSol ?? 0);
    if (![minPrice, maxPrice, maxSpend, jitoTipSol].every(Number.isFinite) ||
        minPrice < 0 || maxPrice <= 0 || minPrice > maxPrice || maxSpend <= 0 ||
        jitoTipSol < 0 || jitoTipSol > 1) {
      throw new Error("Invalid price, budget, or Jito tip values.");
    }
    const traitValues = Array.isArray(rule.traitValues)
      ? rule.traitValues.slice(0, 100).map(v => String(v).slice(0, 120))
      : [];
    return {
      symbol,
      name: String(rule.name || symbol).slice(0, 160),
      trait: String(rule.trait || "").slice(0, 120),
      traitValues,
      traitMatch: "ANY",
      minPrice,
      maxPrice,
      maxSpend,
      jitoTipSol,
      enabled: Boolean(rule.enabled),
      mode: "configuration-only",
      updatedAt: Number.isFinite(Number(rule.updatedAt)) ? Number(rule.updatedAt) : Date.now()
    };
  });
}
async function loadPersistedSniperRules() {
  await fs.access(SNIPER_DATA_DIR);
  try {
    const raw = await fs.readFile(SNIPER_RULES_FILE, "utf8");
    persistedSniperRules = normalizeSniperRules(JSON.parse(raw));
  } catch (error) {
    if (error.code === "ENOENT") persistedSniperRules = [];
    else throw error;
  }
  sniperRulesLoaded = true;
  sniperRulesStorageError = null;
  return persistedSniperRules;
}
async function savePersistedSniperRules(rules) {
  const safeRules = normalizeSniperRules(rules);
  await fs.access(SNIPER_DATA_DIR);
  const tempFile = SNIPER_RULES_FILE + ".tmp";
  await fs.writeFile(tempFile, JSON.stringify(safeRules, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tempFile, SNIPER_RULES_FILE);
  persistedSniperRules = safeRules;
  sniperRulesLoaded = true;
  sniperRulesStorageError = null;
  return safeRules;
}
function requireSniperRulesSession(req, res, next) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const session = sniperSessions.get(token);
  if (!session || session.expiresAt < Date.now() || session.wallet !== EXPECTED_SNIPER_WALLET) {
    if (token) sniperSessions.delete(token);
    return res.status(401).json({ error: "Wallet authorization expired. Sign in again." });
  }
  req.sniperWallet = session.wallet;
  next();
}

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
      const txType = String(tx.type || tx.parsed?.type || tx.parsed?.summary?.type || "").toUpperCase();
      // Never infer NFTs from generic SPL token transfers: require Helius' explicit NFT mint classification.
      if (txType !== "NFT_MINT" && txType !== "COMPRESSED_NFT_MINT") continue;

      const tokenTransfers = Array.isArray(tx.tokenTransfers) ? tx.tokenTransfers : [];
      const nftEvent = tx.events?.nft || tx.parsed?.events?.nft || {};
      const nftEventItems = Array.isArray(nftEvent) ? nftEvent : (Array.isArray(nftEvent.nfts) ? nftEvent.nfts : [nftEvent]);
      const compressedEvents = [].concat(tx.events?.compressed || tx.parsed?.events?.compressed || []);
      const candidates = txType === "COMPRESSED_NFT_MINT"
        ? compressedEvents
        : [...nftEventItems, ...tokenTransfers];

      for (const nft of candidates) {
        const decimals = nft.decimals ?? nft.tokenDecimals;
        const amount = nft.tokenAmount ?? nft.amount;
        const standard = String(nft.tokenStandard || nft.standard || "").toLowerCase();
        if ((decimals != null && Number(decimals) !== 0) ||
            (amount != null && Number(amount) > 1) ||
            standard.includes("fungible")) continue;

        const mint = nft.mint || nft.mintAddress || nft.tokenMint || nft.assetId || nft.address;
        if (!mint || recentMints.has(mint)) continue;
        const blockTime = Number(tx.timestamp || tx.blockTime || tx.parsed?.timestamp || Date.now() / 1000);
        const metadata = nft.metadata || nft.content?.metadata || {};
        recentMints.set(mint, {
          mint,
          name: nft.name || metadata.name || nft.content?.metadata?.name || "New NFT mint",
          symbol: nft.symbol || metadata.symbol || "",
          collection: nft.collection?.name || nft.collectionName || "",
          signature: tx.signature || "",
          time: Number.isFinite(blockTime) ? blockTime * 1000 : Date.now(),
          source: "Helius Mainnet",
          standard: txType === "COMPRESSED_NFT_MINT" ? "Compressed NFT" : "NFT"
        });
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

function getSniperExecutionReadiness() {
  const signer = getSniperSignerStatus();
  let solanaWeb3Installed = false;
  try { require.resolve("@solana/web3.js"); solanaWeb3Installed = true; } catch {}
  let tensorSwapSdkInstalled = false;
  let tensorCompressedSdkInstalled = false;
  try { require.resolve("@tensor-oss/tensorswap-sdk"); tensorSwapSdkInstalled = true; } catch {}
  try { require.resolve("@tensor-oss/tcomp-sdk"); tensorCompressedSdkInstalled = true; } catch {}
  const magicEdenInstructionKeyConfigured = Boolean(process.env.MAGIC_EDEN_API_KEY);
  const checks = {
    dedicatedWalletSignerVerified: signer.signerConfigured,
    tensorLegacySdkInstalled: tensorSwapSdkInstalled,
    tensorCompressedNftSdkInstalled: tensorCompressedSdkInstalled,
    magicEdenInstructionApiKeyConfigured: magicEdenInstructionKeyConfigured,
    solanaRpcConfigured: Boolean(HELIUS_RPC),
    solanaTransactionLibraryInstalled: solanaWeb3Installed,
    transactionSimulationImplemented: false,
    jitoBundleSubmissionImplemented: false,
    marketplaceBuyExecutorImplemented: false
  };
  const blockers = Object.entries(checks)
    .filter(([name, passed]) => !passed)
    .map(([name]) => name);
  return {
    mode: "read-only-readiness-check",
    autoBuyEnabled: false,
    liveBuyingEnabled: false,
    buyExecutorImplemented: false,
    walletAddress: signer.walletAddress,
    checks,
    blockers,
    note: "This endpoint never creates, signs, or submits a transaction. Tensor documents public SDKs that do not require an API key; REST API access is separate. Magic Eden public read endpoints are free, but its instruction-generation endpoints require MAGIC_EDEN_API_KEY."
  };
}

app.get("/api/sniper/execution-readiness", (_req, res) => {
  res.json(getSniperExecutionReadiness());
});

app.get("/api/sniper/status", async (_req, res) => {
  let storageMounted = false;
  try { await fs.access(SNIPER_DATA_DIR); storageMounted = true; }
  catch (error) { sniperRulesStorageError = error.message; }
  res.json({
    ...getSniperSignerStatus(),
    rulesPersistence: {
      storageMounted,
      ready: storageMounted && sniperRulesLoaded && !sniperRulesStorageError,
      savedRuleCount: sniperRulesLoaded ? persistedSniperRules.length : null,
      error: sniperRulesStorageError
    }
  });
});
app.get("/api/sniper/rules/auth/challenge", (req, res) => {
  const wallet = String(req.query.wallet || "");
  if (wallet !== EXPECTED_SNIPER_WALLET) {
    return res.status(403).json({ error: "Connect the dedicated sniper wallet to authorize cloud rules." });
  }
  const nonce = crypto.randomBytes(24).toString("hex");
  const message = "SOL SCANNER sniper rules authorization\nWallet: " + wallet + "\nNonce: " + nonce;
  sniperChallenges.set(wallet, { nonce, message, expiresAt: Date.now() + 5 * 60 * 1000 });
  res.json({ message, expiresAt: Date.now() + 5 * 60 * 1000 });
});
app.post("/api/sniper/rules/auth/verify", (req, res) => {
  try {
    const wallet = String(req.body?.wallet || "");
    const signature = Buffer.from(String(req.body?.signature || ""), "base64");
    const challenge = sniperChallenges.get(wallet);
    if (wallet !== EXPECTED_SNIPER_WALLET || !challenge || challenge.expiresAt < Date.now() || signature.length !== 64) {
      return res.status(401).json({ error: "Authorization challenge expired or invalid." });
    }
    const publicBytes = decodeBase58(wallet);
    const publicDer = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicBytes]);
    const publicKey = crypto.createPublicKey({ key: publicDer, format: "der", type: "spki" });
    const valid = crypto.verify(null, Buffer.from(challenge.message, "utf8"), publicKey, signature);
    sniperChallenges.delete(wallet);
    if (!valid) return res.status(401).json({ error: "Wallet signature did not verify." });
    const token = crypto.randomBytes(32).toString("hex");
    sniperSessions.set(token, { wallet, expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
    res.json({ ok: true, token, expiresInSeconds: 43200 });
  } catch {
    res.status(400).json({ error: "Could not verify wallet signature." });
  }
});
app.get("/api/sniper/rules", requireSniperRulesSession, async (_req, res) => {
  try {
    if (!sniperRulesLoaded) await loadPersistedSniperRules();
    res.json({ rules: persistedSniperRules, storage: "Railway persistent volume", updated: true });
  } catch (error) {
    sniperRulesStorageError = error.message;
    res.status(503).json({ error: "Persistent rules storage is unavailable.", detail: error.message });
  }
});
app.put("/api/sniper/rules", requireSniperRulesSession, async (req, res) => {
  try {
    const rules = await savePersistedSniperRules(req.body?.rules);
    res.json({ ok: true, rules, storage: "Railway persistent volume" });
  } catch (error) {
    sniperRulesStorageError = error.message;
    res.status(400).json({ error: error.message || "Could not save sniper rules." });
  }
});

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

let collectionDirectoryCache = null;
let collectionDirectoryCacheAt = 0;
let collectionDirectoryBusy = null;
let collectionDirectoryError = null;
app.get("/api/collections/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    if (q.length < 1) return res.json({ collections: [], source: "Magic Eden collection directory" });

    // Magic Eden's Solana v2 collections endpoint is paginated, not a fuzzy-search endpoint.
    // Fetch one large page and cache it; never crawl thousands of pages per keystroke.
    if (!collectionDirectoryCache || Date.now() - collectionDirectoryCacheAt > 10 * 60 * 1000) {
      if (!collectionDirectoryBusy) {
        collectionDirectoryBusy = (async () => {
          const raw = await meGet("/collections?offset=0&limit=500");
          const items = Array.isArray(raw) ? raw : [];
          collectionDirectoryCache = items.filter(c => c && c.symbol).map(c => ({
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
          collectionDirectoryCacheAt = Date.now();
          collectionDirectoryError = null;
        })().catch(error => {
          collectionDirectoryError = error.message;
          throw error;
        }).finally(() => { collectionDirectoryBusy = null; });
      }
      await collectionDirectoryBusy;
    }
    const matches = (collectionDirectoryCache || []).filter(c =>
      (String(c.name) + " " + String(c.symbol)).toLowerCase().includes(q)
    ).slice(0, 30);
    res.json({
      collections: matches,
      source: "Magic Eden collection directory",
      indexed: collectionDirectoryCache?.length || 0,
      note: "Search covers the cached first 500 Magic Eden collections, not every collection ever created."
    });
  } catch (error) {
    // Keep serving a warm cache if Magic Eden is temporarily rate-limiting requests.
    if (collectionDirectoryCache?.length) {
      const matches = collectionDirectoryCache.filter(c =>
        (String(c.name) + " " + String(c.symbol)).toLowerCase().includes(String(req.query.q || "").trim().toLowerCase())
      ).slice(0, 30);
      return res.json({ collections: matches, source: "Magic Eden cached directory", indexed: collectionDirectoryCache.length, warning: error.message });
    }
    res.status(502).json({ collections: [], error: error.message, hint: "Magic Eden is rate-limiting collection search. Wait briefly and retry." });
  }
});

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
    note: "Only Helius-classified NFT_MINT and COMPRESSED_NFT_MINT transactions are shown; generic SPL TOKEN_MINT events are excluded. This is not a complete mint index."
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

const collectionAttributesCache = new Map();
const collectionAttributesBusy = new Map();
app.get("/api/collection/:symbol/attributes", async (req, res) => {
  const symbol = String(req.params.symbol || "").trim();
  if (!symbol) return res.status(400).json({ attributes: [], error: "Collection symbol is required" });
  const cached = collectionAttributesCache.get(symbol);
  if (cached && Date.now() - cached.at < 15 * 60 * 1000) {
    return res.json({ attributes: cached.attributes, source: "Magic Eden", cached: true });
  }
  try {
    if (!collectionAttributesBusy.has(symbol)) {
      const pending = meGet(`/collections/${encodeURIComponent(symbol)}/attributes`)
        .then(raw => {
          collectionAttributesCache.set(symbol, { attributes: raw, at: Date.now() });
          return raw;
        })
        .finally(() => collectionAttributesBusy.delete(symbol));
      collectionAttributesBusy.set(symbol, pending);
    }
    const attributes = await collectionAttributesBusy.get(symbol);
    res.json({ attributes, source: "Magic Eden", cached: false });
  } catch (error) {
    res.status(502).json({ attributes: [], error: error.message, hint: "Magic Eden could not load this collection's traits. Try again shortly." });
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

let newCollectionsCache = null;
let newCollectionsCacheAt = 0;
let newCollectionsBusy = null;
app.get("/api/new", async (_req, res) => {
  try {
    if (newCollectionsCache && Date.now() - newCollectionsCacheAt < 10 * 60 * 1000) {
      return res.json(newCollectionsCache);
    }
    if (!newCollectionsBusy) {
      newCollectionsBusy = (async () => {
        // Use marketplace creation timestamps only; never relabel active-sale collections as newly created.
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
        newCollectionsCache = {
          collections,
          source: "Magic Eden",
          note: "Only collections with marketplace creation timestamps are shown; this is not a complete launch feed."
        };
        newCollectionsCacheAt = Date.now();
      })().finally(() => { newCollectionsBusy = null; });
    }
    await newCollectionsBusy;
    res.json(newCollectionsCache || { collections: [], source: "Magic Eden" });
  } catch (error) {
    res.status(502).json({ collections: [], error: error.message });
  }
});

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`SOL SCANNER running on port ${PORT}`);
  loadPersistedSniperRules().then(rules => console.log(`Loaded ${rules.length} sniper rules from persistent volume`)).catch(error => { sniperRulesStorageError = error.message; console.error("Sniper rules volume unavailable:", error.message); });
  pollSales();
  pollNewMints();
  pollTensorSales();
  setInterval(pollSales, 6000);
  setInterval(pollNewMints, 30000);
  setInterval(pollTensorSales, 60000);
});

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
    const collectionAddress = String(rule.collectionAddress || "").trim();
    if (collectionAddress && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(collectionAddress)) {
      throw new Error("Core collection address must be a valid Solana public key.");
    }
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
      collectionAddress,
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
const globalMagicEdenSales = new Map();
const magicEdenSeenSignatures = new Set();
const MAGIC_EDEN_PROGRAMS = [
  "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K",
  "mmm3XBJg5k8XJxEKBvdgptZz6SgK4tXvn36sodowMc"
];
let magicEdenLastPollAt = null;
let magicEdenPollError = null;
let magicEdenPollBusy = false;
let magicEdenBaselineReady = false;
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
    const cutoff = Date.now() - 12 * 60 * 60 * 1000;
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
  const t = String(a.type ?? a.txType ?? a.activityType ?? "").toLowerCase().replace(/[\\s-]+/g, "_");
  // Magic Eden reports both instant buys and accepted bids as sales.
  return ["buy", "sale", "accept_bid", "fill_order", "nft_sale"].some(k => t.includes(k));
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
async function pollMagicEdenSales() {
  if (magicEdenPollBusy) return;
  if (!HELIUS_API_KEY) {
    magicEdenPollError = "HELIUS_API_KEY is not configured";
    return;
  }
  magicEdenPollBusy = true;
  try {
    // Watch the Magic Eden V2 and MMM programs directly, rather than rotating
    // through a truncated collection directory.
    const groups = await Promise.all(MAGIC_EDEN_PROGRAMS.map(address =>
      heliusRpc("getSignaturesForAddress", [address, { limit: 50, commitment: "confirmed" }])
    ));
    const signatures = groups.flat().filter(item => item?.signature);
    // On process startup, establish a clean live-feed boundary: do not replay
    // transactions that were already present before this scanner started.
    if (!magicEdenBaselineReady) {
      for (const item of signatures) magicEdenSeenSignatures.add(item.signature);
      magicEdenBaselineReady = true;
      magicEdenLastPollAt = new Date().toISOString();
      magicEdenPollError = null;
      return;
    }
    const fresh = signatures
      .filter(item => !magicEdenSeenSignatures.has(item.signature))
      .slice(0, 100);
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
      if (!response.ok) throw new Error(`Helius parsed-transactions returned ${response.status}`);
      const parsed = await response.json();
      if (!Array.isArray(parsed)) throw new Error("Unexpected Helius parsed-transactions response");
      for (const item of fresh) magicEdenSeenSignatures.add(item.signature);
      for (const tx of parsed) {
        const source = String(tx.source || "").toUpperCase();
        const type = String(tx.type || "").toUpperCase();
        if (!source.includes("MAGIC_EDEN") || type !== "NFT_SALE") continue;
        const nft = tx.events?.nft || {};
        const amount = Number(nft.amount ?? nft.saleAmount);
        const timestamp = Number(tx.timestamp || nft.timestamp);
        const nfts = Array.isArray(nft.nfts) ? nft.nfts : [];
        const first = nfts[0] || {};
        const mint = first.mint || first.assetId || "";
        const collection = first.collection || nft.collection || {};
        const signature = tx.signature;
        if (!signature || globalMagicEdenSales.has(signature) || !Number.isFinite(amount) || amount <= 0 ||
            !Number.isFinite(timestamp) || timestamp <= 0) continue;
        const price = amount > 100000 ? amount / 1e9 : amount;
        const symbol = String(collection.symbol || collection.name || "Magic Eden");
        tracked.add(symbol);
        globalMagicEdenSales.set(signature, {
          id: signature, symbol, collection: collection.name || symbol,
          mint, time: timestamp * 1000, price, marketplace: "Magic Eden",
          signature, source: "Helius parsed on-chain Magic Eden sale"
        });
      }
    }
    while (magicEdenSeenSignatures.size > 10000) {
      magicEdenSeenSignatures.delete(magicEdenSeenSignatures.values().next().value);
    }
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const [id, sale] of globalMagicEdenSales) if (sale.time < cutoff) globalMagicEdenSales.delete(id);
    magicEdenLastPollAt = new Date().toISOString();
    magicEdenPollError = null;
  } catch (error) {
    magicEdenPollError = error.message;
  } finally {
    magicEdenPollBusy = false;
  }
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
    const cutoff = Date.now() - 12 * 60 * 60 * 1000;
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
  const packageInstalled = (name) => {
    try { require.resolve(name); return true; } catch { return false; }
  };
  const loadExports = (name) => {
    try { return require(name); } catch { return null; }
  };
  const web3 = loadExports("@solana/web3.js");
  const tensor = loadExports("@tensor-foundation/marketplace");
  const common = loadExports("@tensor-foundation/common-helpers");
  const resolvers = loadExports("@tensor-foundation/resolvers");
  const tensorExports = {
    createSolanaRpc: typeof web3?.createSolanaRpc === "function",
    createKeyPairSignerFromBytes: typeof web3?.createKeyPairSignerFromBytes === "function",
    findListStatePda: typeof tensor?.findListStatePda === "function",
    fetchMaybeListState: typeof tensor?.fetchMaybeListState === "function",
    getBuyLegacyInstructionAsync: typeof tensor?.getBuyLegacyInstructionAsync === "function",
    getBuyCoreInstructionAsync: typeof tensor?.getBuyCoreInstructionAsync === "function",
    findAssetListStatePda: typeof tensor?.findAssetListStatePda === "function",
    fetchMaybeAssetListState: typeof tensor?.fetchMaybeAssetListState === "function",
    getBuyCompressedInstructionAsync: typeof tensor?.getBuyCompressedInstructionAsync === "function",
    fetchMetadata: typeof common?.fetchMetadata === "function",
    simulateTxWithIxs: typeof common?.simulateTxWithIxs === "function",
    findMetadataPda: typeof resolvers?.findMetadataPda === "function"
  };
  const solanaWeb3Installed = packageInstalled("@solana/web3.js");
  const tensorMarketplaceSdkInstalled = packageInstalled("@tensor-foundation/marketplace");
  const tensorCommonHelpersInstalled = packageInstalled("@tensor-foundation/common-helpers");
  const tensorSwapSdkInstalled = packageInstalled("@tensor-oss/tensorswap-sdk");
  const tensorCompressedSdkInstalled = packageInstalled("@tensor-oss/tcomp-sdk");
  const magicEdenInstructionKeyConfigured = Boolean(process.env.MAGIC_EDEN_API_KEY);
  const checks = {
    dedicatedWalletSignerVerified: signer.signerConfigured,
    tensorMarketplaceSdkInstalled,
    tensorCommonHelpersInstalled,
    tensorLegacySdkInstalled: tensorSwapSdkInstalled,
    tensorCompressedNftSdkInstalled: tensorCompressedSdkInstalled,
    magicEdenInstructionApiKeyConfigured: magicEdenInstructionKeyConfigured,
    solanaRpcConfigured: Boolean(HELIUS_RPC),
    solanaTransactionLibraryInstalled: solanaWeb3Installed,
    tensorLegacyBuyInstructionAvailable: tensorExports.getBuyLegacyInstructionAsync,
    tensorCoreBuyInstructionAvailable: tensorExports.getBuyCoreInstructionAsync,
    tensorCoreListingStateAvailable: tensorExports.findAssetListStatePda && tensorExports.fetchMaybeAssetListState,
    tensorCompressedBuyInstructionAvailable: tensorExports.getBuyCompressedInstructionAsync,
    tensorTransactionSimulationHelperAvailable: tensorExports.simulateTxWithIxs,
    transactionSimulationImplemented: true,
    jitoBundleSubmissionImplemented: false,
    marketplaceBuyExecutorImplemented: false
  };
  const optionalSdkChecks = new Set(["tensorLegacySdkInstalled", "tensorCompressedNftSdkInstalled"]);
  const blockers = Object.entries(checks)
    .filter(([name, passed]) => !passed && !optionalSdkChecks.has(name))
    .map(([name]) => name);
  return {
    mode: "read-only-readiness-check",
    autoBuyEnabled: false,
    liveBuyingEnabled: false,
    buyExecutorImplemented: false,
    walletAddress: signer.walletAddress,
    checks,
    tensorExports,
    blockers,
    optionalSdkChecks: ["tensorLegacySdkInstalled", "tensorCompressedNftSdkInstalled"],
    note: "The unified Tensor Marketplace SDK provides legacy and compressed buy-instruction functions; the separate older SDK packages are optional. A legacy Tensor listing simulation endpoint is implemented and uses unsigned RPC simulation only. It never signs or submits a transaction. Magic Eden instruction generation requires MAGIC_EDEN_API_KEY."
  };
}


async function simulateTensorLegacyListing(mint) {
  let stage = "initialization";
  try {
  if (!getSniperSignerStatus().signerConfigured) throw new Error("Dedicated sniper signer is not verified.");
  // Auto-route Core assets even if an older browser tab calls the legacy endpoint.
  stage = "detecting NFT standard through Helius DAS";
  const detectedAsset = await heliusRpc("getAsset", { id: mint });
  if (detectedAsset?.interface === "MplCoreAsset") return await simulateTensorCoreListing(mint);
  if (!HELIUS_RPC) throw new Error("Solana RPC is not configured.");

  stage = "loading SDK modules";
  const web3 = require("@solana/web3.js");
  const tensor = require("@tensor-foundation/marketplace");
  const common = require("@tensor-foundation/common-helpers");
  const resolvers = require("@tensor-foundation/resolvers");
  stage = "loading dedicated signer";
  const secret = signerKeyBytes(process.env.SNIPER_WALLET_PRIVATE_KEY);
  const seed = secret.subarray(0, 32);
  const publicKey = deriveEd25519PublicKey(seed);
  const secret64 = secret.length === 64 ? secret : Buffer.concat([seed, publicKey]);
  const signer = await web3.createKeyPairSignerFromBytes(new Uint8Array(secret64), false);
  if (signer.address !== EXPECTED_SNIPER_WALLET) throw new Error("SDK signer address does not match the configured sniper wallet.");

  stage = "validating NFT mint";
  const mintAddress = web3.address(mint);
  const rpc = web3.createSolanaRpc(HELIUS_RPC);
  stage = "looking up Tensor listing account";
  const [listStateAddress] = await tensor.findListStatePda({ mint: mintAddress });
  stage = "fetching Tensor listing account";
  const listState = await tensor.fetchMaybeListState(rpc, listStateAddress);
  if (!listState || !listState.data) {
    throw new Error("No active Tensor legacy listing exists for this NFT mint. List the NFT on Tensor first, then retry the dry-run.");
  }
  const { owner, amount, rentPayer, makerBroker, privateTaker, cosigner } = listState.data;
  if (!owner || amount == null) {
    throw new Error("Tensor listing account is incomplete; owner or listing price is missing.");
  }

  if ((web3.isSome(privateTaker) && web3.unwrapOption(privateTaker) !== signer.address) || cosigner) {
    throw new Error("This Tensor listing is private or requires a cosigner; safe public SDK simulation is not supported.");
  }

  const priceLamports = Number(amount);
  if (!Number.isSafeInteger(priceLamports) || priceLamports <= 0) throw new Error("Tensor listing returned an invalid price.");
  const priceSol = priceLamports / 1_000_000_000;
  if (priceSol > 0.02) throw new Error("Listing price exceeds your 0.02 SOL maximum.");

  stage = "deriving NFT metadata account";
  const [metadataPda] = await resolvers.findMetadataPda({ mint: mintAddress });
  stage = "checking on-chain metadata account";
  const metadataAccountResult = await heliusRpc("getAccountInfo", [
    metadataPda,
    { encoding: "base64", commitment: "confirmed" }
  ]);
  if (!metadataAccountResult?.value) {
    stage = "checking NFT through Helius DAS";
    const asset = await heliusRpc("getAsset", { id: mint });
    if (asset) {
      const assetInterface = asset.interface || asset.content?.metadata?.token_standard || "unknown";
      const assetName = asset.content?.metadata?.name || "unnamed asset";
      throw new Error("NFT is indexed by Helius DAS (" + assetName + "; interface: " + assetInterface + ") but has no Metaplex Token Metadata PDA. It may be a Metaplex Core or compressed NFT; this legacy Tensor dry-run cannot process that standard.");
    }
    throw new Error("Helius DAS could not find this mint as an NFT asset, and no Metaplex metadata account exists. Verify the mint/asset ID and mainnet network.");
  }
  stage = "fetching NFT metadata";
  let metadata;
  try {
    metadata = await common.fetchMetadata(rpc, metadataPda);
  } catch (metadataError) {
    stage = "cross-checking NFT with Helius DAS";
    const asset = await heliusRpc("getAsset", { id: mint });
    if (asset) {
      const assetInterface = asset.interface || asset.content?.metadata?.token_standard || "unknown";
      const assetName = asset.content?.metadata?.name || "unnamed asset";
      throw new Error("Helius DAS confirms asset " + assetName + " (interface: " + assetInterface + "), but Tensor's legacy metadata decoder failed: " + String(metadataError?.message || metadataError).slice(0, 100));
    }
    throw metadataError;
  }
  if (!metadata || !metadata.data) {
    throw new Error("NFT metadata was not found on-chain for this mint. Verify the NFT mint address and metadata account.");
  }
  if (!metadata.tokenStandard) {
    throw new Error("NFT token standard is missing or unsupported by this Tensor legacy dry-run.");
  }
  const symbol = String(metadata.data.symbol || "").trim();
  if (!symbol) {
    throw new Error("NFT collection symbol is missing from metadata, so its saved sniper rule cannot be matched.");
  }
  const matchingRule = persistedSniperRules.find(rule => rule.enabled && rule.symbol.toLowerCase() === symbol.toLowerCase());
  if (!matchingRule) throw new Error("No enabled sniper rule matches this NFT collection symbol.");
  if (matchingRule.trait) throw new Error("This dry-run currently refuses trait-filtered rules until NFT attributes can be verified against the listing metadata.");
  if (priceSol < matchingRule.minPrice || priceSol > matchingRule.maxPrice || priceSol > matchingRule.maxSpend) {
    throw new Error("Listing price is outside the enabled collection rule's price or spend limits.");
  }

  const creators = (metadata?.data?.creators || []).map(creator => creator.address);
  const ruleSet = metadata?.programmableConfig?.ruleSet ?? undefined;
  stage = "building unsigned Tensor buy instruction";
  const buyIx = await tensor.getBuyLegacyInstructionAsync({
    payer: signer,
    owner,
    mint: mintAddress,
    maxAmount: amount,
    rentDestination: rentPayer ?? undefined,
    makerBroker: web3.unwrapOption(makerBroker) ?? undefined,
    takerBroker: signer.address,
    authorizationRules: ruleSet,
    tokenStandard: metadata.tokenStandard,
    creators
  });

  // Tensor's helper compiles an unsigned v0 message and calls simulateTransaction
  // with sigVerify=false. It does not sign or submit the transaction.
  stage = "simulating unsigned transaction";
  const simulation = await common.simulateTxWithIxs(rpc, [buyIx], signer);
  const value = simulation?.value || {};
  return {
    mode: "unsigned-tensor-simulation",
    mint,
    collectionSymbol: symbol,
    walletAddress: signer.address,
    listingPriceSol: priceSol,
    rule: { minPrice: matchingRule.minPrice, maxPrice: matchingRule.maxPrice, maxSpend: matchingRule.maxSpend },
    simulationPassed: !value.err,
    simulationError: value.err || null,
    unitsConsumed: value.unitsConsumed ?? null,
    logs: Array.isArray(value.logs) ? value.logs.slice(-30) : [],
    transactionSigned: false,
    transactionSubmitted: false,
    solSpent: false,
    note: "Unsigned simulation only. No signature, network submission, Jito tip, or SOL spend. Exact total fees must be verified before any live purchase."
  };
  } catch (error) {
    const detail = String(error?.message || error || "unknown error").slice(0, 180);
    throw new Error("Dry-run failed during " + stage + ": " + detail);
  }
}



function encodeBase58(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let out = "";
  while (number > 0n) {
    const digit = Number(number % 58n);
    out = alphabet[digit] + out;
    number /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out || "1";
}

function decodeTensorCoreListData(encoded) {
  const bytes = decodeBase58(encoded);
  const discriminator = Buffer.from([173, 76, 167, 125, 118, 71, 1, 153]);
  if (bytes.length < 16 || !bytes.subarray(0, 8).equals(discriminator)) return null;
  const amount = bytes.readBigUInt64LE(8);
  let offset = 16;
  const readOption = (size) => {
    if (offset >= bytes.length) throw new Error("Truncated Core listing instruction data.");
    const tag = bytes[offset++];
    if (tag === 0) return null;
    if (tag !== 1 || offset + size > bytes.length) throw new Error("Malformed Core listing option data.");
    const value = bytes.subarray(offset, offset + size);
    offset += size;
    return value;
  };
  readOption(8); // expiry
  const currency = readOption(32);
  const privateTaker = readOption(32);
  const makerBroker = readOption(32);
  return {
    amount,
    currency: currency ? encodeBase58(currency) : null,
    privateTaker: privateTaker ? encodeBase58(privateTaker) : null,
    makerBroker: makerBroker ? encodeBase58(makerBroker) : null
  };
}

async function findActiveTensorCoreListing(rpc, tensor, mintAddress, mint) {
  const [listStateAddress] = await tensor.findAssetListStatePda({ asset: mintAddress });
  const state = await tensor.fetchMaybeAssetListState(rpc, listStateAddress);
  if (!state || !state.exists) throw new Error("No active Tensor Core listing-state account exists for this asset.");
  const signatures = await heliusRpc("getSignaturesForAddress", [
    listStateAddress, { limit: 20, commitment: "confirmed" }
  ]);
  for (const entry of signatures || []) {
    if (!entry.signature) continue;
    const tx = await heliusRpc("getTransaction", [
      entry.signature,
      { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }
    ]);
    const instructions = tx?.transaction?.message?.instructions || [];
    for (const ix of instructions) {
      if (ix.programId !== "TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp" || !ix.data) continue;
      const listing = decodeTensorCoreListData(ix.data);
      if (!listing) continue;
      const accounts = (ix.accounts || []).map(a => typeof a === "string" ? a : a.pubkey);
      if (!accounts.includes(listStateAddress) || !accounts.includes(mint)) continue;
      if (listing.privateTaker) throw new Error("This Core listing is private-taker restricted; safe public simulation is refused.");
      if (listing.currency) throw new Error("This Core listing uses a non-SOL currency; this dry-run only supports SOL listings.");
      if (listing.amount <= 0n) throw new Error("Core listing contains an invalid price.");
      if (listing.amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Core listing price exceeds safe numeric range.");
      const listingOwner = accounts[3];
      if (!listingOwner) throw new Error("Tensor Core listCore instruction did not expose its owner account; refusing to infer the seller.");
      return {
        listStateAddress, listingOwner, amount: listing.amount, makerBroker: listing.makerBroker,
        signature: entry.signature, accounts
      };
    }
  }
  throw new Error("The active Core listing PDA exists, but its matching Tensor listCore transaction could not be decoded. No buy instruction was built.");
}

async function simulateTensorCoreListing(mint) {
  let stage = "initialization";
  try {
    if (!getSniperSignerStatus().signerConfigured) throw new Error("Dedicated sniper signer is not verified.");
    if (!HELIUS_RPC) throw new Error("Solana RPC is not configured.");
    stage = "loading Tensor SDK";
    const web3 = require("@solana/web3.js");
    const tensor = require("@tensor-foundation/marketplace");
    const common = require("@tensor-foundation/common-helpers");
    if (typeof tensor.getBuyCoreInstructionAsync !== "function" ||
        typeof tensor.findAssetListStatePda !== "function" ||
        typeof tensor.fetchMaybeAssetListState !== "function") {
      throw new Error("Installed Tensor SDK does not expose the required Core listing and buy functions.");
    }
    stage = "loading dedicated signer";
    const secret = signerKeyBytes(process.env.SNIPER_WALLET_PRIVATE_KEY);
    const seed = secret.subarray(0, 32);
    const publicKey = deriveEd25519PublicKey(seed);
    const secret64 = secret.length === 64 ? secret : Buffer.concat([seed, publicKey]);
    const signer = await web3.createKeyPairSignerFromBytes(new Uint8Array(secret64), false);
    if (signer.address !== EXPECTED_SNIPER_WALLET) throw new Error("SDK signer address does not match the configured sniper wallet.");

    stage = "reading asset through Helius DAS";
    const asset = await heliusRpc("getAsset", { id: mint });
    if (!asset || asset.interface !== "MplCoreAsset") {
      throw new Error("This endpoint only handles Helius DAS MplCoreAsset NFTs; detected interface: " + String(asset?.interface || "not found"));
    }
    const mintAddress = web3.address(mint);
    const rpc = web3.createSolanaRpc(HELIUS_RPC);
    stage = "verifying active Tensor Core listing and decoding its on-chain terms";
    const listing = await findActiveTensorCoreListing(rpc, tensor, mintAddress, mint);

    const currentAssetOwner = String(asset.ownership?.owner || "");
    if (!currentAssetOwner) throw new Error("Helius DAS did not return the current Core asset owner.");
    // Tensor Core listings custody-transfer the asset to the list-state PDA.
    // The seller remains the separate owner signer at listCore account index 3.
    if (currentAssetOwner !== listing.listStateAddress) {
      throw new Error("Helius DAS asset owner is not the Tensor listing-state PDA; the NFT may have been transferred out or the listing is no longer active.");
    }
    const owner = listing.listingOwner;
    if (!owner) throw new Error("Tensor Core listing seller could not be verified from the on-chain listCore instruction.");
    const collection = (asset.grouping || []).find(g => g.group_key === "collection")?.group_value || null;
    let symbol = String(asset.content?.metadata?.symbol || "").trim();
    // Core asset metadata may omit the collection symbol. Resolve it from the
    // DAS collection asset itself; never infer a symbol from the NFT name.
    if (!symbol && collection) {
      stage = "resolving Core collection metadata through Helius DAS";
      const collectionAsset = await heliusRpc("getAsset", { id: collection });
      if (collectionAsset && collectionAsset.interface === "MplCoreCollection") {
        symbol = String(collectionAsset.content?.metadata?.symbol || "").trim();
      }
    }
    const matchingRule = persistedSniperRules.find(rule => {
      if (!rule.enabled) return false;
      if (rule.collectionAddress) return Boolean(collection) && rule.collectionAddress === collection;
      return Boolean(symbol) && rule.symbol.toLowerCase() === symbol.toLowerCase();
    });
    if (!matchingRule) {
      if (!symbol && collection) {
        throw new Error("Core collection symbol is missing. Add this exact on-chain collection address to the saved rule: " + collection);
      }
      throw new Error("No enabled sniper rule matches this verified Core collection identity.");
    }
    const attributes = asset.content?.metadata?.attributes || [];
    if (matchingRule.trait) {
      const trait = attributes.find(a => String(a.trait_type || "").toLowerCase() === matchingRule.trait.toLowerCase());
      const allowed = matchingRule.traitValues || [];
      if (!trait || !allowed.length || !allowed.some(v => String(v).toLowerCase() === String(trait.value).toLowerCase())) {
        throw new Error("Core NFT does not match the saved trait filter.");
      }
    }

    const priceLamports = listing.amount;
    const priceSol = Number(priceLamports) / 1e9;
    if (!Number.isFinite(priceSol) || priceSol <= 0) throw new Error("Invalid Core listing price.");
    if (priceSol > 0.02) throw new Error("Listing price exceeds your 0.02 SOL maximum.");
    if (priceSol < matchingRule.minPrice || priceSol > matchingRule.maxPrice || priceSol > matchingRule.maxSpend) {
      throw new Error("Core listing price is outside the enabled collection rule's price or spend limits.");
    }

    const royaltyBps = Number(asset.royalty?.basis_points ?? 0);
    if (!Number.isFinite(royaltyBps) || royaltyBps < 0 || royaltyBps > 10000) {
      throw new Error("Helius DAS returned invalid Core royalty basis points.");
    }
    const royaltyLamports = (priceLamports * BigInt(Math.round(royaltyBps)) + 9999n) / 10000n;
    const marketFeeLamports = (priceLamports * 2n + 99n) / 100n;
    const maxAmount = priceLamports + royaltyLamports + marketFeeLamports;
    const estimatedTotalSol = Number(maxAmount) / 1e9;
    const balance = await heliusRpc("getBalance", [signer.address, { commitment: "confirmed" }]);
    const balanceLamports = BigInt(balance?.value || 0);
    const reserveLamports = 2_000_000n;
    if (maxAmount + reserveLamports > balanceLamports) {
      throw new Error("Estimated listing price + 2% Tensor taker fee + full royalty exceeds spendable wallet balance after a 0.002 SOL reserve.");
    }

    const creators = (asset.creators || []).filter(c => c.address).map(c => web3.address(c.address));
    if (!creators.length) throw new Error("Helius DAS returned no creator addresses; royalty accounts cannot be safely constructed.");
    stage = "building unsigned Tensor Core buy instruction";
    const buyIx = await tensor.getBuyCoreInstructionAsync({
      asset: mintAddress,
      ...(collection ? { collection: web3.address(collection) } : {}),
      payer: signer,
      buyer: signer.address,
      owner: web3.address(owner),
      takerBroker: signer.address,
      ...(listing.makerBroker ? { makerBroker: web3.address(listing.makerBroker) } : {}),
      maxAmount,
      creators
    });

    stage = "simulating unsigned Core buy transaction";
    const simulation = await common.simulateTxWithIxs(rpc, [buyIx], signer);
    const value = simulation?.value || {};
    return {
      mode: "unsigned-tensor-core-simulation",
      standard: "MplCoreAsset",
      mint,
      collectionSymbol: symbol,
      walletAddress: signer.address,
      listingPriceSol: priceSol,
      estimatedRoyaltySol: Number(royaltyLamports) / 1e9,
      estimatedTensorFeeSol: Number(marketFeeLamports) / 1e9,
      estimatedTotalSol,
      walletBalanceSol: Number(balanceLamports) / 1e9,
      listingSignature: listing.signature,
      rule: { minPrice: matchingRule.minPrice, maxPrice: matchingRule.maxPrice, maxSpend: matchingRule.maxSpend, trait: matchingRule.trait || null },
      simulationPassed: !value.err,
      simulationError: value.err || null,
      unitsConsumed: value.unitsConsumed ?? null,
      logs: Array.isArray(value.logs) ? value.logs.slice(-30) : [],
      transactionSigned: false,
      transactionSubmitted: false,
      solSpent: false,
      note: "Core unsigned RPC simulation only. No signature, transaction submission, Jito tip, or SOL spend. A live executor is not enabled."
    };
  } catch (error) {
    const detail = String(error?.message || error || "unknown error").slice(0, 200);
    throw new Error("Core dry-run failed during " + stage + ": " + detail);
  }
}

app.post("/api/sniper/tensor/simulate-core", requireSniperRulesSession, async (req, res) => {
  try {
    const mint = String(req.body?.mint || "").trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
      return res.status(400).json({ error: "Enter a valid Solana NFT asset address." });
    }
    const result = await simulateTensorCoreListing(mint);
    res.status(result.simulationPassed ? 200 : 422).json(result);
  } catch (error) {
    res.status(400).json({
      mode: "unsigned-tensor-core-simulation",
      simulationPassed: false,
      transactionSigned: false,
      transactionSubmitted: false,
      solSpent: false,
      error: String(error.message || "Tensor Core simulation failed").slice(0, 260)
    });
  }
});


app.post("/api/sniper/tensor/simulate-legacy", requireSniperRulesSession, async (req, res) => {
  try {
    const mint = String(req.body?.mint || "").trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
      return res.status(400).json({ error: "Enter a valid Solana NFT mint address." });
    }
    const result = await simulateTensorLegacyListing(mint);
    res.status(result.simulationPassed ? 200 : 422).json(result);
  } catch (error) {
    res.status(400).json({
      mode: "unsigned-tensor-simulation",
      simulationPassed: false,
      transactionSigned: false,
      transactionSubmitted: false,
      solSpent: false,
      error: String(error.message || "Tensor simulation failed").slice(0, 240)
    });
  }
});

app.get("/api/sniper/execution-readiness", (_req, res) => {
  res.json(getSniperExecutionReadiness());
});

app.get("/api/sniper/self-test", async (_req, res) => {
  const signer = getSniperSignerStatus();
  const result = {
    mode: "read-only-self-test",
    transactionsCreated: false,
    transactionsSigned: false,
    transactionsSubmitted: false,
    walletAddress: signer.walletAddress,
    checks: {
      signerMatchesWallet: signer.signerConfigured,
      rpcReachable: false,
      walletBalanceReadable: false
    },
    balanceSol: null,
    rpcVersion: null,
    errors: []
  };
  if (!signer.signerConfigured) result.errors.push("sniper_signer_not_verified");
  try {
    const version = await heliusRpc("getVersion", []);
    result.checks.rpcReachable = true;
    result.rpcVersion = version?.["solana-core"] || null;
  } catch (error) {
    result.errors.push("rpc: " + String(error.message || "unavailable").slice(0, 180));
  }
  if (result.checks.rpcReachable) {
    try {
      const balance = await heliusRpc("getBalance", [signer.walletAddress, { commitment: "confirmed" }]);
      const lamports = Number(balance?.value);
      if (!Number.isFinite(lamports) || lamports < 0) throw new Error("invalid_balance_response");
      result.checks.walletBalanceReadable = true;
      result.balanceSol = lamports / 1_000_000_000;
    } catch (error) {
      result.errors.push("balance: " + String(error.message || "unavailable").slice(0, 180));
    }
  }
  result.passed = Object.values(result.checks).every(Boolean);
  result.note = "Read-only check only. No SOL can be spent by this endpoint.";
  res.status(result.passed ? 200 : 503).json(result);
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
    const collections = (Array.isArray(raw) ? raw : []).filter(c => c && c.symbol).map((c) => ({
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

    // The directory feed does not include a reliable highest bid. Enrich the
    // 30 rows displayed by the dashboard with the dedicated collection stats
    // endpoint, using bounded concurrency to avoid API bursts.
    for (let i = 0; i < Math.min(collections.length, 30); i += 5) {
      await Promise.all(collections.slice(i, i + 5).map(async (collection) => {
        try {
          const stats = await meGet(`/collections/${encodeURIComponent(collection.symbol)}/stats`);
          collection.floorPrice = sol(stats.floorPrice) ?? collection.floorPrice;
          collection.highestBid = sol(stats.highestBid ?? stats.highestOffer ?? stats.highestBidPrice);
          collection.listedCount = stats.listedCount ?? collection.listedCount;
          collection.volume24h = sol(stats.volume24hr ?? stats.volume24h) ?? collection.volume24h;
        } catch {
          // Keep directory values where available; a missing bid stays null.
        }
      }));
    }

    collectionsCache = { collections, source: "Magic Eden collection stats" };
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
  const windows = { "5m": volumeFor(5), "15m": volumeFor(15), "1h": volumeFor(60), "4h": volumeFor(240), "6h": volumeFor(360), "12h": volumeFor(720) };
  const perCollection = {};
  for (const symbol of tracked) {
    const recent = [...sales.values()].filter(x => x.symbol === symbol);
    const volume = (minutes) => {
      const cutoff = Date.now() - minutes * 60 * 1000;
      const items = recent.filter(x => x.time >= cutoff);
      return { sol: items.reduce((sum, item) => sum + item.price, 0), sales: items.length };
    };
    perCollection[symbol] = { "5m": volume(5), "15m": volume(15), "1h": volume(60), "4h": volume(240), "6h": volume(360), "12h": volume(720) };
  }
  res.json({
    windows, perCollection,
    trackedCollections: tracked.size,
    lastPollAt,
    note: "Observed Magic Eden sale activity from the rotating tracked collection set; not historical backfill.",
    warning: pollError
  });
});

app.get("/api/live-sales", (_req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.json({
    sales: [...globalMagicEdenSales.values()].sort((a, b) => b.time - a.time).slice(0, 100),
    source: "Magic Eden on-chain program monitoring via Helius",
    lastPollAt: magicEdenLastPollAt,
    warning: magicEdenPollError,
    note: "Global program feed covers observed Magic Eden V2/MMM NFT_SALE transactions since monitoring began; it is not historical backfill and depends on Helius indexing."
  });
});

app.get("/api/tensor/volume", (_req, res) => {
  res.json({
    windows: { "5m": tensorVolumeFor(5), "15m": tensorVolumeFor(15), "1h": tensorVolumeFor(60), "4h": tensorVolumeFor(240), "6h": tensorVolumeFor(360), "12h": tensorVolumeFor(720) },
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


const tensorCollectionCache = new Map();
async function tensorApiGet(route) {
  const key = process.env.TENSOR_API_KEY;
  if (!key) throw new Error("Tensor API key is not configured in Railway. Magic Eden links work without it; Tensor collection lookup/traits need TENSOR_API_KEY.");
  const response = await fetch("https://api.mainnet.tensordev.io/api/v1" + route, {
    headers: { accept: "application/json", "x-tensor-api-key": key },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error("Tensor API returned " + response.status + ". Check the Tensor API key and collection link.");
  return response.json();
}
app.get("/api/marketplace/collection-link", async (req, res) => {
  try {
    const marketplace = String(req.query.marketplace || "").toLowerCase();
    const slug = String(req.query.slug || "").trim();
    if (!slug || slug.length > 160 || !["magiceden", "tensor"].includes(marketplace)) {
      return res.status(400).json({ error: "Paste a valid Magic Eden or Tensor collection link." });
    }
    if (marketplace === "tensor") {
      const cacheKey = "tensor:" + slug;
      const cached = tensorCollectionCache.get(cacheKey);
      if (cached && Date.now() - cached.at < 10 * 60 * 1000) return res.json({ collection: cached.collection, source: "Tensor" });
      const raw = await tensorApiGet("/collections/find?query=" + encodeURIComponent(slug));
      const candidates = Array.isArray(raw) ? raw : (raw.collections || raw.results || (raw.collection ? [raw.collection] : []));
      const match = candidates.find(c => c.slugDisplay === slug || c.slugMe === slug || c.symbol === slug) || candidates[0];
      if (!match) return res.status(404).json({ error: "Tensor could not resolve this collection link. Check the copied collection URL." });
      const collection = {
        symbol: String(match.slugDisplay || match.slugMe || match.symbol || slug),
        name: match.name || match.slugDisplay || slug,
        collId: match.collId || null,
        coreCollectionAddress: String(match.tokenProgram || "").toUpperCase() === "MPL_CORE" ? (match.collId || "") : "",
        tokenStandard: match.tokenStandard || "",
        source: "Tensor"
      };
      tensorCollectionCache.set(cacheKey, { collection, at: Date.now() });
      return res.json({ collection, source: "Tensor" });
    }
    const stats = await meGet("/collections/" + encodeURIComponent(slug) + "/stats");
    const collection = {
      symbol: slug,
      name: stats.name || stats.symbol || slug,
      floorPrice: sol(stats.floorPrice),
      listedCount: stats.listedCount ?? null,
      volume24h: sol(stats.volume24hr ?? stats.volume24h),
      highestBid: sol(stats.highestBid ?? stats.highestOffer),
      source: "Magic Eden"
    };
    return res.json({ collection, source: "Magic Eden" });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});
app.get("/api/marketplace/collection/:slug/attributes", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    const raw = await tensorApiGet("/collections/" + encodeURIComponent(slug) + "/traits");
    const attributes = raw.attributes || raw.traits || raw;
    res.json({ attributes, source: "Tensor" });
  } catch (error) {
    res.status(502).json({ attributes: [], error: error.message });
  }
});

const coreCollectionTraitsCache = new Map();
const coreCollectionTraitsBusy = new Map();
app.get("/api/core/collection/:address/attributes", async (req, res) => {
  const address = String(req.params.address || "").trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    return res.status(400).json({ attributes: [], error: "A valid on-chain Core collection address is required." });
  }
  const cached = coreCollectionTraitsCache.get(address);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
    return res.json({ attributes: cached.attributes, assetCount: cached.assetCount, source: "Helius DAS Core collection assets", cached: true, complete: cached.complete });
  }
  try {
    if (!coreCollectionTraitsBusy.has(address)) {
      const pending = (async () => {
        const traits = new Map();
        let page = 1;
        let assetCount = 0;
        let complete = false;
        const maxPages = 20;
        while (page <= maxPages) {
          const result = await heliusRpc("getAssetsByGroup", {
            groupKey: "collection",
            groupValue: address,
            page,
            limit: 1000,
            displayOptions: { showCollectionMetadata: true }
          });
          const items = Array.isArray(result?.items) ? result.items : [];
          for (const asset of items) {
            if (asset?.interface !== "MplCoreAsset") continue;
            assetCount++;
            const attrs = asset?.content?.metadata?.attributes;
            if (!Array.isArray(attrs)) continue;
            for (const attr of attrs) {
              const type = String(attr?.trait_type ?? attr?.traitType ?? "").trim();
              const value = attr?.value == null ? "" : String(attr.value).trim();
              if (!type || !value) continue;
              if (!traits.has(type)) traits.set(type, new Set());
              traits.get(type).add(value);
            }
          }
          const total = Number(result?.total ?? 0);
          if (items.length < 1000 || (total > 0 && page * 1000 >= total) || !items.length) {
            complete = true;
            break;
          }
          page++;
        }
        const attributes = [...traits.entries()].map(([trait_type, values]) => ({
          trait_type, values: [...values].sort((a, b) => a.localeCompare(b))
        })).sort((a, b) => a.trait_type.localeCompare(b.trait_type));
        const value = { attributes, assetCount, complete, at: Date.now() };
        coreCollectionTraitsCache.set(address, value);
        return value;
      })().finally(() => coreCollectionTraitsBusy.delete(address));
      coreCollectionTraitsBusy.set(address, pending);
    }
    const result = await coreCollectionTraitsBusy.get(address);
    res.json({
      attributes: result.attributes,
      assetCount: result.assetCount,
      source: "Helius DAS Core collection assets",
      cached: false,
      complete: result.complete,
      note: result.complete ? "Traits aggregated from indexed Core NFTs in this collection." : "Partial trait index: collection exceeded the 20,000-asset scan limit."
    });
  } catch (error) {
    res.status(502).json({ attributes: [], error: error.message, hint: "Helius DAS could not index this Core collection. Verify the on-chain collection address and retry." });
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
    // Magic Eden documents a maximum page size of 1000 for this endpoint.
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit || 100)));
    const payload = await meGet(`/collections/${encodeURIComponent(req.params.symbol)}/activities?offset=0&limit=${limit}`);
    const activities = Array.isArray(payload) ? payload :
      (payload?.activities ?? payload?.results ?? payload?.data ?? []);
    res.json({ activities: Array.isArray(activities) ? activities : [], source: "Magic Eden" });
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


// --- Dedicated Tensor bidding rules (separate from NFT buy-sniper) ---
const BID_RULES_FILE = path.join(SNIPER_DATA_DIR, "bid-rules.json");
let persistedBidRules = [];
let bidRulesLoaded = false;
let bidRulesStorageError = null;
function normalizeBidRules(input) {
  if (!Array.isArray(input) || input.length > 50) throw new Error("Bid rules must be an array with at most 50 entries.");
  return input.map((rule) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new Error("Invalid bid rule.");
    const collectionSlug = String(rule.collectionSlug || "").trim().slice(0, 160);
    const collectionName = String(rule.collectionName || collectionSlug).trim().slice(0, 160);
    const bidType = String(rule.bidType || "collection").toLowerCase();
    const startBidSol = Number(rule.startBidSol);
    const maxBidSol = Number(rule.maxBidSol);
    const incrementSol = Number(rule.incrementSol);
    if (!collectionSlug || !/^[a-zA-Z0-9._-]{1,160}$/.test(collectionSlug)) throw new Error("Every bid rule needs a valid Tensor collection slug.");
    if (!["collection", "trait"].includes(bidType)) throw new Error("Bid type must be collection or trait.");
    if (![startBidSol, maxBidSol, incrementSol].every(Number.isFinite) ||
        startBidSol <= 0 || maxBidSol < startBidSol || incrementSol <= 0 || maxBidSol > 100000) {
      throw new Error("Enter valid starting bid, maximum bid, and positive bid increment.");
    }
    const traitName = String(rule.traitName || "").trim().slice(0, 120);
    const traitValue = String(rule.traitValue || "").trim().slice(0, 160);
    if (bidType === "trait" && (!traitName || !traitValue)) throw new Error("Trait bids require both a trait name and value.");
    const whitelistAddress = String(rule.whitelistAddress || "").trim();
    if (whitelistAddress && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(whitelistAddress)) throw new Error("Tensor whitelist address must be a valid Solana public key.");
    return {
      id: String(rule.id || crypto.randomUUID()).slice(0, 80),
      marketplace: "Tensor",
      collectionSlug,
      collectionName,
      bidType,
      traitName: bidType === "trait" ? traitName : "",
      traitValue: bidType === "trait" ? traitValue : "",
      whitelistAddress: String(rule.whitelistAddress || "").trim(),
      startBidSol,
      maxBidSol,
      incrementSol,
      autoOutbid: Boolean(rule.autoOutbid),
      enabled: Boolean(rule.enabled),
      executionMode: "locked",
      createdAt: Number.isFinite(Number(rule.createdAt)) ? Number(rule.createdAt) : Date.now(),
      updatedAt: Date.now()
    };
  });
}
async function loadPersistedBidRules() {
  await fs.access(SNIPER_DATA_DIR);
  try {
    persistedBidRules = normalizeBidRules(JSON.parse(await fs.readFile(BID_RULES_FILE, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") persistedBidRules = [];
    else throw error;
  }
  bidRulesLoaded = true;
  bidRulesStorageError = null;
  return persistedBidRules;
}
async function savePersistedBidRules(rules) {
  const safe = normalizeBidRules(rules);
  await fs.access(SNIPER_DATA_DIR);
  const tmp = BID_RULES_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(safe, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, BID_RULES_FILE);
  persistedBidRules = safe;
  bidRulesLoaded = true;
  bidRulesStorageError = null;
  return safe;
}
app.get("/api/bids/status", async (_req, res) => {
  let storageMounted = false;
  try { await fs.access(SNIPER_DATA_DIR); storageMounted = true; } catch (error) { bidRulesStorageError = error.message; }
  res.json({
    marketplace: "Tensor",
    apiKeyConfigured: Boolean(process.env.TENSOR_API_KEY),
    storageMounted,
    rulesLoaded: bidRulesLoaded,
    savedRuleCount: bidRulesLoaded ? persistedBidRules.length : null,
    executionEnabled: false,
    autoOutbidEnabled: false,
    transactionSigningEnabled: false,
    keylessSdkPath: true,
    warning: !process.env.TENSOR_API_KEY
      ? "Tensor REST order-book monitoring needs an API key. The official SDK simulation path does not, but it needs a Tensor whitelist address and Helius RPC."
      : "Live execution remains locked until bid creation, escrow funding, cancellation, and transaction simulation are verified.",
    storageError: bidRulesStorageError
  });
});

function unwrapTensorRows(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["bids", "orders", "results", "data", "collectionBids", "traitBids"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}
function bidAmountSol(row) {
  for (const key of ["amount", "price", "bidPrice", "priceLamports", "amountLamports", "grossAmount"]) {
    const value = Number(row?.[key]);
    if (Number.isFinite(value) && value > 0) return key.toLowerCase().includes("lamport") || value > 100000 ? value / 1e9 : value;
  }
  return null;
}
function bidOwner(row) {
  return String(row?.owner || row?.bidder || row?.wallet || row?.maker || row?.ownerAddress || "");
}
const bidMarketCache = new Map();
let bidMonitorLastAt = null;
let bidMonitorLastError = null;
async function resolveTensorCollectionForBid(slug) {
  const cached = tensorCollectionCache.get("tensor:" + slug);
  if (cached?.collection?.collId) return cached.collection;
  const raw = await tensorApiGet("/collections/find?query=" + encodeURIComponent(slug));
  const candidates = Array.isArray(raw) ? raw : (raw.collections || raw.results || (raw.collection ? [raw.collection] : []));
  const match = candidates.find(c => c.slugDisplay === slug || c.slugMe === slug || c.symbol === slug) || candidates[0];
  if (!match?.collId) throw new Error("Tensor collection ID could not be resolved for " + slug);
  const collection = { collId: match.collId, symbol: match.slugDisplay || match.slugMe || match.symbol || slug, name: match.name || slug };
  tensorCollectionCache.set("tensor:" + slug, { collection, at: Date.now() });
  return collection;
}
async function fetchBidMarketSnapshot(rule) {
  const collection = await resolveTensorCollectionForBid(rule.collectionSlug);
  const route = rule.bidType === "trait" ? "/collections/trait_bids" : "/collections/coll_bids";
  const query = new URLSearchParams({ collId: collection.collId, limit: rule.bidType === "trait" ? "100" : "50" });
  const payload = await tensorApiGet(route + "?" + query.toString());
  let rows = unwrapTensorRows(payload);
  if (rule.bidType === "trait") {
    rows = rows.filter(row => {
      const traits = row?.traits || row?.attributes || row?.trait || row?.traitAttributes || [];
      if (Array.isArray(traits)) return traits.some(t =>
        String(t?.trait_type || t?.traitType || t?.name || t?.key || "").toLowerCase() === rule.traitName.toLowerCase() &&
        String(t?.value ?? t?.traitValue ?? "").toLowerCase() === rule.traitValue.toLowerCase()
      );
      if (traits && typeof traits === "object") return String(traits[rule.traitName] ?? "").toLowerCase() === rule.traitValue.toLowerCase();
      return false;
    });
  }
  const ranked = rows.map(row => ({ row, amountSol: bidAmountSol(row), owner: bidOwner(row) }))
    .filter(item => item.amountSol !== null)
    .sort((a, b) => b.amountSol - a.amountSol);
  const top = ranked[0] || null;
  const own = ranked.find(item => item.owner === EXPECTED_SNIPER_WALLET) || null;
  return {
    ruleId: rule.id,
    collection: collection.name,
    bidType: rule.bidType,
    trait: rule.bidType === "trait" ? { name: rule.traitName, value: rule.traitValue } : null,
    marketBidCount: ranked.length,
    highestBidSol: top?.amountSol ?? null,
    highestBidOwner: top?.owner || null,
    ownBidSol: own?.amountSol ?? null,
    outbid: Boolean(top && top.owner !== EXPECTED_SNIPER_WALLET && top.amountSol >= rule.startBidSol),
    nextSuggestedBidSol: top ? Math.min(rule.maxBidSol, Number((top.amountSol + rule.incrementSol).toFixed(9))) : rule.startBidSol,
    maxReached: Boolean(top && top.amountSol + rule.incrementSol > rule.maxBidSol),
    observedAt: Date.now(),
    source: "Tensor REST order book",
    executionEnabled: false
  };
}
app.get("/api/bids/monitor", requireSniperRulesSession, async (_req, res) => {
  try {
    if (!bidRulesLoaded) await loadPersistedBidRules();
    if (!process.env.TENSOR_API_KEY) return res.status(503).json({ error: "Tensor API key is not configured in Railway yet.", snapshots: [], executionEnabled: false });
    const active = persistedBidRules.filter(rule => rule.enabled).slice(0, 10);
    const snapshots = [];
    for (const rule of active) {
      try {
        const cacheKey = rule.id;
        const cached = bidMarketCache.get(cacheKey);
        if (cached && Date.now() - cached.at < 10000) snapshots.push(cached.value);
        else {
          const value = await fetchBidMarketSnapshot(rule);
          bidMarketCache.set(cacheKey, { value, at: Date.now() });
          snapshots.push(value);
        }
      } catch (error) {
        snapshots.push({ ruleId: rule.id, error: error.message, observedAt: Date.now(), executionEnabled: false });
      }
    }
    bidMonitorLastAt = Date.now();
    bidMonitorLastError = null;
    res.json({ snapshots, checkedAt: bidMonitorLastAt, pollIntervalMs: 15000, executionEnabled: false, autoOutbidEnabled: false, note: "Read-only market monitoring only. No bid is signed, submitted, edited, or cancelled." });
  } catch (error) {
    bidMonitorLastError = error.message;
    res.status(502).json({ error: error.message, snapshots: [], executionEnabled: false });
  }
});

app.post("/api/bids/simulate", requireSniperRulesSession, async (req, res) => {
  try {
    if (!bidRulesLoaded) await loadPersistedBidRules();
    const ruleId = String(req.body?.ruleId || "");
    const rule = persistedBidRules.find(item => item.id === ruleId);
    if (!rule) return res.status(404).json({ error: "Saved bid rule was not found." });
    if (!rule.enabled) return res.status(400).json({ error: "Turn this bid rule on before simulation." });
    if (!rule.whitelistAddress) return res.status(400).json({ error: "Add the Tensor whitelist address for this collection or trait target first." });
    const amountSol = Number(req.body?.amountSol ?? rule.startBidSol);
    if (!Number.isFinite(amountSol) || amountSol < rule.startBidSol || amountSol > rule.maxBidSol) {
      return res.status(400).json({ error: "Simulation amount must be between the rule starting bid and maximum bid." });
    }
    if (!HELIUS_RPC) return res.status(503).json({ error: "HELIUS_API_KEY is required for mainnet transaction simulation." });
    const signerStatus = getSniperSignerStatus();
    if (!signerStatus.signerConfigured || signerStatus.walletAddress !== req.sniperWallet) {
      return res.status(503).json({ error: "Dedicated bid signer is not verified for the authorized wallet." });
    }
    const secret = signerKeyBytes(process.env.SNIPER_WALLET_PRIVATE_KEY);
    if (secret.length !== 32 && secret.length !== 64) {
      return res.status(400).json({ error: "The configured Solana keypair must decode to 32 or 64 bytes." });
    }
    const seed = secret.subarray(0, 32);
    const publicKey = deriveEd25519PublicKey(seed);
    const secret64 = secret.length === 64 ? secret : Buffer.concat([seed, publicKey]);
    const web3 = await import("@solana/web3.js");
    const marketplace = await import("@tensor-foundation/marketplace");
    const helpers = await import("@tensor-foundation/common-helpers");
    if (typeof helpers.simulateTxWithIxs !== "function") throw new Error("Installed Tensor common-helpers package does not expose simulateTxWithIxs.");
    if (typeof marketplace.getBidInstructionAsync !== "function" || !marketplace.Target || marketplace.Target.Whitelist == null) {
      throw new Error("Installed Tensor Marketplace SDK does not expose the expected collection-bid instruction API.");
    }
    const signer = await web3.createKeyPairSignerFromBytes(new Uint8Array(secret64), false);
    if (signer.address !== EXPECTED_SNIPER_WALLET) throw new Error("SDK signer address does not match the configured dedicated wallet.");
    const targetAddress = web3.address(rule.whitelistAddress);
    const amountLamports = BigInt(Math.round(amountSol * 1e9));
    const instruction = await marketplace.getBidInstructionAsync({
      owner: signer,
      target: marketplace.Target.Whitelist,
      targetId: targetAddress,
      amount: amountLamports,
      quantity: 1,
      makerBroker: signer.address
    });
    if (instruction.programAddress !== "TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp") {
      throw new Error("Unexpected Tensor marketplace program address; refusing simulation.");
    }
    if (!Array.isArray(instruction.accounts) || instruction.accounts.length < 7 || !(instruction.data instanceof Uint8Array)) {
      throw new Error("Tensor SDK returned an incomplete bid instruction; refusing simulation.");
    }
    if (typeof marketplace.getBidInstructionDataDecoder !== "function") {
      throw new Error("Installed Tensor SDK cannot decode its generated bid instruction for verification.");
    }
    const decoded = marketplace.getBidInstructionDataDecoder().decode(instruction.data);
    if (decoded.target !== marketplace.Target.Whitelist ||
        decoded.targetId !== targetAddress ||
        BigInt(decoded.amount) !== amountLamports ||
        Number(decoded.quantity) !== 1 ||
        decoded.makerBroker !== signer.address) {
      throw new Error("Generated bid instruction did not match the saved collection target and bid limits.");
    }
    const rpc = web3.createSolanaRpc(HELIUS_RPC);
    const simulation = await helpers.simulateTxWithIxs(rpc, [instruction], signer);
    const value = simulation?.value;
    if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, "err")) {
      throw new Error("RPC simulation returned an unrecognized response; refusing to report success.");
    }
    if (value.err) throw new Error("Tensor bid simulation failed: " + JSON.stringify(value.err));
    res.json({
      ok: true, simulated: true, submitted: false, signedForSubmission: false,
      ruleId: rule.id, bidType: rule.bidType, targetAddress: rule.whitelistAddress,
      amountSol, amountLamports: amountLamports.toString(), quantity: 1,
      signer: signer.address, programAddress: instruction.programAddress, instructionCount: 1,
      unitsConsumed: value.unitsConsumed ?? null,
      logs: Array.isArray(value.logs) ? value.logs.slice(-25) : [],
      note: "Verified unsigned RPC simulation only. No transaction was signed or submitted and no SOL was spent. Collection bids target a Tensor whitelist; a trait rule is only valid if its whitelist is specifically configured for that trait."
    });
  } catch (error) {
    res.status(502).json({ error: error.message || "Tensor bid simulation failed.", simulated: false, submitted: false });
  }
});

app.get("/api/bids/rules", requireSniperRulesSession, async (_req, res) => {
  try {
    if (!bidRulesLoaded) await loadPersistedBidRules();
    res.json({ rules: persistedBidRules, storage: "Railway persistent volume", executionEnabled: false });
  } catch (error) {
    bidRulesStorageError = error.message;
    res.status(503).json({ error: "Persistent bid-rules storage is unavailable." });
  }
});
app.put("/api/bids/rules", requireSniperRulesSession, async (req, res) => {
  try {
    const rules = await savePersistedBidRules(req.body?.rules);
    res.json({ ok: true, rules, storage: "Railway persistent volume", executionEnabled: false });
  } catch (error) {
    bidRulesStorageError = error.message;
    res.status(400).json({ error: error.message || "Could not save bid rules." });
  }
});

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`SOL SCANNER running on port ${PORT}`);
  loadPersistedSniperRules().then(rules => console.log(`Loaded ${rules.length} sniper rules from persistent volume`)).catch(error => { sniperRulesStorageError = error.message; console.error("Sniper rules volume unavailable:", error.message); });
  pollSales();
  pollMagicEdenSales();
  pollNewMints();
  pollTensorSales();
  setInterval(pollSales, 6000);
  setInterval(pollMagicEdenSales, 15000);
  setInterval(pollNewMints, 30000);
  setInterval(pollTensorSales, 60000);
});

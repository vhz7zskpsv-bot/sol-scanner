# SOL Scanner

Dark, mobile-friendly Solana dashboard with SOL technical signals and a separate Solana meme-coin scanner / paper-trading simulator.

## Features
- SOL scalp, intraday and swing technical signals from Kraken public SOL/USD candles.
- Existing SOL paper-trading simulator with persistent trade history.
- New Solana pool discovery through GeckoTerminal.
- Token risk reports through RugCheck.
- Limited same-slot buyer-cluster heuristic using public Solana JSON-RPC endpoints (PublicNode, then Solana public RPC); no Helius key is required.
- Separate $1,000 virtual meme paper account; $25 demo position sizing, 15% stop, 30% target, estimated fees and slippage.
- All required security checks must pass on two consecutive scans before a demo entry.
- NFT marketplace, collection, sale and mint monitor endpoints/UI removed.
- No real wallet connection, private key, or real order execution.

## RPC configuration
- `SOLANA_RPC_URL` optional. If omitted, the scanner uses `https://solana-rpc.publicnode.com` and falls back to `https://api.mainnet.solana.com`.
- No Helius account or API key is required.
- Public RPC endpoints are shared and rate-limited. If all endpoints fail or return rate limits, the bundle check becomes UNKNOWN and paper entries remain blocked.

## Other configuration
- `PORT` optional (Railway sets it automatically).
- `PAPER_TRADING_FILE` optional path for SOL demo state.
- `MEME_PAPER_FILE` optional path for meme demo state. Railway volume mount defaults to persistent `/data`.

## Run
Node.js 20+:
```sh
npm install
npm start
```

## Safety notes
Unknown checks fail closed. RugCheck's score and reports are screening signals, not guarantees. The bundle detector samples recent pool transactions and flags large same-slot buyer clusters; it cannot reliably identify every coordinated wallet or every launch bundle. Liquidity locks, holder distribution and creator attribution may be incomplete for some tokens, so missing evidence blocks entries. GeckoTerminal's new-pool feed is not every token mint. Paper performance is not a forecast of live returns. Solana documents that shared public RPC endpoints are rate-limited and not intended for production workloads.

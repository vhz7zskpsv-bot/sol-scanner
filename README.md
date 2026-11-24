# SOL SCANNER

A mobile-friendly dark dashboard starter for tracking Solana NFT collections.

## Features
- Responsive purple/neon dashboard
- Solana Mainnet health check through Helius RPC
- Marketplace collection and discovery feed through Magic Eden API
- 5m / 15m / 1h timeframe controls (volume aggregation is a follow-up implementation)
- Website-only alerts panel placeholder

## Run locally
1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env`.
3. Add your Helius API key to `HELIUS_API_KEY`.
4. Optionally add a Magic Eden API key to `MAGIC_EDEN_API_KEY` if your API access requires one.
5. Run `npm install`, then `npm start`.
6. Open `http://localhost:3000`.

## Deploy
Deploy as a Node.js web service on a host such as Render or Railway. Set the environment variables in the host dashboard; do not commit `.env` or paste API keys into source files.

## Data limitations
- Collection floor and volume values depend on the marketplace API response and availability.
- Highest bid is shown as unavailable until a supported bid endpoint is integrated.
- The new collection panel uses a marketplace discovery feed. It is not a complete on-chain mint detector.
- Exact 5m/15m/1h sales aggregation and persistent browser alerts are not yet implemented in this starter.
- Helius is currently used for a Mainnet RPC health check; full on-chain NFT mint indexing is a later step.

Never share wallet seed phrases or private keys. API keys belong only in deployment environment secrets.


## Deploy on Render (free starter)

Use the one-click Render Blueprint button below. Render will ask you to connect GitHub and approve creation of one free web service.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/vhz7zskpsv-bot/sol-scanner)

When Render asks for secrets, enter your Helius API key in the `HELIUS_API_KEY` field. Keep it in Render's Environment settings only; never commit it to GitHub. The Magic Eden key is optional and can be left blank unless your marketplace API access requires one.

The free web service may sleep when idle and can take a short time to wake on the next visit.

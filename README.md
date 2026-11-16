# CINTEXA Intelligence OS

Multi-department organisational intelligence platform with a responsive web command centre, React Native mobile client and ETI as a Bitget-live-only department.

## Run the web application

Requires Node.js 20+.

```bash
npm install
npm run dev:web
npm test
npm run check
```

## Architecture

- Web: Vite, vanilla ES modules and responsive CSS.
- Mobile: Expo / React Native.
- API: Cloudflare Workers.
- Relational records: Cloudflare D1.
- Planned real-time coordination: Durable Objects.
- Planned background processing: Queues and Cron.
- Object storage: R2.

Free-tier quotas apply; they do not guarantee continuous high-frequency production trading.

## ETI execution policy

Bitget is the only configured execution venue. No paper or testnet order route exists in this project. Live order submission remains disabled until production authentication, account reconciliation, server-side risk evaluation, instrument metadata, idempotency and exchange-side protective-order services have been independently implemented and verified.

Use a Bitget API key without withdrawal permissions. Store credentials as Cloudflare Worker secrets, never in web/mobile bundles.

## GainzAlgo integrity

The V2 and Alpha adapters intentionally return neutral signals until authorised strategy source or exact specifications are supplied. No proprietary rules are invented. The SMC engine contains deterministic baseline implementations of FVG, liquidity sweeps, BOS and order blocks; it is not a guarantee of profitable signals.

## Status

This is an early foundation, not a production-ready autonomous trading platform. The interface and initial modules are committed; real account connectivity, authenticated user identity, full exchange order lifecycle, market WebSockets, departmental agent runtime, D1-backed persistence and production acceptance tests remain outstanding.
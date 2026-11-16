# CINTEXA Intelligence OS

Multi-department organisational intelligence platform with a responsive web command centre, React Native mobile client and ETI as a Bitget-live-only department.

## Run the web application

Requires Node.js 20+.

```bash
npm install
npm run dev:web
npm test
npm run check
npm run build:web
```

The static web application expects the Worker API on the same origin by default. When the Worker is hosted separately, define `window.CINTEXA_API_BASE` before loading `src.js` with the Worker hostname. Configure the Worker `CORS_ORIGIN` variable to the exact Pages/site origin.

## Bitget market-data API

The Worker exposes public market-data routes; market data does not require API credentials:

- `GET /api/market/instruments?productType=USDT-FUTURES`
- `GET /api/market/ticker?productType=USDT-FUTURES&symbol=BTCUSDT`
- `GET /api/market/candles?productType=USDT-FUTURES&symbol=BTCUSDT&granularity=1min&limit=200`
- `POST /api/eti/signals` with `{"productType":"USDT-FUTURES","symbol":"BTCUSDT","granularity":"1min"}`

Supported product families: Spot, Margin metadata, USDT Futures, USDC Futures and Coin Futures. Candle intervals are validated and normalized for Bitget's Spot and Mix APIs. The web command centre refreshes ticker and one-minute candle history every 60 seconds.

## Architecture

- Web: Vite, vanilla ES modules and responsive CSS.
- Mobile: Expo / React Native.
- API: Cloudflare Workers.
- Relational records: Cloudflare D1 (initial schema committed; runtime persistence integration remains in progress).
- Planned real-time coordination: Durable Objects.
- Planned background processing: Queues and Cron.
- Object storage: R2.

Free-tier quotas apply; they do not guarantee continuous high-frequency production trading.

## ETI execution policy

Bitget is the only configured execution venue. No paper or testnet order route exists in this project. **Live order submission is hard-disabled in code.** The order function rejects every request until production authentication, independently computed server-side risk, instrument metadata, exchange-side stop-loss/take-profit placement, idempotency, fill reconciliation and emergency position management have been implemented and tested. Environment flags or client-supplied attestations cannot bypass this block.

Use a Bitget API key without withdrawal permissions when authenticated account services are introduced. Store credentials as Cloudflare Worker secrets, never in web/mobile bundles. Public market data uses unauthenticated endpoints.

## ETIAlgo V3 Alpha

ETIAlgo V3 Alpha is ETI's native, independently developed algorithm. It does not depend on GainzAlgo V2 or V2 Alpha, external indicator licences or proprietary vendor source code. Its initial implementation contains a V3 core engine using EMA alignment, MACD, RSI, ADX, ATR, VWAP, Bollinger context and relative volume; an Alpha impulse engine for candle expansion and local momentum breaks; and a confluence layer comparing both engines with recent BOS, CHoCH, liquidity sweeps, FVG, IFVG, order blocks and inducement evidence. It also analyses EQH/EQL and premium/discount positioning. Bitget candles are fetched across 1m, 5m, 15m, 1H and 4H intervals for higher-timeframe agreement. It returns a heuristic signal-quality score, market-regime label, evidence and entry context. Scores are not calibrated probabilities. Multi-timeframe orchestration, order-book/funding/open-interest intelligence, backtesting, walk-forward validation and model calibration remain future phases. The Worker obtains market data and instrument status server-side and does not trust client-supplied freshness or risk approval. Signals remain non-executable until independent account-risk controls and the full protective-order lifecycle are verified.

No indicator or model can guarantee profitable or accurate future trades. Backtesting, walk-forward validation, fee/slippage modelling and out-of-sample evaluation are required before any strategy is relied upon.

## Current status

This is an early foundation, not a production-ready autonomous trading platform. Implemented: executive interface, department directory, Bitget public REST market-data service, minute-refreshing market chart, initial SMC engine, risk module, strategy adapter contracts, D1 schema and CI checks. Outstanding: Bitget WebSocket streaming, complete instrument metadata synchronisation, authenticated user identity and roles, D1-backed runtime persistence, exact authorised GainzAlgo V2/Alpha rules, comprehensive strategy validation, account reconciliation, protective-order lifecycle, and full production acceptance/security testing.

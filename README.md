# CINTEXA Intelligence OS

Multi-department organisational intelligence platform with a responsive web command centre, React Native mobile client and ETI as a Bitget-only trading department.

## Run the web application

Requires Node.js 20+.

```bash
npm install
npm run dev:web
npm test
npm run check
npm run build:web
```

Cloudflare Pages: build command `npm run build` (alias of `build:web`), output directory `dist`.

`npm run check` syntax-checks every plain JavaScript file in the repository automatically (React Native sources under `apps/` use JSX and are skipped).

The static web application expects the Worker API on the same origin by default. When the Worker is hosted separately, set `window.CINTEXA_API_BASE` in `public/config.js` (served unbundled, so it can be edited after a build and works under the strict Content-Security-Policy) to the Worker origin, and set the Worker `CORS_ORIGIN` variable to the exact site origin. `public/_headers` supplies security headers (CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`) when hosted on Cloudflare Pages.

## Worker configuration

Copy `.env.example` to `worker/.dev.vars` for local development (git-ignored) and use `wrangler secret put` in production.

| Name | Kind | Purpose |
| --- | --- | --- |
| `BITGET_API_KEY`, `BITGET_API_SECRET`, `BITGET_API_PASSPHRASE` | secret | Future authenticated Bitget services (public market data needs none). |
| `ETI_EXECUTION_TOKEN` | secret | Bearer token for `POST /api/eti/orders`. The route stays hard-disabled and answers `403` once authorised. |
| `ETI_INGESTION_TOKEN` | secret | `x-eti-ingestion-token` for `POST /api/eti/observations` and `POST /api/eti/outcomes/evaluate`. |
| `CORS_ORIGIN` | variable | Exact web origin allowed to call the API (default `https://cintexa.com`). |
| `RATE_LIMIT_PER_MIN` | variable | Per-IP cap for `POST /api/eti/signals` (default 30). |

Token comparisons are constant-time. Client errors (malformed JSON, invalid symbol/product) return `400`; upstream Bitget failures return a sanitised `502` (full diagnostics go to Worker logs, not to clients); rate-limited callers receive `429` with `Retry-After`.

### Abuse protection

`POST /api/eti/signals` fans out to several Bitget endpoints and writes to D1. It has a best-effort per-IP limiter, but Worker isolates do not share memory, so it is a backstop, not a guarantee. Add a Cloudflare rate-limiting rule for `/api/eti/signals` on the zone for authoritative protection. Observations and signals are persisted only for symbols confirmed in the Bitget instrument catalogue, and observation timestamps are bucketed to the minute so repeated requests deduplicate instead of growing the table.

## Bitget market-data API

Public market-data routes do not require API credentials:

- `GET /api/market/instruments?productType=USDT-FUTURES`
- `GET /api/market/ticker?productType=USDT-FUTURES&symbol=BTCUSDT`
- `GET /api/market/candles?productType=USDT-FUTURES&symbol=BTCUSDT&granularity=1min&limit=200`
- `GET /api/market/context?productType=USDT-FUTURES&symbol=BTCUSDT`
- `POST /api/eti/signals` with `{"productType":"USDT-FUTURES","symbol":"BTCUSDT","granularity":"1min"}`. If a higher-timeframe request fails the analysis still completes (fail-closed) and `market.unavailableTimeframes` lists what was missing.

Supported product families: Spot, Margin metadata, USDT Futures, USDC Futures and Coin Futures. Candle intervals are validated and normalized for Bitget Spot and Mix APIs. The web command centre refreshes ticker and one-minute candle history every 60 seconds.

Market context uses Bitget public order-book depth for Spot/Margin and Mix futures, plus current funding rate and open interest for derivatives. The engine derives spread in basis points, bid/ask depth, notional imbalance and directional pressure. Funding is treated as a carry/crowding warning, not a standalone entry signal. A single open-interest snapshot is displayed as a level only; it is not misrepresented as rising or falling interest. If the order book is missing, crossed, stale or too wide, microstructure approval fails closed.

## ETIAlgo V3 Alpha

ETIAlgo V3 Alpha is ETI's native, independently developed algorithm. It does not require GainzAlgo V2 or V2 Alpha, external indicator licences, or proprietary vendor source code.

The engine includes:
- V3 trend and momentum core: EMA alignment, MACD, RSI, ADX, ATR, VWAP, Bollinger context and relative volume.
- Alpha impulse engine: candle expansion and local momentum breaks.
- Smart Money Concepts: BOS, CHoCH, liquidity sweeps, FVG, IFVG, order blocks, inducement, EQH/EQL and premium/discount positioning.
- Multi-timeframe agreement using Bitget candles from 1m through 1W, with higher-timeframe context evaluated relative to the selected chart interval.
- Market microstructure: live order-book spread, depth, bid/ask imbalance, funding-rate pressure and open-interest context.
- Signal confluence: engine agreement, recent structure evidence, higher-timeframe alignment, fresh liquidity conditions and data quality.
- Trade planning: ATR/swing-aware stop placement, graduated reward-to-risk targets, risk-budget sizing, notional/margin caps and fee/slippage assumptions. Position sizing is withheld until verified account equity and available balance are supplied from authenticated Bitget account data.

Scores are heuristic signal-quality measures, not calibrated probabilities or promises of profitability. The current Alpha impulse engine is deterministic candle analysis, not a trained predictive model. Historical backtesting, walk-forward validation, out-of-sample evaluation, Monte Carlo analysis and score calibration remain required before assessing predictive performance.

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

Bitget is the only configured execution venue. No paper or testnet order route exists in this project. **Live order submission remains hard-disabled.** The order function rejects every request until production authentication, independently computed server-side risk, instrument metadata, exchange-side stop-loss/take-profit placement, idempotency, fill reconciliation and emergency position management have been implemented and tested. Environment flags or client-supplied attestations cannot bypass this block.

Use a Bitget API key without withdrawal permissions when authenticated account services are introduced. Store credentials as Cloudflare Worker secrets, never in web/mobile bundles. Public market data uses unauthenticated endpoints.

## Validation policy

No indicator or model guarantees profitable future trades. Backtesting, walk-forward validation, fee/slippage modelling, out-of-sample evaluation and signal calibration are required before relying on the algorithm for live execution.

## Current status

Implemented: executive interface, department directory, Bitget public REST market-data service, minute-refreshing market chart, native ETIAlgo V3 Alpha core and Alpha impulse analysis, expanded SMC modules, multi-timeframe analysis, order-book/funding/open-interest context, microstructure confluence, trade-planning module, independent risk module, D1 schema and CI checks.

Known limitations: the mobile client is a static preview and is not connected to the Worker API; the repository has no committed lockfile (`npm install` is used in CI); Bitget spot/margin candle interval strings for hours/days (for example `1H`, `1D`) are sent unchanged and should be confirmed against Bitget's current spot API before relying on spot multi-timeframe analysis.

Outstanding: Bitget WebSocket streaming, authenticated account and position synchronisation, verified account equity for sizing, D1-backed runtime persistence, complete execution lifecycle, advanced backtesting and walk-forward validation, model calibration, production acceptance and security testing.

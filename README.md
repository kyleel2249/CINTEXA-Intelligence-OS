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

The static web application expects the Worker API on the same origin by default. When the Worker is hosted separately, define `window.CINTEXA_API_BASE` before loading `src.js` with the Worker hostname. Configure the Worker `CORS_ORIGIN` variable to the exact Pages/site origin.

## Bitget market-data API

Public market-data routes do not require API credentials:

- `GET /api/market/instruments?productType=USDT-FUTURES`
- `GET /api/market/ticker?productType=USDT-FUTURES&symbol=BTCUSDT`
- `GET /api/market/candles?productType=USDT-FUTURES&symbol=BTCUSDT&granularity=1min&limit=200`
- `GET /api/market/context?productType=USDT-FUTURES&symbol=BTCUSDT`
- `POST /api/eti/signals` with `{"productType":"USDT-FUTURES","symbol":"BTCUSDT","granularity":"1min"}`

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

Outstanding: Bitget WebSocket streaming, authenticated account and position synchronisation, verified account equity for sizing, D1-backed runtime persistence, complete execution lifecycle, advanced backtesting and walk-forward validation, model calibration, production acceptance and security testing.

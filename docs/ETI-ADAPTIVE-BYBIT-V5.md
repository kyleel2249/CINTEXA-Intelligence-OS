# ETI Adaptive Intelligence and Bybit V5 Integration

## Scope

This phase adds:
- Adaptive market-regime classification and score/threshold adjustments to ETIAlgo.
- Historical calibration from completed ETI trade outcomes.
- Bybit V5 public market data for Spot, Linear, Inverse and Options categories.
- Protected Bybit Unified account reads: wallet, account mode, collateral, Spot Margin state, positions and open orders.
- Bybit Spot Margin borrow-quota, maximum-borrowable and liability read endpoints.
- Bybit ETI signal evaluation for Spot, Linear and Inverse categories.
- Exchange-scoped historical observations for both Bitget and Bybit.

No live order placement, borrowing, leverage changes, margin-mode changes, withdrawals or other account mutations are enabled.

## Adaptive signal intelligence

Module: `worker/src/core/adaptive-intelligence.js`

`classifyMarketRegime` classifies current candles as:
- `TRENDING`
- `RANGING`
- `HIGH_VOLATILITY`
- `LOW_VOLATILITY`
- `LOW_LIQUIDITY`
- `TRANSITIONAL`
- `INSUFFICIENT_DATA`

The adaptive engine:
- Adjusts the base ETI score using regime, higher-timeframe disagreement, funding pressure and microstructure approval.
- Raises the required signal score in volatile or range-bound conditions.
- Blocks directional approval when the order-book spread is outside the liquidity threshold or the microstructure gate rejects the market.
- Uses historical 4-hour directional outcomes only when at least 30 completed TRADE outcomes are available.
- Uses a Wilson lower confidence bound for the historical win-rate estimate.
- Leaves calibration inactive when the sample is too small.

The adaptive layer does not create a trade decision by itself. Existing SMC evidence, multi-timeframe confirmation, fresh exchange data, tradable instrument status and the independent server-side risk gate remain required. The risk gate still returns unapproved in this release, so the API continues to return `NO TRADE` and execution remains blocked.

## Bybit V5 market categories

Bybit connector: `worker/src/exchanges/bybit.js`

Supported market categories:
- `spot`: spot markets.
- `linear`: USDT/USDC linear perpetuals and futures.
- `inverse`: inverse perpetuals and futures.
- `option`: option instrument catalogue, ticker and order-book data.

The public market API includes:
- Instruments and trading status.
- Tickers.
- OHLCV candles for Spot, Linear and Inverse.
- Order-book snapshots.
- Funding-rate history for Linear and Inverse.
- Open-interest history for Linear and Inverse.

Options are currently market-data and account-visibility only. ETI directional signal evaluation is enabled for Spot, Linear and Inverse.

## Protected account endpoints

All private account routes require the `ETI_EXCHANGE_READ_TOKEN` header as `x-eti-exchange-token`. The Bybit API key and secret remain in Worker secrets and are never returned to the browser.

- `GET /api/bybit/account`: Unified wallet, account mode, collateral data, Spot Margin state/leverage, Linear/Inverse/Options positions, and Spot/Options open orders.
- `GET /api/bybit/positions?category=linear|inverse|option`: position records.
- `GET /api/bybit/orders?category=spot|linear|inverse|option`: open orders.
- `GET /api/bybit/orders/history?category=...`: order history.
- `GET /api/bybit/executions?category=...`: execution history.
- `GET /api/bybit/margin/borrow-quota?symbol=BTCUSDT&side=Buy`: Spot and Spot Margin available trade quota.
- `GET /api/bybit/margin/max-borrowable?currency=USDT`: maximum borrowable amount.
- `GET /api/bybit/margin/liability?currency=USDT`: current margin liabilities.

Spot Margin uses Bybit's Spot category and Unified account margin facilities. The account snapshot reads the Spot Margin enabled state and leverage. Borrow quota is a live exchange value and may change with collateral, lending-pool availability and account risk. It must be refreshed before any eventual order.

## ETI API endpoints

Public:
- `GET /api/bybit/market/instruments?category=linear`
- `GET /api/bybit/market/ticker?category=linear&symbol=BTCUSDT`
- `GET /api/bybit/market/candles?category=linear&symbol=BTCUSDT&interval=1&limit=200`
- `GET /api/bybit/market/context?category=linear&symbol=BTCUSDT`
- `POST /api/bybit/signals` with `{ "category":"linear", "symbol":"BTCUSDT", "interval":"1" }`

Bybit signal outcomes use an exchange-prefixed product identifier such as `BYBIT-LINEAR`, so Bybit results do not mix with Bitget history.

Historical observations:
- `GET /api/eti/history?exchange=BYBIT&productType=LINEAR&symbol=BTCUSDT`
- `GET /api/eti/performance?productType=BYBIT-LINEAR&symbol=BTCUSDT`

## Credentials and environment

Create a Bybit API key with **read-only permissions first**. Restrict it to the account and IP allowlist where practical. Do not grant withdrawal permissions. Never paste API keys into the frontend or commit them to Git.

From the repository root:

```cmd
npx wrangler secret put BYBIT_API_KEY --config worker/wrangler.toml
npx wrangler secret put BYBIT_API_SECRET --config worker/wrangler.toml
npx wrangler secret put ETI_EXCHANGE_READ_TOKEN --config worker/wrangler.toml
```

Use a strong, separate random value for `ETI_EXCHANGE_READ_TOKEN`. Enter that token in the Bybit account panel when connecting the read-only account snapshot. The page does not save it.

By default the connector uses the production host `https://api.bybit.com`. For testnet, set `BYBIT_TESTNET=true` in the Worker environment. Do not mix testnet keys with the production host or production keys with testnet.

## Live execution status

`POST /api/bybit/orders` is present as a protected endpoint but always returns `executionAllowed:false` and `submitted:false`. The exchange adapter's order-submission function throws a hard-disabled error.

This is intentional. Before live orders can be enabled, ETI must implement and verify:
1. Server-side risk attestation based on fresh account equity, available balance, instrument risk limits and existing exposure.
2. Exchange-precision-aware order sizing and notional/margin caps.
3. Unique idempotency keys persisted before the exchange request.
4. Exchange-side stop-loss and take-profit placement with post-fill verification.
5. Partial-fill, cancel/replace and execution reconciliation.
6. Position and wallet reconciliation across Spot, Spot Margin, Linear, Inverse and Options.
7. Emergency reduce-only close, kill switch, stale-feed lockout and rate-limit handling.
8. An explicit operator activation process with testnet and production separation.

The Bybit connector currently provides authenticated reads, not live order placement or account-setting mutations. Do not set a live-enable flag or grant trade permission expecting order submission to work.

## Tests

Run from the repository root:

```cmd
npm test
npm run check
npm run build:web
```

Tests use mocked exchange responses. A passing local test suite does not establish that the user's API key, account permissions, IP allowlist, region, product eligibility or live exchange connectivity work.

## Official Bybit references

- V5 overview: https://bybit-exchange.github.io/docs/v5/intro
- Instruments: https://bybit-exchange.github.io/docs/v5/market/instrument
- Place order parameters: https://bybit-exchange.github.io/docs/v5/order/create-order
- Wallet balance: https://bybit-exchange.github.io/docs/v5/account/wallet-balance
- Account info and margin mode: https://bybit-exchange.github.io/docs/v5/account/account-info
- Collateral info: https://bybit-exchange.github.io/docs/v5/account/collateral-info
- Spot Margin state: https://bybit-exchange.github.io/docs/v5/spot-margin-uta/status
- Spot borrow quota: https://bybit-exchange.github.io/docs/v5/order/spot-borrow-quota
- Spot Margin max borrowable: https://bybit-exchange.github.io/docs/v5/spot-margin-uta/max-borrowable
- Set leverage: https://bybit-exchange.github.io/docs/v5/position/leverage
- Set margin mode: https://bybit-exchange.github.io/docs/v5/account/set-margin-mode
- Set trading stop: https://bybit-exchange.github.io/docs/v5/position/trading-stop

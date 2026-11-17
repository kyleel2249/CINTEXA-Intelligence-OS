# ETI Historical Market Intelligence

This module adds persistent market observations and forward-outcome tracking to ETIAlgo. It extends the existing signal engine and does not authorize exchange orders.

## Storage

Migration: `worker/migrations/0002_historical_intelligence.sql`

D1 tables:
- `market_observations`: timestamped Bitget order-book, funding, open-interest and ticker observations.
- `signal_outcomes`: signal decision, direction, entry snapshot, score and forward 1h / 4h / 24h results.
- Existing `signal_events` remains the canonical signal event record.

Observation rows are idempotent for the same exchange, product, symbol, type and timestamp. Signal snapshots are deduplicated by symbol, product, timeframe, direction, decision and minute. Market observations older than 90 days are removed by the Worker daily cron; signal outcomes are retained.

## Worker endpoints

- `GET /api/eti/history?symbol=BTCUSDT&productType=USDT-FUTURES&hours=24`
  Returns stored observations, funding/open-interest changes and detected liquidity events.
- `GET /api/eti/performance?symbol=BTCUSDT&productType=USDT-FUTURES`
  Returns signal counts and forward-outcome statistics. A sample under 30 completed trade outcomes is explicitly marked `INSUFFICIENT_SAMPLE`.
- `POST /api/eti/observations`
  Authenticated manual observation ingestion.
- `POST /api/eti/outcomes/evaluate`
  Authenticated forward-outcome evaluation against supplied closed candles.
- `POST /api/eti/signals`
  Existing ETI analysis endpoint. When D1 is available, it stores a deduplicated signal record and market context, then advances pending outcomes using the five-minute candle history already fetched by the endpoint.

### Observation ingestion authentication

Set a strong random secret as a Worker secret:

```cmd
npx wrangler secret put ETI_INGESTION_TOKEN --config worker/wrangler.toml
```

Send it in the `x-eti-ingestion-token` header. Never place this token in frontend JavaScript, a public repository, or a browser-visible configuration.

Example order-book observation:

```json
{
  "observationType": "ORDER_BOOK",
  "exchange": "BITGET",
  "productType": "USDT-FUTURES",
  "symbol": "BTCUSDT",
  "observedAt": 1794873600000,
  "source": "BITGET",
  "data": {
    "mid": 95000,
    "spreadBps": 1.8,
    "bidNotional": 125000,
    "askNotional": 119000,
    "notionalImbalance": 0.0246,
    "microPrice": 95000.2
  }
}
```

Other observation types:
- `FUNDING`: `data.rate`
- `OPEN_INTEREST`: `data.size`
- `TICKER`: `data.last`

All observations must be timestamped and normalized. Invalid or future-dated records are rejected. Only Bitget is currently accepted as the exchange provenance.

### Outcome evaluation

The Worker automatically evaluates eligible pending signals during a successful `POST /api/eti/signals` request, using completed five-minute candles. The protected manual endpoint accepts:

```json
{
  "symbol": "BTCUSDT",
  "productType": "USDT-FUTURES",
  "barDurationMs": 300000,
  "candles": [
    { "time": 1794873600000, "high": 95100, "low": 94900, "close": 95050 }
  ]
}
```

Candle timestamps are treated as bar-open timestamps. The evaluator only uses bars whose full duration ends within the relevant forward horizon. Missing bars do not get filled with invented prices.

## Analytics interpretation

- Open-interest change and funding change require at least two observations.
- Liquidity withdrawal with price displacement is an observational anomaly, not proof of spoofing.
- Possible absorption is a low-confidence order-book pattern only. Book snapshots alone cannot prove executed aggressor flow.
- Forward return is direction-adjusted and gross, before fees, funding and slippage. MFE and MAE are measured against the signal entry. This is forward signal validation, not a full execution backtest.
- Performance statistics are descriptive. They do not establish future profitability or signal accuracy.
- The displayed win rate is calculated on completed TRADE decisions; NO TRADE decisions remain in the signal record counts.

## Deployment

From the repository root on Windows CMD:

```cmd
npx wrangler d1 migrations list cintexa-intelligence-os --remote --config worker/wrangler.toml
npx wrangler d1 migrations apply cintexa-intelligence-os --remote --config worker/wrangler.toml
npx wrangler deploy --config worker/wrangler.toml
```

Confirm `/api/health` reports `historicalIntelligence: true`. The Pages frontend must also rebuild from `main` to load `historical-dashboard.js`.

## External dependency

The Worker currently receives a Bitget Cloudflare 403 response for public market requests. The historical database, analytics, tests and ingestion interfaces are implemented, but live Bitget observations will not accumulate until Bitget restores/approves Worker-origin access or an approved ingestion source sends authenticated observations. No proxy or access-control bypass is included.

Live order routing remains hard-disabled.

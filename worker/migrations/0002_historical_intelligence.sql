CREATE TABLE IF NOT EXISTS market_observations (
  id TEXT PRIMARY KEY,
  exchange TEXT NOT NULL,
  product_type TEXT NOT NULL,
  symbol TEXT NOT NULL,
  observation_type TEXT NOT NULL CHECK (observation_type IN ('ORDER_BOOK','FUNDING','OPEN_INTEREST','TICKER')),
  observed_at_ms INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  quality TEXT NOT NULL DEFAULT 'VALID' CHECK (quality IN ('VALID','PARTIAL','REJECTED')),
  source TEXT NOT NULL DEFAULT 'BITGET',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(exchange, product_type, symbol, observation_type, observed_at_ms)
);
CREATE INDEX IF NOT EXISTS idx_market_observations_lookup ON market_observations(exchange, product_type, symbol, observation_type, observed_at_ms DESC);
CREATE TABLE IF NOT EXISTS signal_outcomes (
  id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL UNIQUE REFERENCES signal_events(id),
  dedupe_key TEXT NOT NULL UNIQUE,
  product_type TEXT NOT NULL,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('BUY','SELL','NEUTRAL')),
  decision TEXT NOT NULL CHECK (decision IN ('TRADE','NO TRADE')),
  entry_price REAL,
  entry_time_ms INTEGER NOT NULL,
  signal_score REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PARTIAL','COMPLETE','INVALID')),
  horizon_results_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_signal_outcomes_pending ON signal_outcomes(symbol, product_type, status, entry_time_ms);
CREATE INDEX IF NOT EXISTS idx_signal_outcomes_time ON signal_outcomes(entry_time_ms DESC);

# CINTEXA Intelligence OS

A multi-department AI operating platform with a shared organisational memory, web command centre, React Native mobile client, and ETI as a live-Bitget-only trading department.

## Current status

This is an initial runnable foundation. It includes the approved dark command-centre UI, department registry and hierarchy, shared-memory schema, deterministic Smart Money Concepts calculations, signal fusion and risk gates, and a Bitget live adapter that fails closed unless explicitly configured.

It does not claim to reproduce proprietary GainzAlgo V2/Alpha logic without authorised source code or exact documented rules. The adapters are integration contracts, not a substitute for those strategies.

Live execution is disabled until production identity, account synchronisation, instrument rules, risk policy, exchange-side protection, reconciliation and acceptance tests are complete. No paper/testnet execution route is included.

## Run

- Node.js 20+
- `npm install`
- `npm run dev:web`
- `npm test`
- `npm run check`

## Cloudflare

Deploy the web app to Pages and the API to Workers. Configure D1 and optional KV bindings from `worker/wrangler.toml`. Apply reviewed migrations before deploying.

Secrets must be configured using Wrangler secrets and must never be placed in frontend code. Bitget API credentials must not have withdrawal permissions.

## Important limitations

The current UI is a foundation, not a completed production system. Authentication, production permissions, D1-backed order persistence, WebSocket market ingestion, complete order reconciliation, and exchange-side stop/TP lifecycle require implementation and verification. SMC algorithms require market-specific validation. GainzAlgo exact strategy logic requires authorised definitions or source.

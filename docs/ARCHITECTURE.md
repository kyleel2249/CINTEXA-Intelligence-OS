# Architecture and governance

## Operating model
Hybrid governance: departments execute bounded internal work autonomously. Human/executive approval is required for external commitments, expenditure, sensitive customer data, credential changes and live trading.

## Shared memory
Department-private and organisation-shared memory are separately classified. Every record has an owner, department, sensitivity, timestamp and optional expiry. Access is role- and task-scoped. Credentials and secrets are never stored in agent memory.

## ETI live-only
Bitget is the only execution venue. The execution endpoint is disabled until account risk, protective-order, authentication, instrument metadata and reconciliation services are production-ready. No paper or testnet order route is provided.

## Strategy integrity
GainzAlgo V2 and Alpha adapters remain unverified until authorised source or exact specifications are provided. SMC outputs are deterministic evidence, not guarantees of future outcomes.
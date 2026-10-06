# Pakka hardening tracker

This is the user's security/product checklist, not a claim of audit readiness.
Testnet-only restrictions remain. No mainnet transaction or deployment is authorized by this work.

| Priority | Work | Status |
| --- | --- | --- |
| P0 | ERC-4626 limits, entry pause, per-series cap, index circuit breaker | Implementing; regression checks pending |
| P0 | Router/market face-price bounds, exact output, deadlines, sqrt-price bound | Implementing; regression checks pending |
| P0 | Tijori rolling cap, token allowlist, USDC blacklist errors, approval cleanup | Implementing; regression checks pending |
| P0 | Real-vault index accrual and integrated Arc fork | Needs verified vault/RPC; no successful fork run yet |
| P0 | Slither/Aderyn, Foundry coverage >=95%, whole-system invariants | Tools not installed; setup and checks pending |
| P0 | Admin powers, separate deployer/owner | Pending documentation/script changes |
| P0 | Shared deployment manifest, quote service, simulations/nonce management | Pending |
| P0 | Keeper webhook alerts | Pending; destination must be locally configured |
| P1 | Event activity/indexer, two-provider RPC fallback | Pending |
| P1 | Four-page frontend, batching/permit verification, agent setup, mobile/errors | Pending |
| P1 | Browser and MCP E2E | Pending |
| P0 | Mainnet $1 canary | Future mainnet release only; current guards reject mainnet |
| P2 | External audit, bounty, timelock, increased caps, Postgres/charts/dashboard | Deferred as requested |

No Safe, Morpho vault, permit implementation or Arc-specific anvil tool is assumed
to exist without verification. A deployment manifest for mainnet may be prepared
later, but its existence must never bypass the current chain guards.

# Pakka

Fixed-rate USDC on Arc. Pakka splits an ERC-4626 USDC vault position into a
**principal token (PT)** and a **yield token (YT)** for a single maturity.
Holding both is equivalent to the underlying position, less rounding dust.

The protocol never sets a rate. PT redeems for exactly 1 USDC at maturity, so
buying it below par on the open market *is* the fixed rate — the discount you
pay is the return you lock in. Rates are therefore a property of the pool price,
not a parameter anyone controls.

> Unaudited testnet software. Mainnet deployment is deliberately disabled.

## Contracts

| Contract | Responsibility |
| --- | --- |
| `PrincipalToken.sol` | ERC-20 principal in asset units; only its YieldToken mints or burns. |
| `YieldToken.sol` | Custodies vault shares, splits and merges, settles accrued interest before balance changes, freezes the index at expiry, redeems PT. |
| `SeriesRegistry.sol` | Owner-approved directory of series. Validates token/vault relationships, rejects duplicates, records one PT/USDC pool key per series. |
| `UniswapV4Market.sol` | Real v4 swaps: exact-output PT purchases, exact-input early sales, rollback-based quoting, pool-state reads. |
| `PakkaRouter.sol` | Atomic locks, early sales, maturity cash-outs, multi-maturity ladders with budget refunds. |
| `Tijori.sol` | User-owned treasury that restricts an agent to capped purchases, redemptions, interest claims and payments to approved payees. |
| `TijoriFactory.sol` | One minimal clone per owner, over a locked shared implementation. |
| `PoolSeeder.sol` | Owner-operated pool initialization, bounded liquidity adds, fee collection, post-expiry withdrawal. |
| `TestnetPoolManager.sol` | Testnet-only wrapper around the vendored Uniswap v4 PoolManager. |
| `DemoVault.sol` | Testnet-only ERC-4626 vault over faucet USDC. Yield is simulated by direct donation; it does not lend. |

Entrypoint constructors accept only Arc Testnet (`5042002`) and local
Hardhat/Anvil (`31337`). Deployed addresses live in [DEPLOYMENTS.md](DEPLOYMENTS.md);
`deployments/arc-testnet.json` is the source of truth that code actually reads.

## Layout

```
contracts/      Solidity sources (contracts/test/ holds local-only harnesses)
backend/        Read-only HTTP API and chain read services
frontend/       Browser app, served as-is (plain JS, no build step)
agent/          MCP server exposing scoped treasury tools
scripts/        Compile, deploy, register, seed, keeper, security checks
test/           Contract, backend, agent and browser end-to-end tests
api/            Serverless entrypoint for platform deploys
vendor/         Pinned OpenZeppelin and Uniswap v4 sources
```

## Requirements

Node.js 24+ and npm. `backend/`, `agent/`, `scripts/` and `test/` are typed
TypeScript with **no build step** — Node executes `.ts` directly, so every
command is the same as it would be for plain JavaScript. `frontend/` stays
plain JS because it is served straight to the browser.

Solidity is pinned to 0.8.26 targeting Cancun with via-IR (Uniswap v4 requires
transient storage). Compilation uses the installed solc package and never
downloads a compiler at runtime.

## Quick start

```sh
npm ci
npm run compile
npm test
npm run dev        # http://127.0.0.1:4173
```

| Command | Purpose |
| --- | --- |
| `npm run compile` | Compile contracts into `artifacts/`. |
| `npm test` | Full contract, backend and agent suite. |
| `npm run test:browser` | Headless Chromium end-to-end run against a live local deployment. |
| `npm run test:system` | Security and invariant suite. |
| `npm run typecheck` | `tsc --noEmit`; type-checks without executing. |
| `npm run security` | Static analysis and coverage gates. |
| `npm run agent:connect` | Connect Claude Desktop: agent wallet, browser approval, Claude config. |
| `npm run agent:setup` | Provision a treasury and agent wallet from the terminal. |

Tests cover split/merge/transfer/maturity and loss-recovery paths, variable share
decimals, illiquid exits, exact arithmetic, and thousands of deterministic random
operations with a backing check after every step. Market tests run against the
real vendored PoolManager locally, including both currency orderings, slippage
rollback and multi-swap composition. Mock vaults are used throughout; no fork
verification against a live vault has been performed.

## Deploying to Arc Testnet

Deployment separates two wallets by design. The **deployer** funds and publishes
contracts; a distinct **owner** holds registry and seeder admin rights. The
deploy script refuses to proceed if they are the same address, and the register
and seed scripts reject the deployer key.

Configure `.env` from `.env.example`, then:

```sh
npm run deploy:testnet     # deployer: publishes contracts and series
npm run register:testnet   # owner: registers series, attaches pool keys
npm run seed:testnet       # owner: initializes pools and adds liquidity
```

`deploy:testnet` refuses to overwrite an existing manifest. To add a maturity to
a live deployment, use `SERIES_DURATION=86400 npm run add:series`, then register
and seed again — both scripts skip anything already done or expired.

Seeding budgets are per series and default to 10 USDC each:

```sh
PT_PRICE_USDC=0.97 POOL_SEED_PT=6 POOL_SEED_USDC=6 npm run seed:testnet
```

The owner wallet needs `POOL_SEED_PT + POOL_SEED_USDC` per series: the PT budget
is split out of the vault to create inventory, and the USDC budget becomes the
other side of the liquidity. Both remain owner-controlled as an LP position.

Seed meaningfully below par. Pools seeded close to 1.00 leave little room before
the market's par-price guard rejects a fill.

## Web app and API

`backend/server.ts` serves a **read-only** HTTP API plus the static frontend. It
never signs or broadcasts a transaction. Every write — lock, ladder, cash-out,
pay, approvals — is signed by the connected browser wallet directly against the
contracts, including an EIP-5792 batched-call path with a two-transaction
approve/act/revoke fallback.

`/` serves the landing page; `/app` serves the operational app.

| Route | Returns |
| --- | --- |
| `GET /api/deployment` | Public addresses and registered series. Never keys or RPC URLs. |
| `GET /api/abis` | ABIs for the contracts the frontend calls. |
| `GET /api/rates` | Per-series TVL, caps, pool/entry status, a PT quote, and an observed variable rate. |
| `GET /api/quote?seriesId&ptAmount` | A live PT buy quote, cross-checked against the v4 quoter when configured. |
| `GET /api/positions?account` | PT/YT balances, accrued interest, redeemable shares. |
| `GET /api/treasury?owner&payee` | Treasury address, agent, pause state, balance, positions. |
| `GET /api/activity?account&tijori&fromBlock` | Decoded, deduplicated router and treasury events. |
| `GET /api/agent-config?tijori` | An MCP client config stub. Never a real private key. |

The server answers `GET` only, binds to loopback, and rejects any `Host` or
`Origin` outside the allowlist. To front it with your own TLS-terminating proxy:

```dotenv
API_ALLOWED_HOSTS=example.com
API_ALLOWED_ORIGINS=https://example.com
```

For serverless platforms, `api/` exposes the same handler and derives the
allowed host from the platform environment. `vercel.json` builds artifacts and
serves `frontend/` from the CDN.

## Agent treasury

See [AGENTS.md](AGENTS.md) to connect an agent — Claude Desktop over stdio, or
any other MCP client over HTTP.

`agent/` runs an MCP server whose tools are scoped to a single `Tijori`. The
treasury contract — not the agent process — enforces what is possible: the agent
can buy registered series, redeem matured PT, claim interest, and pay approved
payees within per-payee and daily caps. It cannot move funds to arbitrary
addresses, change its own limits, or act once the owner pauses it.

Quotes and plans never broadcast. Payments are journaled before broadcast and
keyed by operation ID, so a lost response cannot double-pay, and a restart
resumes rather than reissues.

```sh
npm run agent:mcp    # stdio, for clients that spawn a subprocess
npm run agent:http   # Streamable HTTP on 127.0.0.1:4174, for everything else
```

`agent:http` requires `AGENT_HTTP_TOKEN` (32+ characters) and binds to loopback.
It holds the agent key and signs, so run it yourself rather than delegating it.

## Security notes

- Read path and write path are separated: the backend holds no keys and cannot sign.
- Owner actions require a signer distinct from the deployer.
- `YieldToken.SERIES_TVL_CAP` caps entry TVL per series at compile time.
- Index movement bounds reject entries on sudden vault index jumps without blocking exits.
- Per-payee rolling windows and daily caps are enforced on-chain and cannot reset at a boundary.
- `.env` is gitignored and excluded from deploy uploads. Never commit a key.

Before any mainnet consideration: pin official dependencies, resolve exact
maturity settlement, validate the target vault and market infrastructure against
a fork, and get the contracts reviewed.

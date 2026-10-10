# Pakka

Fixed-rate USDC on Arc. Pakka splits an ERC-4626 USDC vault position into a
**principal token (PT)** and a **yield token (YT)** for a single maturity.
Holding both is equivalent to the underlying position, less rounding dust.

The protocol never sets a rate. PT redeems for exactly 1 USDC at maturity, so
buying it below par on the open market *is* the fixed rate — the discount you
pay is the return you lock in. Rates are therefore a property of the pool price,
not a parameter anyone controls.

> Unaudited software. Every command runs on Arc Testnet unless mainnet is selected explicitly.

## Contracts

| Contract | Responsibility |
| --- | --- |
| `PrincipalToken.sol` | ERC-20 principal in asset units; only its YieldToken mints or burns. |
| `YieldToken.sol` | Custodies vault shares, splits and merges, settles accrued interest before balance changes, freezes the index at expiry, redeems PT. |
| `SeriesFactory.sol` | Creates the registry and is the only source of series it accepts: its own YieldToken bytecode over one vault fixed at deployment. Opens a maturity (deploy, register, attach pool key) in one owner call. |
| `SeriesRegistry.sol` | Directory of series. Accepts only factory-created series, validates token/vault relationships, rejects duplicates, records one PT/USDC pool key per series. Ownership transfers in two steps. |
| `UniswapV4Market.sol` | Real v4 swaps: exact-output PT purchases, exact-input early sales, rollback-based quoting, pool-state reads. |
| `PakkaRouter.sol` | Atomic locks, early sales, maturity cash-outs, multi-maturity ladders with budget refunds. |
| `Tijori.sol` | User-owned treasury that restricts an agent to capped purchases, redemptions, interest claims and payments to approved payees. |
| `TijoriFactory.sol` | One minimal clone per owner, over a locked shared implementation. |
| `PoolSeeder.sol` | Owner-operated pool initialization, bounded liquidity adds, fee collection, post-expiry withdrawal. Records every range it holds and pays the registry's current owner. |
| `TestnetPoolManager.sol` | Self-hosted wrapper around the vendored Uniswap v4 PoolManager, used when no existing manager is configured. |
| `DemoVault.sol` | Demo ERC-4626 vault. Yield is simulated by direct donation; it does not lend. Never deployed on mainnet unless explicitly allowed. |

Entrypoint constructors accept only Arc mainnet (`5042`), Arc Testnet (`5042002`)
and local Hardhat/Anvil (`31337`), and on both Arc networks they require the canonical
USDC contract. Deployed addresses live in [docs/deployments.md](docs/deployments.md);
`deployments/arc-testnet.json` (or `arc-mainnet.json`) is the source of truth that code actually reads.

## Networks

Testnet is the default everywhere. Mainnet is selected with `PAKKA_NETWORK=mainnet`, which
the `*:mainnet` npm scripts set:

```sh
VAULT_ADDRESS=0x… npm run deploy:mainnet   # then add:series:mainnet and seed:mainnet
npm run keeper:mainnet                      # settles maturities on time
npm run dev:mainnet                         # serve the app against the mainnet manifest
```

A mainnet deployment needs `VAULT_ADDRESS` set to an ERC-4626 USDC vault. `ALLOW_DEMO_VAULT=1`
deploys the simulated-yield `DemoVault` with real USDC instead; that must be a deliberate choice.
Set `UNISWAP_V4_POOL_MANAGER_ADDRESS` to use an existing PoolManager after verifying it yourself,
or leave it blank to self-host one. A hosted frontend picks its network from the same
`PAKKA_NETWORK` variable. Mainnet funds are real and the contracts are unaudited.

## Layout

```
contracts/      Solidity sources (contracts/test/ holds local-only harnesses)
backend/        Read-only HTTP API and chain read services
frontend/       Browser app, served as-is (plain JS, no build step)
agent/          MCP server exposing scoped treasury tools
scripts/        Compile, deploy, open series, seed, keeper, security checks
test/           Contract, backend, agent and browser end-to-end tests
api/            Serverless entrypoint for platform deploys
docs/           Agent connection guide and deployed addresses
examples/       Drop-in MCP client configs, agent brief, keeper service template
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
| `npm run keeper:once` | Settle any matured series once and exit (what the scheduled workflow runs). |
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
contracts; a distinct **owner** opens maturities and holds registry and seeder admin
rights. The deploy script refuses to proceed if they are the same address, and the
series and seed scripts reject the deployer key.

Configure `.env` from `.env.example`, then:

```sh
npm run deploy:testnet     # deployer: publishes the contracts, no maturities yet
npm run add:series         # owner: opens the SERIES_DURATIONS maturities through the factory
npm run seed:testnet       # owner: initializes pools and adds liquidity
```

`deploy:testnet` refuses to overwrite an existing manifest. To add a maturity to
a live deployment, use `SERIES_DURATION=2592000 npm run add:series` and seed again, or
open and seed it from the app's Owner page. Both scripts first pick up any maturity
opened from the app, and skip anything already done or expired.

Seeding budgets are per series and default to 10 USDC each:

```sh
PT_PRICE_USDC=0.97 POOL_SEED_PT=6 POOL_SEED_USDC=6 npm run seed:testnet
```

The owner wallet needs `POOL_SEED_PT + POOL_SEED_USDC` per series: the PT budget
is split out of the vault to create inventory, and the USDC budget becomes the
other side of the liquidity. Both remain owner-controlled as an LP position.

Seed meaningfully below par. Pools seeded close to 1.00 leave little room before
the market's par-price guard rejects a fill.

A flat price is a different rate on every maturity: 0.99 is roughly 53% a year on a seven-day
series and 368% on a one-day one. Set a rate instead and each pool is priced for its own length:

```sh
PT_TARGET_RATE_PERCENT=8 npm run seed:testnet
```

The 0.05% pool fee is paid on top of the price, so a maturity too short for the chosen rate to
out-earn the fee is refused. The pool price does not drift toward par on its own as maturity
approaches; only trades move it.

## Web app and API

`backend/server.ts` serves a **read-only** HTTP API plus the static frontend. It
never signs or broadcasts a transaction. Every write — lock, ladder, cash-out,
pay, approvals — is signed by the connected browser wallet directly against the
contracts, including an EIP-5792 batched-call path with a two-transaction
approve/act/revoke fallback.

`/` serves the landing page; `/app` serves the operational app.

When the connected wallet is the registry's on-chain `owner()`, the app adds an **Owner** page:
open a maturity, seed its pool at an opening fixed rate, withdraw liquidity and fees, and pause
or resume entries. No other wallet is shown the page, and the contracts reject the calls
regardless. The page signs from the browser and cannot write the manifest, so `seed:testnet`
does not know about a pool seeded there. On a deployment made before the series factory the
page registers script-deployed maturities instead, and remembers its own liquidity ranges only
in that browser.

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

See [docs/connect-an-agent.md](docs/connect-an-agent.md) to connect an agent — Claude Desktop over stdio, or
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

## Operations

`.github/workflows/ci.yml` runs the compile, type-check, contract, backend, agent and browser
suites on every push. `.github/workflows/keeper.yml` runs the keeper every five minutes once a
`KEEPER_PRIVATE_KEY` repository secret holds a dedicated, funded wallet; without the secret it
does nothing. GitHub's scheduler is best-effort, so for settlement on the minute run
`npm run keeper:testnet` on a host of your own (`examples/pakka-keeper.service`).

## Security notes

- Read path and write path are separated: the backend holds no keys and cannot sign.
- Owner actions require a signer distinct from the deployer.
- `YieldToken.SERIES_TVL_CAP` caps entry TVL per series at compile time.
- Index movement bounds reject entries on sudden vault index jumps without blocking exits. The
  band is 1% plus 0.25% per day since the last accepted observation, so ordinary growth never
  trips it and a persistent move is accepted later rather than freezing the series.
- Entries close one hour before maturity (`SeriesRegistry.MIN_ENTRY_WINDOW`); exits never close.
- The owner can open maturities, pause entries and manage its own liquidity. It cannot move
  backing, block exits or alter a series, and it cannot choose a series' code or vault: the
  registry accepts only what its factory deployed. Ownership moves to another address (a Safe,
  a hardware wallet) in two steps, and the protocol liquidity follows it.
- Settlement falls back to the last accepted index if the vault's conversion reverts, so a
  failing vault cannot keep matured principal from being redeemed as vault shares.
- Per-payee limits are exact rolling 30-day windows enforced on-chain. The daily cap covers the
  current clock hour and the 24 before it, so no 24-hour period can exceed it. An agent's PT
  purchases are bounded by face value per ticket but not by the daily cap.
- `.env` is gitignored and excluded from deploy uploads. Never commit a key.

Still open before real size: the contracts are unreviewed; the owner starts as a single key with
no timelock until it is transferred; maturity settles on the first call after expiry (run the
keeper); the index guard limits how far a vault's share price can move per block, not in total,
so the vault chosen at deployment must not be one whose price can be pushed up temporarily; and
the target vault and market infrastructure have not been validated against a fork.

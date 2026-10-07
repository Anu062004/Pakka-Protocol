# Pakka backend — agent handoff

Updated: 2026-10-06. Workspace: `/Users/macavenue/Desktop/arc`.

## Session update, 2026-10-06 (full TypeScript conversion)

At the user's request, every Node-executed `.mjs` file in the repo (`backend/`,
`agent/`, `scripts/`, `test/`, `test/helpers/`) was converted to real, typed
`.ts`. `frontend/` deliberately stayed `.mjs` — a user decision, since those
files are served straight to the browser and converting them would require
adding a build/bundle step to an otherwise zero-build project.

- **No build step added.** Node 24 (installed here) runs `.ts` files natively
  via type-stripping; every `npm run`/`node --test` command now simply points
  at `.ts` instead of `.mjs` (see `package.json`). `scripts/solc.d.ts` and
  `frontend/errors.d.mts` are small hand-written ambient declaration files for
  two untyped JS dependencies (`solc` has no published types; `frontend/errors.mjs`
  stayed JS by the decision above).
- **`tsconfig.json`** is new: `target`/`lib` ES2023+DOM (DOM is needed only for
  `test/browser-e2e.ts`'s in-browser `page.evaluate` closures), `module`/
  `moduleResolution: nodenext`, `strict: true`. `noUncheckedIndexedAccess` was
  tried and reverted — it fights ethers v6's `Contract` dynamic-method index
  signature (no TypeChain is used here) and produced mostly-noise errors.
  `npm run typecheck` runs `tsc --noEmit`.
- **A real compiler quirk, not a style choice:** the installed TypeScript is
  7.0.2 (the new native/Go-ported compiler, now what `npm install typescript`
  resolves to). It does **not** narrow a variable's type after a bare
  `if (cond) neverReturningFn();` statement — only after `return`/`throw`.
  This codebase's `fail(code)` helpers (in `treasury-service.ts`,
  `expiry-keeper.ts`, `mcp-server.ts`) are `(code: string) => never`, used
  exactly that way throughout. Every call site that needed the narrowing was
  changed to `if (cond) return fail(code);` (behaviorally identical — `fail`
  always throws, this only changes what TS can prove). If you add a new guard
  clause and see `'X' is possibly null/undefined` right after it, this is why.
- **`Contract.connect(signer)` returns `BaseContract`, not `Contract`**, in
  ethers v6's own types (a documented quirk, not specific to this codebase) —
  it loses the dynamic method-call index signature. Every `x.connect(y).method(...)`
  in the test suite is written `(x.connect(y) as Contract).method(...)`.
- **`TreasuryService.invoke()` returns `Promise<any>`, not `Promise<unknown>`**
  — deliberate. Its return shape genuinely depends on the tool `name` argument
  (status object, quote, plan, receipt...); expressing that honestly would need
  a discriminated-union overload per tool name, which wasn't worth it for a
  dynamic-dispatch method. Callers narrow per call site as needed.
- Three `backend/types.ts` manifest fields became **optional** during this pass
  (`SeriesManifestEntry.duration`/`.transactionHash`, `SeriesPool.transactions`,
  `Manifest.status`/`.contracts`/`.ownerActions`/`.tijoriImplementation`) because
  test fixtures (`test/helpers/system.ts` and others) build manifests in-memory
  without deployment-script bookkeeping fields that no runtime reader actually
  needs. Don't re-tighten these without checking those fixtures.
- Ran the full suite after conversion: **same 144/148 as before the conversion**,
  confirmed test-by-test as each file was converted (not just at the end) by
  diffing pass/fail counts against the pre-conversion `.mjs` baseline. The 4
  failures are the same pre-existing ones logged in the entry below — this pass
  did not touch contracts or fix them, only converted syntax/types.
- One **machine-level change outside the repo**: `~/.zshenv` already had
  `.cyfrin/bin` on `PATH` (from the prior session's `cyfrinup` install); this
  pass didn't touch it further.

## Session update, 2026-10-06 (backend gap-closing pass)

A prior session built `backend/` (read-only API server, read/quote/activity/rpc
services) and `frontend/` (the web app) plus extra security/E2E test layers
(`test/full-flow.test.ts`, `test/browser-e2e.ts`, `test/backend-safety.test.ts`,
`test/solidity/Security.t.sol`, `test/solidity/RealVaultFork.t.sol`,
`scripts/fork-e2e.ts`, `scripts/security-check.ts`, `scripts/register-testnet.ts`,
`scripts/setup-env.ts`) **without updating this file or README.md**, so neither
document mentioned the web app at all until now. This pass:

- Added `backend/variable-rate.ts` and wired it into `ReadService.rates()`:
  `/api/rates` now reports each vault's **observed trailing-24h rate** (two
  `convertToAssets` samples via binary-searched blocks, annualized), replacing
  the previous hardcoded `variableRatePercent: null`. It can be negative after a
  loss and is explicitly labeled as observed, not a Morpho rate feed. Unit-tested
  (`blockAtOrBefore`, `observedApy`, `vaultObservedApy`) and exercised for real by
  `test/full-flow.test.ts` against a live local DemoVault.
- Made `backend/server.ts`'s Host/Origin allowlist configurable via
  `API_ALLOWED_HOSTS`/`API_ALLOWED_ORIGINS` (additive to the existing
  localhost-only defaults, strictly validated) so the read API can sit behind an
  operator's own TLS reverse proxy on a public hostname. The process still only
  ever binds to `127.0.0.1`; nothing about the default local behavior changed
  (existing tests pass unmodified). New exported `publicHosting(env)` is unit-tested.
- Installed `forge` (Foundry 1.8.5), `slither` (0.11.6, in the existing gitignored
  `.tools/security` venv) and `aderyn` (0.6.8, via Cyfrin's prebuilt-binary
  installer, no Rust toolchain build needed) and added their bin directories to
  `~/.zshenv` (outside the repo — flagged here since it's a machine-level change).
  `npm run security:status` now reports all three tools present; `npm run security`
  correctly advances to and stops at the next real gate, `realForkConfigured`
  (needs `FORK_RPC_URL` + `FORK_VAULT_ADDRESS` pointing at a verified real Arc
  vault — a human decision, not something this pass could complete; docs.html
  still says "to fill in: pick a curated vault").
- Documented the web app, its API routes, the hosting env vars, the observed-rate
  semantics, keeper alerts, and the security-tooling setup in `README.md`
  (previously undocumented entirely).
- Ran the full suite (`npm test`): **144/148 passing**. 4 pre-existing failures,
  unrelated to this pass's changes (confirmed deterministic by rerunning in
  isolation), all in files never touched this session:
  - `test/uniswap-v4.test.ts:164` expects error `InvalidAmount`, contract now
    reverts `PurchaseCapExceeded`.
  - `test/uniswap-v4.test.ts:214` expects error `SeriesExpired`, contract now
    reverts `SeriesInactive`.
  - `test/uniswap-v4.test.ts:275` ("multiple real v4 unlocks...") reverts with
    an undecoded custom error (`0x110ecdb4`) during `estimateGas`, not previously
    debugged.
  - `test/expiry-keeper.test.ts:348` ("reverted settlement receipts clear the
    journal...") asserts `ok:true` but gets a `SETTLEMENT_SIMULATION_FAILED`
    alert instead.
  These look like a contract/test drift (error names renamed in `UniswapV4Market.sol`
  or `PakkaRouter.sol` without updating the test file) rather than anything
  flaky — investigate before trusting the "122/122" / "all green" claims
  elsewhere in this file for the Uniswap v4 adapter and expiry keeper specifically.

## Current task and user decisions

The user requested the core contracts, testnet configuration and SeriesRegistry,
then Uniswap v4 instead of a fixed-price counter, Tijori/Factory and the expiry
keeper. After discussing contract count and complexity, the user authorized the
next phase: **the agent/MCP treasury service**. It is implemented in two agent
files, reuses the existing contracts and adds no Solidity contracts. The full
regression suite passed **122/122 tests**, including 20 agent tests.
No public-chain transactions, deployment or hosting have occurred.

- Keep this release on **testnet only**. Mainnet migration is a later task.
- `.env` has been prepared. Do not print, copy into documentation, or commit secrets.
- Use Uniswap v4 for the PT market. Do not replace it with a fixed-price counter.
- The user asked the contract count: before Tijori/Factory, 8 deployable application
  types + 1 abstract base + 6 test fixtures (15 files). After adding Tijori/Factory:
  **10 deployable application types + 1 abstract base + 6 fixtures = 17 files**,
  excluding vendored dependencies and per-series/per-user instances.
- No transactions have been sent and no deployment has been performed in this session.

## Project and source of requirements

Read `docs.html` and `contact.png`, alongside `README.md`. The user referred to
the image as `contract.png`; the actual file is `contact.png`. The HTML was empty
on the initial inspection but was later populated and analyzed.

Pakka splits an ERC-4626 USDC vault position into principal tokens (PT) and yield
tokens (YT), each tied to a maturity. Buying PT at a discount is what creates a
fixed rate; splitting a deposit alone does not set a fixed APY. The intended full
system adds a market, router, bond ladders, a restricted agent treasury (Tijori),
and an agent/MCP interface. The current vault is a demo, not a Morpho integration.

## Completed implementation

| File | Implemented behavior |
| --- | --- |
| `contracts/PrincipalToken.sol` | ERC-20 PT; only the associated YieldToken can mint or burn it. |
| `contracts/YieldToken.sol` | Holds vault shares; splits shares or USDC into PT/YT; merges before expiry; settles YT interest before balance changes; pays interest; freezes the maturity index; redeems PT after expiry. |
| `contracts/DemoVault.sol` | ERC-4626 faucet-USDC vault with 18-decimal shares. USDC donations simulate yield; no lending protocol is connected. |
| `contracts/SeriesRegistry.sol` | Immutable owner, owner-only registration, metadata validation, duplicate protection, permanent records, reverse lookups and one-time optional PT/USDC pool-key attachment. |
| `contracts/UniswapV4Market.sol` | Exact-output PT buys, exact-input early sales, rollback-based quotes without approvals, pool-state reads and full-fill/slippage/deadline checks. |
| `contracts/PakkaRouter.sol` | Bounded locks and atomic ladders with caller refunds; early sales; matured PT redemption into USDC/shares; synthetic YT purchases. |
| `contracts/Tijori.sol` | Owner treasury with one restricted agent; retained PT/refunds/redemptions/claims; capped approved payments; pause, key replacement and owner asset recovery. |
| `contracts/TijoriFactory.sol` | One initialized ERC-1167 clone per caller/owner, locked shared implementation, no administrator or upgrades. |
| `contracts/PoolSeeder.sol` | Owner-only initialization, liquidity calculations, bounded additions/removals and fee collection; withdrawal remains available after expiry. |
| `contracts/V4Client.sol` | Shared manager/registry configuration, callback authentication and ERC-20 delta settlement for market and seeder. |
| `contracts/TestnetPoolManager.sol` | Constructor guard around real vendored Uniswap PoolManager, for self-hosted testnet infrastructure. Not an official deployment. |
| `contracts/test/` | Mock USDC, configurable vault/loss/liquidity simulation, arithmetic/series/batch fixtures and a token that simulates reentry or short-credit deposits. |
| `scripts/compile.ts` | Local solc compilation, custom ABI/bytecode artifacts and deployed-code-size check. |
| `scripts/deploy-testnet.ts` | Checks Arc Testnet and USDC; deploys vault, registry, manager, market, router, TijoriFactory/implementation, seeder and three registered series; persists successful deployments and refuses to overwrite an existing manifest. |
| `scripts/seed-testnet.ts`, `scripts/seed-v4.ts` | Fund market inventory by splitting USDC if needed; attach keys, initialize empty pools and add liquidity; persist positions and transaction hashes. The shared seed helper is tested locally. |
| `scripts/expiry-keeper.ts` | Registry discovery, due-series ordering, testnet/local guards, gas bounds, durable signed-tx journal/recovery, receipt/nonce reconciliation and structured health/alerts. |
| `scripts/keeper-testnet.ts` | Arc-Testnet-only CLI: continuous, one-cycle and key-free health modes; separate wallet, bounded RPC requests, signals and local lock. |
| `infra/pakka-keeper.service` | Optional Linux systemd template using a dedicated `.env.keeper`, persistent runtime directory and restart-on-failure. Not installed on any host. |
| `agent/treasury-service.ts` | Bound Tijori status/quotes/plans, ladder execution, cash-out, YT claims and capped payments; strict chain/agent checks, signed transaction journal and idempotent retry/recovery. |
| `agent/mcp-server.ts` | Official MCP SDK stdio server with eight strict tools, lazy testnet configuration, optional read-only mode, single-host lock and sanitized errors. |
| `test/agent-mcp.test.ts` | 20 real-contract and SDK integration tests, including an actual stdio client subprocess and transaction fault injection. |
| `backend/server.ts` | Localhost-only, GET-only HTTP API serving `/api/{deployment,abis,agent-config,rates,quote,positions,treasury,activity}` and the static frontend; CSP headers; configurable `API_ALLOWED_HOSTS`/`API_ALLOWED_ORIGINS` for a reverse-proxied public host (added 2026-10-06), process always binds `127.0.0.1`. |
| `backend/read-service.ts` | Chain reads for rates/positions/treasury/activity; verifies RPC chain ID and deployment-address match before answering; staleness guard on local timestamps. |
| `backend/quotes.ts` | PT buy quotes via market `eth_call` simulation, optional cross-check against the Uniswap v4 quoter, slippage/cap math. |
| `backend/variable-rate.ts` | **Added 2026-10-06.** Observed trailing-window vault APY: binary-searches the block at a target age, samples `convertToAssets` at both blocks, annualizes the change. Can report negative rates after a vault loss. Replaces the previous hardcoded `null`. |
| `backend/activity.ts` | Decodes/deduplicates router and Tijori events into a scoped, paginated feed. |
| `backend/rpc.ts` | JSON-RPC provider with a fallback endpoint, retried only on transport failure (never masks a revert), chain-ID-checked. |
| `backend/alerts.ts` | Keeper health alerts to a Discord webhook or Telegram bot, cooldown-limited, never persists the webhook/token. |
| `backend/project.ts` | Loads/validates `deployments/arc-testnet.json`, strips secrets for `publicDeployment()`, reads compiled ABIs. |
| `frontend/index.html` + `landing.css` | **Added 2026-10-06.** Static marketing landing page at `/` (hero, problem, 3 user stories, mechanism, Tijori safety, Arc stats, closing CTA). No wallet code; links to `/app`. |
| `frontend/app.html`, `app.mjs`, `wallet.mjs`, `errors.mjs`, `app.css` | The operational app, now served at `/app` (moved from `/` when the landing page was added): rates table, lock/ladder flow, positions, Tijori setup/MCP-config export. Reads via the backend API; all writes are signed directly by the browser wallet (EIP-5792 batched calls with a two-tx fallback), never proxied through the backend. |
| `test/backend-safety.test.ts`, `test/full-flow.test.ts`, `test/browser-e2e.ts` | Backend unit tests (quote math, RPC fallback, alerts, API host/origin/secret safety); a full local deploy→seed→lock→MCP-ladder→keeper→cash-out→pay integration test; a real headless-Chromium Playwright run against the actual server and a locally deployed system. |
| `scripts/security-check.ts` | `npm run security`: forge test/coverage (≥95% per core contract), slither, aderyn, gated on a verified real-vault fork config. `npm run security:status` reports tool/config state without running anything. |
| `.env`, `.env.example`, `.gitignore` | Testnet RPC and demo durations configured; private key initially blank; `.env` ignored and mode 600. Do not overwrite user-supplied values. |
| `README.md` | Setup, contract behavior, accounting, registry API, deployment and limitations. |

### Accounting behavior to preserve

- PT/YT decimals match the underlying asset (6 for USDC). Vault share decimals
  are read at deployment; supported share decimals are at most 59.
- `INDEX_UNIT = 10 ** (shareDecimals + 18)`; the stored index is a high-water mark.
  YT earns no additional shares during loss or recovery below that mark.
- Split rounds minted amounts down. `sharesForPT` rounds required backing up.
  Interest uses full-precision arithmetic with a single final rounding step.
- Transfers, minting and burning settle affected accounts' interest first.
  A buyer cannot take the seller's previously accrued yield.
- Before maturity, merging burns matching PT/YT. After maturity, PT redeems
  without YT. Claims pay the beneficiary even if someone else triggers them.
- Exits can return shares or redeem to USDC; an illiquid vault redemption reverts
  the entire transaction. There is no administrator sweep of backing or interest.
- A vault loss can reduce principal's USDC value; this is not a guaranteed deposit.

### Registry behavior to preserve

- Constructor takes `(asset, owner)`; owner is immutable. Registry requires 6-decimal USDC.
- `registerSeries(yieldToken)` derives the vault, PT and expiry from the YT,
  checks asset/issuer/token relationships, and rejects expired series and duplicates.
- A vault/expiry pair can be registered once. IDs start at 1; reverse lookups
  return 0 for unknown entries. `getSeries` rejects invalid IDs.
- `seriesCount`, `getSeries`, `seriesIdByYieldToken`, `seriesIdByPrincipalToken`
  and `seriesIdFor` support discovery. Expired records remain available.
- `setPoolKey(id, key)` can be called once before maturity. PoolKey fields match
  the v4 ABI: currency0, currency1, uint24 fee, int24 tickSpacing, hooks.
  The current implementation requires sorted PT/USDC currencies, static fee
  at most 1,000,000, spacing 1–32,767 and zero hooks.
- Pool metadata does **not** initialize a market or verify liquidity. Getter
  validation does **not** establish that arbitrary registered code is safe;
  code approval remains the owner's responsibility.

## Validation already completed

The last full `npm test` run passed **122/122 tests**: 16 token/accounting tests,
10 registry tests, 17 Uniswap integration tests, 19 router tests, 18 Tijori tests
and 22 expiry keeper tests, plus 20 agent/MCP tests, with no failures or skips
(about 323 seconds). After the final status, journal-validation and cancellation
changes, all **20/20 agent tests passed again** (about 42 seconds).
This includes 2,000 deterministic
random operations with backing checks, extreme arithmetic cases, loss/recovery,
illiquid exits, transfer settlement, expiry, registry permissions/duplicates,
pool keys, and a local simulation proving mainnet constructors reject deployment.
Compilation and syntax checks for deployment and both seeding scripts also passed.

Agent coverage includes read-only quotes/plans; increasing billing windows;
three-leg execution, maturity cash-out and bill payment; explicit illiquid share
redemption; retained YT claims; revoked/paused/owner keys; payment caps; durable
operation IDs and conflicting intent; dropped/lost responses; confirmation depth;
nonce replacement; failed persistence/corrupt state; gas/chain checks;
cancellation and overlap; reverted payments; key rotation; history reorg halt;
strict SDK tools, sanitized errors and a real stdio subprocess handshake.
A clean offline `npm ci --omit=dev` in a temporary directory also passed the MCP
handshake/tool-list check without Hardhat or solc installed.

All 17 Uniswap tests passed against a real locally deployed PoolManager.
Coverage includes both currency orderings, quotes without funds, slippage and
partial-fill rollback, allowances, unsolicited callbacks, owner LP recovery,
seed-helper execution, maturity redemption, multiple unlocks per transaction and
atomic rollback when the second swap fails.

All 19 router tests passed: three-maturity purchases with refunds, per-leg and
aggregate budget enforcement, exhausted/empty later-leg rollback, early exits,
USDC/share cash-outs (including pool-free redemption), loss/illiquidity and
minimum-output rollback, synthetic YT buys, allowance cleanup, unwanted token
donations, deadline/receiver/amount checks, token callback reentry and short-credit
deposit protection. The mainnet constructor simulation includes PakkaRouter,
Tijori and TijoriFactory.

All 18 Tijori tests passed: real clone bytecode and independent state, locked
implementation/initializers, owner-only policy/recovery, all-entrypoint agent
pause and key replacement, approved payees and daily/30-day rollover, policy
edits without resetting spend, failed-payment rollback, retained PT/refunds,
atomic ladders and slippage rollback, face-value cap, registered-series/deadline
checks, maturity-to-bill payment, illiquid share recovery, bounded USDC/share YT
claims, paused withdrawals, first-clone-call reentrancy and short-credit funding.
Compilation emitted 17 repository artifacts and the deployed-code-size checks
passed. Deployment script syntax checks passed; no deployment command was run.

All 22 keeper tests passed against real local registry/YieldToken contracts:
permissionless settlement preserves user positions, later registry discovery,
ordered maturity handling, settled-series skips, restart recovery, pre-broadcast
journaling, lost responses, dropped-tx replay, confirmations, reorg recovery,
nonce conflicts/external settlement, unknown pending wallet activity, chain and
owner guards, stale/failed RPC, gas bounds/funding warnings, per-series failure
isolation, signed-state/context checks, disk failure, reverted/noncanonical
receipts, overlapping tick exclusion, PID lock recovery and CLI/health config.
Worker/CLI/test syntax checks passed. A clean offline production-only install
and worker import passed with no Hardhat/solc. The Linux unit has not been run
on a host, and no live RPC settlement has been verified.

These tests use a real Uniswap core with mock vaults and USDC. No live-network or
Morpho/Uniswap fork verification, security audit or testnet transaction has been
completed. The market-to-maturity flow is verified locally.

### Uniswap integration decisions

- The official deployment list checked in this session lists Arc mainnet but no
  Arc Testnet entry. Default deployment creates our own testnet core. No unverified
  address from the spec was hardcoded. An optional existing manager must be vetted.
- Market and PoolSeeder use one immutable manager and registry. They call
  PoolManager directly with authenticated callbacks; no Permit2 or Universal Router
  deployment is needed for this demo.
- Market quotes are non-view methods intended for `eth_call` / ethers `.staticCall`.
  A callback revert rolls back pool state; the quote returns the simulated amount.
  Execution still requires token approval to the market and spending/output bounds.
- The adapter rejects matured trades; it cannot disable permissionless v4 pools
  for other routers. Actual quotes include fees and price impact.
- PoolSeeder owns its positions with zero salt and returns withdrawals only to its
  immutable owner. No public LP accounts/NFTs exist. Preserve tick ranges and
  liquidity in the manifest for later removal; zero removal collects fees.
- Default seed configuration is PT price 0.99 USDC, fee 500 (0.05%), spacing 10,
  and maximum 10 PT + 10 USDC per series. This is demo pricing, not an APY promise.
  YT created during inventory splits stays with the owner. Prices move with trades.
- Core dependencies are frozen browser-extracted source snapshots under `vendor/`,
  with SPDX/license texts and URL/hash provenance. They are not claimed to be a
  specific release/commit or identical to an existing network deployment.

### PakkaRouter behavior to preserve

- Constructor takes only UniswapV4Market and derives immutable registry/USDC.
  Testnet/local chain guards remain. No owner, upgrade, sweep or arbitrary-target call exists.
- `lock(id, ptAmount, maxUsdc, receiver, deadline)` pulls the maximum budget,
  buys exact PT and refunds the caller's unused USDC. Refunds never include donations.
- `buildLadder(legs, maxTotalUsdc, receiver, deadline)` takes explicit
  `{seriesId, ptAmount, maxUsdc}` legs in strictly increasing maturity order.
  It bounds each buy by the remaining total budget and its own cap. Caps can sum
  above the total budget. One failed leg rolls back everything; refunds happen once.
- The router does not automatically select monthly maturities. That planning
  is implemented by the MCP service; the on-chain ladder executes explicit choices.
- `sellEarly(id, ptAmount, minUsdc, receiver, deadline)` pulls approved caller PT,
  sells through the immutable market and sends USDC directly to receiver.
- `cashOut(id, ptAmount, receiver, toAssets, minOutput, deadline)` requires maturity,
  settles the index, checks `maxRedeem(YieldToken)` for USDC exits, pulls caller PT
  into the router and redeems it. This is necessary because core burns its caller's PT.
  Minimum output is in USDC or vault-share units according to toAssets. Share exits
  skip maxRedeem and remain usable when the vault is illiquid. No pool is needed.
- `buyYield(id, assets, minYT, minUsdcReturned, receiver, deadline)` splits a deposit,
  sells all minted PT and transfers new YT to receiver. PT-sale proceeds go back to
  the caller; the caller must temporarily fund the full deposit. No YT pool exists.
- Every money entrypoint is nonReentrant/nonpayable, checks its receiver/deadline,
  uses exact temporary downstream approvals and clears them on success. `_pull`
  checks the received amount so a short-credit deposit cannot spend donated balances.
- Caller approves router for USDC or the relevant PT; no caller approval to market
  or YieldToken is needed for routed trades/redemption. Initial approvals can require
  separate transactions; no permit/single-signature approval system is implemented.
- Events: Locked per purchase, LadderBuilt summary, SoldEarly, CashedOut, YieldBought.
  Normal calls leave no newly deposited USDC/PT/YT in the router. Unsolicited tokens
  cannot be withdrawn by other callers and have no administrator recovery method.

### Tijori implementation decisions

- Factory constructor deploys one locked implementation with immutable router,
  registry, USDC and factory address. Clone initialization is factory-only and
  atomic with creation. `tijoriOf(owner)` and events are the discovery mechanism.
  One clone per owner per factory, no ownership transfer, no upgrades or router edits.
- Owner chooses an agent (zero disables it), payment caps, approved payees and
  pause state. Old keys immediately lose access. Every agent operation checks
  identity and pause. Owner actions remain available while paused.
- `lock` and `buildLadder` call the existing router with receiver hardcoded to
  the treasury. Each leg must have `maxUsdc <= ptAmount` (fee-inclusive face-value
  cap); this bounds price but is not an oracle or a vault-loss guarantee. No
  agent early-sale/YT-buy/arbitrary-call/withdraw/approve capability is exposed.
- `cashOut` approves exact PT and receives USDC or vault shares in the treasury.
  `claimInterest` claims only for the treasury and enforces minimum output.
  Registered-series validation comes from immutable registry/router. Claims can
  use YT the owner sent in. All routed allowances are cleared on success.
- `pay` sends USDC only to an owner-approved payee, under both a per-payee and a
  global daily cap. Daily windows are UTC days. Payee windows are **fixed 30-day
  Unix-epoch windows**, not calendar months or rolling periods. This is an explicit
  testnet choice for the docs' monthly bill story. Review calendar requirements
  before mainnet. `paymentRemaining` returns the current lesser allowance;
  public raw counters reset lazily and must be read with their window identifiers.
- Edits, revocation/reapproval, pause and key changes never erase spending in
  the current windows. Owner payments also obey caps; owner withdrawals bypass
  payment bookkeeping. Payment caps do not limit treasury-owned investments.
- Owner `deposit` uses exact-credit checks; `withdraw(token, amount)` sends only
  to owner and works while paused. It recovers USDC/PT/YT/vault shares as held,
  without promising instant conversion to USDC. Constructor-based OZ ReentrancyGuard
  works from a clone's zero storage; first-deposit callback reentry is tested.
- Core YT interest claims remain permissionless and pay only the treasury even
  when an external caller invokes them; pausing wrappers does not block core claims.
- Official OZ v5.1 Clones/Errors were added to the vendored subset, retaining
  executable logic and SPDX with comments/formatting normalized. No new npm dependency.
- Testnet deployment now records `tijoriFactory` and `tijoriImplementation`.
  Owners must call factory create from their own wallets; script does not create
  or fund user treasuries. No .env changes were needed in this phase.

### Expiry keeper implementation decisions

- Registry/chain context comes from `deployments/arc-testnet.json`; CLI requires
  chain 5042002 and canonical USDC, a dedicated `KEEPER_PRIVATE_KEY`, and rejects
  the deployer plus the actual registry owner. Module tests allow 31337 only.
  Real `eth_chainId` is checked every tick and before broadcast. Provider has a
  fixed network hint to avoid ethers' indefinite initial-discovery retry loop;
  the explicit chain checks and signed EIP-155 chain binding enforce the network.
- Full registry scan each cycle discovers new series, reads chain timestamps,
  skips future/settled entries and orders eligible series by expiry. Demo-scale
  O(n) reads are deliberate; events/metadata caching are a later scaling change.
- One transaction in flight per wallet; exact raw signed bytes/hash/nonce are
  atomically written with fsync and mode 600 before broadcast. Journal context,
  signature/from/to, registered series, zero value, calldata and gas bounds are
  validated before any replay. Preserve the runtime directory across restarts.
- Canonical receipts require configured confirmations. Lost responses recover
  by receipt; missing unconsumed transactions replay the same signed bytes.
  Reverted receipts clear the journal and retry next cycle. An externally
  settled series resolves a consumed nonce. Otherwise `NONCE_CONFLICT` retains
  evidence and blocks new signing until operator review. No fee bump/cancellation.
- Wallet activity with an unknown pending nonce blocks new signing. A local
  PID lock prevents duplicate workers on the same path and reclaims exited-PID
  locks. Use one worker per dedicated wallet; this is not a distributed/HA lock.
- Defaults: 10-second poll delay, 2 confirmations, 120-second stale-block/stuck-tx
  thresholds, gas-price floor 25 gwei/cap 250 gwei, gas-limit cap 500000 with 20%
  estimate buffer, low-gas warning at 0.1 native USDC. Low balance warns but
  affordable work continues; actual insufficient transaction funds block sends.
- RPC requests time out after 30 seconds. Per-series preparation errors don't
  prevent processing another due series; fatal config/state mismatches stop CLI.
  SIGINT/SIGTERM finishes the current cycle, preserves pending data and releases
  the lock. Calls are serial and overlapping ticks are rejected.
- JSON stdout alerts and `<stateFile>.health.json` contain last heartbeat, block,
  balance and pending hash. `keeper:health` reads that file without key or RPC and
  returns nonzero if unhealthy/stale. External notification delivery remains a
  hosting task; no messages/webhooks/email have been sent or configured.
- CLI commands: `keeper:testnet` continuous; `keeper:once` one cycle, up to one new
  transaction, without waiting for mining; `keeper:health` cached status. Once
  is not a dry run. Manifest/key preflight still blocks a real start here.
- Added 9 missing keeper settings to `.env` without displaying or overwriting
  existing values/secrets; mode 600 preserved. `.env.example` documents them.
  Runtime state and `.env.keeper` are gitignored. Server service template uses
  `.env.keeper` with only worker settings/key, not the deployment key.
- Ethers 6.17.0 moved from devDependencies to dependencies; lock regenerated
  offline with identical versions. Clean `npm ci --omit=dev` in a temporary
  directory and runtime import passed without Hardhat or solc. No new package.
- `infra/pakka-keeper.service` is a Linux template for `/opt/pakka`, user pakka,
  Node at `/usr/bin/node`, persistent runtime and restart-on-failure. It hasn't
  been installed or validated on an actual Linux host. README has setup steps.

## Agent/MCP implementation decisions

- `agent/mcp-server.ts` uses official `@modelcontextprotocol/sdk` 1.30.1 and
  direct `zod` 4.6.5 runtime dependencies, installed from the local offline cache.
  Stdio only; SDK negotiates supported versions including 2025-11-25. No model,
  public HTTP endpoint, remote connector, scheduler or extra contracts were added.
- Eight tools: `treasuryStatus`, `quotePT`, `planTreasury`, `executePlan`,
  `cashOut`, `claimInterest`, `pay`, `transactionStatus`. Strict schemas reject
  receiver overrides/arbitrary fields; USDC/PT amounts are decimal strings,
  six decimals maximum. Raw outputs are strings. Stdout contains protocol only;
  returned errors are controlled codes, not raw ethers/RPC errors or secrets.
- One configured factory-created clone per process. Verify manifest, factory
  owner mapping, initialized treasury, router/market/registry/asset relationships,
  actual chain and fresh block. CLI is testnet-only; module allows local 31337.
  Signing requires a separate `AGENT_PRIVATE_KEY` matching the current active
  Tijori agent and differing from both treasury and registry owners.
- Planning quotes positive discounted PT, caps each leg at face, bounds the
  total by treasury balance and user budget, and saves a SHA-256-addressed plan.
  Execute uses that plan's caps/deadline through Tijori. Default TTL 300 seconds,
  ending before first expiry if sooner. Plans do not move money or reserve quotes.
- Default billing intervals are fixed 30-day seconds; choose each maturity within
  its window before the due date. Missing windows fail. Explicit increasing
  `seriesIds` support the one-hour/day/week demo, which cannot serve three monthly
  payments. Explicit IDs and date/interval parameters cannot be combined.
- Cash-out and YT claims retain outputs in Tijori. Minimum outputs use configured
  slippage (default 100 bps); a caller cannot weaken them. Illiquid USDC redemption
  fails and requires explicit `toAssets:false` for shares. Status includes
  retained vault-share balances once PT has been burned. Empty interest claims
  do not sign a transaction. Vault solvency/liquidity still affect principal.
- Every write requires an operation ID, 8–64 alphanumeric/underscore/hyphen
  characters. Exact request fingerprints detect changed intent. Atomically save
  raw signed bytes, hash, nonce, signer and method before broadcasting; retries
  replay those bytes, never another nonce. Status only reconciles, never sends.
  Reverted actions remain terminal; intentional new attempts require new IDs.
- One pending action and serial requests per instance; unknown wallet pending
  nonces block signing. Confirm canonical receipts with default 2 confirmations.
  Consumed unknown nonces or missing confirmed receipts fail closed; a historical
  receipt disappearing while another action is pending persistently halts writes.
  No fee bumps/replacements. Recent receipts are rechecked; arbitrary deep reorgs
  are outside this testnet model. Key rotation keeps old history and cannot
  automatically replay an old unbroadcast agent action.
- Signature/from/to, calldata allowlist, context, zero native value, nonce and
  gas bounds are validated when loading the journal. Defaults: 25-gwei gas floor,
  250-gwei ceiling, 20% gas buffer, 1.5m gas limit. Recheck chain/agent before
  signing/broadcasting. Cancelled requests stop before signing; signed actions
  remain journaled. Shutdown waits for the active request before releasing lock.
- Reuse keeper `writeJson` and PID-lock helpers. Single host only: run one process
  per dedicated agent wallet/journal. Preserve runtime history across restarts;
  on-chain `pay` has no operation IDs. New IDs mean new intents, so an agent must
  not rename a bill merely to retry. JSON history is sufficient for testnet;
  registry scan ceiling 1000, live saved plans 128, ladder legs 12.
- Settings were appended only if missing in `.env` (mode 600), documented in
  `.env.example`; `.env.agent` and runtime files are ignored. Do not place owner
  keys on an agent host. Service works read-only without its key. MCP initialize
  and tool-list need no key/RPC/manifest; business calls remain unconfigured here.
- `npm run agent:mcp` is a terminal start command. MCP clients must launch Node
  directly with absolute script/env-file paths because npm adds stdout text.
  Relative runtime paths resolve from project root, not client cwd. Configured
  use requires compiled artifacts and `deployments/arc-testnet.json`.

## Remaining work, in recommended order

1. **Testnet deployment and live operation:** fund separate deployer, keeper and
   agent wallets, deploy and seed, create/deposit/configure an owner Tijori and
   approved payees, connect an MCP client, then host the continuous keeper with
   persistent state, health monitoring and external alerts. No host is chosen and
   no live run exists. Run the integrated ladder/maturity/MCP-payment demo. This
   also unblocks the backend/frontend (`npm run dev`), which only has local
   Hardhat coverage (`test/full-flow.test.ts`, `test/browser-e2e.ts`) so far.
2. **Public hosting for the web app:** pick a host, put a TLS reverse proxy in
   front of `backend/server.ts` (which only ever binds to `127.0.0.1`), and set
   `API_ALLOWED_HOSTS`/`API_ALLOWED_ORIGINS` for the real domain. The grant
   submission needs a live URL reviewers can open.
3. **Real vault + fork security run:** pick and verify a real curated Morpho
   vault on Arc (Gauntlet/Steakhouse, per `docs.html`), set `FORK_RPC_URL` and
   `FORK_VAULT_ADDRESS`, then run `npm run security` (forge/slither/aderyn are
   now installed; this was the last blocker per `reports/security-status.json`).
4. **Fix the 4 known test failures** listed in the 2026-10-06 session update
   above (`test/uniswap-v4.test.ts` error-name drift, one undecoded v4 batch
   revert, one expiry-keeper settlement-simulation assertion) before trusting a
   future "all tests green" claim for those two areas.
5. **Dependency/integration validation:** verify a real vault and any externally
   supplied manager. Demo contracts/local tests do not prove real Morpho behavior.

## Constraints and unresolved points

- All production entrypoint constructors allow only Arc Testnet
  `5042002` and local chain `31337`; Arc mainnet `5042` is rejected. Keep this guard.
- Canonical testnet USDC is `0x3600000000000000000000000000000000000000`.
  Contract money paths use ERC-20 calls and are nonpayable.
- **Expiry is lazy:** the first interaction at or after maturity freezes the
  observed index. A late first interaction includes intervening yield in YT.
  The implemented keeper helps the demo but does not provide exact historical settlement;
  resolve this before a later mainnet release.
- DemoVault does not prove behavior of a real curated Morpho vault. Real vault
  selection, liquidity assumptions and fork validation remain pending.
- Do not treat addresses in the specification as verified live deployments.
  An existing Uniswap manager and real vault choices need official verification.
- OpenZeppelin 5.1 source subset is vendored; see
  `vendor/openzeppelin-contracts/README.md` for provenance/formatting details.
  Review/use the official distribution for a later production migration.
- Registry ownership cannot transfer and core records/pool keys cannot be edited.
  Consider any operational changes explicitly before altering that design.
- The workspace currently has no Git repository and no `deployments/` manifest.
  Do not claim commits or live contract addresses exist.

## Commands and development environment

Node.js 22+, Solidity 0.8.26, Cancun EVM, via-IR, optimizer 200 runs. Ethers 6.17.0,
Hardhat 2.29.1, local Cancun hardfork. v4 requires EIP-1153 transient storage.
Tests use Node's test runner and the local Hardhat provider.

```sh
npm ci
npm run compile
npm test
node --test test/series-registry.test.ts
node --test test/uniswap-v4.test.ts
node --test test/pakka-router.test.ts
node --test test/tijori.test.ts
node --test test/expiry-keeper.test.ts
node --test test/agent-mcp.test.ts
node --check scripts/deploy-testnet.ts
npm run keeper:testnet
npm run keeper:once
npm run keeper:health
npm run agent:mcp
```

The custom compiler writes `artifacts/<ContractName>.json`. `npm test` runs files
sequentially to avoid concurrent writes to those artifacts. Compilation uses
installed solc, so it does not download a compiler at runtime. Dependencies are
already installed. Shell network access was restricted during setup; an offline
npm cache was prepared at `/tmp/pakka-npm-cache`, if still available.

For a user-authorized deployment, set `DEPLOYER_PRIVATE_KEY` locally to a funded
test wallet. `TESTNET_VAULT_ADDRESS` can stay blank to use DemoVault;
`SERIES_DURATIONS` defaults to `3600,86400,604800` and rejects duplicate durations.
`npm run deploy:testnet` sends real testnet transactions and writes
`deployments/arc-testnet.json`. It is not a dry run and was not executed here.

`.env` and `.env.example` now also contain `UNISWAP_V4_POOL_MANAGER_ADDRESS`
(blank means self-hosted testnet core), `PT_PRICE_USDC`, `POOL_SEED_USDC` and
`POOL_SEED_PT`. Existing values/secrets were preserved. After deployment,
`npm run seed:testnet` sends seeding transactions and records position details.
Successful pools are skipped on rerun. A broadcast but unresolved liquidity
transaction prevents automatic replay; inspect its receipt. No deployment manifest
or live address exists yet. Contract APIs/seed configuration are in README.md.

## Resume guidance

Use this file and the README as the baseline, then inspect the relevant source
and spec section before editing. The foundation, registry, local Uniswap market
and PakkaRouter, Tijori, TijoriFactory, the expiry keeper and local MCP service are complete;
the full backend is not.
Continue with the next user-authorized phase,
using the existing core and minimal dependencies. Keep this handoff updated when
implementation, tests, deployment state or user decisions change.

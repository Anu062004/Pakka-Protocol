# Pakka contracts — testnet prototype

For the current implementation status, remaining work and continuation notes,
see [AGENT_HANDOFF.md](AGENT_HANDOFF.md).

The implementation follows `docs.html` and `contact.png` (the image referred to
as contract.png), especially sections 6–8 and the contract test list. The HTML
was populated after the initial inspection and has now been checked against the
core implementation.

Pakka splits an ERC-4626 USDC vault position into principal (PT) and yield (YT)
for one maturity. Holding both is equivalent to the underlying position, less
rounding dust. Buying PT below face value creates a fixed rate; UniswapV4Market
and PakkaRouter now provide that purchase flow. The core does not set an APY or PT price.

## Implemented

| Contract | Behavior |
| --- | --- |
| `PrincipalToken.sol` | ERC-20 principal in asset units; only its YieldToken mints/burns. |
| `YieldToken.sol` | Holds shares, splits and merges, settles YT interest before balance changes, freezes expiry, and redeems PT. |
| `SeriesRegistry.sol` | Owner-approved directory of series, validates token/vault relationships, rejects duplicates and optionally records one PT/USDC pool key. |
| `UniswapV4Market.sol` | Real v4 swaps: exact-output PT purchases, exact-input early sales, rollback-based quotes and pool-state reads. |
| `PakkaRouter.sol` | Atomic locks, early sales, maturity cash-outs, ladders with budget refunds, and synthetic YT purchases. |
| `Tijori.sol` | User-owned treasury with restricted agent purchases, redemptions, interest claims and capped payee payments. |
| `TijoriFactory.sol` | Creates and initializes one minimal treasury clone per owner, with a locked shared implementation. |
| `PoolSeeder.sol` | Owner-operated pool initialization, bounded liquidity additions, fee collection and withdrawal after expiry. |
| `TestnetPoolManager.sol` | Testnet/local-only constructor wrapper around vendored Uniswap v4 PoolManager; self-hosted infrastructure for the demo. |
| `DemoVault.sol` | Testnet-only ERC-4626 vault over faucet USDC, with 18-decimal shares. Direct USDC donations simulate yield. It does not lend to Morpho. |
| `contracts/test/` | Local USDC, configurable vault, loss/liquidity simulation and interest arithmetic harness. |

All production entrypoint constructors allow only Arc Testnet (`5042002`) and
local Hardhat/Anvil (`31337`). YieldToken, DemoVault and SeriesRegistry require
canonical ERC-20 USDC on Arc Testnet. Mainnet deployment is deliberately disabled
for this release. Test fixtures are local-only development assets.

## Series registry

The deployment wallet is the registry's immutable owner. Only that address can
call `registerSeries(yieldToken)` or `setPoolKey(seriesId, poolKey)`. Registration
reads the vault, PT and expiry from the YieldToken, verifies the shared USDC asset,
the PT's issuer and 6-decimal tokens, and rejects matured or duplicate series.
Each vault/expiry pair can be registered only once. The owner must approve the
contract code; matching getter values alone do not establish its safety.

IDs start at 1 and records cannot be removed or replaced, including after expiry.
Use `seriesCount()` and `getSeries(id)` to enumerate records, or
`seriesIdByYieldToken(address)`, `seriesIdByPrincipalToken(address)` and
`seriesIdFor(vault, expiry)` to look them up. Unknown reverse lookups return 0;
`getSeries` rejects unknown IDs. `SeriesRegistered` events support indexing.

Series can be registered before a market exists. Before maturity the owner can
attach one Uniswap v4-compatible PT/USDC pool key with currencies sorted by address,
a static fee, positive tick spacing and no hooks. `PoolKeySet` emits its pool ID.
This stores metadata only; it does not create a pool or verify its liquidity.
`hasPool` distinguishes an attached key from the initial empty fields. Custom hooks
and dynamic fees remain part of the later market implementation.

## Uniswap v4 market

This release uses real Uniswap v4 core, not a mock pool or fixed-price counter.
`UniswapV4Market` and `PoolSeeder` share one immutable PoolManager and registry.
The official [v4 deployment list](https://developers.uniswap.org/docs/protocols/v4/deployments)
does not currently list Arc Testnet. The default deployment therefore creates
our own `TestnetPoolManager`; this is **not an official Uniswap deployment**.
Alternatively, configure a manager whose testnet code/compatibility you have
independently verified. Never copy a mainnet address into the testnet configuration.

The market calls PoolManager directly with authenticated unlock callbacks and
settles ERC-20 deltas. It does not use Permit2 or Universal Router. Operations are:

| Function | Behavior |
| --- | --- |
| `buyPT(id, ptAmount, maxUsdc, receiver, deadline)` | Buy the exact PT amount, pulling only the actual USDC cost. |
| `sellPT(id, ptAmount, minUsdc, receiver, deadline)` | Sell the exact PT amount for USDC before maturity. |
| `quoteBuyPT(id, ptAmount)` / `quoteSellPT(id, ptAmount)` | Call via `eth_call` / ethers `.staticCall`; simulate a swap and revert its pool changes internally. No funds/allowances needed for quotes. |
| `poolState(id)` | Read pool ID, sqrt price, tick, active liquidity and LP fee. |

Trades require a registered pool key and a future maturity. Unfilled/partial
swaps revert, as do expired deadlines and failed spending/output bounds. Quotes
include the pool's swap fee and price impact; they are estimates, not guaranteed
execution prices or APYs. Pool initialization price is not the price of every trade.
This adapter rejects matured trades; v4 pools themselves are permissionless,
so unrelated routers may still trade them after maturity.

Approve USDC to the market for buying, or PT for selling. The market never asks
the buyer to approve the PoolManager and leaves no normal-operation token balance
in the adapter. Receivers cannot be zero, the market or the PoolManager.

PoolSeeder's immutable owner is the registry owner. `initializePool` uses the
registered key. `liquidityForAmounts` calculates liquidity from current price and
two maximum token budgets. `addLiquidity` supplies a tick range and liquidity
with maximum token costs; `removeLiquidity` supplies minimum outputs and remains
available after maturity. Zero removal collects accrued LP fees. These positions
belong to PoolSeeder, use a zero salt, and pay only its owner; no LP NFTs or public
liquidity accounts are implemented. Save the tick range/liquidity from the manifest
to withdraw the same position later.

## PakkaRouter

The constructor takes the deployed `UniswapV4Market` address and derives its
immutable registry and USDC asset. There is no administrator, upgrade mechanism,
arbitrary-target call or sweep. The router keeps no user position records: PT/YT
go to the specified receiver, and a later call uses only its caller's approved tokens.

| Function | Behavior |
| --- | --- |
| `lock(id, ptAmount, maxUsdc, receiver, deadline)` | Pull the maximum USDC budget, buy exact PT and refund unused USDC to the caller. |
| `buildLadder(legs, maxTotalUsdc, receiver, deadline)` | Buy each target PT amount in one atomic transaction; enforce per-leg limits and total spending; refund once. |
| `sellEarly(id, ptAmount, minUsdc, receiver, deadline)` | Pull caller-approved PT, sell it before maturity and pay USDC directly to receiver. |
| `cashOut(id, ptAmount, receiver, toAssets, minOutput, deadline)` | Redeem matured caller-approved PT; bound output in USDC or vault-share units. No market pool is needed for redemption. |
| `buyYield(id, assets, minYT, minUsdcReturned, receiver, deadline)` | Split USDC into PT/YT, sell all minted PT, return sale proceeds to caller and deliver YT to receiver. |

Each ladder leg is `{ seriesId, ptAmount, maxUsdc }`. Supply registered series in
**strictly increasing maturity order**; duplicate or unordered maturities are
rejected. IDs need not be consecutive. Per-leg spending caps may sum above the
total budget: each purchase is also bounded by the remaining budget. If any leg
fails, every deposit, approval, earlier purchase and pool change is rolled back.
The router does not choose calendar dates or maturities automatically; that
selection is implemented by the agent service's `planTreasury` tool.

For USDC operations, approve the router, not the market. For early sale and
cash-out, approve the appropriate PT to the router. The router gives exact,
temporary downstream approvals and clears them on success. Approval transactions
may be required before the single transaction that executes a ladder. All methods
are nonpayable and require a valid deadline. Zero, router, market and PoolManager
receivers are rejected. Amounts use 6 decimals except share outputs, which use
the vault's share decimals.

Cash-out pulls PT into the router because YieldToken burns its caller's tokens.
It settles maturity, checks `maxRedeem(YieldToken)` before a USDC exit, and enforces
the minimum actual output. A failed liquidity or minimum-output check preserves
the user's PT. Set `toAssets=false` to receive shares when USDC redemption is
unavailable. The router does not automatically switch payout assets. The existing
lazy-expiry and vault-loss limitations still apply.

YT buying is a synthetic route through the PT pool, not a separate YT exchange.
The caller temporarily funds the full deposit; the PT-sale proceeds return to
that caller, so the net USDC cost is `assets - usdcReturned`. `minYT` and
`minUsdcReturned` bound the received yield position and net cost. The entire flow
reverts if the PT sale cannot complete. Newly received YT earns subsequent yield;
the core's transfer accounting preserves any earlier holder's accrued interest.

`Locked`, `LadderBuilt`, `SoldEarly`, `CashedOut` and `YieldBought` events identify
the initiating caller and receiver. A ladder emits `Locked` for each leg and one
summary with total spending/refund. Normal operations leave no newly deposited
USDC, PT or YT in the router. Unsolicited tokens sent to the router are not included
in refunds and cannot be swept through these methods.

Example with ethers contract instances `asset`, `market`, `router`, and an
already connected `signer` (IDs must represent increasing future maturities):

```js
const ptAmount = 1_000_000n; // Target 1 USDC of principal per maturity for the small demo pools.
const receiver = await signer.getAddress();
const legs = [];
for (const seriesId of [1, 2, 3]) {
  const quote = await market.quoteBuyPT.staticCall(seriesId, ptAmount);
  legs.push({ seriesId, ptAmount, maxUsdc: quote + quote / 100n + 1n });
}
const maxTotalUsdc = legs.reduce((sum, leg) => sum + leg.maxUsdc, 0n);
await (await asset.connect(signer).approve(router.target, maxTotalUsdc)).wait();
const deadline = (await signer.provider.getBlock("latest")).timestamp + 300;
await (await router.connect(signer).buildLadder(legs, maxTotalUsdc, receiver, deadline)).wait();
```

## Tijori agent treasury

`TijoriFactory(router)` deploys a locked Tijori implementation. Each wallet calls
`create(agent, dailyCap)` to create its own 45-byte ERC-1167 clone. `tijoriOf(owner)`
and `TijoriCreated` identify it. Only one treasury per owner per factory is allowed;
the factory cannot create for someone else's wallet. Initialization is restricted
to the factory and happens in the same transaction as creation. Never deposit to
the implementation address. Dependencies, owner and router cannot be replaced.

The owner sets the agent, pause state, daily cap and approved payee caps. Setting
the agent to zero disables it; replacing it immediately revokes the previous key.
Pausing blocks all agent entrypoints while owner control remains available.
Smart-account agents are supported; there is no arbitrary execution function.

| Function | Who / behavior |
| --- | --- |
| `deposit(amount)` | Owner approves USDC to Tijori, then funds it; short-credit transfers revert. Direct token transfers are also accepted. |
| `withdraw(token, amount)` | Owner retrieves USDC, PT, YT or vault shares to their own wallet, including while paused. |
| `setAgent(address)`, `setPaused(bool)` | Owner changes/revokes the key or pauses agent actions. |
| `setDailyCap(cap)`, `setPayeeCap(payee, cap)` | Owner sets payment limits; zero payee cap revokes approval. |
| `paymentRemaining(payee)` | Remaining allowance under both caps, excluding available USDC balance. |
| `pay(payee, amount)` | Owner/active agent pays only an approved destination within both limits. |
| `lock(id, ptAmount, maxUsdc, deadline)` | Owner/active agent buys registered PT; treasury receives the PT and budget refund. |
| `buildLadder(legs, maxTotalUsdc, deadline)` | Same receiver policy for an atomic ladder through PakkaRouter. |
| `cashOut(id, ptAmount, toAssets, minOutput, deadline)` | Redeem matured PT into treasury USDC or vault shares. |
| `claimInterest(id, toAssets, minOutput)` | Claim the treasury's YT interest into itself, with a minimum-output check. |

Payment limits are in raw USDC units. The global daily window is a UTC day
(`timestamp / 86400`). Each payee has a separate cap for a **fixed 30-day window
anchored to the Unix epoch**, using `timestamp / (30 * 86400)`. This implements a
30-day billing cap for the demo, not a calendar-month or rolling-window cap.
Both windows reset lazily on a successful payment. Editing limits, revoking and
reapproving payees, pausing or replacing the agent preserves already-used spending
in the current window. Failed transfers roll back both counters. Owner payments
also obey caps; owner withdrawals are independent. Purchases do not consume payment
caps because the resulting positions remain in the owner's treasury.

Every purchase leg must cap fee-inclusive USDC cost at or below PT face value:
`maxUsdc <= ptAmount`, since both tokens have 6 decimals. A trade above this bound
reverts; this is not an oracle or a guarantee against underlying vault losses.
The agent cannot sell PT early, buy YT, change limits/router, set a receiver,
withdraw tokens or approve arbitrary spenders. It can claim interest on YT the
owner transfers into the treasury. All routed approvals are temporary and cleared.
Permissionless core interest claims remain callable by anyone and always pay the
treasury; the Tijori pause does not change that core behavior.

Example using connected `ownerSigner`/`agentSigner` and existing ethers instances:

```js
await (await tijoriFactory.connect(ownerSigner).create(await agentSigner.getAddress(), 50_000_000n)).wait();
const ownerAddress = await ownerSigner.getAddress();
const tijori = new Contract(await tijoriFactory.tijoriOf(ownerAddress), tijoriAbi, ownerSigner);
await (await asset.connect(ownerSigner).approve(tijori.target, 150_000_000n)).wait();
await (await tijori.deposit(150_000_000n)).wait();
await (await tijori.setPayeeCap(serviceProviderAddress, 50_000_000n)).wait();
const deadline = (await ownerSigner.provider.getBlock("latest")).timestamp + 300;
// Small demo purchase: 1 USDC of face value; all outputs go to Tijori.
await (await tijori.connect(agentSigner).lock(1, 1_000_000n, 1_000_000n, deadline)).wait();
```

Withdrawal recovers the assets currently held. It does not instantly convert
unmatured PT or illiquid vault shares into USDC. The owner can withdraw PT to their
wallet and use the regular router's early-sale flow if market liquidity permits.

## Expiry keeper

`scripts/keeper-testnet.ts` is a continuous Node worker over the existing
`YieldToken.settleExpiry()` function. It requires no new contract, compiler,
owner privileges or database. It reads the registry in `deployments/arc-testnet.json`
and discovers all registered series on every cycle, including later registrations.
Only matured series with zero `indexAtExpiry` are candidates, oldest maturity first.
It uses blockchain timestamps rather than the computer clock to decide maturity.

Deploy the contracts first. Set `KEEPER_PRIVATE_KEY` locally to a **separate**
funded testnet wallet; the worker rejects the registry-owner/deployment wallet.
Existing `.env` values are preserved and missing keeper settings have been added.
The RPC's actual chain ID and the registry's canonical USDC asset are checked.
The CLI allows Arc Testnet only; chain 31337 is available solely to local module tests.

```sh
npm run keeper:testnet  # Continuous worker; sends settlement transactions when due.
npm run keeper:once     # One cycle, at most one new transaction; also sends transactions.
npm run keeper:health   # Reads the last heartbeat; no key or RPC call needed.
```

`keeper:once` does not wait for mining or confirmations and is not a dry run.
Use the continuous worker, or run subsequent cycles to reconcile pending receipts.
The health command exits nonzero for an unhealthy or stale heartbeat. Monitoring
should invoke it periodically and collect the worker's JSON stdout logs.

| Setting | Default / purpose |
| --- | --- |
| `KEEPER_POLL_INTERVAL_SECONDS` | 10; non-overlapping cycle delay, maximum 86400. |
| `KEEPER_CONFIRMATIONS` | 2; canonical receipt block plus this confirmation count before clearing the journal. |
| `KEEPER_MAX_BLOCK_AGE_SECONDS` | 120; stale RPC blocks pause transaction submission and emit an alert. |
| `KEEPER_PENDING_ALERT_SECONDS` | 120; alert when an unconfirmed transaction remains pending. |
| `KEEPER_MAX_GAS_PRICE_GWEI` | 250; refuse gas quotes above this cap; a 25 gwei floor matches deployment tooling. |
| `KEEPER_GAS_LIMIT_CAP` | 500000; estimate with a 20% buffer, then enforce this limit. |
| `KEEPER_MIN_GAS_BALANCE` | 0.1 native USDC; warning threshold. Affordable settlements continue below it. |
| `KEEPER_STATE_FILE` | `runtime/keeper-state.json`; durable transaction journal. |

Gas balances use native USDC's 18-decimal representation; the ERC-20 asset uses
6 decimals. See the official [Arc connection reference](https://docs.arc.io/arc/references/connect-to-arc).
Insufficient funds for the estimated transaction cost prevent signing/broadcasting.
RPC requests have a 30-second timeout, and failed cycles retry on the next poll.
There is one settlement in flight per wallet. A preparation failure for one series
does not stop another eligible series from being considered.

Before any broadcast, the exact signed transaction, hash and nonce are written to
an atomic, fsynced journal with mode 600. Startup binds that journal to its chain,
registry and wallet. Recovery validates the signature, target registered YT, calldata,
zero value and configured gas bounds; it rebroadcasts identical bytes only when the
transaction is missing and its nonce is unconsumed. Confirmed canonical receipts
clear the journal. Reverted receipts are reported and retried on a later cycle.
A lost RPC response or a restart does not cause a new transaction to be signed.

Keep the runtime directory on persistent local disk and run one worker per wallet.
The local PID lock prevents duplicate workers using the same state path and reclaims
locks from exited processes. Do not delete the journal while a transaction is
unresolved. `NONCE_CONFLICT` retains the evidence and stops new submissions: stop
the worker, inspect the replacement transaction/nonce, and clear `pending` only
after verifying the old transaction cannot still be mined. There are no automatic
fee bumps or cancellation transactions. Lowering gas bounds can invalidate an
existing journal entry and requires review. Full registry scans suit the three-series
demo; event-based discovery/caching can be added when the registry grows.

Logs and the sibling `keeper-state.json.health.json` file include heartbeat,
gas balance, pending hash and alert codes for RPC failures, low funds, failed
settlement and stuck/conflicting transactions. They contain no private keys,
RPC URLs or raw signed bytes. These are local monitoring signals; external alert
delivery must be connected when choosing the host. SIGINT/SIGTERM stops between
cycles and preserves pending transactions for restart.

An optional Linux service template is in `infra/pakka-keeper.service`. On a server,
install Node.js 22+, copy the project to `/opt/pakka`, and run `npm ci --omit=dev`.
The keeper needs ethers at runtime; Hardhat/solc are unnecessary. Create the
`pakka` service user and a writable `/opt/pakka/runtime` directory. Give it an
owner-readable `.env.keeper` with only RPC/keeper settings and the keeper key;
keep the deployment key off the worker host. Check the unit's paths before installing:

```sh
sudo install -m 644 infra/pakka-keeper.service /etc/systemd/system/pakka-keeper.service
sudo systemctl daemon-reload
sudo systemctl enable --now pakka-keeper
journalctl -u pakka-keeper --follow
```

The template provides restart-on-failure and limits repeated startup failures.
It has not been installed or run on a host. The keeper reduces expiry delays but
does not reconstruct a historical vault index; exact expiry settlement remains a
mainnet design issue.

## Accounting

- PT/YT decimals match the asset's runtime `decimals()` (6 for USDC).
- Share decimals are read at deployment. `INDEX_UNIT = 10 ** (shareDecimals + 18)`.
  Share decimals above 59 are rejected because the scale would overflow uint256.
- The high-water index is `max(vault.convertToAssets(INDEX_UNIT), pyIndexStored)`.
  Only successful state-changing interactions persist a new high-water mark.
- Split mints `floor(shares * index / INDEX_UNIT)` PT and YT.
- Each account earns exactly
  `floor(YT * INDEX_UNIT * (current - previous) / (previous * current))` shares.
  Full-precision quotient/remainder arithmetic avoids overflowing the products.
- Transfers, transferFrom, mints and burns settle both affected accounts first.
  A seller keeps prior interest; a buyer earns only subsequent interest.
- Before expiry, merge burns equal PT and YT. After expiry, redeem burns PT only
  and returns `floor(PT * INDEX_UNIT / indexAtExpiry)` shares.
- Claims pay only the beneficiary's address even when triggered by someone else.
- Payouts round down; `sharesForPT` rounds the required backing up. Rounding dust
  remains in the contract. There is no administrator sweep of backing or interest.
- A loss leaves the high-water mark unchanged. YT earns no new shares until
  recovery above that mark; PT/share claim values can lose USDC value.
- `toAssets = false` returns vault shares; `true` calls the vault's `redeem`.
  Failed vault redemption reverts the entire operation, preserving tokens/claims.

## Expiry limitation

ERC-4626 does not expose a historical index. As the image specifies, expiry is
settled lazily on the first interaction at or after maturity. A delayed first
interaction includes intervening yield in YT. Schedule `settleExpiry()` at maturity
for the demo; it is permissionless and idempotent. After settlement, YT stops
earning shares and further share appreciation belongs to outstanding PT and
previously accrued interest shares. Exact historical settlement would need a
separate source of historical vault state before mainnet use.

## Run locally

Requires Node.js 24+ and npm. Every `backend/`, `agent/`, `scripts/` and `test/`
file is real, typed TypeScript (`frontend/` stays plain JS — it's served straight
to the browser). There is **no build/compile step for the TypeScript**: Node runs
`.ts` files natively, so `npm test`/`npm run dev`/etc. are exactly the same
commands they'd be for `.mjs`, just pointed at `.ts`. Run `npm run typecheck`
(`tsc --noEmit`) to check types without running anything. Solidity is pinned to
0.8.26 and Cancun EVM with via-IR; Uniswap v4 needs transient-storage opcodes,
and the local Hardhat network uses Cancun. Compilation
uses the installed solc package without downloading a compiler at runtime.

```sh
npm ci
npm run compile
npm test
```

The tests include the image's split, yield, transfer, merge, maturity, loss/recovery
and revert cases; variable share decimals; illiquid exits; exact arithmetic checks;
and 2,000 deterministic random operations with a backing check after every step.
Registry tests cover permissions, relationships, duplicates, metadata lookups,
pool-key validation and preservation of expired records.
Market tests use the real vendored PoolManager locally, including quotes, both
currency orderings, slippage/partial-fill rollback, LP recovery, multi-swap
composition and the deployment seeding helper. They use mock vaults rather than
a live Morpho deployment. No live-network or fork verification has been performed.
Router coverage includes three-maturity purchases, shared budget/refunds,
later-leg failure rollback, early exits, USDC/share redemption, synthetic YT
purchases, loss/illiquidity, unwanted token donations and reentrant/short-credit
token deposits. Tijori tests cover clone initialization/isolation, owner and agent
permissions, key revocation/pause, payment window rollover, limit edits, failed
payments, purchases/ladder rollback, price caps, cash-out, claims, recovery and
clone reentrancy/short-credit protection. Test results are recorded in AGENT_HANDOFF.md.
The latest full run passed **122/122 tests**: 16 accounting, 10 registry, 17 Uniswap,
19 router, 18 Tijori, 22 keeper and 20 agent/MCP tests. Keeper coverage includes restart/replay,
lost responses, dropped transactions, reorgs, confirmations, nonce conflicts,
gas/RPC guards, signed-state validation, failed persistence, reverted receipts,
concurrency, locks and CLI health checks. Mainnet constructor rejection includes
Tijori and its factory. Agent tests cover the ladder-to-payment workflow against
the real local market, retained shares/interest, scoped permissions, billing
windows, durable payment IDs, restart/replay and lost responses, reverts, nonce
conflicts, gas/cancellation guards, corrupt journals, key rotation, reorg halts,
strict SDK calls and an actual stdio handshake. A clean production-only install
also passed that handshake without Hardhat or solc.
All 20 agent tests passed again after the final status and cancellation changes.
As of 2026-10-06, after adding the web app/backend and its tests, the full suite
is **144/148 passing**. The 4 failures are pre-existing mismatches between
`test/uniswap-v4.test.ts`/`test/expiry-keeper.test.ts` and current contract
error names/behavior, unrelated to the backend work above; see AGENT_HANDOFF.md
for the current list.

The required OpenZeppelin source subset is vendored because npm registry access
is unavailable in this development environment; see its provenance and formatting
notes in `vendor/openzeppelin-contracts/README.md`.
The required Uniswap core, one periphery liquidity-math library and Solmate owner
source are also vendored; see `vendor/uniswap-v4-core/README.md` and `SOURCES.json`
for provenance and local hashes. Upstream SPDX headers and license texts are retained.

## Prepare an Arc Testnet deployment

`.env` is prepared with the Arc Testnet RPC and the three demo series durations.
Set `DEPLOYER_PRIVATE_KEY` locally to a dedicated test wallet funded from
[Circle's faucet](https://faucet.circle.com). The key is intentionally blank;
no private key has been generated or imported. `.env` is excluded from Git and
has owner-only read/write permissions.

Leave `TESTNET_VAULT_ADDRESS` blank to deploy DemoVault, or supply an existing
testnet ERC-4626 USDC vault. Then run:

```sh
npm run deploy:testnet
```

By default this deploys DemoVault, SeriesRegistry, TestnetPoolManager,
UniswapV4Market, PakkaRouter, TijoriFactory (with its Tijori implementation),
PoolSeeder and one-hour, one-day and seven-day series, and
registers each series under the deployer-owned registry.
It records addresses, series IDs and transaction hashes in
`deployments/arc-testnet.json` after each deployment/registration step. Existing
manifests are not overwritten. Pool keys and liquidity are prepared by the separate
seeding command. It validates chain ID
before sending transactions. Nothing has been deployed by creating these files.

To prepare markets, fund the owner wallet with enough faucet USDC for both the
vault splits and liquidity. Then run:

```sh
npm run seed:testnet
```

This command sends testnet transactions. Defaults are `PT_PRICE_USDC=0.99`,
`POOL_SEED_USDC=10` and `POOL_SEED_PT=10` **per series**. These are demo budgets
and an initialization price, not a promised return. It uses fee 500 (0.05%) and
tick spacing 10; a range around the current tick concentrates the small demo
liquidity. Larger trades can have substantial price impact or fail.

The seed helper reuses owned PT or splits USDC to create inventory; the resulting
YT stays with the owner. It registers the key, initializes an empty pool, computes
liquidity and adds it within both budgets. It records position details and transaction
hashes, clears seeder allowances after success, skips completed pools, and skips
expired series. An unresolved broadcast liquidity transaction stops automatic
replay; inspect its receipt before retrying. Withdraw liquidity through PoolSeeder
using the recorded range, liquidity, minimum outputs and a fresh deadline.

Approve USDC to a YieldToken, then call `splitFromAssets(assets, yourAddress)`.
Donate faucet USDC directly to DemoVault to simulate yield, call
`claimInterest(yourAddress, true)`, settle at expiry, and call
`redeemPT(amount, yourAddress, true)`. USDC amounts use 6 decimals; share amounts
use the vault's decimals. Split issues both PT and YT to the chosen receiver.

Official Arc references: [testnet connection settings](https://docs.arc.io/arc/references/connect-to-arc)
and [USDC ERC-20 address/decimals](https://docs.arc.io/arc/references/contract-addresses).
All contract funds move through ERC-20 calls; entrypoints are nonpayable.

## Current Arc Testnet deployment

Deployed 2026-10-06 at block 65779740 (chain `5042002`). This is a convenience
copy for reference only — `deployments/arc-testnet.json` is the source of truth
every script and the backend actually read from; update this table by hand if
you redeploy, or just rely on the manifest.

| Contract | Address |
| --- | --- |
| DemoVault | `0xCFf24F7dB2583873e94B24e69a09B60552d13e27` |
| SeriesRegistry | `0xdd63C87DC097eB74c15EDf43aBD8fC7Ed953E722` |
| TestnetPoolManager (self-hosted) | `0x6F73287700f87203164e9CC408F72A5927475ac1` |
| UniswapV4Market | `0x96159cfbF6736d846e257F786Ce083A8830FA72A` |
| PakkaRouter | `0x577459924735400E06024fFF3D45771399D96ecc` |
| TijoriFactory | `0x66ecf82b8e0e270070641d5A02de2cDC878B38dc` |
| Tijori implementation (clone template, never deposit here) | `0xd5Ad0f8aB0c2319A78623C0265DE15B6cEb6b6F3` |
| PoolSeeder | `0xCc836C3b3C4c06C4782Bb8D7e97b6626D7CF5EED` |

| Series (expiry, duration) | YieldToken | PrincipalToken |
| --- | --- | --- |
| 1 hour | `0x77eBD5Efe9395244108a7577d7Bfd7d1cE8E4F43` | `0xd9f3Cc8c78510D3F42FF8C6faFB2c61b8e82A846` |
| 1 day | `0x78F5607c8f63d8771F89a0cD93ab3aD3dF6162f3` | `0x18090E5f1A2Dd02d3cC8679D8Cd5cD5Aefd78e77` |
| 7 days | `0x7F2713D55F0c5Af7F90325B9558345aae43Bf253` | `0xbE01918AA75BdF03357c0bae836f9559af0dA3F0` |

Deployer: `0x6b3a924379B9408D8110f10F084ca809863B378A`. Protocol owner (SeriesRegistry/PoolSeeder admin,
separate from the deployer as required): `0xaBF3bA5894004Ae655bFe9E9Bd6899610351Cf67`.

**Status: `owner-registration-required`.** The three series above exist on-chain
but are not yet registered in `SeriesRegistry` — `/api/rates`, quotes and the
frontend will show nothing until the owner wallet runs `npm run register:testnet`
(needs `OWNER_PRIVATE_KEY` for the owner address above, funded for gas), then
`npm run seed:testnet` to attach pool keys and add demo liquidity.

## Agent/MCP treasury service

`agent/mcp-server.ts` exposes eight tools through the official MCP SDK over
stdio. It binds one deployed Tijori and uses a separate agent key; it adds no
contracts. The production entrypoint accepts only Arc Testnet `5042002`.
Local integration tests use `31337`; there is no mainnet override.

| Tool | Behavior |
| --- | --- |
| `treasuryStatus` | USDC balance, PT/YT positions, retained vault shares, maturity/index status, pause state, daily allowance and limits for supplied payees. |
| `quotePT` | Fee-inclusive exact-output market quote for a future, registered, discounted PT. |
| `planTreasury` | Quotes and saves a bounded ladder; sends no transaction. |
| `executePlan` | Executes a saved, unexpired plan through Tijori; PT and refunds stay there. |
| `cashOut` | Redeems matured PT into Tijori, in USDC or explicitly requested vault shares. |
| `claimInterest` | Claims accrued YT interest into Tijori with a minimum-output bound. |
| `pay` | Pays an owner-approved payee within on-chain payee and daily limits. |
| `transactionStatus` | Reads receipt, confirmation and nonce status; never broadcasts. |

There are no agent tools for withdrawals, owner policy changes, arbitrary calls,
early sales or receiver overrides. Before signing and broadcasting, the service
checks the actual chain, authorized agent, pause state and gas bounds. Deployment
relationships are checked against the manifest and factory. Reads work without a
key and while paused. Errors return controlled codes without raw RPC errors,
URLs, private keys or signed bytes. This is a tool server; an MCP client supplies
the conversational agent. It does not run a model or autonomous bill scheduler.

### Configure and connect

First deploy and seed the testnet contracts. Using the owner's wallet, call
`TijoriFactory.create(agentAddress, dailyCap)`, approve/deposit USDC, and set each
approved payee's cap. If the owner already has a clone, use it and `setAgent`
instead of creating another. Set these values locally:

```dotenv
ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.io
AGENT_TIJORI_ADDRESS=YOUR_OWNER_CREATED_TIJORI
AGENT_PRIVATE_KEY=YOUR_SEPARATE_AGENT_KEY
AGENT_STATE_FILE=runtime/agent-state.json
AGENT_SLIPPAGE_BPS=100
AGENT_PLAN_TTL_SECONDS=300
AGENT_CONFIRMATIONS=2
AGENT_MAX_GAS_PRICE_GWEI=250
AGENT_GAS_LIMIT_CAP=1500000
```

The key must match `Tijori.agent()` and differ from both treasury and registry
owners. Fund it separately for testnet gas. Blank `AGENT_PRIVATE_KEY` enables
read-only use. Existing `.env` values were preserved and missing settings added;
no key or treasury address was generated. For a separate agent host, use an
owner-readable `.env.agent` containing only these agent/RPC settings; keep owner,
deployer and keeper keys on their respective hosts.

`npm run agent:mcp` starts the process for terminal use. An MCP client should
launch **Node directly**, since npm writes additional text to stdout:

```json
{
  "mcpServers": {
    "pakka-testnet": {
      "command": "node",
      "args": [
        "--env-file=/Users/macavenue/Desktop/arc/.env.agent",
        "/Users/macavenue/Desktop/arc/agent/mcp-server.ts"
      ]
    }
  }
}
```

Adapt the paths and client configuration format to your machine. Configuration,
manifest and RPC access are lazy: initialize and list-tools work before any
deployment. Business calls return `AGENT_TIJORI_NOT_CONFIGURED` or
`TESTNET_DEPLOYMENT_MISSING` until configured. Runtime/artifact paths resolve from
the project directory, regardless of the client's working directory. Run
`npm run compile` after installing dependencies and before configured use.

This is a local subprocess connection, with protocol messages only on stdout.
There is no public HTTP endpoint or remote connector hosting in this phase.
The pinned SDK negotiates its supported MCP versions, including `2025-11-25`;
see the official [lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle),
[tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) and
[stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) specifications.

### Plan, execute and pay

Amounts are decimal strings with at most six decimal places; raw token outputs
are integer strings. Floating point and scientific notation are rejected.
A plan's payout is PT face value, rather than guaranteed USDC redemption after
vault losses. The planner requires a discounted quote, caps each buy at face
value, and fits the aggregate budget inside the current treasury balance.

```json
{"payoutUsdc":"50","periods":3,"seriesIds":[1,2,3]}
```

Pass that to `planTreasury`, then its `planId` to `executePlan` with a unique
`operationId`, such as `ladder-2026-demo-001`. Plans expire after 300 seconds by
default, or before the earliest maturity if sooner. Execution uses the saved
per-leg/total caps and deadline; changing prices can cause an atomic revert.

Without `seriesIds`, planning uses fixed 30-day intervals. `firstDueTimestamp`
and `intervalSeconds` can choose another billing schedule. Each chosen series
must mature inside its billing window and no later than the due date; missing
windows fail with `NO_SERIES_FOR_BILLING_WINDOW`. These are fixed seconds, not
calendar-month arithmetic. Explicit IDs must match `periods`, have increasing
maturities and cannot be combined with date/interval inputs. The default
one-hour, one-day and seven-day demo series do **not** supply three monthly
maturities; use explicit IDs for that demo or deploy suitable maturities.
Tiny default seeding budgets may not support a 50-USDC trade; adjust demo
trade size or liquidity according to the returned quote.

At maturity, call `cashOut` with `seriesId`, `ptAmount` and `operationId`. Output
defaults to USDC. An illiquid vault fails; request `toAssets:false` explicitly to
retain shares in Tijori. Then `pay` with `payee`, `amountUsdc` and the bill's own
`operationId`. It can use only approved payees and available USDC within caps.
`claimInterest` similarly retains outputs in Tijori. Optional `minOutputRaw` uses
the output token's decimals and cannot weaken the configured slippage minimum.

### Retry and recovery rules

Use one unique `operationId` (8–64 letters, digits, underscores or hyphens) per
intended action. **Reuse that same ID and arguments after a timeout or restart.**
A changed request with the same ID fails with `OPERATION_ID_CONFLICT`. A new ID
represents a new payment; this service cannot recognize that two differently
named operations represent the same real-world bill.

Before broadcasting, the service atomically writes the exact signed transaction,
hash, nonce and intent fingerprint to an owner-readable journal. A retry reuses
those bytes and checks receipts; it never signs another nonce for that ID.
`prepared` means journaled with an uncertain broadcast; `pending` means awaiting
the configured confirmation depth; `confirmed` and `reverted` are terminal. A
reverted action requires a deliberately new ID for a new attempt. Conflicting
nonce use or lost canonical receipts block further writes for manual review.
There are no automatic fee bumps or replacement transactions.

Only one pending action is allowed. Other wallet activity can block signing with
`WALLET_HAS_UNKNOWN_PENDING_TRANSACTION`; dedicate the agent wallet to this
process. Pause or replace the key from the owner wallet to revoke its access.
Old signed actions remain in history; rotation cannot automatically replay an
unbroadcast old-agent action. Owner permissions still decide whether an already
broadcast transaction succeeds on chain.

Preserve and back up `AGENT_STATE_FILE`, its parent directory and the deployed
Tijori context across restarts. Deleting history loses off-chain idempotency;
on-chain `pay` does not store operation IDs. Signed journal bytes can be relayed,
so treat runtime files as private. Do not lower gas limits below those in existing
journaled transactions without reviewing the state. Recent receipts are checked
again before new writes; arbitrarily deep reorgs are outside this testnet model.

The service uses a single-host PID lock and serial requests. Run one instance per
dedicated agent wallet and journal. Registry scans are capped at 1,000 entries,
saved live plans at 128 and ladder legs at 12. Payment history remains in JSON;
an indexed store would be appropriate if this grows beyond testnet scale.

## Web app and API

`backend/server.ts` serves a small **read-only** HTTP API plus the static
frontend in `frontend/`. It never signs or broadcasts a transaction; every write
(lock, ladder, cash-out, pay, approvals) is signed by the connected browser
wallet directly against the contracts via `frontend/wallet.mjs`, including an
EIP-5792 batched-call path with a two-transaction approve/act/revoke fallback.

```sh
npm run dev   # http://127.0.0.1:4173, reading deployments/arc-testnet.json
```

| Route | Returns |
| --- | --- |
| `GET /api/deployment` | Public contract addresses and registered series from the manifest. Never includes keys or RPC URLs. |
| `GET /api/abis` | ABIs for the contracts the frontend talks to. |
| `GET /api/rates` | Per-series state (TVL, cap, pool/entry status, a PT quote) plus an observed variable rate — see below. |
| `GET /api/quote?seriesId&ptAmount` | A live PT buy quote, cross-checked against the Uniswap v4 quoter when configured. |
| `GET /api/positions?account` | PT/YT balances, accrued interest and redeemable vault shares for an address. |
| `GET /api/treasury?owner&payee` | A Tijori's address, agent, pause state, balance and positions. |
| `GET /api/activity?account&tijori&fromBlock` | Decoded router/Tijori events, deduplicated and scoped to the requested addresses. |
| `GET /api/agent-config?tijori` | A ready-to-edit MCP client config stub for that treasury (never a real private key). |

The server only answers `GET`, rejects any `Host`/`Origin` other than
`127.0.0.1`/`localhost`, and always binds to loopback — it has no public-interface
mode. To put it behind your own TLS-terminating reverse proxy on a real domain
(the grant submission needs a URL reviewers can open), set:

```dotenv
API_ALLOWED_HOSTS=pakka.example.com
API_ALLOWED_ORIGINS=https://pakka.example.com
```

These extend the allowlist additively (`localhost` keeps working) and are
validated strictly (plain hostnames, `https://` origins with no path/query/userinfo).
The process itself still only listens on `127.0.0.1:${API_PORT:-4173)}`; the proxy
is what actually faces the internet.

**Variable rate.** `/api/rates` reports each series' vault as an **observed,
trailing 24-hour rate**: it samples `convertToAssets` at two real blocks and
annualizes the change (`backend/variable-rate.ts`). This is not Morpho's own
rate model, not fetched from any Morpho API, and can be **negative** after a
vault loss — it says only what that specific vault actually did over the last
day. A series reports `null`/`INSUFFICIENT_HISTORY` until the chain and the
vault are old enough to sample a full window.

**Keeper alerts.** `backend/alerts.ts` can push expiry-keeper health alerts to
Discord or Telegram; configure `KEEPER_ALERT_WEBHOOK_URL` (a `discord.com`
webhook URL) or `KEEPER_TELEGRAM_BOT_TOKEN`/`KEEPER_TELEGRAM_CHAT_ID`. Delivery
is cooldown-limited and never includes the webhook/token in its persisted state.

## Security tooling

`npm run security` runs `forge test`, `forge coverage` (≥95% per core contract),
`slither` and `aderyn`, and blocks on any high/medium finding. It requires all
three tools on `PATH` and a verified real vault to fork from
(`FORK_RPC_URL` + `FORK_VAULT_ADDRESS`) — intentionally: a clean run against mock
vaults only would be a false signal. `npm run security:status` reports what's
missing without running anything.

Install the tools locally (already done on this machine, at `/Users/macavenue/.foundry/bin`,
`~/.cargo/bin` and the gitignored `.tools/security` venv — added to `~/.zshenv`):

```sh
curl -L https://foundry.paradigm.xyz | bash && foundryup          # forge, cast, anvil
python3 -m venv .tools/security && .tools/security/bin/pip install slither-analyzer
curl -L https://raw.githubusercontent.com/Cyfrin/up/main/install | bash && cyfrinup  # aderyn
```

Picking and verifying the real Arc USDC vault to fork from (Gauntlet/Steakhouse
curated Morpho vault, per the ecosystem check in `docs.html`) is still an open,
human decision — this does not run itself.

## Next phases from the image

Testnet deployment, continuous keeper hosting on a real host, picking/verifying
a real Arc vault to fork for the security run above, and live integrated
verification remain. Tijori, its factory, the expiry keeper, local MCP tools and
the web app (backend + frontend) are implemented; no public-chain deployment,
hosted worker or remote MCP endpoint has been created, and the web app has not
yet been run against a live `deployments/arc-testnet.json`.
No live Morpho or official Arc Testnet Uniswap addresses are assumed. Before a
mainnet migration, use pinned official dependencies, resolve exact maturity
settlement, validate the chosen vault and market infrastructure on a fork, and
review the contracts.

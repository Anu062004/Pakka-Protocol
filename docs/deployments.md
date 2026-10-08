# Deployments

`deployments/arc-testnet.json` is the source of truth. Every script and the
backend read addresses from it. This file is a convenience copy; regenerate or
edit it by hand after a redeploy.

## Arc Testnet (`5042002`)

Deployed at block 65779740. USDC is the canonical Arc Testnet token at
`0x3600000000000000000000000000000000000000`.

| Contract | Address |
| --- | --- |
| SeriesRegistry | `0xdd63C87DC097eB74c15EDf43aBD8fC7Ed953E722` |
| UniswapV4Market | `0x96159cfbF6736d846e257F786Ce083A8830FA72A` |
| PakkaRouter | `0x577459924735400E06024fFF3D45771399D96ecc` |
| TijoriFactory | `0x66ecf82b8e0e270070641d5A02de2cDC878B38dc` |
| PoolSeeder | `0xCc836C3b3C4c06C4782Bb8D7e97b6626D7CF5EED` |
| TestnetPoolManager | `0x6F73287700f87203164e9CC408F72A5927475ac1` |
| DemoVault | `0xCFf24F7dB2583873e94B24e69a09B60552d13e27` |
| Tijori implementation | `0xd5Ad0f8aB0c2319A78623C0265DE15B6cEb6b6F3` |

The Tijori implementation is a clone template. It holds no funds and must never
be deposited into directly; use `TijoriFactory` to create an owned clone.

`TestnetPoolManager` and `DemoVault` are testnet-only infrastructure. The vault
is an ERC-4626 wrapper over faucet USDC whose yield is simulated by direct
donation — it does not lend anywhere.

### Series

Each series is a `(YieldToken, PrincipalToken)` pair for one maturity. Series
IDs are assigned by `SeriesRegistry` at registration, so they are not stable
across deployments.

| ID | Maturity (UTC) | YieldToken | PrincipalToken |
| --- | --- | --- | --- |
| 1 | 2026-10-07 10:19:08 | `0x78F5607c8f63d8771F89a0cD93ab3aD3dF6162f3` | `0x18090E5f1A2Dd02d3cC8679D8Cd5cD5Aefd78e77` |
| 2 | 2026-10-13 10:19:14 | `0x7F2713D55F0c5Af7F90325B9558345aae43Bf253` | `0xbE01918AA75BdF03357c0bae836f9559af0dA3F0` |
| 3 | 2026-10-08 06:24:37 | `0xaa6D242e9f850aa2E85F495f2B2baC416E3F5D35` | `0xbADA196Ae8EE5E9A73059c0a35c96a9ba16bE8f4` |

All three are registered with pool keys attached and seeded with demo liquidity.

One earlier series (`0x77eBD5Efe9395244108a7577d7Bfd7d1cE8E4F43`) expired before
registration. `registerSeries` reverts with `ExpiredSeries` past maturity, so it
is permanently unregistered and is skipped by the registration and seeding
scripts.

### Liquidity limits

Demo pools are intentionally small, and `UniswapV4Market` refuses to push PT
above par. A purchase large enough to move the pool price to 1.00 reverts with
`IncompleteFill` even while PT inventory remains, so order sizes are bounded by
how far the current price sits below par rather than by the pool balance. Seed
further below par, or add liquidity, to widen that range.

`YieldToken.SERIES_TVL_CAP` additionally caps each series at 500 USDC of entry
TVL. It is a compile-time constant.

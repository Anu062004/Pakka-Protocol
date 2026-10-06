# Uniswap v4 core source snapshot

The dependency subset needed by PoolManager and StateLibrary was retrieved from
the official `Uniswap/v4-core` repository's `main` branch on 2026-10-04 via the
browser tool. npm downloads and shell network access were unavailable. This is
a frozen source snapshot, not a claimed release/commit or a claim of matching
the runtime bytecode of any existing deployment. `SOURCES.json` records origin
URLs and SHA-256 hashes of the local files. Browser line markers were removed;
blank-line formatting may differ from the original. No protocol logic was
intentionally changed.

Sources: https://github.com/Uniswap/v4-core

PoolManager's Solmate dependency (`Owned.sol`) is in `../solmate`, fetched from
the official Solmate repository: https://github.com/transmissions11/solmate

Per-file SPDX headers are retained. The Uniswap BUSL and MIT license texts are
in `licenses/`. Solmate Owned.sol is MIT. This snapshot is used for local tests
and a self-hosted testnet demo; it is not labeled an official Uniswap deployment.
Use a pinned official distribution and validate compatibility for any later
production migration. Do not update these files opportunistically without
rerunning the integration and accounting tests.

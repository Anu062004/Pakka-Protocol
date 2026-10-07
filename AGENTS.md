# Connect your agent to Pakka

Pakka exposes its treasury as an **MCP server**, so any agent that speaks MCP —
Claude Desktop, Hermes, OpenClaw, or something you wrote yourself — can use it
without a custom integration.

Your agent never holds your money. It gets a key that can only do what your
treasury contract allows, and you can revoke it at any time.

---

## How the safety model works

Read this first; it explains why the setup has the steps it has.

A **Tijori** is a treasury contract you own. You deposit USDC into it and
authorize one agent address. The contract — not the agent, and not this
software — decides what that agent can do.

| Your agent can | Your agent cannot |
| --- | --- |
| Buy principal tokens for registered maturities | Send funds to any address it chooses |
| Redeem matured positions back into your treasury | Change its own spending limits |
| Claim earned interest into your treasury | Withdraw to itself or to you |
| Pay payees **you** approved, within your caps | Add a new payee |
| | Act at all once you pause it |

So the agent key is a **limited permission**, not ownership. If it leaks, the
worst case is bounded by the caps you set, and you can pause the agent on-chain
immediately.

---

## Setup from a terminal

If you would rather not use a browser, one command does steps 1–2 below:

```sh
OWNER_PRIVATE_KEY=0xYourOwnerKey npm run agent:setup -- init --daily 5
```

It generates the agent wallet, creates a treasury you own, authorizes the agent
on-chain, and writes the key to `runtime/agent-wallet.json` with mode `600`. The
key is written to a file rather than printed, so it does not end up in your
shell history or scrollback.

```sh
npm run agent:setup -- status --tijori 0xYourTreasury   # agent, caps, balance
npm run agent:setup -- rotate --tijori 0xYourTreasury   # new key, old one dead
```

**Holding real value?** Do not put the owner key in an environment variable. Use
`--unsigned` to generate the agent wallet and print the transaction, then sign it
from a hardware wallet or multisig:

```sh
npm run agent:setup -- init --daily 5 --unsigned
```

Then deposit USDC (the app's **Add funds**, or a direct `deposit` call) and skip
to step 3.

## Step 1 — Create your treasury

1. Open the app and go to **Tijori**.
2. Connect the wallet you want to *own* the treasury.
3. Enter a daily payment limit and select **Create Tijori**.
4. Add funds with **Deposit USDC**.

You now have a treasury address. Everything below is scoped to it.

## Step 2 — Register your agent and get its wallet

Still on the **Tijori** page, select **Connect your AI agent**.

This generates a fresh keypair **in your browser**. The private key is never
sent anywhere — not to a server, not into storage. You will see it exactly once.

- **Copy the private key now** and keep it somewhere safe. Closing the panel
  loses it, and you would have to generate a new one.
- The matching public address is authorized on-chain as your agent.

If you ever need to revoke it, use **Replace agent** or **Pause agent** on that
same page. Replacing the key makes the old one useless immediately.

## Step 3 — Configure the connection

Pick the option that matches your agent.

### Option A — Claude Desktop (runs the server for you)

Claude Desktop launches the server as a local process. Use the config shown in
the app under **Claude Desktop MCP configuration**, and paste your agent key
into it where indicated:

```json
{
  "mcpServers": {
    "pakka": {
      "command": "node",
      "args": ["/absolute/path/to/pakka/agent/mcp-server.ts"],
      "env": {
        "AGENT_TIJORI_ADDRESS": "0xYourTreasuryAddress",
        "AGENT_PRIVATE_KEY": "0xYourAgentPrivateKey"
      }
    }
  }
}
```

Restart Claude Desktop. The Pakka tools appear automatically.

### Option B — Any other agent (Hermes, OpenClaw, your own)

Agents that connect over the network need an endpoint rather than a subprocess.
Run the gateway yourself:

```sh
AGENT_TIJORI_ADDRESS=0xYourTreasuryAddress \
AGENT_PRIVATE_KEY=0xYourAgentPrivateKey \
AGENT_HTTP_TOKEN=$(openssl rand -hex 24) \
npm run agent:http
```

It prints:

```
Pakka agent MCP endpoint: http://127.0.0.1:4174/mcp
```

Point your agent at that URL with the token as a bearer header. Most MCP clients
take this shape:

```json
{
  "mcpServers": {
    "pakka": {
      "url": "http://127.0.0.1:4174/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN_HERE" }
    }
  }
}
```

Keep these two values in mind:

| Setting | Default | Meaning |
| --- | --- | --- |
| `AGENT_HTTP_PORT` | `4174` | Port to listen on. |
| `AGENT_HTTP_HOST` | `127.0.0.1` | Loopback only. Change this only if you understand the consequence below. |

**The endpoint signs transactions.** Anyone who can reach it *and* holds the
token has your agent's permissions. It listens on loopback so that, by default,
only programs on your own machine can use it. If you expose it to a network, put
it behind TLS and treat the token like a password. Do not hand your agent key to
a third party to run this for you — running it yourself is the point.

## Step 4 — Check that it works

Ask your agent for the treasury status. A healthy connection returns your
balance, positions, pause state and limits.

Good first requests:

- *"What's in my Pakka treasury?"*
- *"Quote 10 USDC of principal for series 2."*
- *"Plan a 3-month ladder paying 50 USDC per month."*

A plan is just a plan — nothing is sent until you tell the agent to execute it.

---

## What your agent can call

| Tool | Sends a transaction? | Purpose |
| --- | --- | --- |
| `treasuryStatus` | No | Balance, positions, pause state, payee limits. |
| `quotePT` | No | Price a maturity. A quote does not reserve that price. |
| `planTreasury` | No | Build a ladder across maturities and save it. |
| `executePlan` | **Yes** | Submit a saved, unexpired plan. |
| `cashOut` | **Yes** | Redeem matured principal into the treasury. |
| `claimInterest` | **Yes** | Claim earned interest into the treasury. |
| `pay` | **Yes** | Pay an approved payee within your caps. |
| `transactionStatus` | No | Check a submitted operation without resending. |

Every transaction is written to a journal *before* it is broadcast and is keyed
by an operation ID. If a response is lost, retrying with the same ID resumes the
original transaction rather than sending a second one — so a timeout cannot
cause a double payment.

## Tuning limits

Set these where you run the server:

| Variable | Default | Effect |
| --- | --- | --- |
| `AGENT_SLIPPAGE_BPS` | `50` | Maximum price movement tolerated, in basis points. |
| `AGENT_CONFIRMATIONS` | `2` | Confirmations required before the next write proceeds. |
| `AGENT_PLAN_TTL_SECONDS` | `300` | How long a saved plan stays executable. |
| `AGENT_MAX_GAS_PRICE_GWEI` | `250` | Refuse to sign above this gas price. |
| `AGENT_GAS_LIMIT_CAP` | `1500000` | Per-transaction gas ceiling. |

These bound the agent process. Your on-chain caps bound it regardless of what
the process is configured to do.

## If something goes wrong

| Message | Meaning |
| --- | --- |
| `UNAUTHORIZED` | Wrong or missing bearer token. |
| `AGENT_TIJORI_NOT_CONFIGURED` | `AGENT_TIJORI_ADDRESS` is not set. |
| `AGENT_DEPLOYMENT_MISMATCH` | The address is not a treasury from this deployment. |
| `AGENT_SIGNER_REQUIRED` | No `AGENT_PRIVATE_KEY`, so write tools are unavailable. |
| `AGENT_KEY_NOT_AUTHORIZED` | This key is not the treasury's current agent. Re-register it. |
| `AGENT_PAUSED` | You paused the agent. Unpause it in the app. |
| `UNSUPPORTED_CHAIN` | The configured RPC is not Arc Testnet. |

Errors are returned as codes on purpose. The server never echoes RPC URLs, key
material or raw signed transactions back to an agent.

---

Testnet software, funded only from a faucet. Never point this at a wallet that
holds real money.

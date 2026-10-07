# Connect your agent to Pakka

Give your AI agent a budget it can spend on fixed-rate USDC positions, without
giving it your wallet.

Works with anything that speaks MCP — Claude Desktop, Hermes, OpenClaw, or your
own code.

---

## What you are setting up

Three separate things. Keeping them straight makes the rest obvious.

| | What it is | Holds |
| --- | --- | --- |
| **Your wallet** | The MetaMask you already have | Your real money |
| **Your Tijori** | A treasury contract you own | The USDC your agent may use |
| **Agent wallet** | A throwaway key you create in step 2 | Only gas — never your funds |

Your agent gets the third one. It is a **permission**, not ownership. The
treasury contract enforces the limits, so even a leaked agent key cannot drain
you, and you can pause it instantly.

---

# Part 1 — Create your treasury

Pick **A** if you use MetaMask. Pick **B** if you live in a terminal.

## A. In the browser (recommended)

1. Open the app and select **Tijori**.
2. Select **Connect wallet** and approve in MetaMask. Use Arc Testnet.
3. Under **Create your Tijori**, select **Generate agent wallet**.
   - This creates a keypair *in your browser*. It is never sent to any server.
   - The private key appears once. Select **Copy** and save it somewhere safe.
   - The agent address fills in automatically.
4. Set a **daily payment limit** (start at 5 USDC).
5. Select **Create Tijori** and confirm in MetaMask.
6. Select **Add funds** and deposit USDC into the treasury.

You now have a treasury address and an agent key. Keep both.

## B. In the terminal

```sh
OWNER_PRIVATE_KEY=0xYourOwnerKey npm run agent:setup -- init --daily 5
```

Generates the agent wallet, creates the treasury, authorizes the agent, and
writes the key to `runtime/agent-wallet.json` with mode `600`. It prints the
treasury and agent addresses; the key stays in the file so it never reaches your
shell history.

**Holding real value?** Don't put your owner key in an environment variable:

```sh
npm run agent:setup -- init --daily 5 --unsigned
```

This generates the agent wallet and prints the transaction for you to sign from
a hardware wallet or multisig.

Useful afterwards:

```sh
npm run agent:setup -- status --tijori 0xYourTreasury   # agent, caps, balance
npm run agent:setup -- rotate --tijori 0xYourTreasury   # new key, old one dead
```

---

# Part 2 — Fund the agent's gas

**Do not skip this.** Your agent submits its own transactions, so it pays its
own gas. With an empty agent wallet, every write fails.

Send a small amount of gas to the **agent address** (not the treasury). On Arc,
gas is USDC. About 1 USDC is plenty for testing.

Check it worked:

```sh
npm run agent:setup -- status --tijori 0xYourTreasury
```

---

# Part 3 — Connect your agent

## Claude Desktop

Copy [`examples/claude-desktop.json`](examples/claude-desktop.json) into your
Claude Desktop config and replace the three `REPLACE_` values:

| Replace | With |
| --- | --- |
| the path in `args` | absolute path to `agent/mcp-server.ts` |
| `AGENT_TIJORI_ADDRESS` | your treasury address |
| `AGENT_PRIVATE_KEY` | your agent private key |

The config file lives at:

- **macOS** — `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows** — `%APPDATA%\Claude\claude_desktop_config.json`

Restart Claude Desktop. The Pakka tools appear automatically.

## Hermes, OpenClaw, or your own agent

These connect over the network, so run the endpoint yourself:

```sh
AGENT_TIJORI_ADDRESS=0xYourTreasury \
AGENT_PRIVATE_KEY=0xYourAgentKey \
AGENT_HTTP_TOKEN=$(openssl rand -hex 24) \
npm run agent:http
```

It prints the token and the URL:

```
Pakka agent MCP endpoint: http://127.0.0.1:4174/mcp
```

Then use [`examples/mcp-http.json`](examples/mcp-http.json), replacing the token.

| Setting | Default | Meaning |
| --- | --- | --- |
| `AGENT_HTTP_PORT` | `4174` | Port to listen on |
| `AGENT_HTTP_HOST` | `127.0.0.1` | Loopback only — see the warning below |

**This endpoint signs transactions.** Anyone who can reach it *and* has the token
has your agent's permissions. It binds to loopback so only programs on your own
machine can use it. Expose it to a network only behind TLS, and treat the token
like a password. Do not hand your agent key to someone else to run this for you.

## ChatGPT

ChatGPT cannot reach `127.0.0.1` — its servers run remotely, so a local endpoint
is invisible to it. You would need to host the endpoint on a public HTTPS URL and
add it as a connector. That means a machine you control, with TLS, exposing a
signing endpoint to the internet. **Not recommended for a key with real value.**
Claude Desktop or a local agent is the safer path today.

## Brief your agent

Once connected, give your agent [`examples/agent-brief.md`](examples/agent-brief.md)
— paste it into the chat or add it as project context. It explains what the
treasury is, which tools spend money, how to retry safely, and what the error
codes mean.

---

# Part 4 — Check it works

Ask your agent:

> What's in my Pakka treasury?

A healthy connection returns your balance, remaining daily allowance, pause
state and positions. Then try:

> Quote 1 USDC of principal for series 2.

Quotes and plans never spend anything. Nothing moves until you approve an action
that sends a transaction.

---

## Where the agent wallet comes from

Common question, short answer: **it is an ordinary Ethereum keypair, generated
locally.** Nothing about it is Pakka-specific.

A private key is 32 random bytes. The public key derives from it over the
secp256k1 curve, and the address is the last 20 bytes of the public key's
keccak256 hash. Every wallet works this way.

Three ways to produce one, all equivalent:

| Method | Where the key is generated |
| --- | --- |
| **Generate agent wallet** button | In your browser, via `Wallet.createRandom()` |
| `npm run agent:setup -- init` | On your machine, written to an `0600` file |
| Any wallet tool | e.g. `cast wallet new`, or a fresh MetaMask account |

What makes it *your agent's* wallet is a single on-chain step: your owner wallet
calls `setAgent(address)` on your treasury. That authorizes it. Before that call
it is just an address like any other.

So the key never touches a server — not ours, not anyone's. Which is also why
nobody can recover it for you. If you lose it, generate a new one and rotate:

```sh
npm run agent:setup -- rotate --tijori 0xYourTreasury
```

The old key stops working the moment that lands.

---

## When things go wrong

| Message | Fix |
| --- | --- |
| `UNAUTHORIZED` | Wrong or missing bearer token |
| `AGENT_TIJORI_NOT_CONFIGURED` | `AGENT_TIJORI_ADDRESS` is not set |
| `AGENT_DEPLOYMENT_MISMATCH` | That address is not a treasury from this deployment |
| `AGENT_SIGNER_REQUIRED` | No `AGENT_PRIVATE_KEY`; writes unavailable |
| `AGENT_KEY_NOT_AUTHORIZED` | This key is not the treasury's current agent — rotate |
| `AgentPaused` | You paused the agent. Unpause it in the app |
| `UNSUPPORTED_CHAIN` | The RPC is not Arc Testnet |
| Agent transactions fail instantly | The agent wallet has no gas — see Part 2 |

Errors are returned as codes deliberately. The server never echoes RPC URLs, key
material or signed transactions back to an agent.

---

Testnet software, funded from a faucet. Never point this at a wallet holding
real money.

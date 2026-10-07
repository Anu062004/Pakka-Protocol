import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet, getAddress, parseUnits } from "ethers";
import type { JsonRpcProvider } from "ethers";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AgentError, TreasuryService, fail, projectRoot, type AgentOptions } from "./treasury-service.ts";
import { lockKeeper } from "../scripts/expiry-keeper.ts";
import { loadDeployment } from "../backend/project.ts";
import { rpcProvider } from "../backend/rpc.ts";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine((v) => {
  try { getAddress(v); return true; } catch { return false; }
}, "Invalid address checksum");
const decimal = z.string().regex(/^\d{1,32}(\.\d{1,6})?$/);
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const operationId = z.string().regex(/^[a-zA-Z0-9_-]{8,64}$/);
const output = { toAssets: z.boolean().default(true), minOutputRaw: z.string().regex(/^\d{1,78}$/).optional() };

interface ToolDefinition {
  description: string;
  schema: z.ZodTypeAny;
  readOnly: boolean;
}

export const toolDefinitions: Record<string, ToolDefinition> = {
  treasuryStatus: {
    description: "Read this Tijori's balance, positions, pause state and payment limits. Supply payees to read their caps.",
    schema: z.object({ payees: z.array(address).max(50).default([]) }).strict(), readOnly: true,
  },
  quotePT: {
    description: "Quote a registered future principal token in six-decimal USDC. A quote does not reserve the price.",
    schema: z.object({ seriesId: id, ptAmount: decimal }).strict(), readOnly: true,
  },
  planTreasury: {
    description: "Save a quoted ladder without sending a transaction. payoutUsdc is face value per period. Default periods are fixed 30-day intervals; each maturity must fall before its bill date. Explicit seriesIds support the short testnet demo schedule. Vault solvency and liquidity affect redemption.",
    schema: z.object({ payoutUsdc: decimal, periods: z.number().int().min(1).max(12),
      seriesIds: z.array(id).min(1).max(12).optional(), firstDueTimestamp: id.optional(),
      intervalSeconds: z.number().int().min(60).max(31536000).optional(),
      maxTotalUsdc: decimal.optional(), slippageBps: z.number().int().min(0).max(1000).optional(),
    }).strict().refine((v) => !v.seriesIds || (v.firstDueTimestamp === undefined && v.intervalSeconds === undefined),
      "Use explicit seriesIds or billing intervals, not both"), readOnly: true,
  },
  executePlan: {
    description: "Submit a saved, unexpired ladder through Tijori. All PT and refunds stay in Tijori. Reuse the same operationId after any retry or timeout; never assign a new ID just to retry.",
    schema: z.object({ planId: z.string().regex(/^[a-f0-9]{64}$/), operationId }).strict(), readOnly: false,
  },
  cashOut: {
    description: "Redeem matured PT into this Tijori. Default output is USDC; toAssets=false returns vault shares. minOutputRaw is in output-token units and cannot weaken the configured slippage bound. Reuse operationId for retries.",
    schema: z.object({ seriesId: id, ptAmount: decimal, ...output, operationId }).strict(), readOnly: false,
  },
  claimInterest: {
    description: "Claim accrued YT interest into this Tijori, in USDC or vault shares. minOutputRaw uses the output token's raw units. Reuse operationId for retries.",
    schema: z.object({ seriesId: id, ...output, operationId }).strict(), readOnly: false,
  },
  pay: {
    description: "Pay an owner-approved payee from Tijori within its on-chain payee and daily caps. This sends a transaction. Use a unique operationId for each intended bill, and the same ID for every retry of that bill.",
    schema: z.object({ payee: address, amountUsdc: decimal, operationId }).strict(), readOnly: false,
  },
  transactionStatus: {
    description: "Check a journaled operation's receipt and confirmations without broadcasting. A conflict requires manual review; do not retry payment with a new operationId.",
    schema: z.object({ operationId }).strict(), readOnly: true,
  },
};

export function agentConfig(env: NodeJS.ProcessEnv = process.env): AgentOptions & { stateFile: string } {
  const integer = (name: string, fallback: number): number => {
    const value = env[name] ?? String(fallback);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail("INVALID_AGENT_CONFIG");
    return Number(value);
  };
  let maxGasPrice: bigint;
  try { maxGasPrice = parseUnits(env.AGENT_MAX_GAS_PRICE_GWEI ?? "250", "gwei"); }
  catch { return fail("INVALID_AGENT_CONFIG"); }
  return { confirmations: integer("AGENT_CONFIRMATIONS", 2),
    slippageBps: integer("AGENT_SLIPPAGE_BPS", 50), planTtlSeconds: integer("AGENT_PLAN_TTL_SECONDS", 300),
    maxGasLimit: BigInt(integer("AGENT_GAS_LIMIT_CAP", 1500000)), maxGasPrice,
    stateFile: path.resolve(projectRoot, env.AGENT_STATE_FILE || "runtime/agent-state.json") };
}

export function createServer(getService: () => TreasuryService | Promise<TreasuryService>): McpServer {
  const server = new McpServer({ name: "pakka-testnet-treasury", version: "0.1.0" }, {
    instructions: "Arc Testnet only. One bound Tijori. Plan before executePlan; inspect transactionStatus after writes. Preserve operationId across retries and restarts. This service cannot change owner policy or withdraw funds. Never invent approved payees or treat a quote as guaranteed redemption.",
  });
  for (const [name, definition] of Object.entries(toolDefinitions)) {
    server.registerTool(name, {
      description: definition.description, inputSchema: definition.schema,
      annotations: { readOnlyHint: definition.readOnly, destructiveHint: !definition.readOnly,
        idempotentHint: name !== "planTreasury", openWorldHint: true },
    }, async (input: unknown, extra: { signal?: AbortSignal }) => {
      try {
        const args = definition.schema.parse(input) as Record<string, unknown>;
        const service = await getService();
        const result = await service.invoke(name, args, extra.signal);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
      } catch (error) {
        // Do not return ethers errors, RPC URLs, private keys, or signed transaction bytes.
        const code = error instanceof AgentError ? error.code : "AGENT_TOOL_FAILED";
        const result = { error: code };
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result, isError: true };
      }
    });
  }
  return server;
}

export interface AgentRuntime {
  server: McpServer;
  // The signer, provider and file locks are per process, so transports that need a fresh
  // McpServer per request share this one service rather than constructing their own.
  getService: () => TreasuryService;
  close: () => Promise<void>;
}

// Transport-independent: the key, locks and provider are owned here so stdio and HTTP
// entrypoints share one construction path rather than duplicating the lifecycle.
export function createRuntime(env: NodeJS.ProcessEnv = process.env): AgentRuntime {
  let service: TreasuryService | undefined, provider: JsonRpcProvider | undefined, unlock: (() => void) | undefined, unlockWallet: (() => void) | undefined;
  const getService = (): TreasuryService => {
    if (service) return service;
    const tijoriAddress = env.AGENT_TIJORI_ADDRESS;
    if (!tijoriAddress) return fail("AGENT_TIJORI_NOT_CONFIGURED");
    const manifestFile = path.join(projectRoot, "deployments/arc-testnet.json");
    if (!fs.existsSync(manifestFile)) return fail("TESTNET_DEPLOYMENT_MISSING");
    let manifest;
    try { manifest = loadDeployment(manifestFile); }
    catch { return fail("INVALID_DEPLOYMENT_MANIFEST"); }
    if (manifest.chainId !== 5042002) fail("UNSUPPORTED_CHAIN");
    const config = agentConfig(env);
    let signer: Wallet | null = null;
    if (env.AGENT_PRIVATE_KEY) {
      try { signer = new Wallet(env.AGENT_PRIVATE_KEY); }
      catch { return fail("INVALID_AGENT_KEY"); }
    }
    const candidateProvider = rpcProvider(env);
    let candidateUnlock: (() => void) | undefined, candidateWalletUnlock: (() => void) | undefined;
    try {
      candidateUnlock = lockKeeper(`${config.stateFile}.lock`);
      if (signer) candidateWalletUnlock = lockKeeper(path.join(projectRoot, `runtime/wallet-${signer.address.toLowerCase()}.lock`));
      const candidate = new TreasuryService({ ...config, provider: candidateProvider,
        signer: signer?.connect(candidateProvider), manifest, tijoriAddress });
      provider = candidateProvider; unlock = candidateUnlock; unlockWallet = candidateWalletUnlock; service = candidate;
      return service;
    } catch (error) { candidateWalletUnlock?.(); candidateUnlock?.(); candidateProvider.destroy(); throw error; }
  };
  const server = createServer(getService);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    await server.close();
    await service?.idle;
    provider?.destroy(); unlockWallet?.(); unlock?.(); unlock = undefined;
  })();
  return { server, getService, close };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<McpServer> {
  const { server, close } = createRuntime(env);
  await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 65536 }));
  // No diagnostics on stdout: it is reserved for newline-delimited MCP messages.
  const shutdownFailed = () => { console.error("AGENT_SHUTDOWN_FAILED"); process.exitCode = 1; };
  const stop = () => { void close().then(() => process.exit(0), shutdownFailed); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdin.once("end", () => { void close().catch(shutdownFailed); });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch { console.error("AGENT_STARTUP_FAILED"); process.exitCode = 1; }
}

import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Wallet, getAddress, parseEther, parseUnits } from "ethers";
import { ExpiryKeeper, lockKeeper, type KeeperOptions, type KeeperHealth } from "./expiry-keeper.ts";
import { loadDeployment, projectRoot } from "../backend/project.ts";
import { rpcProvider } from "../backend/rpc.ts";
import { keeperAlerts } from "../backend/alerts.ts";

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) throw new Error(`Invalid ${name}.`);
  return Number(raw);
}

export interface KeeperConfig extends KeeperOptions {
  pollMs: number;
  stateFile: string;
}

export function keeperConfig(env: NodeJS.ProcessEnv = process.env): KeeperConfig {
  const pollSeconds = positiveInteger(env, "KEEPER_POLL_INTERVAL_SECONDS", 10);
  if (pollSeconds > 86400) throw new Error("KEEPER_POLL_INTERVAL_SECONDS must not exceed 86400.");
  let maxGasPrice: bigint, minGasBalance: bigint;
  try {
    maxGasPrice = parseUnits(env.KEEPER_MAX_GAS_PRICE_GWEI ?? "250", "gwei");
    minGasBalance = parseEther(env.KEEPER_MIN_GAS_BALANCE ?? "0.1");
  } catch { throw new Error("Invalid keeper gas settings."); }
  if (maxGasPrice < parseUnits("25", "gwei") || minGasBalance < 0n) throw new Error("Invalid keeper gas settings.");
  return {
    pollMs: pollSeconds * 1000,
    confirmations: positiveInteger(env, "KEEPER_CONFIRMATIONS", 2),
    maxBlockAgeSeconds: positiveInteger(env, "KEEPER_MAX_BLOCK_AGE_SECONDS", 120),
    pendingAlertSeconds: positiveInteger(env, "KEEPER_PENDING_ALERT_SECONDS", 120),
    maxGasLimit: BigInt(positiveInteger(env, "KEEPER_GAS_LIMIT_CAP", 500_000)),
    maxGasPrice, minGasBalance,
    stateFile: path.resolve(env.KEEPER_STATE_FILE || "runtime/keeper-state.json"),
  };
}

export function keeperHealth(config: Pick<KeeperConfig, "stateFile" | "pollMs">, now: number = Date.now()): KeeperHealth & { fresh: boolean } {
  const health = JSON.parse(fs.readFileSync(`${config.stateFile}.health.json`, "utf8")) as KeeperHealth;
  const age = now - Date.parse(health.checkedAt);
  return { ...health, fresh: Number.isFinite(age) && age >= 0 && age <= config.pollMs * 2 + 60_000 };
}

export async function main(args: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (args.some((arg) => !["--once", "--health"].includes(arg)) || args.length > 1) {
    throw new Error("Usage: keeper-testnet.mjs [--once | --health]");
  }
  const config = keeperConfig(env);
  const notify = keeperAlerts(env);
  if (args.includes("--health")) {
    const health = keeperHealth(config);
    console.log(JSON.stringify(health));
    return health.ok && health.fresh && !health.fatal ? 0 : 1;
  }
  const key = env.KEEPER_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Set KEEPER_PRIVATE_KEY locally to a dedicated, funded testnet wallet.");
  let wallet: Wallet;
  try { wallet = new Wallet(key); }
  catch { throw new Error("KEEPER_PRIVATE_KEY is invalid."); }
  const manifestPath = "deployments/arc-testnet.json";
  if (!fs.existsSync(manifestPath)) throw new Error("Deploy on Arc Testnet first: deployments/arc-testnet.json is missing.");
  const manifest = loadDeployment(manifestPath);
  if (manifest.chainId !== 5042002 || manifest.usdc !== "0x3600000000000000000000000000000000000000") {
    throw new Error("Keeper requires an Arc Testnet deployment manifest with canonical USDC.");
  }
  const registryAddress = getAddress(manifest.registry);
  if (manifest.deployer && getAddress(manifest.deployer) === wallet.address) {
    throw new Error("Use a separate keeper wallet, not the deployment/registry-owner wallet.");
  }
  // Avoid ethers' unbounded network-bootstrap retry loop. ExpiryKeeper explicitly
  // fetches eth_chainId each cycle and before sending; signed transactions bind chain 5042002.
  const provider = rpcProvider(env);
  const controller = new AbortController();
  const stop = () => controller.abort();
  let unlock: (() => void) | undefined, unlockWallet: (() => void) | undefined;
  try {
    unlock = lockKeeper(`${config.stateFile}.lock`);
    unlockWallet = lockKeeper(path.join(projectRoot, `runtime/wallet-${wallet.address.toLowerCase()}.lock`));
    const keeper = new ExpiryKeeper({ ...config, provider, signer: wallet.connect(provider), registryAddress,
      log: (record) => console.log(JSON.stringify(record)) });
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    let exitCode = 0;
    do {
      try {
        const health = await keeper.tick();
        const alertResult = await notify(health);
        if (alertResult.error) console.log(JSON.stringify({ event: "alert", code: alertResult.error }));
        exitCode = health.ok && !health.fatal ? 0 : 1;
        if (health.fatal || args.includes("--once")) break;
      } catch (error) {
        // File/transport errors are retried. Signed transactions remain journaled.
        console.log(JSON.stringify({ time: new Date().toISOString(), event: "alert",
          code: "KEEPER_TICK_FAILED", errorCode: (error as { code?: string }).code ?? "UNKNOWN" }));
        exitCode = 1;
        await notify({ ok: false, chainId: 5042002, alerts: [{ code: "KEEPER_TICK_FAILED" }] });
        if (args.includes("--once")) break;
      }
      if (!controller.signal.aborted) {
        try { await sleep(config.pollMs, undefined, { signal: controller.signal }); }
        catch (error) { if ((error as Error).name !== "AbortError") throw error; }
      }
    } while (!controller.signal.aborted);
    return controller.signal.aborted ? 0 : exitCode;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    provider.destroy();
    unlockWallet?.(); unlock?.();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) {
    // Configuration errors above are deliberately generic and contain no secret values.
    const e = error as { code?: string; message?: string };
    console.error(e.code ?? "KEEPER_STARTUP_FAILED");
    if (!e.code) console.error(e.message);
    process.exitCode = 1;
  }
}

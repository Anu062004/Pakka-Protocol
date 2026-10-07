import { FetchRequest, JsonRpcProvider } from "ethers";

interface RpcError {
  code?: string;
  status?: number;
  info?: { responseStatus?: string };
}

const transportFailure = (e: RpcError): boolean =>
  (e.code !== undefined && ["TIMEOUT", "NETWORK_ERROR", "ENOTFOUND", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN"].includes(e.code)) ||
  [429, 502, 503, 504].includes(Number(e.info?.responseStatus?.split?.(" ")[0] ?? e.status));

type Send = (method: string, params: unknown[]) => Promise<unknown>;

export async function sendWithFallback(primary: Send, backup: Send | null | undefined, method: string, params: unknown[], chainId: number): Promise<unknown> {
  try { return await primary(method, params); }
  catch (e) {
    if (!transportFailure(e as RpcError)) throw e; // A contract revert must never be hidden by another RPC.
    const send = backup ?? primary;
    if (BigInt(await send("eth_chainId", []) as string) !== BigInt(chainId)) throw new Error("WRONG_FALLBACK_CHAIN");
    // For eth_sendRawTransaction this is a retry of exactly the same signed bytes/nonce.
    return send(method, params);
  }
}

export function rpcProvider(env: NodeJS.ProcessEnv = process.env, { chainId = 5042002 }: { chainId?: number } = {}): JsonRpcProvider {
  if (![5042002, 31337].includes(chainId)) throw new Error("UNSUPPORTED_CHAIN");
  const make = (url: string) => {
    const request = new FetchRequest(url);
    request.timeout = 10000;
    return new JsonRpcProvider(request, chainId, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 });
  };
  const primary = make(env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.io");
  const backup = env.ARC_TESTNET_RPC_FALLBACK_URL ? make(env.ARC_TESTNET_RPC_FALLBACK_URL) : null;
  const primarySend = primary.send.bind(primary), backupSend = backup?.send.bind(backup);
  primary.send = (method: string, params: unknown[]) => sendWithFallback(primarySend, backupSend, method, params, chainId) as Promise<any>;
  const destroy = primary.destroy.bind(primary);
  primary.destroy = () => { backup?.destroy(); destroy(); };
  return primary;
}

// ethers keeps a block poller running after tx.wait(); destroying the provider rejects any
// request still in flight, with nothing awaiting it. That surfaces as an unhandled rejection
// after the work already succeeded, so a finished script looks like it crashed. Only this
// exact shutdown signature is swallowed.
export function shutdown(provider: { removeAllListeners: () => void; destroy: () => void }): void {
  const ignore = (error: unknown): void => {
    const e = error as { code?: string; operation?: string } | null;
    if (e?.code !== "UNSUPPORTED_OPERATION" || !e.operation) throw error;
  };
  process.on("unhandledRejection", ignore);
  provider.removeAllListeners();
  provider.destroy();
}

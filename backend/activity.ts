import { Interface, getAddress } from "ethers";
import type { Provider } from "ethers";
import { abi } from "./project.ts";
import type { Manifest } from "./types.ts";

const routerEvents = ["Locked", "LadderBuilt", "SoldEarly", "CashedOut", "YieldBought"];
const tijoriEvents = ["Deposited", "Withdrawn", "Paid", "InterestClaimed", "AgentChanged", "PauseChanged", "PayeeCapChanged", "DailyCapChanged"];

export interface LogLike {
  removed?: boolean;
  blockHash: string;
  transactionHash: string;
  blockNumber: number;
  address: string;
  topics: readonly string[];
  data: string;
  index?: number;
  logIndex?: number;
}

export interface ActivityItem {
  id: string;
  event: string;
  address: string;
  fields: Record<string, string>;
  blockNumber: number;
  transactionHash: string;
  logIndex: number | undefined;
}

export function decodeActivity(logs: LogLike[], interfaces: Map<string, Interface>, accounts: (string | undefined)[] = []): ActivityItem[] {
  const seen = new Set<string>(), allowed = new Set(accounts.filter((a): a is string => Boolean(a)).map((a) => getAddress(a)));
  const result: ActivityItem[] = [];
  for (const log of logs) {
    if (log.removed) continue;
    const key = `${log.blockHash}:${log.transactionHash}:${log.index ?? log.logIndex}`;
    if (seen.has(key)) continue; seen.add(key);
    const iface = interfaces.get(getAddress(log.address));
    let parsed;
    try { parsed = iface?.parseLog(log); } catch { continue; }
    if (!parsed) continue;
    const fields = Object.fromEntries(parsed.fragment.inputs.map((input, i) => [input.name, String(parsed.args[i])]));
    if (allowed.size && !allowed.has(getAddress(log.address)) &&
      !Object.values(fields).some((v) => /^0x[\da-fA-F]{40}$/.test(v) && allowed.has(getAddress(v)))) continue;
    result.push({ id: key, event: parsed.name, address: log.address, fields,
      blockNumber: log.blockNumber, transactionHash: log.transactionHash, logIndex: log.index ?? log.logIndex });
  }
  return result.sort((a, b) => b.blockNumber - a.blockNumber || (b.logIndex ?? 0) - (a.logIndex ?? 0));
}

export interface ActivityResult {
  fromBlock: number;
  toBlock: number;
  nextFromBlock: number | null;
  items: ActivityItem[];
}

export async function activity({ provider, manifest, account, tijori, fromBlock }: {
  provider: Provider;
  manifest: Manifest;
  account?: string;
  tijori?: string;
  fromBlock?: number;
}): Promise<ActivityResult> {
  const latest = await provider.getBlockNumber();
  const first = manifest.deployedAtBlock ?? 0;
  const from = fromBlock ?? Math.max(first, latest - 4999);
  if (!Number.isSafeInteger(from) || from < first || from > latest) throw new Error("INVALID_ACTIVITY_CURSOR");
  const to = Math.min(latest, from + 4999);
  const sources = [{ address: manifest.router, iface: new Interface(abi("PakkaRouter")), events: routerEvents }];
  if (tijori) sources.push({ address: getAddress(tijori), iface: new Interface(abi("Tijori")), events: tijoriEvents });
  const logs = (await Promise.all(sources.map((s) => provider.getLogs({ address: s.address, fromBlock: from, toBlock: to,
    topics: [s.events.map((name) => s.iface.getEvent(name)!.topicHash)] })))).flat();
  // Application events only: do not count USDC Transfer/native EIP-7708 logs as another payment.
  return { fromBlock: from, toBlock: to, nextFromBlock: to < latest ? to + 1 : null,
    items: decodeActivity(logs, new Map(sources.map((s) => [getAddress(s.address), s.iface])), [account, tijori].filter(Boolean)) };
}

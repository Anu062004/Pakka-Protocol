import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TreasuryService } from "../../agent/treasury-service.ts";
import { createServer } from "../../agent/mcp-server.ts";
import { ExpiryKeeper } from "../../scripts/expiry-keeper.ts";
import type { System } from "./system.ts";
import { Contract } from "ethers";

const sent = async (tx: Promise<{ wait: () => Promise<unknown> }>) => (await tx).wait();

export interface FullFlowResult {
  steps: string[];
  series: number;
  paymentsUsdc: string;
  realVault: boolean;
}

export async function fullFlow(system: System, { stateDirectory, advance, mine, realVault = false }: {
  stateDirectory: string;
  advance: (timestamp: number) => Promise<void>;
  mine: () => Promise<unknown>;
  realVault?: boolean;
}): Promise<FullFlowResult> {
  const { provider, manifest, priya, agent, keeper, payee, asset, router, registry, tijori, series, vault } = system;
  const service = new TreasuryService({ provider, signer: agent, manifest, tijoriAddress: tijori.target as string,
    chainId: manifest.chainId, confirmations: 1, stateFile: path.join(stateDirectory, "agent.json") });
  const server = createServer(() => service);
  const client = new Client({ name: "pakka-full-flow", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const r = await client.callTool({ name, arguments: args });
    assert.equal(r.isError, undefined, JSON.stringify(r.structuredContent));
    return r.structuredContent;
  };
  try {
    const quote = await service.quotes.quote({ seriesId: 1, ptAmountRaw: 1_000000n });
    await sent((asset.connect(priya) as Contract).approve(router.target, quote.maxUsdc.raw));
    await (router.connect(priya) as Contract).lock.staticCall(1, 1_000000n, quote.maxUsdc.raw, await priya.getAddress(), quote.deadline);
    await sent((router.connect(priya) as Contract).lock(1, 1_000000n, quote.maxUsdc.raw, await priya.getAddress(), quote.deadline));
    assert.equal(await series[0]!.pt.balanceOf(await priya.getAddress()), 1_000000n);
    const plan = await call("planTreasury", { payoutUsdc: "1", periods: 3, seriesIds: [1, 2, 3] });
    const executed = await call("executePlan", { planId: plan.planId, operationId: "e2e-ladder-0001" });
    assert.equal(executed.status, "confirmed");
    for (const s of series) assert.equal(await s.pt.balanceOf(tijori.target), 1_000000n);
    if (!realVault) await sent(vault.addYield(100000n));
    // Protocol pause must not disable either user's or agent's exit/payment path.
    await sent((registry.connect(system.owner) as Contract).setEntriesPaused(true));
    const worker = new ExpiryKeeper({ provider, signer: keeper, registryAddress: registry.target as string, chainId: manifest.chainId,
      confirmations: 1, maxBlockAgeSeconds: 20_000_000, stateFile: path.join(stateDirectory, "keeper.json") });
    for (const [i, s] of series.entries()) {
      await advance(s.expiry + 1); const health = await worker.tick(); assert.equal(health.ok, true, JSON.stringify(health.alerts));
      await mine(); await worker.tick(); assert(await s.yt.indexAtExpiry() as bigint > 0n);
      const redeemed = await call("cashOut", { seriesId: s.seriesId, ptAmount: "1", operationId: `e2e-cashout-${i}000` });
      assert.equal(redeemed.status, "confirmed");
      const paid = await call("pay", { payee: await payee.getAddress(), amountUsdc: "1", operationId: `e2e-payment-${i}000` });
      assert.equal(paid.status, "confirmed");
      if (i === 0) {
        await sent((s.pt.connect(priya) as Contract).approve(router.target, 1_000000n));
        await sent((router.connect(priya) as Contract).cashOut(1, 1_000000n, await priya.getAddress(), true, 990000n, s.expiry + 120));
        assert.equal(await s.pt.balanceOf(await priya.getAddress()), 0n);
      }
    }
    assert.equal(await asset.balanceOf(await payee.getAddress()), 3_000000n);
    for (const s of series) assert.equal(await s.pt.balanceOf(tijori.target), 0n);
    assert.equal(await asset.allowance(tijori.target, router.target), 0n);
    assert.equal(await asset.allowance(router.target, system.market.target), 0n);
    return { steps: ["deploy", "seed", "Priya lock", "MCP ladder", "time advance", "keeper settle", "cash out", "pay"],
      series: series.length, paymentsUsdc: "3", realVault };
  } finally { await client.close(); await server.close(); }
}

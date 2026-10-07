import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { authorized, main, requireToken } from "../agent/http-server.ts";

const token = crypto.randomBytes(24).toString("hex");
let server: Server, url: URL;

before(async () => {
  // No AGENT_PRIVATE_KEY: the endpoint must serve read-only tooling without a signer.
  server = await main({ AGENT_HTTP_TOKEN: token, AGENT_HTTP_PORT: "0",
    AGENT_TIJORI_ADDRESS: "0x000000000000000000000000000000000000dEaD" } as NodeJS.ProcessEnv);
  url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });

const connect = async (bearer: string): Promise<Client> => {
  const client = new Client({ name: "test-agent", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
  return client;
};

test("a short or missing token is refused before the endpoint can start", () => {
  assert.throws(() => requireToken({} as NodeJS.ProcessEnv), /AGENT_HTTP_TOKEN_REQUIRED/);
  assert.throws(() => requireToken({ AGENT_HTTP_TOKEN: "tooshort" } as NodeJS.ProcessEnv), /AGENT_HTTP_TOKEN_REQUIRED/);
  assert.equal(requireToken({ AGENT_HTTP_TOKEN: "a".repeat(32) } as NodeJS.ProcessEnv), "a".repeat(32));
});

test("only an exact bearer token authorizes; prefixes and wrong schemes do not", () => {
  assert.equal(authorized(`Bearer ${token}`, token), true);
  assert.equal(authorized(`Bearer ${token.slice(0, -1)}`, token), false);
  assert.equal(authorized(`Bearer ${token}extra`, token), false);
  assert.equal(authorized(`Basic ${token}`, token), false);
  assert.equal(authorized(undefined, token), false);
});

test("an unauthenticated agent cannot reach the endpoint at all", async () => {
  for (const bearer of [null, "wrong-token-wrong-token-wrong-token"]) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const response = await fetch(url, { method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "UNAUTHORIZED" });
  }
  const other = await fetch(new URL("/", url), { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  assert.equal(other.status, 404);
});

test("an authorized external agent lists the same scoped tools it gets over stdio", async () => {
  const client = await connect(token);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(),
      ["cashOut", "claimInterest", "executePlan", "pay", "planTreasury", "quotePT", "transactionStatus", "treasuryStatus"]);
    // Write tools stay marked destructive over HTTP so a remote agent cannot be told otherwise.
    assert.equal(tools.find((t) => t.name === "pay")!.annotations!.readOnlyHint, false);
    assert.equal(tools.find((t) => t.name === "treasuryStatus")!.annotations!.readOnlyHint, true);
  } finally { await client.close(); }
});

test("independent agents are served concurrently and failures stay sanitized", async () => {
  const [a, b] = await Promise.all([connect(token), connect(token)]);
  try {
    const results = await Promise.all([
      a.callTool({ name: "treasuryStatus", arguments: { payees: [] } }),
      b.callTool({ name: "treasuryStatus", arguments: { payees: [] } }),
    ]);
    for (const result of results) {
      assert.equal(result.isError, true);
      const text = (result.content as { text: string }[])[0]!.text;
      // A coded failure, never an RPC URL, key material or raw ethers output.
      assert.match(text, /^\{"error":"[A-Z_]+"\}$/);
    }
  } finally { await a.close(); await b.close(); }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import hre from "hardhat";
import { BrowserProvider, Contract, ContractFactory, Wallet } from "ethers";
import { compile } from "../scripts/compile.ts";
import { approvalUrl, claudeConfigPath, claudeEntry, CLIENTS, clientConfigPath, clientSnippet, findAuthorization, isAuthorized, parseArgs, updateClaudeConfig, writeWallet } from "../scripts/agent-cli.ts";
import { createRuntime } from "../agent/mcp-server.ts";

test("arguments parse into a command with defaults, and a flag cannot swallow the next flag", () => {
  assert.deepEqual(parseArgs(["init"]),
    { command: "init", tijori: undefined, daily: "5", out: "runtime/agent-wallet.json", unsigned: false, app: undefined, config: undefined, open: true, client: "claude" });
  const parsed = parseArgs(["rotate", "--tijori", "0xabc", "--daily", "25", "--out", "k.json", "--unsigned"]);
  assert.deepEqual(parsed, { command: "rotate", tijori: "0xabc", daily: "25", out: "k.json", unsigned: true, app: undefined, config: undefined, open: true, client: "claude" });
  const connect = parseArgs(["connect", "--app", "http://127.0.0.1:4173", "--config", "c.json", "--no-open"]);
  assert.deepEqual([connect.command, connect.app, connect.config, connect.open], ["connect", "http://127.0.0.1:4173", "c.json", false]);
  // Without this, `--daily --unsigned` would silently set the cap to "--unsigned".
  assert.throws(() => parseArgs(["init", "--daily", "--unsigned"]), /MISSING_VALUE_FOR_DAILY/);
  assert.throws(() => parseArgs(["init", "--tijori"]), /MISSING_VALUE_FOR_TIJORI/);
});

test("an unknown or absent command yields no command rather than guessing one", () => {
  assert.equal(parseArgs([]).command, "");
  assert.equal(parseArgs(["--unsigned"]).command, "");
});

test("a generated agent wallet is written readable only by its owner", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pakka-cli-"));
  try {
    const agent = Wallet.createRandom();
    const file = writeWallet(path.join(directory, "nested", "agent.json"),
      { address: agent.address, privateKey: agent.privateKey });
    // 0o600: a key sitting in a file must not be group or world readable.
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { address: string; privateKey: string };
    assert.equal(saved.address, agent.address);
    assert.equal(new Wallet(saved.privateKey).address, agent.address);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("rewriting an existing wallet file keeps owner-only permissions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pakka-cli-"));
  try {
    const file = path.join(directory, "agent.json");
    fs.writeFileSync(file, "{}", { mode: 0o644 });
    writeWallet(file, { address: "0x1", privateKey: "0x2" });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("the Claude config location follows each platform's convention", () => {
  assert.equal(claudeConfigPath("darwin", {}, "/Users/a"), "/Users/a/Library/Application Support/Claude/claude_desktop_config.json");
  assert.equal(claudeConfigPath("linux", {}, "/home/a"), "/home/a/.config/Claude/claude_desktop_config.json");
  assert.equal(claudeConfigPath("linux", { XDG_CONFIG_HOME: "/x" }, "/home/a"), "/x/Claude/claude_desktop_config.json");
  assert.equal(claudeConfigPath("win32", { APPDATA: "/appdata" }, "/home/a"), path.join("/appdata", "Claude", "claude_desktop_config.json"));
});

test("the Claude entry references the key file and never contains the key", () => {
  const agent = Wallet.createRandom();
  const entry = claudeEntry("0x000000000000000000000000000000000000dEaD", "/keys/agent.json", { ARC_TESTNET_RPC_URL: "https://rpc.example" });
  assert.deepEqual(entry.env, { AGENT_TIJORI_ADDRESS: "0x000000000000000000000000000000000000dEaD", AGENT_KEY_FILE: "/keys/agent.json", ARC_TESTNET_RPC_URL: "https://rpc.example" });
  assert.equal(path.isAbsolute(entry.command as string), true);
  assert.equal(JSON.stringify(entry).includes(agent.privateKey), false);
  assert.equal(JSON.stringify(entry).includes("PRIVATE_KEY"), false);
});

test("connecting adds only the pakka server; uninstalling removes only it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pakka-cli-"));
  try {
    const file = path.join(directory, "Claude", "claude_desktop_config.json");
    // First run on a machine where Claude Desktop has never written a config.
    assert.equal(updateClaudeConfig(file, { command: "node" }), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { mcpServers: { pakka: { command: "node" } } });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.chmodSync(file, 0o640);

    fs.writeFileSync(file, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" }, pakka: { command: "old" } } }));
    updateClaudeConfig(file, { command: "new" });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")),
      { theme: "dark", mcpServers: { other: { command: "x" }, pakka: { command: "new" } } });

    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    assert.equal(updateClaudeConfig(file, null), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { theme: "dark", mcpServers: { other: { command: "x" } } });
    assert.equal(updateClaudeConfig(file, null), false);
    assert.equal(updateClaudeConfig(path.join(directory, "absent.json"), null), false);
    assert.equal(fs.existsSync(path.join(directory, "absent.json")), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("a Claude config that cannot be parsed is refused and left byte-for-byte intact", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pakka-cli-"));
  try {
    const file = path.join(directory, "claude_desktop_config.json");
    // Replacing these would silently delete the user's other MCP servers.
    for (const broken of ['{ "mcpServers": { "other": ', "[]", '{"mcpServers":[]}']) {
      fs.writeFileSync(file, broken);
      assert.throws(() => updateClaudeConfig(file, { command: "node" }), /MCP_CONFIG_UNREADABLE/);
      assert.equal(fs.readFileSync(file, "utf8"), broken);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("the terminal finds its treasury from the chain, and only while its key is the agent", async () => {
  const provider = new BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
  const artifacts = compile();
  const [deployer, owner, second] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  const deploy = async (name: string, args: unknown[] = []): Promise<Contract> => {
    const c = await new ContractFactory(artifacts[name]!.abi, artifacts[name]!.bytecode!, deployer).deploy(...args);
    await c.waitForDeployment(); return c as unknown as Contract;
  };
  const sent = async (tx: Promise<{ wait: () => Promise<unknown> }>) => (await tx).wait();
  const asset = await deploy("MockUSDC");
  const registry = await deploy("SeriesRegistry", [asset.target, await deployer.getAddress()]);
  const manager = await deploy("TestnetPoolManager", [await deployer.getAddress()]);
  const market = await deploy("UniswapV4Market", [manager.target, registry.target]);
  const router = await deploy("PakkaRouter", [market.target]);
  const factory = await deploy("TijoriFactory", [router.target]);
  const manifest = { tijoriFactory: factory.target as string };
  const first = Wallet.createRandom().address, replacement = Wallet.createRandom().address, stranger = Wallet.createRandom().address;
  const start = await provider.getBlockNumber();

  assert.equal(await findAuthorization(provider, manifest, first, start), null);
  // New owner: the browser creates the treasury with the terminal's agent address.
  await sent((factory.connect(owner) as Contract).create(first, 5_000000n));
  const tijori = await factory.tijoriOf(await owner.getAddress()) as string;
  assert.equal(await findAuthorization(provider, manifest, first, start), tijori);
  assert.equal(await findAuthorization(provider, manifest, stranger, start), null);

  // Existing owner: the browser swaps the agent. The old key must stop resolving.
  await sent((new Contract(tijori, artifacts.Tijori!.abi, owner)).setAgent(replacement));
  assert.equal(await findAuthorization(provider, manifest, replacement, start), tijori);
  assert.equal(await findAuthorization(provider, manifest, first, start), null);
  assert.equal(await isAuthorized(provider, manifest, tijori, first), false);

  // A look-alike contract outside the factory can emit the same event; it must not be trusted.
  const rogueFactory = await deploy("TijoriFactory", [router.target]);
  await sent((rogueFactory.connect(second) as Contract).create(stranger, 5_000000n));
  const rogue = await rogueFactory.tijoriOf(await second.getAddress()) as string;
  await sent((new Contract(rogue, artifacts.Tijori!.abi, second)).setAgent(first));
  assert.equal(await findAuthorization(provider, manifest, first, start), null);
  assert.equal(await isAuthorized(provider, manifest, rogue, first), false);
});

test("the agent server refuses a missing or keyless key file instead of starting unsigned", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pakka-cli-"));
  try {
    const empty = path.join(directory, "empty.json");
    fs.writeFileSync(empty, "{}");
    for (const AGENT_KEY_FILE of [path.join(directory, "absent.json"), empty]) {
      const runtime = createRuntime({ AGENT_TIJORI_ADDRESS: "0x000000000000000000000000000000000000dEaD", AGENT_KEY_FILE } as NodeJS.ProcessEnv);
      assert.throws(() => runtime.getService(), /INVALID_AGENT_KEY/);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("the approval link only ever points at https, or http on this machine", () => {
  const agent = "0x000000000000000000000000000000000000dEaD";
  assert.equal(approvalUrl("https://example.com/", agent), `https://example.com/app?agent=${agent}#tijori`);
  assert.equal(approvalUrl("http://127.0.0.1:4173", agent), `http://127.0.0.1:4173/app?agent=${agent}#tijori`);
  // Each of these would open something other than the app, or smuggle extra content into the link or a shell.
  for (const app of ["http://example.com", "javascript:alert(1)", "file:///etc/passwd", "https://user:pw@example.com", "https://example.com/?x=1&calc", "https://example.com/#x", "not a url"])
    assert.throws(() => approvalUrl(app, agent), /INVALID_APP_URL/);
  assert.throws(() => approvalUrl("https://example.com", "0x1234"));
});

test("an installed package tells Claude to start it through a pinned npx, never from the download cache", () => {
  const entry = claudeEntry("0x000000000000000000000000000000000000dEaD", "/keys/agent.json", { PAKKA_PACKAGE: "@scope/pakka-agent@1.2.3" });
  // An unpinned name would let any later publish start running with the agent key.
  assert.deepEqual(entry.args, ["-y", "@scope/pakka-agent@1.2.3", "serve"]);
  assert.equal(path.basename(entry.command as string).startsWith("npx"), true);
  const env = entry.env as Record<string, string>;
  assert.equal(env.AGENT_KEY_FILE, "/keys/agent.json");
  assert.equal(env.PATH!.split(path.delimiter)[0], path.dirname(process.execPath));
  assert.equal(JSON.stringify(entry).includes("mcp-server.ts"), false);
});

test("each client gets its own format, and none of them is handed the key", () => {
  const agent = Wallet.createRandom();
  const entry = { command: "/opt/my node/npx", args: ["-y", "pkg@1.0.0", "serve"], env: { AGENT_TIJORI_ADDRESS: "0xabc", AGENT_KEY_FILE: "/keys/agent wallet.json" } };
  assert.equal(parseArgs(["connect", "--client", "Codex"]).client, "codex");
  assert.equal(clientConfigPath("cursor", "darwin", {}, "/Users/a"), "/Users/a/.cursor/mcp.json");
  assert.equal(clientConfigPath("claude", "darwin", {}, "/Users/a"), claudeConfigPath("darwin", {}, "/Users/a"));

  assert.equal(clientSnippet("codex", entry).text, [
    "[mcp_servers.pakka]", 'command = "/opt/my node/npx"', 'args = ["-y","pkg@1.0.0","serve"]',
    'env = { AGENT_TIJORI_ADDRESS = "0xabc", AGENT_KEY_FILE = "/keys/agent wallet.json" }'].join("\n"));
  assert.equal(clientSnippet("hermes", entry).text, [
    "mcp_servers:", "  pakka:", '    command: "/opt/my node/npx"', '    args: ["-y","pkg@1.0.0","serve"]', "    env:",
    '      AGENT_TIJORI_ADDRESS: "0xabc"', '      AGENT_KEY_FILE: "/keys/agent wallet.json"'].join("\n"));
  // OpenCode takes the program and its arguments as one list, and calls the variables "environment".
  assert.deepEqual(JSON.parse(clientSnippet("opencode", entry).text),
    { mcp: { pakka: { type: "local", command: ["/opt/my node/npx", "-y", "pkg@1.0.0", "serve"], enabled: true, environment: entry.env } } });
  for (const client of ["openclaw", "other"]) assert.deepEqual(JSON.parse(clientSnippet(client, entry).text), { mcpServers: { pakka: entry } });

  const real = claudeEntry("0x000000000000000000000000000000000000dEaD", "/keys/agent.json", {});
  for (const client of CLIENTS) assert.equal(clientSnippet(client, real).text.includes(agent.privateKey.slice(2, 20)), false);
});

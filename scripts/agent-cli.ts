import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, Interface, Wallet, formatUnits, getAddress, parseUnits, zeroPadValue } from "ethers";
import type { JsonRpcProvider, Provider } from "ethers";
import { abi, dataRoot, loadDeployment, projectRoot } from "../backend/project.ts";
import { rpcProvider, shutdown } from "../backend/rpc.ts";

const USAGE = `Pakka agent setup

  connect    Set up an MCP client: make an agent wallet, approve it in your browser
             wallet, and configure the client. Needs no owner key.
  uninstall  Remove Pakka from the client's config
  init       Generate an agent wallet, create a Tijori owned by you, and authorize it
  rotate     Generate a replacement agent wallet for an existing Tijori
  status     Show a Tijori's agent, limits, balance and pause state

Options
  --tijori 0x...   Treasury address (rotate, status)
  --daily <usdc>   Daily payment cap for init (default 5)
  --out <path>     Where to write the agent wallet (default runtime/agent-wallet.json)
  --unsigned       Print calldata for an external signer instead of sending
  --app <url>      Web app to open for connect (default PAKKA_APP_URL or the hosted app)
  --client <name>  claude (default), cursor, codex, opencode, hermes, openclaw, other.
                   Claude Desktop and Cursor are configured for you; for the rest the
                   exact settings to paste are printed.
  --config <path>  Client config file to write (default: the client's standard location)
  --no-open        Print the approval link instead of opening a browser

Signing
  Set OWNER_PRIVATE_KEY to the wallet that should own the treasury. Prefer --unsigned
  and a hardware wallet or multisig for anything holding real value.`;

export interface Args { command: string; tijori?: string; daily: string; out: string; unsigned: boolean; app?: string; config?: string; open: boolean; client: string }

const COMMANDS = ["connect", "uninstall", "init", "rotate", "status"];
// Only clients whose config is plain JSON with a stable "mcpServers" key are edited in place.
// The others use TOML, YAML or a layout that varies by version, so their settings are printed.
const WRITTEN_CLIENTS = ["claude", "cursor"];
export const CLIENTS = [...WRITTEN_CLIENTS, "codex", "opencode", "hermes", "openclaw", "other"];
const HOSTED_APP = "https://arc-sigma-three.vercel.app";
// Authorization that landed shortly before this run still counts, so a rerun after an
// interrupted connect finishes instead of waiting for a transaction that already happened.
const LOOKBACK_BLOCKS = 5000;

export function parseArgs(argv: string[]): Args {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    if (index === -1) return undefined;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`MISSING_VALUE_FOR_${name.toUpperCase()}`);
    return next;
  };
  return { command: argv.find((a) => !a.startsWith("--")) ?? "", tijori: value("tijori"),
    daily: value("daily") ?? "5", out: value("out") ?? "runtime/agent-wallet.json",
    unsigned: argv.includes("--unsigned"), app: value("app"), config: value("config"), open: !argv.includes("--no-open"),
    client: (value("client") ?? "claude").toLowerCase() };
}

export function clientConfigPath(client: string, platform: string = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return client === "cursor" ? path.join(home, ".cursor", "mcp.json") : claudeConfigPath(platform, env, home);
}

// Settings in the client's own format. JSON string escaping is also valid TOML and YAML, so
// paths with spaces or backslashes survive a paste. The key is never part of this: the entry
// only names the key file.
export function clientSnippet(client: string, entry: Record<string, unknown>): { where: string; text: string } {
  const { command, args, env } = entry as { command: string; args: string[]; env: Record<string, string> };
  const q = JSON.stringify;
  if (client === "codex") return { where: "~/.codex/config.toml", text:
    `[mcp_servers.pakka]\ncommand = ${q(command)}\nargs = ${q(args)}\nenv = { ${Object.entries(env).map(([k, v]) => `${k} = ${q(v)}`).join(", ")} }` };
  if (client === "hermes") return { where: "~/.hermes/config.yaml (then run /reload-mcp)", text:
    `mcp_servers:\n  pakka:\n    command: ${q(command)}\n    args: ${q(args)}\n    env:\n${Object.entries(env).map(([k, v]) => `      ${k}: ${q(v)}`).join("\n")}` };
  if (client === "opencode") return { where: "opencode.json", text:
    JSON.stringify({ mcp: { pakka: { type: "local", command: [command, ...args], enabled: true, environment: env } } }, null, 2) };
  return { where: client === "openclaw" ? "OpenClaw's MCP server settings" : "your client's MCP server settings", text:
    JSON.stringify({ mcpServers: { pakka: entry } }, null, 2) };
}

export function claudeConfigPath(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const directory = platform === "darwin" ? path.join(home, "Library/Application Support")
    : platform === "win32" ? env.APPDATA || path.join(home, "AppData/Roaming")
    : env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(directory, "Claude", "claude_desktop_config.json");
}

// The entry points at the key file rather than embedding the key: the Claude config is not
// owner-only, and other tools read it.
export function claudeEntry(tijori: string, keyFile: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const rpc: Record<string, string> = {};
  for (const name of ["ARC_TESTNET_RPC_URL", "ARC_TESTNET_RPC_FALLBACK_URL"]) if (env[name]) rpc[name] = env[name]!;
  const settings = { AGENT_TIJORI_ADDRESS: tijori, AGENT_KEY_FILE: keyFile, ...rpc };
  if (env.PAKKA_PACKAGE) {
    // Installed from npm: Claude must start it through npx, because this process is running
    // from a download cache that may be gone tomorrow. The exact version is pinned so a
    // later publish can never start running with the agent key unreviewed. Claude Desktop
    // does not inherit the shell's PATH, so npx is given the directory that holds node.
    const bin = path.dirname(process.execPath), npx = path.join(bin, process.platform === "win32" ? "npx.cmd" : "npx");
    return { command: fs.existsSync(npx) ? npx : "npx", args: ["-y", env.PAKKA_PACKAGE, "serve"],
      env: { ...settings, PAKKA_HOME: dataRoot, PATH: [bin, process.platform === "win32" ? env.PATH : "/usr/local/bin:/usr/bin:/bin"].filter(Boolean).join(path.delimiter) } };
  }
  return { command: process.execPath, args: [path.join(projectRoot, "agent/mcp-server.ts")], env: settings };
}

// Sets or (with null) removes only the "pakka" server. A config this cannot parse is left
// untouched rather than replaced, because it holds the user's other MCP servers.
export function updateClaudeConfig(file: string, entry: Record<string, unknown> | null): boolean {
  let config: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try { config = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>; }
    catch { throw new Error(`MCP_CONFIG_UNREADABLE: fix or remove ${file}, then run this again.`); }
    if (config === null || typeof config !== "object" || Array.isArray(config)) throw new Error(`MCP_CONFIG_UNREADABLE: fix or remove ${file}, then run this again.`);
  } else if (!entry) return false;
  const current = config.mcpServers;
  if (current !== undefined && (current === null || typeof current !== "object" || Array.isArray(current))) throw new Error(`MCP_CONFIG_UNREADABLE: fix or remove ${file}, then run this again.`);
  const servers = { ...(current as Record<string, unknown> | undefined) };
  if (!entry && !("pakka" in servers)) return false;
  if (entry) servers.pakka = entry; else delete servers.pakka;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.pakka-tmp`;
  // Keep the file's existing permissions; a new one is owner-only since it can hold an RPC credential.
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  fs.writeFileSync(temporary, `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`, { mode });
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, file);
  return true;
}

interface Addresses { tijoriFactory: string }

// True only for a treasury this deployment's factory created whose current agent is `agent`.
export async function isAuthorized(provider: Provider, manifest: Addresses, tijoriAddress: string, agent: string): Promise<boolean> {
  try {
    const tijori = new Contract(tijoriAddress, abi("Tijori"), provider);
    if (getAddress(await tijori.agent() as string) !== getAddress(agent)) return false;
    const factory = new Contract(manifest.tijoriFactory, abi("TijoriFactory"), provider);
    return getAddress(await factory.tijoriOf(await tijori.owner() as string) as string) === getAddress(tijoriAddress);
  } catch { return false; }
}

// The terminal never learns who the owner is, so it finds the treasury from the chain: the
// events only nominate candidates, and isAuthorized decides.
export async function findAuthorization(provider: Provider, manifest: Addresses, agent: string, fromBlock: number): Promise<string | null> {
  const topic = zeroPadValue(getAddress(agent), 32);
  const factory = new Interface(abi("TijoriFactory")), tijori = new Interface(abi("Tijori"));
  const created = await provider.getLogs({ address: manifest.tijoriFactory, fromBlock, toBlock: "latest",
    topics: [factory.getEvent("TijoriCreated")!.topicHash, null, null, topic] });
  const changed = await provider.getLogs({ fromBlock, toBlock: "latest",
    topics: [tijori.getEvent("AgentChanged")!.topicHash, null, topic] });
  const candidates = [...created.map((log) => getAddress(`0x${log.topics[2]!.slice(26)}`)), ...changed.map((log) => getAddress(log.address))];
  for (const candidate of candidates.reverse()) if (await isAuthorized(provider, manifest, candidate, agent)) return candidate;
  return null;
}

// The link carries the owner to a page that asks for wallet approval, so only a real web
// origin is accepted, and plain http only for a copy running on this machine.
export function approvalUrl(app: string, agent: string): string {
  let base: URL;
  try { base = new URL(app); } catch { throw new Error("INVALID_APP_URL"); }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if (!(base.protocol === "https:" || (base.protocol === "http:" && local)) || base.username || base.password || base.search || base.hash) throw new Error("INVALID_APP_URL");
  return `${base.origin}/app?agent=${getAddress(agent)}#tijori`;
}

function openBrowser(url: string): void {
  const [command, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  // The link is always printed as well, so a missing opener is not an error.
  try { spawn(command as string, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch { /* printed link suffices */ }
}

async function connect(args: Args, provider: JsonRpcProvider, manifest: Addresses, env: NodeJS.ProcessEnv): Promise<void> {
  const keyFile = path.resolve(dataRoot, args.out);
  let saved: { address?: string; privateKey?: string; tijori?: string } = {};
  if (fs.existsSync(keyFile)) {
    try { saved = JSON.parse(fs.readFileSync(keyFile, "utf8")) as typeof saved; }
    catch { throw new Error(`AGENT_WALLET_UNREADABLE: ${keyFile}`); }
  }
  // Reuse a saved key instead of replacing it: overwriting would strand a treasury whose
  // agent is that key, and a rerun after an interrupted approval must offer the same address.
  let agent: Wallet;
  if (saved.privateKey) {
    try { agent = new Wallet(saved.privateKey); } catch { throw new Error(`AGENT_WALLET_UNREADABLE: ${keyFile}`); }
  } else {
    const generated = Wallet.createRandom();
    agent = new Wallet(generated.privateKey);
    writeWallet(args.out, { address: agent.address, privateKey: agent.privateKey });
  }
  console.log(`agent address  ${agent.address}`);
  console.log(`agent key      ${keyFile} (mode 600, never leaves this computer)`);

  let tijori = saved.tijori && await isAuthorized(provider, manifest, saved.tijori, agent.address) ? getAddress(saved.tijori) : null;
  if (!tijori) {
    const fromBlock = Math.max(0, await provider.getBlockNumber() - LOOKBACK_BLOCKS);
    tijori = await findAuthorization(provider, manifest, agent.address, fromBlock);
    if (!tijori) {
      const url = approvalUrl(args.app ?? env.PAKKA_APP_URL ?? HOSTED_APP, agent.address);
      console.log(`\nApprove this agent with your own wallet:\n  ${url}`);
      console.log("Check that the page shows the agent address above, then confirm in your wallet.");
      if (args.open) openBrowser(url);
      console.log("\nWaiting for the approval to reach the chain (Ctrl+C to stop; run this again to resume)...");
      const timeout = Number(env.PAKKA_CONNECT_TIMEOUT_SECONDS ?? 900), interval = Number(env.PAKKA_CONNECT_POLL_SECONDS ?? 3);
      for (const deadline = Date.now() + timeout * 1000; !tijori && Date.now() < deadline;) {
        await new Promise((resolve) => setTimeout(resolve, interval * 1000));
        // A transient RPC failure must not end a wait the user is partway through approving.
        try { tijori = await findAuthorization(provider, manifest, agent.address, fromBlock); } catch { /* retry */ }
      }
      if (!tijori) throw new Error("CONNECT_TIMED_OUT: no approval seen. Run this again to resume with the same agent address.");
    }
    writeWallet(args.out, { address: agent.address, privateKey: agent.privateKey, tijori });
  }
  console.log(`\ntreasury       ${tijori}`);
  // Anyone can point their own treasury at a known address, so the owner is shown for the user to recognise.
  console.log(`owner          ${await new Contract(tijori, abi("Tijori"), provider).owner() as string}  <- must be your wallet`);

  const entry = claudeEntry(tijori, keyFile, env);
  if (await provider.getBalance(agent.address) === 0n) console.log(`\nThe agent has no gas yet. Send about 1 USDC to ${agent.address} or its transactions will fail.`);
  if (WRITTEN_CLIENTS.includes(args.client)) {
    const config = args.config ? path.resolve(args.config) : clientConfigPath(args.client);
    updateClaudeConfig(config, entry);
    console.log(`client config  ${config}`);
    console.log(`\nDone. Quit and reopen ${args.client === "cursor" ? "Cursor" : "Claude Desktop"}, then ask: What's in my Pakka treasury?`);
    return;
  }
  const snippet = clientSnippet(args.client, entry);
  console.log(`\nAdd this to ${snippet.where}:\n\n${snippet.text}\n`);
  console.log("It contains no secret: the agent key stays in the key file above.");
  console.log("Then restart your agent and ask: What's in my Pakka treasury?");
}

// Private keys must not land in shell history or scrollback, so the generated wallet is
// written to an owner-only file and only its public address is printed.
export function writeWallet(file: string, data: Record<string, string>): string {
  const target = path.resolve(dataRoot, file);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  return target;
}

const owner = (provider: JsonRpcProvider): Wallet => {
  const key = process.env.OWNER_PRIVATE_KEY;
  if (!key) throw new Error("Set OWNER_PRIVATE_KEY, or pass --unsigned to print calldata for an external signer.");
  try { return new Wallet(key, provider); } catch { throw new Error("INVALID_OWNER_KEY"); }
};

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (!COMMANDS.includes(args.command)) { console.log(USAGE); return; }
  if (!CLIENTS.includes(args.client)) throw new Error(`UNKNOWN_CLIENT: choose one of ${CLIENTS.join(", ")}`);
  if (args.command === "uninstall") {
    if (!WRITTEN_CLIENTS.includes(args.client)) console.log(`Remove the "pakka" server from ${clientSnippet(args.client, { command: "", args: [], env: {} }).where} yourself; this command did not write it.`);
    else {
      const config = args.config ? path.resolve(args.config) : clientConfigPath(args.client);
      console.log(updateClaudeConfig(config, null) ? `Removed Pakka from ${config}. Restart the client.` : `Pakka is not in ${config}.`);
    }
    console.log("Your agent key and treasury are untouched. To cut the agent off, pause or replace it in the app.");
    return;
  }

  const manifest = loadDeployment();
  const provider = rpcProvider();
  try {
    if (args.command === "connect") { await connect(args, provider, manifest, process.env); return; }
    if (args.command === "status") {
      if (!args.tijori) throw new Error("Pass --tijori 0x...");
      const tijori = new Contract(getAddress(args.tijori), abi("Tijori"), provider);
      const usdc = new Contract(manifest.usdc, ["function balanceOf(address) view returns (uint256)"], provider);
      console.log(`treasury   ${await tijori.getAddress()}`);
      console.log(`owner      ${await tijori.owner() as string}`);
      console.log(`agent      ${await tijori.agent() as string}`);
      console.log(`paused     ${await tijori.paused() as boolean}`);
      console.log(`daily cap  ${formatUnits(await tijori.dailyCap() as bigint, 6)} USDC`);
      console.log(`balance    ${formatUnits(await usdc.balanceOf(await tijori.getAddress()) as bigint, 6)} USDC`);
      return;
    }

    // Generating first removes the ordering problem the browser flow has, where creating a
    // treasury asks for an agent address before there is any way to produce one.
    const agent = Wallet.createRandom();
    const factory = new Contract(manifest.tijoriFactory, abi("TijoriFactory"), provider);
    const daily = parseUnits(args.daily, 6);

    if (args.unsigned) {
      const call = args.command === "init"
        ? { to: manifest.tijoriFactory, data: factory.interface.encodeFunctionData("create", [agent.address, daily]) }
        : { to: getAddress(args.tijori ?? ""), data: new Contract(getAddress(args.tijori ?? ""), abi("Tijori"), provider)
            .interface.encodeFunctionData("setAgent", [agent.address]) };
      const file = writeWallet(args.out, { address: agent.address, privateKey: agent.privateKey });
      console.log(`agent address  ${agent.address}`);
      console.log(`agent key      ${file} (mode 600)`);
      console.log("\nSend this transaction from the owner wallet:");
      console.log(`  to    ${call.to}`);
      console.log(`  data  ${call.data}`);
      return;
    }

    const signer = owner(provider);
    let tijoriAddress: string;
    if (args.command === "init") {
      const tx = await (factory.connect(signer) as Contract).create(agent.address, daily);
      const receipt = await tx.wait();
      tijoriAddress = getAddress(await factory.tijoriOf(signer.address) as string);
      console.log(`created in ${receipt!.hash}`);
    } else {
      if (!args.tijori) throw new Error("Pass --tijori 0x...");
      tijoriAddress = getAddress(args.tijori);
      const tijori = new Contract(tijoriAddress, abi("Tijori"), provider);
      if (getAddress(await tijori.owner() as string) !== signer.address) throw new Error("OWNER_SIGNER_MISMATCH");
      const tx = await (tijori.connect(signer) as Contract).setAgent(agent.address);
      console.log(`rotated in ${(await tx.wait())!.hash}`);
    }

    const file = writeWallet(args.out, { address: agent.address, privateKey: agent.privateKey, tijori: tijoriAddress });
    console.log(`\ntreasury       ${tijoriAddress}`);
    console.log(`agent address  ${agent.address}`);
    console.log(`agent key      ${file} (mode 600)`);
    console.log(`\nFund ${agent.address} with a little gas, then point your agent at:`);
    console.log(`  AGENT_TIJORI_ADDRESS=${tijoriAddress}`);
    console.log("  AGENT_PRIVATE_KEY=<privateKey from that file>");
    console.log("\nSee docs/connect-an-agent.md to connect over stdio or HTTP.");
  } finally {
    shutdown(provider);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}

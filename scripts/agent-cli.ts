import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, Wallet, formatUnits, getAddress, parseUnits } from "ethers";
import type { JsonRpcProvider } from "ethers";
import { abi, loadDeployment, projectRoot } from "../backend/project.ts";
import { rpcProvider, shutdown } from "../backend/rpc.ts";

const USAGE = `Pakka agent setup

  init     Generate an agent wallet, create a Tijori owned by you, and authorize it
  rotate   Generate a replacement agent wallet for an existing Tijori
  status   Show a Tijori's agent, limits, balance and pause state

Options
  --tijori 0x...   Treasury address (rotate, status)
  --daily <usdc>   Daily payment cap for init (default 5)
  --out <path>     Where to write the agent wallet (default runtime/agent-wallet.json)
  --unsigned       Print calldata for an external signer instead of sending

Signing
  Set OWNER_PRIVATE_KEY to the wallet that should own the treasury. Prefer --unsigned
  and a hardware wallet or multisig for anything holding real value.`;

export interface Args { command: string; tijori?: string; daily: string; out: string; unsigned: boolean }

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
    unsigned: argv.includes("--unsigned") };
}

// Private keys must not land in shell history or scrollback, so the generated wallet is
// written to an owner-only file and only its public address is printed.
export function writeWallet(file: string, data: Record<string, string>): string {
  const target = path.resolve(projectRoot, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
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
  if (!["init", "rotate", "status"].includes(args.command)) { console.log(USAGE); return; }

  const manifest = loadDeployment();
  const provider = rpcProvider();
  try {
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
    console.log("\nSee AGENTS.md to connect over stdio or HTTP.");
  } finally {
    shutdown(provider);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}

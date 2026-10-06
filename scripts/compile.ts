import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";
import type { InterfaceAbi } from "ethers";
import type { ContractArtifact } from "../backend/types.ts";

interface SolcError {
  severity: string;
  formattedMessage: string;
}

interface SolcContractOutput {
  abi: InterfaceAbi;
  evm: { bytecode: { object: string }; deployedBytecode: { object: string } };
}

interface SolcOutput {
  errors?: SolcError[];
  contracts: Record<string, Record<string, SolcContractOutput>>;
}

export function compile({ includeTests = false, abiOnly = false }: { includeTests?: boolean; abiOnly?: boolean } = {}): Record<string, ContractArtifact> {
  const sources: Record<string, { content: string }> = {};
  function read(dir: string): void {
    for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = path.posix.join(dir, file.name);
      if (file.isDirectory()) read(name);
      else if (name.endsWith(".sol")) sources[name] = { content: fs.readFileSync(name, "utf8") };
    }
  }
  read("contracts");
  if (includeTests) read("test/solidity");
  const result = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity", sources,
    settings: {
      optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", viaIR: true,
      outputSelection: { "*": { "*": abiOnly ? ["abi"] : ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
    },
  }), { import: (file: string) => {
    const resolved = file.startsWith("@uniswap/v4-core/")
      ? path.join("vendor/uniswap-v4-core", file.slice("@uniswap/v4-core/".length))
      : file.startsWith("@uniswap/v4-periphery/")
      ? path.join("vendor/uniswap-v4-periphery", file.slice("@uniswap/v4-periphery/".length))
      : file.startsWith("solmate/") ? path.join("vendor", file) : path.join("node_modules", file);
    try { return { contents: fs.readFileSync(resolved, "utf8") }; }
    catch { return { error: `Cannot resolve ${file}` }; }
  } })) as SolcOutput;
  for (const error of result.errors ?? []) {
    if (error.severity === "error") throw new Error(error.formattedMessage);
    console.warn(error.formattedMessage);
  }
  const artifacts: Record<string, ContractArtifact> = {};
  for (const [file, contracts] of Object.entries(result.contracts)) {
    if (!file.startsWith("contracts/") && !(includeTests && file.startsWith("test/solidity/"))) continue;
    for (const [name, artifact] of Object.entries(contracts)) {
      artifacts[name] = { contractName: name, sourceName: file, abi: artifact.abi, bytecode: abiOnly ? undefined : `0x${artifact.evm.bytecode.object}` };
      if (abiOnly || file.startsWith("test/")) continue;
      fs.mkdirSync("artifacts", { recursive: true });
      fs.writeFileSync(`artifacts/${name}.json`, `${JSON.stringify(artifacts[name], null, 2)}\n`);
      if (artifact.evm.deployedBytecode.object.length / 2 > 24_576) throw new Error(`${name} exceeds the deployed code size limit`);
    }
  }
  return artifacts;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`Compiled ${Object.keys(compile()).length} contracts using Solidity ${solc.version()} (Cancun EVM).`);
}

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { abi, deploymentFile, loadDeployment, projectRoot } from "../backend/project.ts";

// Builds the installable agent into dist/pakka-agent. Nothing here publishes.
const root = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")) as { version: string; dependencies: Record<string, string> };
const name = process.env.PAKKA_PACKAGE_NAME || "@anu062004/pakka-agent";
const out = path.join(projectRoot, "dist/pakka-agent");
// Only what the agent reads at runtime. ABIs are copied without bytecode or build metadata.
const ABIS = ["PakkaRouter", "SeriesRegistry", "Tijori", "TijoriFactory", "UniswapV4Market", "YieldToken"];
const DEPENDENCIES = ["@modelcontextprotocol/sdk", "ethers", "zod"];

fs.rmSync(out, { recursive: true, force: true });
execFileSync(process.execPath, [path.join(projectRoot, "node_modules/typescript/bin/tsc"), "-p", path.join(projectRoot, "scripts/tsconfig.package.json")], { stdio: "inherit" });

fs.mkdirSync(path.join(out, "artifacts"));
for (const contract of ABIS) fs.writeFileSync(path.join(out, `artifacts/${contract}.json`), `${JSON.stringify({ abi: abi(contract) })}\n`);
loadDeployment(); // refuse to package a manifest the agent itself would reject
fs.mkdirSync(path.join(out, "deployments"));
fs.copyFileSync(deploymentFile, path.join(out, "deployments/arc-testnet.json"));

fs.copyFileSync(path.join(projectRoot, "LICENSE"), path.join(out, "LICENSE"));
fs.writeFileSync(path.join(out, "bin.js"), `#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const pkg = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"));
// Set before the modules load: they read these once, at import.
process.env.PAKKA_HOME ??= path.join(os.homedir(), ".pakka");
process.env.PAKKA_PACKAGE = \`\${pkg.name}@\${pkg.version}\`;

const argv = process.argv.slice(2);
try {
  if (argv[0] === "serve") await (await import("./agent/mcp-server.js")).main();
  else {
    const { main } = await import("./scripts/agent-cli.js");
    if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") await main([]);
    else await main(["connect", "uninstall", "init", "rotate", "status"].includes(argv[0]) ? argv : ["connect", ...argv]);
  }
} catch (error) {
  // stdout belongs to the MCP protocol while serving, and startup errors must not echo secrets.
  console.error(argv[0] === "serve" ? "AGENT_STARTUP_FAILED" : error.message);
  process.exitCode = 1;
}
`, { mode: 0o755 });

fs.writeFileSync(path.join(out, "README.md"), `# ${name}

Connect Claude Desktop, Cursor, Codex, OpenCode, Hermes, OpenClaw or any other MCP client to a
Pakka Tijori treasury on Arc Testnet.

\`\`\`sh
npx ${name}
\`\`\`

This makes an agent wallet on your computer (\`~/.pakka/runtime/agent-wallet.json\`, owner-only),
opens the Pakka app so your own wallet can approve it, then sets up your client. Claude Desktop
is the default; pick another with \`--client cursor|codex|opencode|hermes|openclaw|other\`. Claude
Desktop and Cursor are configured for you; for the others the exact settings are printed. Check that the agent address in the browser matches the one in your terminal
before confirming.

The agent key never leaves your machine. The Tijori contract enforces what the agent may do:
buy registered series, redeem matured principal, claim interest and pay approved payees within
your caps. You can pause or replace the agent at any time from the app.

\`\`\`sh
npx ${name} status --tijori 0xYourTreasury
npx ${name} uninstall
\`\`\`

Unaudited testnet software. Never use it with a wallet that holds real funds.
`);

fs.writeFileSync(path.join(out, "package.json"), `${JSON.stringify({
  name, version: root.version, description: "Connect an MCP client to a Pakka Tijori treasury on Arc Testnet",
  license: "MIT", type: "module", bin: { "pakka-agent": "bin.js" },
  // An allowlist: a file that is not named here cannot be published, whatever lands in this folder.
  files: ["bin.js", "agent/*.js", "scripts/*.js", "backend/*.js", "artifacts/*.json", "deployments/arc-testnet.json"],
  engines: { node: ">=22" },
  dependencies: Object.fromEntries(DEPENDENCIES.map((dependency) => [dependency, root.dependencies[dependency]!])),
  repository: { type: "git", url: "git+https://github.com/Anu062004/Pakka-Protocol.git" },
  publishConfig: { access: "public" },
}, null, 2)}\n`);
console.log(`Built ${name}@${root.version} in ${out}`);

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { projectRoot } from "../backend/project.ts";
import { writeJson } from "./expiry-keeper.ts";

export const coreSources = ["PrincipalToken", "YieldToken", "SeriesRegistry", "UniswapV4Market", "PakkaRouter", "Tijori", "TijoriFactory", "PoolSeeder", "V4Client"]
  .map((n) => `contracts/${n}.sol`);

export interface FileCoverage {
  source: string;
  hit: number;
  total: number;
  percent: number;
  passed: boolean;
}

export interface CoverageResult {
  threshold: number;
  passed: boolean;
  files: FileCoverage[];
}

export function checkCoverage(lcov: string, threshold = 95, sources: string[] = coreSources): CoverageResult {
  const files = new Map<string, Map<number, number>>();
  let file: string | null = null;
  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) { file = line.slice(3).replaceAll("\\", "/"); if (!files.has(file)) files.set(file, new Map()); }
    else if (file && line.startsWith("DA:")) {
      const [number, hits] = line.slice(3).split(",").map(Number) as [number, number];
      const lines = files.get(file)!; lines.set(number, Math.max(lines.get(number) ?? 0, hits));
    }
    else if (line === "end_of_record") file = null;
  }
  const coverage = sources.map((source) => {
    const entries = [...files].filter(([f]) => f === source || f.endsWith(`/${source}`));
    const lines = new Map<number, number>();
    for (const [, records] of entries) for (const [line, hits] of records) lines.set(line, Math.max(lines.get(line) ?? 0, hits));
    const total = lines.size, hit = [...lines.values()].filter((n) => n > 0).length;
    return { source, hit, total, percent: total ? hit / total * 100 : 0, passed: total > 0 && hit * 100 >= total * threshold };
  });
  return { threshold, passed: coverage.every((f) => f.passed), files: coverage };
}

export interface ToolStatus {
  forge: boolean;
  slither: boolean;
  aderyn: boolean;
}

const version = (command: string): boolean => {
  const r = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 15000 });
  return !r.error && r.status === 0;
};
export function toolStatus(): ToolStatus { return { forge: version("forge"), slither: version("slither"), aderyn: version("aderyn") }; }

interface SlitherReport {
  success?: boolean;
  results?: { detectors?: { impact: string }[] };
}

export function slitherBlocking(report: SlitherReport): { impact: string }[] {
  if (report.success !== true || !Array.isArray(report.results?.detectors)) throw new Error("INVALID_SLITHER_REPORT");
  return report.results.detectors.filter((d) => ["high", "medium"].includes(String(d.impact).toLowerCase()));
}

interface AderynReport {
  high_issues?: { issues: unknown[] };
  medium_issues?: { issues: unknown[] };
  low_issues?: { issues: unknown[] };
}

export function aderynBlocking(report: AderynReport): unknown[] {
  // Aderyn's report uses high/low categories. Reject unknown formats instead of claiming a clean audit.
  if (!report.high_issues || !Array.isArray(report.high_issues.issues)) throw new Error("INVALID_ADERYN_REPORT");
  const high = report.high_issues.issues;
  const medium = report.medium_issues?.issues ?? [];
  if (!Array.isArray(medium)) throw new Error("INVALID_ADERYN_REPORT");
  return [...high, ...medium];
}

interface SecurityStatus {
  checkedAt: string;
  tools: ToolStatus;
  realForkConfigured: boolean;
  mainnetReady: boolean;
  findingsReviewed: boolean;
  coverageVerified: boolean;
  coverage?: CoverageResult;
  slitherBlocking?: number;
  aderynBlocking?: number;
  blockingFindingsVerified?: boolean;
  checkedSuccessfully?: boolean;
  blocked?: string;
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  const tools = toolStatus();
  const status: SecurityStatus = { checkedAt: new Date().toISOString(), tools, realForkConfigured: Boolean(process.env.FORK_RPC_URL && process.env.FORK_VAULT_ADDRESS),
    mainnetReady: false, findingsReviewed: false, coverageVerified: false };
  if (args.includes("--status")) { console.log(JSON.stringify(status, null, 2)); return 0; }
  fs.mkdirSync("reports", { recursive: true, mode: 0o700 }); fs.mkdirSync("coverage", { recursive: true, mode: 0o700 });
  const save = () => writeJson("reports/security-status.json", status);
  const missing = Object.entries(tools).filter(([, present]) => !present).map(([name]) => name);
  if (missing.length) { status.blocked = `Missing tools: ${missing.join(", ")}`; save(); console.error(status.blocked); return 2; }
  if (!status.realForkConfigured) { status.blocked = "Configure a verified Arc ERC-4626 vault and fork RPC locally."; save(); console.error(status.blocked); return 2; }
  function execute(label: string, command: string, parameters: string[]): void {
    console.log(`Running ${label}…`);
    const log = fs.openSync(path.join("reports", `${label}.log`), "w", 0o600);
    try {
      const r = spawnSync(command, parameters, { cwd: projectRoot, stdio: ["ignore", log, log] });
      if (r.error || r.status !== 0) throw new Error(`${label.toUpperCase().replaceAll("-", "_")}_FAILED`);
    } finally { fs.closeSync(log); }
  }
  try {
    execute("compile", process.execPath, ["scripts/compile.ts"]);
    execute("forge-tests", "forge", ["test", "--no-match-contract", "RealVaultForkTest"]);
    execute("real-vault-fork", "forge", ["test", "--match-contract", "RealVaultForkTest"]);
    execute("forge-coverage", "forge", ["coverage", "--ir-minimum", "--report", "lcov", "--report-file", "coverage/lcov.info", "--no-match-contract", "RealVaultForkTest"]);
    status.coverage = checkCoverage(fs.readFileSync("coverage/lcov.info", "utf8"));
    status.coverageVerified = status.coverage.passed;
    if (!status.coverageVerified) throw new Error("CORE_COVERAGE_BELOW_95_PERCENT");
    execute("slither", "slither", [".", "--compile-force-framework", "foundry", "--json", "reports/slither.json",
      "--filter-paths", "vendor/|node_modules/|contracts/test/|test/"]);
    status.slitherBlocking = slitherBlocking(JSON.parse(fs.readFileSync("reports/slither.json", "utf8"))).length;
    execute("aderyn", "aderyn", [".", "--output", "reports/aderyn.json"]);
    status.aderynBlocking = aderynBlocking(JSON.parse(fs.readFileSync("reports/aderyn.json", "utf8"))).length;
    if (status.slitherBlocking || status.aderynBlocking) throw new Error("BLOCKING_STATIC_ANALYSIS_FINDINGS");
    status.blockingFindingsVerified = true;
    status.checkedSuccessfully = true;
    // Even clean local analysis does not replace the external review, genuine fork flow or release approval.
    save(); console.log("Configured security checks passed. This does not authorize mainnet deployment."); return 0;
  } catch (e) { status.blocked = (e as Error).message; save(); console.error(status.blocked); return 1; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();

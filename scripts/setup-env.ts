import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "../backend/project.ts";

const file = path.join(projectRoot, ".env");
const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
const names = new Set([...existing.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
const missing = fs.readFileSync(path.join(projectRoot, ".env.example"), "utf8").split("\n")
  .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line) && !names.has(line.slice(0, line.indexOf("="))));
if (missing.length) fs.appendFileSync(file, `\n# Added configuration fields; existing values preserved.\n${missing.join("\n")}\n`, { mode: 0o600 });
fs.chmodSync(file, 0o600);
console.log(`Environment ready: ${missing.length} missing fields added; existing values preserved; permissions 600.`);

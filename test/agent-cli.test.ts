import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Wallet } from "ethers";
import { parseArgs, writeWallet } from "../scripts/agent-cli.ts";

test("arguments parse into a command with defaults, and a flag cannot swallow the next flag", () => {
  assert.deepEqual(parseArgs(["init"]),
    { command: "init", tijori: undefined, daily: "5", out: "runtime/agent-wallet.json", unsigned: false });
  const parsed = parseArgs(["rotate", "--tijori", "0xabc", "--daily", "25", "--out", "k.json", "--unsigned"]);
  assert.deepEqual(parsed, { command: "rotate", tijori: "0xabc", daily: "25", out: "k.json", unsigned: true });
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

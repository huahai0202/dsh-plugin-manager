import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runPnpm, terminateProcessTree } from "../lib/pnpm.js";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  kill() {}
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("pnpm timeout waits for process-tree termination before settling", async () => {
  const child = new FakeChild();
  let terminationStarted = false;
  let settled = false;
  const resultPromise = runPnpm(["update"], ".", {
    timeoutMs: 10,
    spawnImpl: () => child,
    terminate: async () => {
      terminationStarted = true;
      await delay(40);
      child.exitCode = 1;
      child.emit("close", 1);
    },
  });
  resultPromise.then(() => { settled = true });

  await delay(25);
  assert.equal(terminationStarted, true);
  assert.equal(settled, false);

  const result = await resultPromise;
  assert.equal(result.code, 124);
  assert.match(result.stderr, /timed out/);
});

test("a failed termination keeps the queue locked until the child closes", async () => {
  const child = new FakeChild();
  let settled = false;
  const resultPromise = runPnpm(["remove", "plugin"], ".", {
    timeoutMs: 10,
    spawnImpl: () => child,
    terminate: async () => { throw new Error("kill failed"); },
  });
  resultPromise.then(() => { settled = true });

  await delay(25);
  assert.equal(settled, false);
  child.exitCode = 1;
  child.emit("close", 1);

  const result = await resultPromise;
  assert.equal(result.code, 124);
  assert.match(result.stderr, /termination warning: kill failed/);
});

test("Windows tree termination removes the shell descendant", { skip: process.platform !== "win32" }, async (t) => {
  const shell = spawn('node -e "console.log(process.pid);setTimeout(function(){},60000)"', {
    shell: true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  shell.stdout.on("data", (data) => { output += data.toString(); });
  t.after(() => {
    if (shell.pid !== undefined) spawnSync("taskkill", ["/pid", String(shell.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
  });

  for (let attempt = 0; attempt < 20 && output.trim() === ""; attempt += 1) await delay(50);
  const descendant = Number(output.trim().split(/\s+/)[0]);
  assert.equal(Number.isInteger(descendant) && descendant > 0, true);

  await terminateProcessTree(shell, { platform: "win32", graceMs: 3000 });
  assert.throws(() => process.kill(descendant, 0));
});

import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 5000;
const WINDOWS_SHELL_ARG = /^[A-Za-z0-9@/._~-]+$/;

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForClose(child, timeoutMs) {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer;
    const finish = (closed) => {
      if (timer !== undefined) clearTimeout(timer);
      child.off("close", onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    child.once("close", onClose);
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
    }
  });
}

function runTreeKill(pid, spawnImpl) {
  return new Promise((resolve) => {
    const killer = spawnImpl("taskkill", ["/pid", String(pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
      shell: false,
    });
    killer.once("error", (error) => resolve({ code: 1, error }));
    killer.once("close", (code) => resolve({ code: code ?? 1 }));
  });
}

async function terminatePosixTree(child, graceMs) {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill("SIGTERM");
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  if (await waitForClose(child, graceMs)) return;
  if (pid === undefined) {
    child.kill("SIGKILL");
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  if (!await waitForClose(child, graceMs)) {
    throw new Error("pnpm process group did not exit after SIGKILL");
  }
}

async function terminateWindowsTree(child, graceMs, spawnImpl) {
  if (child.pid === undefined) {
    child.kill();
    if (!await waitForClose(child, graceMs)) throw new Error("pnpm shell did not exit");
    return;
  }

  const result = await runTreeKill(child.pid, spawnImpl);
  if (result.code !== 0 && !exited(child)) child.kill();
  if (!await waitForClose(child, graceMs)) {
    const detail = result.error instanceof Error ? `: ${result.error.message}` : "";
    throw new Error(`pnpm process tree did not exit after taskkill${detail}`);
  }
}

async function terminateProcessTree(child, options = {}) {
  if (exited(child)) return;
  const platform = options.platform ?? process.platform;
  const graceMs = options.graceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  const spawnImpl = options.spawnImpl ?? spawn;
  if (platform === "win32") await terminateWindowsTree(child, graceMs, spawnImpl);
  else await terminatePosixTree(child, graceMs);
}

function runPnpm(args, cwd, options = {}) {
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outputBytes = options.outputBytes ?? DEFAULT_OUTPUT_BYTES;
  const spawnImpl = options.spawnImpl ?? spawn;
  const terminate = options.terminate ?? terminateProcessTree;

  if (platform === "win32" && args.some((arg) => !WINDOWS_SHELL_ARG.test(arg))) {
    return Promise.resolve({
      code: 127,
      stdout: "",
      stderr: "refusing to pass an unsafe argument to the Windows pnpm shell",
      outputTruncated: false,
    });
  }

  return new Promise((settle) => {
    const spawnOptions = {
      cwd,
      shell: platform === "win32",
      detached: platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    };
    const child = platform === "win32"
      ? spawnImpl(["pnpm", ...args].join(" "), spawnOptions)
      : spawnImpl("pnpm", args, spawnOptions);
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;
    let outputTruncated = false;
    const capture = (current, data) => {
      const next = current + data.toString();
      if (next.length <= outputBytes) return next;
      outputTruncated = true;
      return next.slice(-outputBytes);
    };
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      settle({ stdout, stderr, outputTruncated, ...result });
    };
    child.stdout?.on("data", (data) => { stdout = capture(stdout, data); });
    child.stderr?.on("data", (data) => { stderr = capture(stderr, data); });
    child.on("error", (error) => {
      if (!timedOut) finish({ code: 127, stderr: `${error.message}\n${stderr}` });
    });
    child.on("close", (code) => {
      if (!timedOut) finish({ code: code ?? 1 });
    });
    const timeout = setTimeout(async () => {
      if (finished) return;
      timedOut = true;
      let terminationError;
      try {
        await terminate(child, { platform, graceMs: options.graceMs, spawnImpl: options.treeKillSpawnImpl });
      } catch (error) {
        terminationError = error;
        // Keep the mutation queue locked until the child really exits.
        await waitForClose(child);
      }
      const detail = terminationError === undefined ? "" : `; termination warning: ${terminationError.message}`;
      finish({ code: 124, stderr: `${stderr}\npnpm timed out after ${timeoutMs} ms${detail}` });
    }, timeoutMs);
    timeout.unref?.();
  });
}

export { runPnpm, terminateProcessTree };

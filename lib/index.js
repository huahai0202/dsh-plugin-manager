// dsh-plugin-manager — host half.
//
// Registers an HTTP API under /plugin-manager/api that lists, updates, and
// removes the user-installed plugins of the *active* dsh profile (the one this
// process booted, i.e. the profile whose node_modules contains this package).
// Plugin state lives in `$DSH_HOME/profiles/<name>/package.json` (`dependencies`
// plus the `dsh.profile.bundles` layer list); mutations are performed with the
// same pnpm-forwarding + bundle-reconciliation semantics as the `dsh plugin`
// command, so a change takes effect after the dsh process restarts.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { runPnpm } from "./pnpm.js";

const MAX_BODY_BYTES = 1 << 20;
const REGISTRY_TIMEOUT_MS = 10000;
const GITHUB_TIMEOUT_MS = 10000;

// ── API error / envelope helpers ────────────────────────────────────────────

class ApiError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new ApiError("bad-request", "request body too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("bad-request", "request body is not valid JSON");
  }
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value });
}

function writeError(res, error) {
  if (error instanceof ApiError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } });
    return;
  }
  writeJson(res, 500, { ok: false, error: { code: "internal", message: error instanceof Error ? error.message : String(error) } });
}

function requireString(payload, key) {
  const value = payload?.[key];
  if (typeof value !== "string" || value === "") throw new ApiError("bad-request", `missing or invalid "${key}"`);
  return value;
}

function tail(text, limit = 2000) {
  const value = String(text ?? "").trim();
  return value.length <= limit ? value : value.slice(value.length - limit);
}

function pnpmFailure(action, result, partial = false) {
  const output = tail(result.stderr || result.stdout);
  const truncated = result.outputTruncated ? "\noutput truncated" : "";
  const prefix = partial ? "earlier updates completed; " : "";
  return new ApiError("pnpm-failed", `${prefix}pnpm ${action} failed (exit ${result.code}): ${output}${truncated}`, 500);
}

// ── Trust fence (mirrors the shipped web-surface fence) ─────────────────────

function header(headers, name) {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;
  return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === undefined) return false;
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host;
  });
}

function isTrustedApiRequest(request, trustedHosts) {
  const host = header(request.headers, "host");
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
  const origin = header(request.headers, "origin");
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

// ── Profile resolution ──────────────────────────────────────────────────────

function dshHome() {
  const env = process.env.DSH_HOME;
  return env !== undefined && env.trim().length > 0 ? resolve(env.trim()) : join(homedir(), ".dsh");
}

function profilesDir() {
  return join(dshHome(), "profiles");
}

function profileFromArgv() {
  // Match the official launcher grammar: `web` is the alias for the web
  // profile, while `--profile` is a launcher option only before inner args.
  const argv = process.argv.slice(2);
  if (argv[0] === "web") return "web";
  if (argv[0] === "--profile") {
    const value = argv[1];
    if (value !== undefined && value !== "") return value;
  }
  if (typeof argv[0] === "string" && argv[0].startsWith("--profile=")) {
    const value = argv[0].slice("--profile=".length);
    if (value !== "") return value;
  }
  return undefined;
}

function activeProfileName() {
  const fromArgv = profileFromArgv();
  if (fromArgv !== undefined) return fromArgv;
  const fromEnv = process.env.DSH_PROFILE;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
  throw new ApiError(
    "profile-unavailable",
    "cannot determine the active dsh profile; launch with `dsh web` or `dsh --profile <name>`",
    500,
  );
}

function profileDir() {
  const name = activeProfileName();
  if (name === "" || name.includes("/") || name.includes("\\") || name === "." || name === ".." || name === "node_modules") {
    throw new ApiError("bad-request", `invalid profile name ${JSON.stringify(name)}`);
  }
  return join(profilesDir(), name);
}

// ── Manifest + installed-package helpers ────────────────────────────────────

function manifestPath(dir) {
  return join(dir, "package.json");
}

function readManifest(dir) {
  const path = manifestPath(dir);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new ApiError("not-found", `profile manifest not found: ${path}`, 404);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError("manifest-invalid", `profile manifest ${path} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError("manifest-invalid", `profile manifest ${path} must hold a JSON object`);
  }
  return parsed;
}

function writeManifest(dir, manifest) {
  writeFileSync(manifestPath(dir), JSON.stringify(manifest, undefined, 2) + "\n");
}

function packageModulesPath(pkg) {
  return join(...pkg.split("/"));
}

function installedPackageJson(dir, pkg) {
  const path = join(dir, "node_modules", packageModulesPath(pkg), "package.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Whether an installed dependency declares a `dsh.bundle` patch layer. */
function declaresBundle(dir, pkg) {
  const direct = installedPackageJson(dir, pkg);
  return direct?.dsh?.bundle?.patch !== undefined;
}

/** Whether a dependency spec is a plain registry spec (vs git/path/alias). */
function isRegistrySpec(spec) {
  if (typeof spec !== "string" || spec === "") return false;
  if (/^(github:|git\+|git:|file:|link:|workspace:|npm:)/.test(spec)) return false;
  if (spec.startsWith(".") || isAbsolute(spec)) return false;
  return true;
}

/** Whether a dependency spec points at a git remote (re-resolvable to latest commit). */
function isGitSpec(spec) {
  if (typeof spec !== "string" || spec === "") return false;
  return /^(github:|git\+|git:)/.test(spec) || /\.git(?:#|$)/.test(spec) || /^git@/.test(spec);
}

/** Parse the GitHub repository and optional ref from a git dependency spec. */
function githubSource(spec) {
  if (typeof spec !== "string" || spec === "") return undefined;
  const value = spec.trim();
  let repo;
  let ref;
  if (value.startsWith("github:")) {
    const body = value.slice("github:".length);
    const hash = body.indexOf("#");
    repo = hash === -1 ? body : body.slice(0, hash);
    ref = hash === -1 ? undefined : body.slice(hash + 1);
  } else if (value.startsWith("git@github.com:") || value.startsWith("git@github.com/")) {
    const body = value.slice("git@github.com".length).replace(/^[:/]/, "");
    const hash = body.indexOf("#");
    repo = hash === -1 ? body : body.slice(0, hash);
    ref = hash === -1 ? undefined : body.slice(hash + 1);
  } else {
    try {
      const url = new URL(value.replace(/^git\+/, ""));
      if (url.hostname !== "github.com") return undefined;
      repo = url.pathname.replace(/^\/+|\/+$/g, "");
      ref = url.hash === "" ? undefined : url.hash.slice(1);
    } catch {
      return undefined;
    }
  }
  repo = repo?.replace(/\.git$/, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "")) return undefined;
  if (ref === "") ref = undefined;
  return { repo, ref };
}

function githubRepositoryUrl(source) {
  return source === undefined ? undefined : `https://github.com/${source.repo}`;
}

/** Derive a clean GitHub HTTPS repo URL from a package manifest, if any. */
function githubUrl(manifest) {
  let candidate;
  const repo = manifest?.repository;
  if (typeof repo === "string") candidate = repo;
  else if (repo && typeof repo === "object" && typeof repo.url === "string") candidate = repo.url;

  if (candidate) {
    candidate = candidate.trim().replace(/^git\+/, "");
    if (candidate.startsWith("github:")) candidate = "https://github.com/" + candidate.slice("github:".length);
    if (candidate.startsWith("git@github.com:")) candidate = "https://github.com/" + candidate.slice("git@github.com:".length);
    if (candidate.startsWith("git@github.com/")) candidate = "https://github.com/" + candidate.slice("git@github.com/".length);
    candidate = candidate.replace(/\.git(?=[\/#]|$)/, "");
    const match = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/.exec(candidate);
    if (match) return "https://github.com/" + match[1];
  }

  return undefined;
}

/** npm package page URL for a registry package name. */
function npmUrl(name) {
  return "https://www.npmjs.com/package/" + name;
}

// ── Bundle reconciliation (mirrors `dsh plugin`'s reconcilePlugins) ─────────

function reconcile(before, dir) {
  const after = readManifest(dir);
  const beforeDeps = new Set(Object.keys(before.dependencies ?? {}));
  const dependencies = Object.keys(after.dependencies ?? {});
  const plugins = after.dsh?.profile?.bundles ?? [];
  let changed = false;
  for (const pkg of dependencies) {
    const isBundle = declaresBundle(dir, pkg);
    if (isBundle && !plugins.includes(pkg)) {
      plugins.push(pkg);
      changed = true;
    }
  }
  const dependencySet = new Set(dependencies);
  for (const pkg of [...plugins]) {
    const wasDependency = beforeDeps.has(pkg) || dependencySet.has(pkg);
    const stillBundle = dependencySet.has(pkg) && declaresBundle(dir, pkg);
    if (wasDependency && !stillBundle) {
      plugins.splice(plugins.indexOf(pkg), 1);
      changed = true;
    }
  }
  if (!changed) return after;
  after.dsh = { ...after.dsh, profile: { ...after.dsh?.profile, bundles: plugins } };
  writeManifest(dir, after);
  return after;
}

// pnpm rewrites package.json, pnpm-lock.yaml, node_modules, and the bundle
// list. Serialize every mutation for one profile so two tabs cannot interleave
// those writes and leave the profile in a mixed state.
const mutationQueues = new Map();

function enqueueMutation(task) {
  const dir = profileDir();
  const previous = mutationQueues.get(dir) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => task(dir));
  let queued;
  queued = current.finally(() => {
    if (mutationQueues.get(dir) === queued) mutationQueues.delete(dir);
  });
  mutationQueues.set(dir, queued);
  return queued;
}

// ── npm registry ────────────────────────────────────────────────────────────

async function fetchLatest(pkg) {
  const url = `https://registry.npmjs.org/${pkg.replace("/", "%2F")}/latest`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) return undefined;
    const data = await response.json();
    return typeof data?.version === "string" ? data.version : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function lockfilePath(dir) {
  return join(dir, "pnpm-lock.yaml");
}

function unquoteYaml(value) {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Read a direct dependency's resolved version from the root pnpm importer. */
function lockedVersion(dir, name) {
  let text;
  try {
    text = readFileSync(lockfilePath(dir), "utf8");
  } catch {
    return undefined;
  }
  const lines = text.split(/\r?\n/);
  let importers = false;
  let rootImporter = false;
  let dependencies = false;
  let currentName;
  for (const line of lines) {
    if (line === "importers:") {
      importers = true;
      continue;
    }
    if (!importers) continue;
    if (/^\S/.test(line)) break;
    const indent = (/^ */.exec(line) ?? [""])[0].length;
    const trimmed = line.trim();
    if (indent === 2) {
      rootImporter = trimmed === ".:";
      dependencies = false;
      currentName = undefined;
      continue;
    }
    if (!rootImporter) continue;
    if (indent === 4) {
      dependencies = trimmed === "dependencies:";
      currentName = undefined;
      continue;
    }
    if (!dependencies) continue;
    if (indent === 6 && trimmed.endsWith(":")) {
      currentName = unquoteYaml(trimmed.slice(0, -1));
      continue;
    }
    if (currentName === name && indent === 8 && trimmed.startsWith("version:")) {
      return unquoteYaml(trimmed.slice("version:".length).trim());
    }
  }
  return undefined;
}

function commitFromLockVersion(version) {
  if (typeof version !== "string") return undefined;
  const match = /(?:\/tar\.gz\/|#)([0-9a-f]{7,64})(?:[/?#]|$)/i.exec(version);
  return match?.[1];
}

function isCommitRef(ref) {
  return typeof ref === "string" && /^[0-9a-f]{7,64}$/i.test(ref);
}

function sameCommit(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a === b || a.startsWith(b) || b.startsWith(a);
}

async function fetchGitHub(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.github.com${path}`, {
      signal: controller.signal,
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "dsh-plugin-manager",
      },
    });
    if (!response.ok) return { status: response.status };
    return { status: response.status, data: await response.json() };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function localGitInfo(dir, name, spec) {
  const source = githubSource(spec);
  if (source === undefined) return { state: "unsupported" };
  const installedCommit = commitFromLockVersion(lockedVersion(dir, name));
  if (isCommitRef(source.ref)) return { state: "fixed", ref: source.ref, installedCommit };
  return { state: installedCommit === undefined ? "unresolved" : "unchecked", ref: source.ref, installedCommit };
}

/** Compare a GitHub branch dependency with the commit pinned in pnpm-lock.yaml. */
async function checkGitHubUpdate(dir, name, spec) {
  const source = githubSource(spec);
  if (source === undefined) return { state: "unsupported" };
  const installedCommit = commitFromLockVersion(lockedVersion(dir, name));
  if (installedCommit === undefined) return { state: "unresolved", ref: source.ref };
  if (isCommitRef(source.ref)) return { state: "fixed", ref: source.ref, installedCommit };
  if (source.ref?.startsWith("semver:")) return { state: "unsupported", ref: source.ref, installedCommit };

  let branch = source.ref === "HEAD" ? undefined : source.ref;
  if (branch === undefined) {
    const repository = await fetchGitHub(`/repos/${source.repo}`);
    if (repository?.status !== 200 || typeof repository.data?.default_branch !== "string") {
      return { state: "unavailable", installedCommit };
    }
    branch = repository.data.default_branch;
  }
  const remote = await fetchGitHub(`/repos/${source.repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  if (remote?.status === 404 && source.ref !== undefined) {
    // A ref that is not a branch is a tag in the normal pnpm GitHub workflow;
    // `pnpm update` deliberately keeps it fixed.
    return { state: "fixed", ref: source.ref, installedCommit };
  }
  const remoteCommit = remote?.data?.object?.sha;
  if (remote?.status !== 200 || typeof remoteCommit !== "string") {
    return { state: "unavailable", ref: branch, installedCommit };
  }
  return {
    state: sameCommit(installedCommit, remoteCommit) ? "current" : "available",
    ref: branch,
    installedCommit,
    remoteCommit,
  };
}

// ── Business API ────────────────────────────────────────────────────────────

const PACKAGE_NAME_RE = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

function assertInstalled(dir, manifest, name) {
  if (!PACKAGE_NAME_RE.test(name)) throw new ApiError("bad-request", `invalid package name ${JSON.stringify(name)}`);
  if (!Object.hasOwn(manifest.dependencies ?? {}, name)) {
    throw new ApiError("not-found", `plugin ${JSON.stringify(name)} is not installed in this profile`, 404);
  }
}

function dependencyState(dir, manifest, name) {
  const pkg = installedPackageJson(dir, name);
  const lock = lockedVersion(dir, name);
  return {
    spec: String(manifest.dependencies?.[name] ?? ""),
    installed: typeof pkg?.version === "string" ? pkg.version : null,
    locked: lock ?? null,
  };
}

function dependencyChanged(before, after) {
  return before.spec !== after.spec || before.installed !== after.installed || before.locked !== after.locked;
}

function dependencyStates(dir, manifest) {
  return Object.keys(manifest.dependencies ?? {}).map((name) => [name, dependencyState(dir, manifest, name)]);
}

function dependencySetChanged(before, after) {
  const current = new Map(after);
  if (before.length !== after.length) return true;
  return before.some(([name, state]) => {
    const next = current.get(name);
    return next === undefined || dependencyChanged(state, next);
  });
}

async function list(payload = {}) {
  const dir = profileDir();
  const manifest = readManifest(dir);
  const refresh = payload?.refresh === true;
  const plugins = Object.entries(manifest.dependencies ?? {}).map(([name, spec]) => {
    const pkg = installedPackageJson(dir, name);
    const source = githubSource(typeof spec === "string" ? spec : String(spec));
    return {
      name,
      spec: typeof spec === "string" ? spec : String(spec),
      installed: typeof pkg?.version === "string" ? pkg.version : null,
      description: typeof pkg?.description === "string" ? pkg.description : null,
      isBundle: declaresBundle(dir, name),
      registry: isRegistrySpec(spec),
      git: isGitSpec(spec),
      latest: null,
      gitInfo: isGitSpec(spec) ? localGitInfo(dir, name, String(spec)) : null,
      github: githubRepositoryUrl(source) ?? githubUrl(pkg),
      npm: isRegistrySpec(spec) ? npmUrl(name) : null,
    };
  });
  if (refresh) {
    await Promise.all(plugins.map(async (plugin) => {
      if (plugin.registry) plugin.latest = await fetchLatest(plugin.name);
      if (plugin.git) plugin.gitInfo = await checkGitHubUpdate(dir, plugin.name, plugin.spec);
    }));
  }
  return { profile: basename(dir), plugins };
}

function updatePlugin(name) {
  return enqueueMutation(async (dir) => {
    const before = readManifest(dir);
    assertInstalled(dir, before, name);
    const previous = dependencyState(dir, before, name);
    const spec = String(before.dependencies?.[name]);
    let args;
    if (isRegistrySpec(spec)) {
      args = ["update", name, "--latest"];
    } else if (isGitSpec(spec)) {
      args = ["update", name];
    } else {
      throw new ApiError("update-unavailable", `plugin ${JSON.stringify(name)} is a local dependency and cannot be updated from the registry or a git remote`, 400);
    }
    const result = await runPnpm(args, dir);
    if (result.code !== 0) {
      throw pnpmFailure("update", result);
    }
    const after = reconcile(before, dir);
    const current = dependencyState(dir, after, name);
    const changed = dependencyChanged(previous, current);
    return {
      name,
      changed,
      before: { installed: previous.installed, commit: commitFromLockVersion(previous.locked) ?? null },
      after: { installed: current.installed, commit: commitFromLockVersion(current.locked) ?? null },
      output: tail(result.stdout),
      restartRequired: changed,
    };
  });
}

function updateAll() {
  return enqueueMutation(async (dir) => {
    const before = readManifest(dir);
    const previous = dependencyStates(dir, before);
    const deps = Object.entries(before.dependencies ?? {});
    const registryNames = deps.filter(([, spec]) => isRegistrySpec(String(spec))).map(([name]) => name);
    const gitNames = deps.filter(([, spec]) => isGitSpec(String(spec))).map(([name]) => name);
    const outputs = [];
    if (registryNames.length > 0) {
      const result = await runPnpm(["update", "--latest", ...registryNames], dir);
      if (result.code !== 0) {
        throw pnpmFailure("update", result);
      }
      outputs.push(tail(result.stdout));
      reconcile(before, dir);
    }
    if (gitNames.length > 0) {
      const result = await runPnpm(["update", ...gitNames], dir);
      if (result.code !== 0) {
        throw pnpmFailure("update", result, outputs.length > 0);
      }
      outputs.push(tail(result.stdout));
    }
    if (outputs.length === 0) {
      return { changed: false, output: "Nothing to update.", restartRequired: false };
    }
    const after = reconcile(before, dir);
    const changed = dependencySetChanged(previous, dependencyStates(dir, after));
    return { changed, output: outputs.join("\n"), restartRequired: changed };
  });
}

function removePlugin(name) {
  return enqueueMutation(async (dir) => {
    const before = readManifest(dir);
    assertInstalled(dir, before, name);
    const result = await runPnpm(["remove", name], dir);
    if (result.code !== 0) {
      throw pnpmFailure("remove", result);
    }
    reconcile(before, dir);
    return { name, output: tail(result.stdout), restartRequired: true };
  });
}

const api = {
  list,
  update: (payload) => updatePlugin(requireString(payload, "name")),
  updateAll,
  remove: (payload) => removePlugin(requireString(payload, "name")),
};

// ── Plugin body ─────────────────────────────────────────────────────────────

function apply(ctx) {
  const fence = (req) => isTrustedApiRequest(req, ctx.webRuntime.trustedHosts);

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/plugin-manager/api",
    handler: async (req, res) => {
      if (!fence(req)) {
        writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
        return;
      }
      if (req.method !== "POST") {
        writeJson(res, 405, { ok: false, error: { code: "method-error", message: "method not allowed" } });
        return;
      }
      const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
      const method = pathname.startsWith("/plugin-manager/api/") ? pathname.slice("/plugin-manager/api/".length) : undefined;
      if (method === undefined || method.includes("/")) {
        writeError(res, new ApiError("not-found", "unknown plugin-manager API method", 404));
        return;
      }
      try {
        const handler = api[method];
        if (handler === undefined) throw new ApiError("not-found", `unknown plugin-manager API method "${method}"`, 404);
        const payload = await readJsonBody(req);
        writeOk(res, await handler(payload));
      } catch (error) {
        writeError(res, error);
      }
    },
  }), "dsh-plugin-manager: /plugin-manager/api routes");
}

const inject = ["webServer", "webRuntime"];

export { apply, inject };

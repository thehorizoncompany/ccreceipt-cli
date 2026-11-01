// Daily check for a newer ccreceipt-cli on npm, and the one-line notice it leads to.
//
// The check never slows a command down: the notice uses the answer stored by an earlier
// check, and a check older than a day is refreshed by a detached child process
// (src/update-check.js) that the command does not wait for. The request asks the npm
// registry for the latest version of ccreceipt-cli and sends nothing else.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PACKAGE = "ccreceipt-cli";
export const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE}/latest`;
export const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_SCRIPT = fileURLToPath(new URL("./update-check.js", import.meta.url));

/** Where the last answer is stored: $XDG_CACHE_HOME/ccreceipt/update.json, else ~/.cache/ccreceipt/update.json. */
export function updateCacheFile(env = process.env) {
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ccreceipt", "update.json");
}

/** False in CI, without a terminal, with --json, NO_UPDATE_NOTIFIER or --no-update-check. */
export function updateCheckEnabled({ argv, env, isTTY }) {
  if (!isTTY) return false;
  if (env.CI || env.NO_UPDATE_NOTIFIER) return false;
  if (argv.includes("--no-update-check") || argv.includes("--json")) return false;
  return true;
}

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(String(v || "").trim());
  return m ? { nums: [+m[1], +m[2], +m[3]], pre: !!m[4] } : null;
}

/** True when `latest` is a release strictly newer than `current`. Prereleases on the registry are ignored. */
export function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b || a.pre) return false;
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i];
  return b.pre; // 1.2.0 is newer than 1.2.0-beta
}

/** The update command that matches how this copy was installed, guessed from its path. */
export function installCommand(scriptPath) {
  const p = scriptPath.replace(/\\/g, "/");
  if (p.includes("/_npx/")) return `npx ${PACKAGE}@latest`;
  if (p.includes("/.bun/install/cache/") || /\/bunx-/.test(p)) return `bunx ${PACKAGE}@latest`;
  if (p.includes("/.bun/install/global/")) return `bun add -g ${PACKAGE}`;
  if (p.includes("/pnpm/")) return `pnpm add -g ${PACKAGE}`;
  return `npm i -g ${PACKAGE}`;
}

export function noticeLine(latest, current, command) {
  return `ccreceipt ${latest} is available (you have ${current}): ${command}`;
}

export function readUpdateCache(file) {
  try {
    const c = JSON.parse(readFileSync(file, "utf8"));
    return c && typeof c === "object" ? c : null;
  } catch {
    return null;
  }
}

export function writeUpdateCache(file, data) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data) + "\n");
    return true;
  } catch {
    return false;
  }
}

function spawnCheck(file) {
  try {
    const child = spawn(process.execPath, [CHECK_SCRIPT, file], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* no check this time */
  }
}

/**
 * Starts a background check when the stored one is a day old or missing, and returns the
 * notice line to print when the stored answer is newer than `current`, else null.
 * The check date is written before the child starts, so concurrent runs start one check a day.
 */
export function updateNotice({ current, file, now = Date.now(), scriptPath, startCheck = spawnCheck }) {
  const cache = readUpdateCache(file);
  const last = cache && Number.isFinite(cache.checkedAt) ? cache.checkedAt : 0;
  if (now - last >= DAY_MS || last > now) {
    if (writeUpdateCache(file, { ...cache, checkedAt: now })) startCheck(file);
  }
  return cache && isNewer(cache.latest, current) ? noticeLine(cache.latest, current, installCommand(scriptPath)) : null;
}

/** Asks the registry for the latest version; resolves to null on any error or after `timeoutMs`. */
export async function fetchLatest(url = REGISTRY_URL, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const v = (await res.json())?.version;
    return parseVersion(v) ? v : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Run by the background child: stores the latest version next to the check date. */
export async function refreshUpdateCache(file, url = REGISTRY_URL, now = Date.now()) {
  const latest = await fetchLatest(url);
  if (!latest) return null;
  writeUpdateCache(file, { checkedAt: now, latest });
  return latest;
}

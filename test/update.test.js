import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isNewer, updateCheckEnabled, installCommand, updateNotice, readUpdateCache, fetchLatest, refreshUpdateCache, updateCacheFile, DAY_MS } from "../src/update.js";

const BIN = fileURLToPath(new URL("../bin/ccreceipt.js", import.meta.url));
const DIR = fileURLToPath(new URL("./fixtures/projects", import.meta.url));
const tmp = () => join(mkdtempSync(join(tmpdir(), "ccreceipt-update-")), "update.json");
const NPM = "/usr/lib/node_modules/ccreceipt-cli/bin/ccreceipt.js";

test("isNewer compares releases and ignores prereleases on the registry", () => {
  assert.equal(isNewer("0.3.0", "0.2.1"), true);
  assert.equal(isNewer("0.10.0", "0.9.9"), true);
  assert.equal(isNewer("1.0.0", "0.99.0"), true);
  assert.equal(isNewer("0.2.1", "0.2.1"), false);
  assert.equal(isNewer("0.2.0", "0.2.1"), false);
  assert.equal(isNewer("0.3.0-beta.1", "0.2.1"), false);
  assert.equal(isNewer("0.2.1", "0.2.1-beta"), true);
  assert.equal(isNewer(undefined, "0.2.1"), false);
  assert.equal(isNewer("latest", "0.2.1"), false);
});

test("the check is off in CI, without a terminal, with --json, NO_UPDATE_NOTIFIER or --no-update-check", () => {
  const on = { argv: ["--list"], env: {}, isTTY: true };
  assert.equal(updateCheckEnabled(on), true);
  assert.equal(updateCheckEnabled({ ...on, isTTY: false }), false);
  assert.equal(updateCheckEnabled({ ...on, env: { CI: "true" } }), false);
  assert.equal(updateCheckEnabled({ ...on, env: { NO_UPDATE_NOTIFIER: "1" } }), false);
  assert.equal(updateCheckEnabled({ ...on, argv: ["--json"] }), false);
  assert.equal(updateCheckEnabled({ ...on, argv: ["--list", "--no-update-check"] }), false);
});

test("the update command matches how the CLI was installed", () => {
  assert.equal(installCommand(NPM), "npm i -g ccreceipt-cli");
  assert.equal(installCommand("/home/me/.npm/_npx/1a2b/node_modules/ccreceipt-cli/bin/ccreceipt.js"), "npx ccreceipt-cli@latest");
  assert.equal(installCommand("C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\1a2b\\node_modules\\ccreceipt-cli\\bin\\ccreceipt.js"), "npx ccreceipt-cli@latest");
  assert.equal(installCommand("/home/me/.bun/install/global/node_modules/ccreceipt-cli/bin/ccreceipt.js"), "bun add -g ccreceipt-cli");
  assert.equal(installCommand("/tmp/bunx-501-ccreceipt-cli@latest/node_modules/ccreceipt-cli/bin/ccreceipt.js"), "bunx ccreceipt-cli@latest");
  assert.equal(installCommand("/home/me/.local/share/pnpm/global/5/node_modules/ccreceipt-cli/bin/ccreceipt.js"), "pnpm add -g ccreceipt-cli");
});

test("a newer stored version gives exactly one notice line; the same or an older one gives none", () => {
  const file = tmp();
  const now = Date.now();
  const checks = [];
  const startCheck = (f) => checks.push(f);
  writeFileSync(file, JSON.stringify({ checkedAt: now - 1000, latest: "0.3.0" }));
  assert.equal(updateNotice({ current: "0.2.1", file, now, scriptPath: NPM, startCheck }), "ccreceipt 0.3.0 is available (you have 0.2.1): npm i -g ccreceipt-cli");
  assert.equal(updateNotice({ current: "0.3.0", file, now, scriptPath: NPM, startCheck }), null);
  assert.equal(updateNotice({ current: "0.4.0", file, now, scriptPath: NPM, startCheck }), null);
  assert.equal(checks.length, 0, "a check from a second ago is not repeated");
});

test("at most one registry check every 24 hours", () => {
  const file = tmp();
  const t0 = Date.parse("2026-11-01T10:00:00Z");
  const checks = [];
  const startCheck = (f) => checks.push(f);
  // first run: nothing stored, a check starts and no notice yet
  assert.equal(updateNotice({ current: "0.2.1", file, now: t0, scriptPath: NPM, startCheck }), null);
  assert.deepEqual(checks, [file]);
  assert.equal(readUpdateCache(file).checkedAt, t0);
  // runs during the next 24 hours start no check, even if the first check failed
  for (const h of [0, 1, 12, 23.9]) updateNotice({ current: "0.2.1", file, now: t0 + h * 3600e3, scriptPath: NPM, startCheck });
  assert.equal(checks.length, 1);
  // a day later, one more
  updateNotice({ current: "0.2.1", file, now: t0 + DAY_MS, scriptPath: NPM, startCheck });
  updateNotice({ current: "0.2.1", file, now: t0 + DAY_MS + 1000, scriptPath: NPM, startCheck });
  assert.equal(checks.length, 2);
});

test("the stored version survives the check date being refreshed", () => {
  const file = tmp();
  const t0 = Date.now();
  writeFileSync(file, JSON.stringify({ checkedAt: t0 - 2 * DAY_MS, latest: "0.3.0" }));
  const line = updateNotice({ current: "0.2.1", file, now: t0, scriptPath: NPM, startCheck: () => {} });
  assert.match(line, /0\.3\.0 is available/);
  assert.deepEqual(readUpdateCache(file), { checkedAt: t0, latest: "0.3.0" });
});

test("no check starts when the cache cannot be written", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccreceipt-update-"));
  writeFileSync(join(dir, "ccreceipt"), "a file where the cache directory should be");
  const checks = [];
  updateNotice({ current: "0.2.1", file: join(dir, "ccreceipt", "update.json"), scriptPath: NPM, startCheck: (f) => checks.push(f) });
  assert.equal(checks.length, 0);
});

function registry(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/ccreceipt-cli/latest` }));
  });
}

test("the background check stores the version the registry returns, and asks for nothing else", async () => {
  const seen = [];
  const { server, url } = await registry((req, res) => {
    seen.push({ method: req.method, url: req.url });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ name: "ccreceipt-cli", version: "0.3.0" }));
  });
  try {
    const file = tmp();
    assert.equal(await refreshUpdateCache(file, url, 42), "0.3.0");
    assert.deepEqual(readUpdateCache(file), { checkedAt: 42, latest: "0.3.0" });
    assert.deepEqual(seen, [{ method: "GET", url: "/ccreceipt-cli/latest" }]);
  } finally {
    server.close();
  }
});

test("a slow, broken or unreachable registry gives no version and no error", async () => {
  const slow = await registry((req, res) => setTimeout(() => res.end('{"version":"9.9.9"}'), 2000));
  const broken = await registry((req, res) => res.end("not json"));
  const missing = await registry((req, res) => {
    res.statusCode = 404;
    res.end("{}");
  });
  try {
    const t = Date.now();
    assert.equal(await fetchLatest(slow.url, 200), null);
    assert.ok(Date.now() - t < 1500, "the timeout stops the request");
    assert.equal(await fetchLatest(broken.url), null);
    assert.equal(await fetchLatest(missing.url), null);
    const closed = missing.url.replace(/:\d+\//, ":9/");
    assert.equal(await fetchLatest(closed, 1000), null);
    const file = tmp();
    assert.equal(await refreshUpdateCache(file, broken.url), null);
    assert.equal(existsSync(file), false);
  } finally {
    for (const s of [slow, broken, missing]) s.server.closeAllConnections?.(), s.server.close();
  }
});

test("the cache lives under XDG_CACHE_HOME when it is set", () => {
  assert.equal(updateCacheFile({ XDG_CACHE_HOME: "/x/cache" }), join("/x/cache", "ccreceipt", "update.json"));
  assert.match(updateCacheFile({}), /\.cache[\\/]ccreceipt[\\/]update\.json$/);
});

test("without a terminal the CLI neither checks nor prints a notice", () => {
  const cache = mkdtempSync(join(tmpdir(), "ccreceipt-cache-"));
  const file = join(cache, "ccreceipt", "update.json");
  mkdirSync(join(cache, "ccreceipt"));
  writeFileSync(file, JSON.stringify({ checkedAt: 0, latest: "99.0.0" }));
  const env = { ...process.env, XDG_CACHE_HOME: cache };
  delete env.CI;
  delete env.NO_UPDATE_NOTIFIER;
  const r = spawnSync(process.execPath, [BIN, "--list", "--dir", DIR], { encoding: "utf8", env });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout + r.stderr, /is available/);
  assert.equal(readUpdateCache(file).checkedAt, 0, "no check was started");
});

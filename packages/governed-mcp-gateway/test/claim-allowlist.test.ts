import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  defaultClaimAllowlist,
  effectiveAllowlist,
  loadClaimAllowlistFixture,
  toolsForScopes,
} from "../src/claim-allowlist.ts";
import { createSeededGateway } from "../src/gateway.ts";

test("claim allowlist seed is in-memory and does not open test fixtures", () => {
  const seed = loadClaimAllowlistFixture();
  assert.deepEqual(seed, defaultClaimAllowlist());
  assert.equal(seed.audience, "mcp://governed-gateway");
  assert.deepEqual(toolsForScopes(["tools:echo", "tools:payments"], seed.mappings), [
    "echo.ping",
    "stripe.charge",
  ]);
  assert.deepEqual(
    effectiveAllowlist(["echo.ping", "stripe.charge"], ["tools:echo"], seed.mappings),
    ["echo.ping"],
  );
});

test("createSeededGateway works when cwd has no test/fixtures tree", async () => {
  const prev = process.cwd();
  const isolated = mkdtempSync(join(tmpdir(), "gateway-seed-"));
  try {
    process.chdir(isolated);
    const gateway = createSeededGateway();
    assert.equal(gateway.claims.mappings.length, 3);
    const health = await gateway.handleWebRequest(new Request("http://127.0.0.1/health"));
    assert.equal(health.status, 200);
    const body = (await health.json()) as { ok?: boolean };
    assert.equal(body.ok, true);
  } finally {
    process.chdir(prev);
  }
});

test("loadClaimAllowlistFixture ignores a planted fixture file under cwd", () => {
  const isolated = mkdtempSync(join(tmpdir(), "gateway-planted-"));
  writeFileSync(
    join(isolated, "claim-allowlist.json"),
    JSON.stringify({ audience: "planted" }),
  );
  const prev = process.cwd();
  try {
    process.chdir(isolated);
    const seed = loadClaimAllowlistFixture();
    assert.equal(seed.audience, "mcp://governed-gateway");
    assert.notEqual(seed.audience, "planted");
  } finally {
    process.chdir(prev);
  }
});

test("in-memory seed module is a plain file URL, not a fixtures path", () => {
  const url = pathToFileURL(
    join(dirname(fileURLToPath(import.meta.url)), "../src/claim-allowlist.ts"),
  ).href;
  assert.match(url, /src\/claim-allowlist\.ts$/);
  assert.doesNotMatch(url, /test\/fixtures/);
});

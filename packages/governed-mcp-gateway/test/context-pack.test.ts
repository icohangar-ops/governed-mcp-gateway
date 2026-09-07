import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextPackStore, resolveSessionId } from "../src/context-pack.ts";
import { builtInCatalog, defaultSeedTools } from "../src/tool-catalog.ts";

test("resolveSessionId prefers explicit then meta then header", () => {
  assert.equal(resolveSessionId("agt_payops"), "ses_agt_payops");
  assert.equal(resolveSessionId("agt_payops", "ses_a", "ses_b", "ses_c"), "ses_a");
  assert.equal(resolveSessionId("agt_payops", undefined, "ses_b", "ses_c"), "ses_c");
  assert.equal(resolveSessionId("agt_payops", undefined, "ses_b"), "ses_b");
});

test("default seed is catalog meta-tools plus allowlisted core", () => {
  const seed = defaultSeedTools(["echo.ping", "stripe.charge", "index.query"], builtInCatalog());
  assert.deepEqual(seed.sort(), ["context.inspect", "context.need", "echo.ping"]);
});

test("admit is fail-closed against the principal allowlist", () => {
  const store = new ContextPackStore();
  const catalog = builtInCatalog();
  const result = store.admit("ses_research", "agt_research", ["echo.ping", "search.web"], catalog, {
    tools: ["stripe.charge", "search.web"],
  });
  assert.ok(result.denied.includes("stripe.charge"));
  assert.ok(result.admitted.includes("search.web"));
  assert.ok(!result.tools.includes("stripe.charge"));
  assert.ok(result.tools.includes("search.web"));
});

test("session cannot be reused by another principal", () => {
  const store = new ContextPackStore();
  const catalog = builtInCatalog();
  store.ensure("ses_shared", "agt_payops", ["echo.ping"], catalog);
  assert.throws(
    () => store.ensure("ses_shared", "agt_research", ["echo.ping"], catalog),
    (error: { code?: string }) => error.code === "session_mismatch",
  );
});

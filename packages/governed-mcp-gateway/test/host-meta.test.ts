import assert from "node:assert/strict";
import { test } from "node:test";
import type { Principal } from "@cubiczan/shared";
import {
  HOST_ONLY_ARGUMENT_KEYS,
  bindHostBindings,
  claimedPrincipalConflict,
  inventedHostKeys,
  stripHostOnlyFromSchema,
  stripHostOnlyKeys,
} from "../src/host-meta.ts";

const principal: Principal = {
  id: "agt_payops",
  kind: "agent",
  orgId: "org_acme",
  displayName: "PayOps",
};

test("bindHostBindings uses principal.orgId as tenant", () => {
  const bound = bindHostBindings({
    principal,
    indexClaim: { header: "kb_prod" },
    vault: [{ name: "github_token", version: 2 }],
  });
  assert.equal(bound.ok, true);
  if (!bound.ok) return;
  assert.equal(bound.host.tenant, "org_acme");
  assert.equal(bound.host.index, "kb_prod");
  assert.deepEqual(bound.host.vault.github_token, { name: "github_token", version: 2 });
});

test("tenant claim that does not match orgId is denied", () => {
  const bound = bindHostBindings({
    principal,
    tenantClaim: { header: "org_other" },
    vault: [],
  });
  assert.equal(bound.ok, false);
  if (bound.ok) return;
  assert.match(bound.reason, /does not match/);
  assert.deepEqual(bound.invented, ["tenant"]);
});

test("conflicting index claims are denied", () => {
  const bound = bindHostBindings({
    principal,
    indexClaim: { header: "kb_prod", meta: "kb_other" },
    vault: [],
  });
  assert.equal(bound.ok, false);
  if (bound.ok) return;
  assert.match(bound.reason, /conflicting host index/);
});

test("matching tenant claims are accepted", () => {
  const bound = bindHostBindings({
    principal,
    tenantClaim: { header: "org_acme", query: "org_acme", meta: "org_acme" },
    vault: [],
  });
  assert.equal(bound.ok, true);
});

test("inventedHostKeys finds model-supplied tenant and vault names", () => {
  assert.ok(HOST_ONLY_ARGUMENT_KEYS.includes("tenant"));
  assert.deepEqual(inventedHostKeys({ query: "x", tenant: "org_other", github_token: "steal" }, ["github_token"]), [
    "tenant",
    "github_token",
  ]);
  assert.deepEqual(inventedHostKeys({ query: "x" }), []);
});

test("stripHostOnlyKeys removes host identifiers from arguments", () => {
  const stripped = stripHostOnlyKeys({ query: "leases", tenant: "org_other", index: "kb" });
  assert.deepEqual(stripped.arguments, { query: "leases" });
  assert.deepEqual(stripped.stripped.sort(), ["index", "tenant"]);
});

test("stripHostOnlyFromSchema hides host-only properties", () => {
  const schema = stripHostOnlyFromSchema({
    type: "object",
    properties: {
      query: { type: "string" },
      tenant: { type: "string" },
      index: { type: "string" },
    },
    required: ["query", "tenant"],
  });
  assert.ok(schema && typeof schema === "object" && !Array.isArray(schema));
  const properties = schema.properties as Record<string, unknown>;
  assert.deepEqual(Object.keys(properties), ["query"]);
  assert.deepEqual(schema.required, ["query"]);
});

test("claimedPrincipalConflict detects impersonation", () => {
  assert.equal(claimedPrincipalConflict(principal, undefined), undefined);
  assert.equal(claimedPrincipalConflict(principal, { id: "agt_payops", orgId: "org_acme" }), undefined);
  assert.match(claimedPrincipalConflict(principal, { id: "agt_research" }) ?? "", /agt_research/);
  assert.match(claimedPrincipalConflict(principal, { orgId: "org_other" }) ?? "", /org_other/);
});

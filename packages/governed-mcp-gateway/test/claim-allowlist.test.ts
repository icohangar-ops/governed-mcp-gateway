import assert from "node:assert/strict";
import { test } from "node:test";
import { listen, signHs256Jwt } from "@cubiczan/shared";
import {
  effectiveAllowlist,
  intersectAllowlist,
  loadClaimAllowlistFixture,
  mintFixtureJwt,
  toolsForScopes,
} from "../src/claim-allowlist.ts";
import { GovernedGateway } from "../src/gateway.ts";

const fixture = loadClaimAllowlistFixture();

async function start() {
  const gateway = new GovernedGateway();
  gateway.seedDemo();
  const server = gateway.createHttpServer();
  const port = await listen(server, 0);
  return { gateway, server, base: `http://127.0.0.1:${port}` };
}

async function rpc(base: string, token: string | undefined, method: string, params?: unknown) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

function listedNames(json: { result?: { tools?: Array<{ name: string }> } }): string[] {
  return (json.result?.tools ?? []).map((t) => t.name).sort();
}

test("claim fixture maps scopes and intersects the registered allowlist", () => {
  assert.equal(fixture.audience, "mcp://governed-gateway");
  assert.deepEqual(toolsForScopes(["tools:echo"], fixture.mappings), ["echo.ping"]);
  assert.deepEqual(
    intersectAllowlist(["echo.ping", "stripe.charge"], ["echo.ping"]),
    ["echo.ping"],
  );
  const echoOnly = { id: "agt_payops", kind: "agent" as const, orgId: "org_acme", displayName: "PayOps", scopes: ["tools:echo"] };
  assert.deepEqual(
    effectiveAllowlist(["echo.ping", "stripe.charge"], echoOnly, fixture.mappings),
    ["echo.ping"],
  );
  const opaque = { id: "agt_payops", kind: "agent" as const, orgId: "org_acme", displayName: "PayOps" };
  assert.deepEqual(
    effectiveAllowlist(["echo.ping", "stripe.charge"], opaque, fixture.mappings),
    ["echo.ping", "stripe.charge"],
  );
});

test("missing Bearer is rejected", async () => {
  const { server, base } = await start();
  try {
    const res = await rpc(base, undefined, "tools/list");
    assert.equal(res.status, 401);
    assert.equal(res.json.reason, "missing");
  } finally {
    server.close();
  }
});

test("invalid Bearer is rejected", async () => {
  const { server, base } = await start();
  try {
    const garbage = await rpc(base, "not-a-jwt.or.signed", "tools/list");
    assert.equal(garbage.status, 401);
    assert.equal(garbage.json.reason, "invalid");

    const tampered = mintFixtureJwt(fixture, fixture.cases.validPayops);
    const broken = `${tampered.slice(0, -4)}xxxx`;
    const res = await rpc(base, broken, "tools/list");
    assert.equal(res.status, 401);
    assert.equal(res.json.reason, "invalid");
  } finally {
    server.close();
  }
});

test("expired Bearer is rejected", async () => {
  const { server, base } = await start();
  try {
    const token = mintFixtureJwt(fixture, fixture.cases.expired);
    const res = await rpc(base, token, "tools/list");
    assert.equal(res.status, 401);
    assert.equal(res.json.reason, "expired");
  } finally {
    server.close();
  }
});

test("wrong-aud Bearer is rejected", async () => {
  const { server, base } = await start();
  try {
    const token = mintFixtureJwt(fixture, fixture.cases.wrongAud);
    const res = await rpc(base, token, "tools/list");
    assert.equal(res.status, 401);
    assert.equal(res.json.reason, "wrong_aud");
  } finally {
    server.close();
  }
});

test("guessed tool name is denied", async () => {
  const { server, base } = await start();
  try {
    const token = mintFixtureJwt(fixture, fixture.cases.guessedTool);
    const res = await rpc(base, token, "tools/call", {
      name: fixture.cases.guessedTool.call,
      arguments: {},
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.error.code, -32001);
  } finally {
    server.close();
  }
});

test("allowlist ∩ scope hides and denies payments", async () => {
  const { server, base } = await start();
  try {
    const token = mintFixtureJwt(fixture, fixture.cases.echoOnly);
    const listed = await rpc(base, token, "tools/list", { mode: "full" });
    assert.equal(listed.status, 200);
    const names = listedNames(listed.json);
    assert.ok(names.includes("echo.ping"));
    assert.ok(!names.includes("stripe.charge"));
    assert.deepEqual(listed.json.result._meta.scopes, ["tools:echo"]);
    assert.equal(listed.json.result._meta.principal.id, "agt_payops");

    const denied = await rpc(base, token, "tools/call", {
      name: fixture.cases.intersectDeny.call,
      arguments: { amountCents: 100 },
    });
    assert.equal(denied.status, 200);
    assert.equal(denied.json.error.code, -32001);
  } finally {
    server.close();
  }
});

test("allowlist ∩ scope allows when both grant", async () => {
  const { server, base } = await start();
  try {
    const token = mintFixtureJwt(fixture, fixture.cases.intersectAllow);
    const res = await rpc(base, token, "tools/call", {
      name: fixture.cases.intersectAllow.call,
      arguments: { hello: "scoped" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.result._meta.principal.id, "agt_payops");
    assert.ok(res.json.result._meta.scopes.includes("tools:echo"));
    assert.ok(res.json.result._meta.scopes.includes("tools:payments"));
    assert.equal(res.json.result.structuredContent.principal.id, "agt_payops");
    assert.deepEqual(res.json.result.structuredContent.principal.scopes, ["tools:echo", "tools:payments"]);
  } finally {
    server.close();
  }
});

test("opaque API key is unchanged when scopes are absent", async () => {
  const { server, base } = await start();
  try {
    const res = await rpc(base, "mcp_agt_payops_demo", "tools/list", { mode: "full" });
    assert.equal(res.status, 200);
    const names = listedNames(res.json);
    assert.ok(names.includes("stripe.charge"));
    assert.deepEqual(res.json.result._meta.scopes, []);
    assert.equal(res.json.result._meta.principal.scopes, undefined);
  } finally {
    server.close();
  }
});

test("JWT SSE frame repeats principal and scopes", async () => {
  const { server, base } = await start();
  try {
    const token = mintFixtureJwt(fixture, fixture.cases.echoOnly);
    const res = await fetch(`${base}/mcp/sse?once=1`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /agt_payops/);
    assert.match(text, /tools:echo/);
    assert.match(text, /"principal"/);
  } finally {
    server.close();
  }
});

test("tools/call stamps _meta.principal on the dispatched params", async () => {
  const gateway = new GovernedGateway();
  gateway.seedDemo();
  const token = mintFixtureJwt(fixture, fixture.cases.echoOnly);
  const principal = gateway.authenticate({
    headers: { authorization: `Bearer ${token}` },
  } as any);
  assert.equal(principal.ok, true);
  if (!principal.ok) return;
  const attached = gateway.attachPrincipal(
    { jsonrpc: "2.0", method: "tools/call", params: { name: "echo.ping", arguments: {} } },
    principal.principal,
  );
  const meta = (attached.params as { _meta: { principal: { id: string }; scopes: string[] } })._meta;
  assert.equal(meta.principal.id, "agt_payops");
  assert.deepEqual(meta.scopes, ["tools:echo"]);
});

test("unsigned JWT-shaped token is invalid", () => {
  const forged = signHs256Jwt(
    {
      sub: "agt_payops",
      aud: fixture.audience,
      iss: fixture.issuer,
      exp: Math.floor(Date.now() / 1000) + 3600,
      scope: "tools:echo",
    },
    "some-other-hmac",
  );
  const gateway = new GovernedGateway();
  gateway.seedDemo();
  const result = gateway.authenticate({
    headers: { authorization: `Bearer ${forged}` },
  } as any);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid");
});

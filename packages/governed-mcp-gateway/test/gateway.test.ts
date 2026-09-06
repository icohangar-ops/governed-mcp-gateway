import assert from "node:assert/strict";
import { test } from "node:test";
import { listen } from "@cubiczan/shared";
import { GovernedGateway } from "../src/gateway.ts";

async function start() {
  const gateway = new GovernedGateway();
  const keys = gateway.seedDemo();
  const server = gateway.createHttpServer();
  const port = await listen(server, 0);
  const base = `http://127.0.0.1:${port}`;
  return { gateway, keys, server, base };
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
  return { status: res.status, json: await res.json() };
}

test("missing credential is rejected", async () => {
  const { server, base } = await start();
  try {
    const res = await rpc(base, undefined, "tools/call", { name: "echo.ping" });
    assert.equal(res.status, 401);
    assert.equal(res.json.reason, "missing");
    assert.equal(res.json.result, undefined);
  } finally {
    server.close();
  }
});

test("tools/call injects principal", async () => {
  const { server, base, keys } = await start();
  try {
    const res = await rpc(base, keys.agentKey, "tools/call", {
      name: "echo.ping",
      arguments: { hello: "world" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.result._meta.cubiczan.principal.id, "agt_payops");
    assert.deepEqual(res.json.result._meta.cubiczan.allowedTools, ["echo.ping", "stripe.charge"]);
    assert.deepEqual(res.json.result._meta.cubiczan.scopes, ["mcp.invoke"]);
    assert.equal(res.json.result._meta.cubiczan.token, undefined);
    assert.equal(res.json.result._meta.cubiczan.jwt, undefined);
    const structured = res.json.result.structuredContent;
    assert.equal(structured.principal.id, "agt_payops");
  } finally {
    server.close();
  }
});

test("SSE event repeats principal", async () => {
  const { server, base, keys } = await start();
  try {
    const res = await fetch(`${base}/mcp/sse?once=1`, {
      headers: { authorization: `Bearer ${keys.agentKey}` },
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /event: message/);
    assert.match(text, /agt_payops/);
    assert.match(text, /cubiczan/);
  } finally {
    server.close();
  }
});

test("rotate named MCP input invalidates the old secret", async () => {
  const { server, base, keys, gateway } = await start();
  try {
    assert.equal(gateway.verifyCredential("github_token", "ghp_old_secret_aaaa"), true);
    const rotate = await fetch(`${base}/v1/credentials/github_token/rotate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${keys.humanKey}`,
      },
      body: JSON.stringify({ secret: "ghp_new_secret_bbbb" }),
    });
    const body = await rotate.json();
    assert.equal(rotate.status, 200);
    assert.equal(body.name, "github_token");
    assert.equal(body.version, 2);
    assert.equal(gateway.verifyCredential("github_token", "ghp_old_secret_aaaa"), false);
    assert.equal(gateway.verifyCredential("github_token", "ghp_new_secret_bbbb"), true);
  } finally {
    server.close();
  }
});

test("disallowed tool does not run", async () => {
  const { server, base } = await start();
  try {
    const res = await rpc(base, "mcp_agt_research_demo", "tools/call", {
      name: "stripe.charge",
      arguments: { amountCents: 100 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.error.code, -32001);
  } finally {
    server.close();
  }
});

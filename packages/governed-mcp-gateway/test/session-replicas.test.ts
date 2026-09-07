import assert from "node:assert/strict";
import { test } from "node:test";
import { listen } from "@cubiczan/shared";
import { GovernedGateway } from "../src/gateway.ts";
import {
  InMemorySessionStore,
  KeyValueSessionStore,
  MapRedisLike,
  SESSION_RPC_CODE,
} from "../src/session-store.ts";

async function start(options: ConstructorParameters<typeof GovernedGateway>[0] = {}) {
  const gateway = new GovernedGateway(options);
  const keys = gateway.seedDemo();
  const server = gateway.createHttpServer();
  const port = await listen(server, 0);
  const base = `http://127.0.0.1:${port}`;
  return { gateway, keys, server, base };
}

async function rpc(
  base: string,
  token: string,
  method: string,
  params?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  assert.ok(text.length > 0, "session errors must not be a silent empty body");
  return { status: res.status, json: JSON.parse(text) as Record<string, unknown>, headers: res.headers };
}

test("STATELESS initialize does not mint Mcp-Session-Id and tools/list works without it", async () => {
  const { server, base, keys } = await start({ sessionMode: "stateless", replicaId: "gw-stateless" });
  try {
    const init = await rpc(base, keys.agentKey, "initialize");
    assert.equal(init.status, 200);
    assert.equal(init.headers.get("mcp-session-id"), null);
    const listed = await rpc(base, keys.agentKey, "tools/list");
    assert.equal(listed.status, 200);
    const result = listed.json.result as { tools: Array<{ name: string }>; _meta: { cubiczan: { principal: { id: string } } } };
    assert.ok(result.tools.some((t) => t.name === "echo.ping"));
    assert.equal(result._meta.cubiczan.principal.id, "agt_payops");
  } finally {
    server.close();
  }
});

test("sticky mode fails closed when Mcp-Session-Id is missing", async () => {
  const { server, base, keys, gateway } = await start({ sessionMode: "sticky", replicaId: "gw-a" });
  try {
    const res = await rpc(base, keys.agentKey, "tools/list");
    assert.equal(res.status, 400);
    const error = res.json.error as { code: number; data: { reason: string; hint: string } };
    assert.equal(error.code, SESSION_RPC_CODE);
    assert.equal(error.data.reason, "MISSING_SESSION");
    assert.match(error.data.hint, /stateless|initialize/i);
    assert.ok(gateway.ledger.records.some((r) => r.event === "session.denied"));
  } finally {
    server.close();
  }
});

test("sticky mode fails closed on a stale or unknown session", async () => {
  const { server, base, keys } = await start({ sessionMode: "sticky", replicaId: "gw-a" });
  try {
    const res = await rpc(base, keys.agentKey, "tools/call", { name: "echo.ping" }, {
      "mcp-session-id": "mcp_stale_from_dead_pod",
    });
    assert.equal(res.status, 404);
    const error = res.json.error as { data: { reason: string; sessionId: string } };
    assert.equal(error.data.reason, "SESSION_STICKY_MISMATCH");
    assert.equal(error.data.sessionId, "mcp_stale_from_dead_pod");
  } finally {
    server.close();
  }
});

test("shared mode fails closed on an unknown store miss", async () => {
  const { server, base, keys } = await start({
    sessionMode: "shared",
    replicaId: "gw-a",
    sessionStore: new InMemorySessionStore(),
  });
  try {
    const res = await rpc(base, keys.agentKey, "tools/list", undefined, {
      "mcp-session-id": "mcp_not_in_store",
    });
    assert.equal(res.status, 404);
    const error = res.json.error as { data: { reason: string } };
    assert.equal(error.data.reason, "UNKNOWN_SESSION");
  } finally {
    server.close();
  }
});

test("two replicas: sticky mismatches; shared store succeeds", async () => {
  const shared = new InMemorySessionStore();
  const a = await start({ sessionMode: "sticky", replicaId: "gw-a", sessionStore: shared });
  const bSticky = await start({ sessionMode: "sticky", replicaId: "gw-b", sessionStore: shared });
  const bShared = await start({ sessionMode: "shared", replicaId: "gw-b", sessionStore: shared });
  try {
    const init = await rpc(a.base, a.keys.agentKey, "initialize");
    assert.equal(init.status, 200);
    const sessionId = init.headers.get("mcp-session-id");
    assert.ok(sessionId);
    assert.ok(a.gateway.ledger.records.some((r) => r.event === "session.opened"));

    const mismatch = await rpc(bSticky.base, bSticky.keys.agentKey, "tools/call", {
      name: "echo.ping",
      arguments: { hello: "replica-b" },
    }, { "mcp-session-id": sessionId });
    assert.equal(mismatch.status, 404);
    const denied = mismatch.json.error as { data: { reason: string; replicaId: string; mode: string } };
    assert.equal(denied.data.reason, "SESSION_STICKY_MISMATCH");
    assert.equal(denied.data.replicaId, "gw-b");
    assert.equal(denied.data.mode, "sticky");

    const listed = await rpc(bShared.base, bShared.keys.agentKey, "tools/list", { pack: "payments" }, {
      "mcp-session-id": sessionId,
    });
    assert.equal(listed.status, 200);
    const names = ((listed.json.result as { tools: Array<{ name: string }> }).tools ?? []).map((t) => t.name);
    assert.ok(names.includes("stripe.charge"));

    const called = await rpc(bShared.base, bShared.keys.agentKey, "tools/call", {
      name: "echo.ping",
      arguments: { hello: "shared-store" },
    }, { "mcp-session-id": sessionId });
    assert.equal(called.status, 200);
    const structured = (called.json.result as { structuredContent: { principal: { id: string } } }).structuredContent;
    assert.equal(structured.principal.id, "agt_payops");
    assert.equal((called.json.result as { _meta: { cubiczan: { principal: { id: string } } } })._meta.cubiczan.principal.id, "agt_payops");
  } finally {
    a.server.close();
    bSticky.server.close();
    bShared.server.close();
  }
});

test("Redis-like key/value store is enough for the two-instance proof (no live Redis)", async () => {
  const store = new KeyValueSessionStore(new MapRedisLike());
  const a = await start({ sessionMode: "shared", replicaId: "gw-a", sessionStore: store });
  const b = await start({ sessionMode: "shared", replicaId: "gw-b", sessionStore: store });
  try {
    const init = await rpc(a.base, a.keys.agentKey, "initialize");
    const sessionId = init.headers.get("mcp-session-id");
    assert.ok(sessionId);
    const listed = await rpc(b.base, b.keys.agentKey, "tools/list", undefined, { "mcp-session-id": sessionId });
    assert.equal(listed.status, 200);
    assert.ok(store.get(sessionId));
  } finally {
    a.server.close();
    b.server.close();
  }
});

test("separate in-process stores simulate a load-balanced sticky miss", async () => {
  const a = await start({ sessionMode: "sticky", replicaId: "gw-a", sessionStore: new InMemorySessionStore() });
  const b = await start({ sessionMode: "sticky", replicaId: "gw-b", sessionStore: new InMemorySessionStore() });
  try {
    const init = await rpc(a.base, a.keys.agentKey, "initialize");
    const sessionId = init.headers.get("mcp-session-id");
    assert.ok(sessionId);
    const miss = await rpc(b.base, b.keys.agentKey, "tools/list", undefined, { "mcp-session-id": sessionId });
    assert.equal(miss.status, 404);
    assert.equal((miss.json.error as { data: { reason: string } }).data.reason, "SESSION_STICKY_MISMATCH");
  } finally {
    a.server.close();
    b.server.close();
  }
});

# Design: Streamable HTTP multi-replica sessions

## Current state (investigated)

`ContextPackStore` is an in-process `Map<string, SessionPack>`. Session identity for packs is `X-Cubiczan-Session`, `params.sessionId`, or `params._meta.cubiczan.sessionId`, defaulting to `ses_<principalId>`. `POST /mcp` `initialize` does **not** issue `Mcp-Session-Id`. `tools/list` / `tools/call` work from the Bearer principal (already stamped on RPC). SSE is `GET /mcp/sse`, not a Streamable HTTP session map.

That is already close to STATELESS for transport — and it is also an accidental local pack cache. A second replica will not see admits performed on the first.

## Modes

| Mode | `Mcp-Session-Id` | Store | Missing / unknown |
|---|---|---|---|
| `stateless` (default) | not minted; ignored | pack store may still be local for explicit Cubiczan session headers | transport session not required |
| `sticky` | minted on `initialize` | replica-bound (`replicaId` must match) | `MISSING_SESSION` / `SESSION_STICKY_MISMATCH` |
| `shared` | minted on `initialize` | any replica with the same `SessionStore` | `MISSING_SESSION` / `UNKNOWN_SESSION` |

## Decisions

1. **Default STATELESS.** Principal-on-RPC is enough for `tools/list` and `tools/call`. Clients pass `params.need` / `params.pack` on the same list call when they need a non-default pack. Do not mint `Mcp-Session-Id` by accident.

2. **Sticky is an operator choice, not a hidden default.** Acceptable for a single-replica demo or a cookie-affined ingress when sessions are short-lived. Not acceptable as the HA story: rolling deploys and scale-in destroy the replica that owns the map.

3. **Externalize via `SessionStore`.** `get` / `put` / `delete` / `values`. `InMemorySessionStore` for tests and single process. `KeyValueSessionStore` + `RedisLike` so a Map stands in for Redis in CI. Two gateway instances sharing one store is the multi-replica proof.

4. **Fail closed, never empty 200.** Session errors use HTTP 400/404 **and** a JSON-RPC error (`code` `-32020`) with `data.reason`. Align with silent-probe style codes: `MISSING_SESSION`, `SESSION_STICKY_MISMATCH`. Shared-store miss is `UNKNOWN_SESSION`. Principal clash is `SESSION_PRINCIPAL_MISMATCH`.

5. **Pack store rides the same interface** when a `sessionStore` is injected, so admit-by-need survives replica B in `shared` mode.

## Error shape

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32020,
    "message": "MCP session is unknown on this replica",
    "data": {
      "reason": "SESSION_STICKY_MISMATCH",
      "replicaId": "gw-b",
      "mode": "sticky",
      "sessionId": "mcp_…",
      "hint": "Re-run initialize, enable a shared SessionStore, or switch to STATELESS."
    }
  }
}
```

## Non-goals

- Live Redis, sticky-cookie implementation inside the Node process, or posting an SO answer.
- Changing CHP, allowlists, or host-injected `_meta`.

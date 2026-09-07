# Principal-on-RPC cookbook

Bearer identity arrives on HTTP. MCP tools often run later, on another thread, worker, or SSE writer. **ThreadLocal, request locals, and contextvars are not part of the JSON-RPC message.** Stamp the principal on the RPC payload at the HTTP boundary and read only that.

This gateway implements the pattern. Spring AI `prepareRequestHandlers`, Ballerina MCP resources, and Python SSE servers should do the same — see [recipes](recipes/).

## Loop

```
HTTP Authorization: Bearer
        │
        ▼
 verify (missing / invalid / expired / wrong-aud → 401)
        │
        ▼
 stamp params._meta.principal + params._meta.scopes
        │
        ├─ tools/list  → filter by allowlist ∩ scope
        ├─ tools/call  → re-check allowlist ∩ scope, then run
        └─ SSE frame   → repeat principal + scopes on every event
```

Never:

- Call `SecurityContextHolder`, `RequestContextHolder`, or `contextvars` from a tool.
- Trust the original handshake still being “in scope” when writing `event: message`.
- List a tool the caller cannot invoke, or invoke a tool that was hidden from the list.

## 1. Resolve Bearer at the HTTP boundary

Accept `Authorization: Bearer <token>`. Fail closed before any JSON-RPC method runs:

| Token | Result |
|---|---|
| Missing header / empty Bearer | HTTP 401 `missing` |
| Not a registered API key and not a valid HS256 JWT | HTTP 401 `invalid` |
| `exp` in the past (or `nbf` in the future) | HTTP 401 `expired` |
| `aud` ≠ configured audience | HTTP 401 `wrong_aud` |
| Valid opaque key or valid JWT `sub` | Continue with a Principal |

Opaque demo keys (`mcp_agt_payops_demo`) stay supported. JWTs are an additional shape: HS256, local HMAC, no live IdP.

## 2. Stamp `_meta.principal` and scopes

After auth, copy identity onto the message the tool will see:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "echo.ping",
    "arguments": {},
    "_meta": {
      "principal": { "id": "agt_payops", "kind": "agent", "orgId": "org_acme", "scopes": ["tools:echo"] },
      "scopes": ["tools:echo"],
      "cubiczan": {
        "principal": { "id": "agt_payops", "kind": "agent", "orgId": "org_acme", "scopes": ["tools:echo"] },
        "scopes": ["tools:echo"]
      }
    }
  }
}
```

This repo namespaces product fields under `_meta.cubiczan.*` and also stamps `_meta.principal` / `_meta.scopes` so language recipes can read the short path. Tool code must take principal from `_meta` (or an argument the gateway copied from `_meta`), not from the transport.

## 3. Filter `tools/list` by claim→allowlist

Map JWT `scope` tokens to tool names. Effective tools = **registered allowlist ∩ scope-mapped tools**.

| Scope | Tools |
|---|---|
| `tools:echo` | `echo.ping` |
| `tools:payments` | `stripe.charge` |
| `tools:search` | `search.web` |

`agt_payops` is registered for `echo.ping` and `stripe.charge`. A JWT with only `tools:echo` lists `echo.ping`, not `stripe.charge` — even on `mode=full`. Opaque keys have no `scopes` field and keep their registered allowlist.

Fixture: [`packages/governed-mcp-gateway/test/fixtures/claim-allowlist.json`](../packages/governed-mcp-gateway/test/fixtures/claim-allowlist.json).

## 4. Re-check on `tools/call`

Listing is not authorization. On every call, compute the same intersection. Deny with JSON-RPC `-32001` when:

- The name is not on the registered allowlist
- The name is not granted by the presented scopes
- The caller guessed a name (`vault.exfil`)

Do not run the tool. Do not probe upstream spend or vault.

## 5. Repeat principal on every SSE frame

The handshake that opened `/mcp/sse` is gone by the time you write `event: message`. Each notification must carry `_meta.principal` (and scopes) again.

```http
GET /mcp/sse?once=1
Authorization: Bearer <token>
```

```
event: message
data: {"jsonrpc":"2.0","method":"notifications/message","params":{"_meta":{"principal":{"id":"agt_payops"}}}}
```

## Proof on this gateway

```bash
# Opaque key — existing fail-closed path
curl -sS -H "Authorization: Bearer mcp_agt_payops_demo" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo.ping"}}' \
  http://127.0.0.1:7474/mcp

# Missing Bearer
curl -sS -o /dev/stderr -w "%{http_code}\n" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  http://127.0.0.1:7474/mcp
```

Mint fixture JWTs in tests via `mintFixtureJwt` — do not call a live issuer.

## Language notes

| Stack | Hook | Trap |
|---|---|---|
| [Spring AI](recipes/spring-ai.md) | HTTP filter + `prepareRequestHandlers` | `SecurityContextHolder` is ThreadLocal |
| [Ballerina](recipes/ballerina.md) | HTTP auth on the resource | Isolated workers do not see the request |
| [Python FastAPI](recipes/python-fastapi.md) | Middleware before the SSE / JSON-RPC app | `contextvars` / `request.state` die on the writer task |

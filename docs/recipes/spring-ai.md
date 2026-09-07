# Recipe: Spring AI MCP

Same pattern as the [Principal-on-RPC cookbook](../principal-on-rpc.md). Not a port of this gateway.

`listTools` / `prepareRequestHandlers` often run on the servlet thread where `SecurityContextHolder` still has the JWT. `tools/call` over SSE is dispatched on a pool thread. The holder is empty. Do not fix that with `MODE_INHERITABLETHREADLOCAL` on a pool.

## Hook

1. **HTTP filter / `OncePerRequestFilter`** — decode Bearer (Nimbus / Spring `JwtDecoder`). Missing, invalid, expired, wrong `aud` → 401. No MCP method yet.
2. **Stamp** — in the JSON-RPC interceptor (or a wrapper around `McpServerFeatures` / `prepareRequestHandlers`), copy `Jwt.getSubject()` and `scope` onto `params._meta.principal` and `params._meta.scopes`.
3. **`tools/list`** — filter the `ToolCallback` catalog by allowlist ∩ scope (same table as [`claim-allowlist.json`](../../packages/governed-mcp-gateway/test/fixtures/claim-allowlist.json)).
4. **`tools/call`** — the tool reads `_meta`, not `SecurityContextHolder.getContext()`. Re-check the intersection; guessed names → JSON-RPC deny.
5. **SSE** — when writing `event: message`, put `_meta.principal` on that payload again.

```java
// Tool body — identity from the RPC message only
JsonNode meta = request.getParams().path("_meta");
String principalId = meta.path("principal").path("id").asText();
```

Point the gateway URL at this SKU if you want the TypeScript control plane instead of re-implementing allowlists in Java.

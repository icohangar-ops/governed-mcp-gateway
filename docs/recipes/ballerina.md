# Recipe: Ballerina MCP

Same pattern as the [Principal-on-RPC cookbook](../principal-on-rpc.md). Not a port of this gateway.

A Ballerina HTTP listener can validate JWT on the resource. Isolated MCP workers and streaming responses do not automatically receive that request. Treat the listener as the HTTP boundary only.

## Hook

1. **Listener auth** — `http:JwtValidatorConfig` (issuer, audience, signature). Fail closed: missing / invalid / expired / wrong `aud` → 401.
2. **Stamp** — in the MCP resource that accepts JSON-RPC, write `params._meta.principal` from the validated claims (`sub`, `scope`). Do not store the principal in a module-level `isolated` map keyed by connection unless you also put it on `_meta`.
3. **`tools/list`** — intersect the service's tool table with claim→allowlist mappings.
4. **`onCallTool` / equivalent** — re-check the intersection from `_meta` (or the claims you copied onto the call record). Guessed names deny.
5. **SSE / stream** — each `data:` record repeats `_meta.principal`.

```ballerina
isolated function callTool(mcp:CallToolParams params) returns mcp:CallToolResult|error {
    Principal p = check principalFromMeta(params._meta);
    check recheckAllowlist(p, params.name);
    // ...
}
```

Use this gateway in front of a Ballerina MCP server when you want one allowlist + ledger for every language.

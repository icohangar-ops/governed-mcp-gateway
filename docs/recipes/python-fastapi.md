# Recipe: Python FastAPI (SSE)

Same pattern as the [Principal-on-RPC cookbook](../principal-on-rpc.md). Not a port of this gateway.

Starlette `Request` and `contextvars` are bound to the accept task. FastMCP / SSE tool runners and `EventSourceResponse` writers often run as other tasks. `request.state.user` is gone by the time the tool body executes.

## Hook

1. **Middleware or dependency on the HTTP route** — parse Bearer. PyJWT / authlib locally; no live JWKS in tests. Missing / invalid / expired / wrong `aud` → 401.
2. **Stamp** — before `session.handle` / your JSON-RPC dispatcher, set `params["_meta"]["principal"]` and `params["_meta"]["scopes"]`.
3. **`tools/list`** — filter the FastMCP tool list by allowlist ∩ scope.
4. **Tool functions** — take principal from `_meta` (or an argument the dispatcher copied). Do not read `request`, `ContextVar`, or Flask `g`.
5. **SSE** — each `data:` line includes `_meta.principal` again.

```python
async def dispatch(message: dict, principal: dict) -> dict:
    params = message.setdefault("params", {})
    meta = params.setdefault("_meta", {})
    meta["principal"] = principal
    meta["scopes"] = principal.get("scopes", [])
    # tools/list and tools/call both use meta — not contextvars
    return await handle_rpc(message)
```

Point Claude Desktop / VS Code at this gateway (`:7474`) when you want the already-tested TypeScript path.

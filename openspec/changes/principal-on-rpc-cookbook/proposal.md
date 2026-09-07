# Change: Principal-on-RPC cookbook and claim→allowlist fixtures

## Why

HTTP Bearer auth often succeeds on the request thread (`tools/list`, Spring `prepareRequestHandlers`, Ballerina HTTP, Python SSE handshake) and then vanishes when `tools/call` or an SSE worker runs. ThreadLocal / request locals / `contextvars` are not part of the JSON-RPC message, so tools cannot see the principal. Fail-closed Bearer already exists on this gateway; operators still need a language-agnostic recipe and claim→allowlist fixtures that cover missing, invalid, expired, and wrong-audience tokens plus scope intersection.

## What Changes

- Document the Principal-on-RPC pattern: resolve Bearer at the HTTP boundary → stamp `params._meta.principal` and scopes → filter `tools/list` by claim→allowlist → re-check on `tools/call` → repeat the principal on every SSE frame. Never rely on ThreadLocal.
- Add HMAC-JWT Bearer verification (HS256, no live IdP) beside existing opaque API keys. Fail closed on missing / invalid / expired / wrong-`aud` tokens.
- Add claim→allowlist mapping fixtures. Effective tools are **allowlist ∩ scope**. Guessed tool names are denied.
- Short Spring AI, Ballerina, and Python FastAPI parity notes that point at the same pattern (recipes, not ports).
- README + OpenSpec links.

## Capabilities

- `mcp-gateway`: principal-on-RPC cookbook, JWT claim verification, claim→allowlist ∩ scope, SSE principal repeat (extends existing fail-closed Bearer).

## Impact

- `packages/governed-mcp-gateway` auth path extended; opaque demo keys keep working with their registered allowlists.
- Optional `Principal.scopes` on the shared type; extra `_meta.principal` / `_meta.scopes` stamps (existing `_meta.cubiczan.principal` unchanged).
- Zero new runtime npm dependencies. Tests mint JWTs locally; no live OAuth or Stripe.
- Non-goals: full Spring / Ballerina / FastAPI ports, JWKS/OIDC discovery, changing spend-plane or CFO mesh.

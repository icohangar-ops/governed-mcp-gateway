# Design: Principal-on-RPC and claim→allowlist

## Decisions

1. **Stamp the message, not the thread.** Resolve Bearer once at the HTTP boundary. Copy principal + scopes onto `params._meta` (and `_meta.cubiczan.*` for this SKU). Tool code and SSE writers read `_meta` only.

2. **Two Bearer shapes, one fail-closed door.** Opaque API keys stay (hash → registered agent). Compact HS256 JWTs are an additional shape. Missing header, bad signature, `exp` in the past, or `aud` ≠ configured audience → HTTP 401. No tool runs.

3. **Allowlist ∩ scope.** A JWT `scope` claim maps to tool names via the fixture. Effective tools = the agent's registered allowlist intersected with those tools. Empty/unknown scopes grant nothing beyond gateway meta-tools. Opaque keys have no `scopes` field and keep the registered allowlist (no regression).

4. **Re-check on call.** `tools/list` hides tools outside the intersection. `tools/call` applies the same intersection. Guessing a name (`vault.exfil`, a payments tool without the payments scope) is JSON-RPC `-32001`.

5. **Local HMAC only.** `signHs256Jwt` / `verifyHs256Jwt` use `node:crypto`. Fixture HMAC is a demo string, not a production secret. Tests never call an IdP.

6. **Recipes, not ports.** Spring / Ballerina / FastAPI notes name the hook (`prepareRequestHandlers`, isolated resource, FastAPI middleware) and point back at the cookbook.

## JWT profile (fixtures)

| Claim | Rule |
|---|---|
| `sub` | Must match a registered principal id |
| `aud` | Must equal `mcp://governed-gateway` (configurable) |
| `iss` | Must equal fixture issuer when configured |
| `exp` | Unix seconds; reject if `now >= exp` |
| `scope` | Space-separated; each token maps through the fixture |

## Mapping

| Scope | Tools |
|---|---|
| `tools:echo` | `echo.ping` |
| `tools:payments` | `stripe.charge` |
| `tools:search` | `search.web` |

## Auth order

1. No `Authorization: Bearer` → `missing` → 401
2. Opaque key hash hits a registered agent → principal without `scopes`
3. Compact JWT → verify HS256, `exp`, `aud` (`iss` if set) → principal + `scopes`
4. Anything else → `invalid` → 401

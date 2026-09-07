# Tasks

## 1. Spec and fixtures

- [x] 1.1 OpenSpec proposal, design, and mcp-gateway spec deltas
- [x] 1.2 Claim→allowlist fixture + HS256 JWT helper
- [x] 1.3 Language-agnostic cookbook and Spring / Ballerina / FastAPI recipes

## 2. Gateway

- [x] 2.1 Optional `Principal.scopes`; stamp `_meta.principal` and scopes on call / list / SSE
- [x] 2.2 JWT Bearer path (missing / invalid / expired / wrong-aud → 401)
- [x] 2.3 Effective tools = allowlist ∩ scope; re-check on `tools/call`
- [x] 2.4 Opaque API keys unchanged when `scopes` is absent

## 3. Proof

- [x] 3.1 Tests: fixture cases, guessed tool deny, intersection allow/deny
- [x] 3.2 README + gateway README links

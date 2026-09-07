# mcp-gateway Specification

## ADDED Requirements

### Requirement: Streamable HTTP session mode is explicit
The gateway SHALL run in one of `stateless`, `sticky`, or `shared` session modes. The default SHALL be `stateless`. In `stateless` mode the gateway SHALL NOT mint an `Mcp-Session-Id` and SHALL serve `tools/list` and `tools/call` from the authenticated principal already injected on the RPC (plus request-scoped `need` / `pack` params).

#### Scenario: STATELESS initialize has no transport session
- GIVEN `sessionMode=stateless` and a valid Bearer principal
- WHEN the client sends JSON-RPC `initialize`
- THEN the response does not include an `Mcp-Session-Id` header
- AND a subsequent `tools/list` without that header succeeds

### Requirement: Sticky and shared modes mint Mcp-Session-Id
When `sessionMode` is `sticky` or `shared`, `initialize` SHALL create a session record, persist it in the configured `SessionStore`, and return `Mcp-Session-Id`. Subsequent `tools/list` and `tools/call` in those modes SHALL require that header.

#### Scenario: Sticky initialize issues a session
- GIVEN `sessionMode=sticky`
- WHEN the client sends `initialize`
- THEN the HTTP response includes `Mcp-Session-Id`
- AND the session record's `replicaId` matches this process

### Requirement: Missing or unrecoverable sessions fail closed
If a transport session is required and the `Mcp-Session-Id` is missing, stale, unknown, or bound to another replica and cannot be recovered, the gateway SHALL return an HTTP 400 or 404 **and** a JSON-RPC error (code `-32020`) whose `data.reason` is one of `MISSING_SESSION`, `SESSION_STICKY_MISMATCH`, `UNKNOWN_SESSION`, or `SESSION_PRINCIPAL_MISMATCH`. The gateway SHALL NOT return a silent empty HTTP 200.

#### Scenario: Missing session header in sticky mode
- GIVEN `sessionMode=sticky`
- WHEN the client sends `tools/list` with no `Mcp-Session-Id`
- THEN the response is not HTTP 200 with an empty body
- AND `error.data.reason` is `MISSING_SESSION`

#### Scenario: Session minted on replica A is unknown on replica B in sticky mode
- GIVEN two gateway instances with `sessionMode=sticky` and distinct stores or replica ids
- WHEN replica A handles `initialize` and replica B receives `tools/call` with that `Mcp-Session-Id`
- THEN replica B returns `SESSION_STICKY_MISMATCH`

#### Scenario: Shared store serves the session on any replica
- GIVEN two gateway instances with `sessionMode=shared` and the same `SessionStore`
- WHEN replica A handles `initialize` and replica B receives `tools/list` with that `Mcp-Session-Id`
- THEN replica B returns HTTP 200 and the list result
- AND `_meta.cubiczan.principal` is still present on subsequent `tools/call`

### Requirement: Session store is pluggable without live Redis
The gateway SHALL accept a `SessionStore` (`get` / `put` / `delete`). An in-memory implementation SHALL be sufficient for CI. A Redis-compatible key/value adapter MAY be provided and MUST be testable with an in-process map.

#### Scenario: In-memory store is enough for the two-instance proof
- GIVEN an `InMemorySessionStore` shared by two `GovernedGateway` instances
- WHEN sessions are created on instance A
- THEN instance B can read them without a network Redis

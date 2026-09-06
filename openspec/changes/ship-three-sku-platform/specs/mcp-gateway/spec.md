# mcp-gateway Specification

## ADDED Requirements

### Requirement: Principal is attached to every tool call
The gateway SHALL resolve a Bearer credential to a Principal and SHALL inject that Principal into `params._meta.cubiczan.principal` on every `tools/call` JSON-RPC request before the tool runs.

#### Scenario: Authenticated tool call carries principal
- GIVEN a valid Bearer API key mapped to principal `agt_payops`
- WHEN the client sends `tools/call` for an allowed tool
- THEN the dispatched call includes `_meta.cubiczan.principal.id = agt_payops`
- AND the tool result includes the same principal

#### Scenario: Missing credential is rejected
- GIVEN a request with no Authorization header
- WHEN the client sends `tools/call`
- THEN the gateway returns HTTP 401
- AND no tool runs

### Requirement: SSE does not drop identity
The gateway SHALL include the Principal on every Server-Sent Event associated with a session. Identity SHALL NOT depend on the original HTTP handshake remaining in scope.

#### Scenario: SSE event repeats principal
- GIVEN an authenticated SSE session for principal `agt_payops`
- WHEN the gateway emits a progress or result event
- THEN the event JSON includes `_meta.cubiczan.principal.id = agt_payops`

### Requirement: Credential rotation without rewriting client config
The gateway SHALL allow a vaulted input (for example a VS Code MCP `inputs` token) to be rotated in place. The old secret SHALL be rejected after rotation. The input name SHALL stay stable.

#### Scenario: Rotate a named MCP input
- GIVEN credential input `github_token` with secret A
- WHEN an operator calls rotate on `github_token`
- THEN secret A is rejected on the next request
- AND secret B is accepted
- AND the input name remains `github_token`

### Requirement: Tool allowlists are enforced per principal
The gateway SHALL deny a tool call when the tool is not on the principal's allowlist.

#### Scenario: Disallowed tool
- GIVEN principal `agt_research` allowlisted for `search.web` only
- WHEN it calls `stripe.charge`
- THEN the gateway returns a JSON-RPC error
- AND no spend-plane request is made

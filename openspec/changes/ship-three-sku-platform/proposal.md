# Change: Ship the three-SKU Cubiczan agent platform

## Why

Stack Overflow demand and the icohangar-ops portfolio overlap on three products, not 140 repos: a governed MCP control plane, an agent spend/mandate plane, and an auditable CFO evidence mesh. Production MCP is stuck on auth (principals do not propagate to tools, tokens cannot rotate, SSE drops identity). Payments exist as Stripe, not as dual-control agent mandates. Controllers need board claims that trace to an agent, a CHP lock, and a document.

## What Changes

- Add a **Governed MCP Gateway** that authenticates a principal, attaches it to every tool call, keeps it on SSE events, and rotates vaulted credentials without rewriting client config.
- Add an **Agent Spend & Mandate Plane** that routes `propose → mandate → countersign → settle`, with Stripe as the commercial rail and x402 as an optional settlement rail.
- Add an **Auditable CFO Agent Mesh** that binds every board claim to an agent, a CHP lock, source documents, and a sealed evidence pack, with lease / revenue / SBC measurement engines.

## Capabilities

- `mcp-gateway`: principal propagation, credential rotation, SSE identity, tool allowlists, optional spend-plane hook.
- `spend-mandate`: dual-key spend (agent proposes, mandate authorizes, human countersigns, rail settles).
- `cfo-mesh`: claim → agent → lock → document evidence packs plus ASC 842 / 606 / 718 engines.

## Impact

- New workspace packages under `packages/`.
- Reuses CHP, clearance, two-key, meshcfo, lease842, poc-revenue, and sbc-ledger ideas as production-shaped TypeScript — does not vendor those repos wholesale.
- Non-goals: a new MCP server catalog, live Stripe charges in tests, on-chain x402 settlement in CI, a full CHP Python engine.

## Approach

One npm workspace, three independently startable HTTP services that speak JSON. Shared HMAC ledger + CHP gate. Tests use Node's built-in test runner.

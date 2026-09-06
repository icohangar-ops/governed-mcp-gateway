# Design: three-SKU agent platform

## Architecture

```
MCP client (Cursor / VS Code / Claude)
        │  Bearer principal + JSON-RPC
        ▼
governed-mcp-gateway :7474
  • vault (rotate credentials)
  • allowlist
  • inject principal into tools/call and SSE
        │  optional POST /v1/proposals
        ▼
spend-mandate-plane :7475
  • lanes: auto | approval | blocked
  • countersign
  • rails: stripe (default) | x402
        │  on LOCKED spend or board claim
        ▼
cfo-agent-mesh :7476
  • claim graph: claim → agent → lock → documents
  • engines: lease842, poc-revenue, sbc
  • HMAC-chained evidence pack
```

## Decisions

1. **TypeScript / Node http, no framework.** Matches two-key and agent-conductor. Zero runtime npm deps; `tsx` is a dev runner.
2. **Integer cents** for spend. Accounting engines expose decimal strings quantized to 0.01.
3. **Principal is a first-class object**, never inferred from a connection. SSE events re-attach `params._meta.cubiczan.principal` on every frame so identity cannot drop when the transport is SSE.
4. **Stripe is a rail, not the SKU.** Settlement returns a Stripe-shaped meter event in test mode. x402 is an interface that records a payment required challenge; it does not talk to a chain in this MVP.
5. **CHP is a gate, not a chatbot.** R0 (solvable, scoped, valid, worthIt) + adversarial findings + lock progression. Human countersign moves PROVISIONAL → LOCKED.
6. **Evidence pack is the CFO SKU.** A claim is not done until it has agent id, lock state, source document hashes, and a chained HMAC signature.

## Trade-offs

- In-memory stores: correct for the MVP and tests; swap the store interface later for Postgres.
- Duplicate-small vs publish-shared: packages depend on `@cubiczan/shared` via workspaces. Independent GitHub repos vendor `shared/` at publish time.
- No live OAuth provider: gateway accepts Bearer API keys that map to principals. OAuth token introspection is a later adapter behind the same Principal type.

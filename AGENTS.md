You are working in cubiczan-agent-platform.

Three SKUs: governed-mcp-gateway (:7474), spend-mandate-plane (:7475), cfo-agent-mesh (:7476).
Shared primitives live in packages/shared (CHP gate, HMAC ledger, HTTP helpers).
Specs: openspec/changes/ship-three-sku-platform/.
Do not commit secrets. Stripe and x402 are rails; do not call live networks in tests.

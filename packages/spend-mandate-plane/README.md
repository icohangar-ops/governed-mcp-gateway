# Agent Spend & Mandate Plane

Port **7475**. Agents propose. Mandates authorize. A human countersigns. Stripe settles.

Stripe is the commercial adjacency. x402 is a **rail**, not the SKU. Flow: **propose → mandate → countersign → settle**.

![Platform: spend plane between MCP gateway and CFO mesh](docs/screenshots/architecture.png)

- Under the agent auto-cap **and** a covering mandate: lane `auto`, CHP `LOCKED`, ready to meter
- Over cap: lane `approval`, CHP `PROVISIONAL`. A **human** second key must countersign. The proposing agent cannot countersign itself
- `POST /v1/settle` with `rail: "stripe"` (default) records `evt_meter_*`. `rail: "x402"` records `x402_payreq_*` without talking to a chain

Amounts are integer cents internally. The HTTP `total` field is a decimal string (`"12.00"`).

## Live behavior

![$12 under cap auto-locks against the Stripe mandate](docs/screenshots/spend-auto.png)

![$80 over cap: agent 400, human LOCKED](docs/screenshots/spend-countersign.png)

![Stripe meter event vs x402 payment-required](docs/screenshots/spend-settle.png)

## Run

From the platform root:

```bash
npm install
npm test -w @cubiczan/spend-mandate-plane
npm run spend
```

Propose (demo agent, covering mandate `man_stripe_monthly`, auto cap $50):

```bash
curl -sS -H "Authorization: Bearer spend_agt_payops_demo" \
  -H "Content-Type: application/json" \
  -d '{"agent":"agt_payops","merchant":{"name":"Stripe","url":"https://stripe.com","country":"US"},"total":"12.00","rationale":"metered tool call"}' \
  http://127.0.0.1:7475/v1/proposals
```

Over cap, then human countersign, then Stripe settle:

```bash
# 1) proposal returns lane=approval, chpState=PROVISIONAL
# 2) agent countersign is rejected
curl -sS -H "Authorization: Bearer spend_agt_payops_demo" \
  -H "Content-Type: application/json" \
  -d '{"proposalId":"prp_…"}' \
  http://127.0.0.1:7475/v1/countersign
# -> 400  {"error":"agent cannot countersign itself"}

# 3) human second key
curl -sS -H "Authorization: Bearer spend_human_controller_demo" \
  -H "Content-Type: application/json" \
  -d '{"proposalId":"prp_…","notes":"approved for vendor"}' \
  http://127.0.0.1:7475/v1/countersign

# 4) settle
curl -sS -H "Content-Type: application/json" \
  -d '{"proposalId":"prp_…","rail":"stripe"}' \
  http://127.0.0.1:7475/v1/settle
```

## API

| Method | Path | Auth | What |
|---|---|---|---|
| `GET` | `/health` | — | `{ ok, service }` |
| `POST` | `/v1/mandates` | Human | Remaining-cents coverage for an agent + merchant |
| `POST` | `/v1/proposals` | Agent | Lane `auto` \| `approval` \| `blocked` |
| `POST` | `/v1/countersign` | Human | `PROVISIONAL` → `LOCKED`; agents rejected |
| `POST` | `/v1/settle` | — | `{ proposalId, rail: "stripe" \| "x402" }` |

Demo keys: `spend_agt_payops_demo`, `spend_human_controller_demo`. Seed mandate covers `https://stripe.com` for `agt_payops`.

Tests do not call Stripe or a chain.

## Layout

```
packages/spend-mandate-plane/src/plane.ts   lanes, dual-key, rails
packages/shared                             CHP gate, cents, HMAC ledger
```

Sister SKUs: [governed-mcp-gateway](https://github.com/icohangar-ops/governed-mcp-gateway) (`:7474`), [cfo-agent-mesh](https://github.com/icohangar-ops/cfo-agent-mesh) (`:7476`).

## License

MIT

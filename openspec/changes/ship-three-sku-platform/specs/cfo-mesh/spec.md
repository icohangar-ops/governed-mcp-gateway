# cfo-mesh Specification

## ADDED Requirements

### Requirement: Every board claim traces to agent, lock, and document
The mesh SHALL refuse to seal an evidence pack unless the claim has a producing agent id, a CHP lock state of LOCKED, and at least one source document hash.

#### Scenario: Incomplete claim cannot seal
- GIVEN a claim with an agent but no documents
- WHEN an operator requests the evidence pack
- THEN the mesh returns an error
- AND no HMAC signature is produced

#### Scenario: Complete claim seals
- GIVEN a claim with agent `agt_lease`, lock LOCKED, and a document hash
- WHEN an operator requests the evidence pack
- THEN the pack includes claim id, agent id, lock state, document hashes, and a chained signature
- AND verifying the ledger succeeds

### Requirement: Lease, revenue, and SBC engines are measurement-only
The mesh SHALL measure leases (ASC 842), over-time revenue (ASC 606 cost-to-cost), and share-based compensation (ASC 718). Engines SHALL NOT decide whether a contract is a lease, whether a performance obligation exists, or which volatility to use.

#### Scenario: Finance lease rollforward
- GIVEN a 24-month lease with ownership transfer
- WHEN the lease engine runs
- THEN classification is finance
- AND closing liability after the final period is 0.00

#### Scenario: Constrained POC revenue
- GIVEN costs incurred 40 of 100 estimated and constrained price 80 of 100 transaction price
- WHEN the revenue engine runs
- THEN percent complete is 0.4000
- AND revenue to date is 32.00

### Requirement: Token spend is an auditable source
The mesh SHALL append token-usage events to the same HMAC ledger as claims so a board narrative can cite model spend.

#### Scenario: Token event is a source
- GIVEN a claim about AI cost
- WHEN a token usage event for 1200 tokens is recorded against the claim
- THEN the evidence pack lists that event as a source

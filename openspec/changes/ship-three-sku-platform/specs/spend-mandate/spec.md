# spend-mandate Specification

## ADDED Requirements

### Requirement: Agents propose, mandates authorize
The plane SHALL accept a spend proposal from an agent and SHALL route it to `auto`, `approval`, or `blocked` using agent cap, merchant policy, and matching mandate remaining amount.

#### Scenario: Auto-execute under cap with covering mandate
- GIVEN an agent cap of $50.00 and a mandate with $200.00 remaining on the same merchant
- WHEN the agent proposes a $12.00 purchase at that merchant
- THEN the lane is `auto`
- AND the proposal can settle without a human countersignature

#### Scenario: Over cap requires countersign
- GIVEN an agent cap of $50.00
- WHEN the agent proposes $80.00
- THEN the lane is `approval`
- AND settlement is refused until a second key countersigns

### Requirement: Countersign is the second key
A proposal in `approval` SHALL NOT settle until a distinct human principal countersigns. The countersigning principal SHALL NOT be the proposing agent.

#### Scenario: Agent cannot countersign itself
- GIVEN a pending proposal from `agt_payops`
- WHEN `agt_payops` submits a countersignature
- THEN the plane rejects the countersign
- AND the proposal remains `approval`

#### Scenario: Human countersign unlocks settlement
- GIVEN a pending proposal from `agt_payops`
- WHEN principal `human.controller` countersigns
- THEN the CHP state becomes LOCKED
- AND Stripe rail settlement is allowed

### Requirement: Stripe is the default rail; x402 is optional
Settlement SHALL default to the Stripe rail and MAY use the x402 rail. x402 SHALL NOT be required to ship the SKU.

#### Scenario: Stripe meter event on settle
- GIVEN a LOCKED proposal
- WHEN settle is called with rail `stripe`
- THEN the plane records a meter event with amount cents and clearance id

#### Scenario: x402 rail records payment-required
- GIVEN a LOCKED proposal
- WHEN settle is called with rail `x402`
- THEN the plane records a payment-required challenge
- AND does not require an on-chain client in this version

export type ChpState =
  | "EXPLORING"
  | "PROVISIONAL"
  | "PROVISIONAL_LOCK"
  | "LOCKED"
  | "REJECTED";

export interface Principal {
  id: string;
  kind: "agent" | "human" | "service";
  orgId: string;
  displayName: string;
  /** JWT `scope` values when the Bearer is a claim token. Absent for opaque API keys. */
  scopes?: string[];
}

export interface R0 {
  solvable: boolean;
  scoped: boolean;
  valid: boolean;
  worthIt: boolean;
}

export interface ChpInput {
  action: string;
  amountCents: number;
  principal: Principal;
  policyMaxAutoCents: number;
  spendCapCents: number;
  spendUsedCents: number;
  allowed: boolean;
  blocked: boolean;
  scoped: boolean;
}

export interface ChpResult {
  state: ChpState;
  r0: R0;
  foundations: string[];
  attackFindings: string[];
  rationale: string;
}

export function runChpGate(input: ChpInput): ChpResult {
  const foundations = [
    `Principal ${input.principal.id} is authenticated for org ${input.principal.orgId}`,
    "Policy pack is current",
    "Amounts are integer cents",
  ];
  const attackFindings: string[] = [];
  const withinCap = input.spendUsedCents + input.amountCents <= input.spendCapCents;

  if (!input.allowed) attackFindings.push("Adversarial: action is outside the allowlist");
  if (input.blocked) attackFindings.push("Adversarial: vendor or tool is blocked");
  if (!withinCap) attackFindings.push("Adversarial: spend cap would be exceeded");
  if (/ignore|override|jailbreak/i.test(input.action)) {
    attackFindings.push("Adversarial: injection markers in action");
  }

  const r0: R0 = {
    solvable: input.allowed && !input.blocked,
    scoped: input.scoped,
    valid: withinCap && input.amountCents >= 0,
    worthIt: input.amountCents <= input.policyMaxAutoCents * 10,
  };
  const r0Pass = r0.solvable && r0.scoped && r0.valid && r0.worthIt;
  const hardFail = attackFindings.some(
    (f) => f.includes("blocked") || f.includes("injection") || f.includes("allowlist"),
  );

  if (!r0Pass || hardFail) {
    return {
      state: "REJECTED",
      r0,
      foundations,
      attackFindings,
      rationale: `CHP denied for ${input.principal.id}: R0 or hard adversarial failure.`,
    };
  }

  if (input.amountCents > input.policyMaxAutoCents) {
    return {
      state: "PROVISIONAL",
      r0,
      foundations,
      attackFindings: [
        ...attackFindings,
        "Devil's advocate: amount exceeds auto-approve — human lock required",
      ],
      rationale: `Amount ${input.amountCents} cents exceeds auto-approve ${input.policyMaxAutoCents}.`,
    };
  }

  if (attackFindings.length > 0) {
    return {
      state: "PROVISIONAL_LOCK",
      r0,
      foundations,
      attackFindings,
      rationale: "Soft adversarial findings — human confirmation required.",
    };
  }

  return {
    state: "LOCKED",
    r0,
    foundations,
    attackFindings: ["Devil's advocate: no material objections at routine tier"],
    rationale: `Auto-locked under policy for ${input.principal.id}.`,
  };
}

export function applyHumanLock(
  decision: "approve" | "reject",
  notes?: string,
): { state: ChpState; rationale: string } {
  if (decision === "approve") {
    return {
      state: "LOCKED",
      rationale: notes?.trim() || "Human validator locked after CHP review.",
    };
  }
  return {
    state: "REJECTED",
    rationale: notes?.trim() || "Human validator rejected.",
  };
}

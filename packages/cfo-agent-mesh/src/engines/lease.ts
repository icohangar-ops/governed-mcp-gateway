import { money } from "@cubiczan/shared";

export type Classification = "finance" | "operating" | "short_term";

export interface Payment {
  period: number;
  amount: number;
}

export interface Lease {
  leaseId: string;
  description: string;
  payments: Payment[];
  annualIbr: number;
  paymentsPerYear?: number;
  economicLifePeriods?: number;
  fairValue?: number;
  transfersOwnership?: boolean;
  purchaseOptionReasonablyCertain?: boolean;
  specializedNoAlternativeUse?: boolean;
  initialDirectCosts?: number;
  incentives?: number;
  prepaid?: number;
}

export interface PeriodRow {
  period: number;
  openingLiability: string;
  interest: string;
  payment: string;
  principal: string;
  closingLiability: string;
  rouAmortization: string;
  closingRou: string;
  periodExpense: string;
}

export interface LeaseResult {
  leaseId: string;
  classification: Classification;
  reasons: string[];
  periodicRate: number;
  initialLiability: string;
  initialRou: string;
  schedule: PeriodRow[];
}

const MAJOR_PART = 0.75;
const SUBSTANTIALLY_ALL = 0.9;

function n(value: number): number {
  return Math.round(value * 100) / 100;
}

export function presentValue(payments: Payment[], rate: number): number {
  let total = 0;
  for (const pmt of payments) {
    if (pmt.period <= 0) throw new Error("payment periods are 1-indexed");
    total += pmt.amount / (1 + rate) ** pmt.period;
  }
  return n(total);
}

export function classify(lease: Lease): { classification: Classification; reasons: string[] } {
  const nPeriods = lease.payments.length;
  const perYear = lease.paymentsPerYear ?? 12;
  if (nPeriods === 0) return { classification: "short_term", reasons: ["no remaining payments"] };
  if (
    nPeriods <= perYear &&
    !lease.purchaseOptionReasonablyCertain &&
    !lease.transfersOwnership
  ) {
    return {
      classification: "short_term",
      reasons: [`term ${nPeriods} periods <= 12 months and no reasonably certain purchase option`],
    };
  }
  const reasons: string[] = [];
  if (lease.transfersOwnership) reasons.push("ownership transfers at end of term (ASC 842-10-25-2a)");
  if (lease.purchaseOptionReasonablyCertain) {
    reasons.push("purchase option reasonably certain to be exercised (25-2b)");
  }
  if (lease.economicLifePeriods && nPeriods / lease.economicLifePeriods >= MAJOR_PART) {
    reasons.push("term is major part of remaining economic life");
  }
  const rate = lease.annualIbr / perYear;
  const pv = presentValue(lease.payments, rate);
  if (lease.fairValue && pv / lease.fairValue >= SUBSTANTIALLY_ALL) {
    reasons.push("PV is substantially all of fair value");
  }
  if (lease.specializedNoAlternativeUse) reasons.push("specialized asset with no alternative use (25-2e)");
  if (reasons.length) return { classification: "finance", reasons };
  return { classification: "operating", reasons: ["no finance-lease indicator met"] };
}

export function rollforward(lease: Lease): LeaseResult {
  const { classification, reasons } = classify(lease);
  const perYear = lease.paymentsPerYear ?? 12;
  const rate = lease.annualIbr / perYear;
  const initialLiability = presentValue(lease.payments, rate);
  const initialRou = n(
    initialLiability + (lease.initialDirectCosts ?? 0) + (lease.prepaid ?? 0) - (lease.incentives ?? 0),
  );
  if (classification === "short_term") {
    return {
      leaseId: lease.leaseId,
      classification,
      reasons,
      periodicRate: rate,
      initialLiability: money(0),
      initialRou: money(0),
      schedule: lease.payments.map((pmt) => ({
        period: pmt.period,
        openingLiability: money(0),
        interest: money(0),
        payment: money(pmt.amount),
        principal: money(pmt.amount),
        closingLiability: money(0),
        rouAmortization: money(0),
        closingRou: money(0),
        periodExpense: money(pmt.amount),
      })),
    };
  }

  const sl = n(lease.payments.reduce((s, p) => s + p.amount, 0) / lease.payments.length);
  let liab = initialLiability;
  let rou = initialRou;
  const schedule: PeriodRow[] = [];
  lease.payments.forEach((pmt, i) => {
    const opening = liab;
    let interest = n(opening * rate);
    let principal = n(pmt.amount - interest);
    if (i === lease.payments.length - 1) {
      principal = opening;
      interest = n(pmt.amount - principal);
    }
    liab = n(opening - principal);
    const remaining = lease.payments.length - i;
    let amort: number;
    let expense: number;
    if (classification === "finance") {
      amort = n(rou / remaining);
      expense = n(interest + amort);
    } else {
      amort = n(sl - interest);
      expense = sl;
    }
    rou = n(rou - amort);
    if (i === lease.payments.length - 1) {
      rou = 0;
      liab = 0;
    }
    schedule.push({
      period: pmt.period,
      openingLiability: money(opening),
      interest: money(interest),
      payment: money(pmt.amount),
      principal: money(principal),
      closingLiability: money(liab),
      rouAmortization: money(amort),
      closingRou: money(rou),
      periodExpense: money(expense),
    });
  });

  return {
    leaseId: lease.leaseId,
    classification,
    reasons,
    periodicRate: rate,
    initialLiability: money(initialLiability),
    initialRou: money(initialRou),
    schedule,
  };
}

export function levelPayments(amount: number, periods: number): Payment[] {
  return Array.from({ length: periods }, (_, i) => ({ period: i + 1, amount }));
}

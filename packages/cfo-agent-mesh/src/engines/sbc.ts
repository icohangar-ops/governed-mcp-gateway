import { money } from "@cubiczan/shared";

export type AwardType = "option" | "rsu";

export interface Grant {
  grantId: string;
  awardType: AwardType;
  grantDate: string;
  shares: number;
  serviceYears: number;
  grantDateFv?: number;
  strike?: number;
  spot?: number;
  expectedTermYears?: number;
  riskFreeRate?: number;
  volatility?: number;
  dividendYield?: number;
  expectedForfeitureRate?: number;
}

export interface PeriodExpense {
  grantId: string;
  unitFv: string;
  expectedToVest: string;
  totalCost: string;
  yearsElapsed: string;
  cumulativeBefore: string;
  periodCost: string;
  remaining: string;
  forfeitedThisPeriod: number;
}

function ncdf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * abs);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-abs * abs);
  return 0.5 * (1 + sign * y);
}

export function blackScholesCall(
  spot: number,
  strike: number,
  years: number,
  rate: number,
  volatility: number,
  dividendYield = 0,
): number {
  if (years <= 0 || volatility <= 0 || spot <= 0 || strike <= 0) {
    return Math.round(Math.max(spot - strike, 0) * 100) / 100;
  }
  const d1 =
    (Math.log(spot / strike) + (rate - dividendYield + (volatility * volatility) / 2) * years) /
    (volatility * Math.sqrt(years));
  const d2 = d1 - volatility * Math.sqrt(years);
  const call =
    Math.exp(-dividendYield * years) * spot * ncdf(d1) -
    Math.exp(-rate * years) * strike * ncdf(d2);
  return Math.round(call * 100) / 100;
}

export function unitFairValue(grant: Grant): number {
  if (grant.grantDateFv != null) return grant.grantDateFv;
  if (grant.awardType === "rsu") {
    if (grant.spot == null) throw new Error(`${grant.grantId}: RSU needs grantDateFv or spot`);
    return grant.spot;
  }
  if (
    grant.spot == null ||
    grant.strike == null ||
    grant.expectedTermYears == null ||
    grant.riskFreeRate == null ||
    grant.volatility == null
  ) {
    throw new Error(`${grant.grantId}: option needs FV or Black-Scholes inputs`);
  }
  return blackScholesCall(
    grant.spot,
    grant.strike,
    grant.expectedTermYears,
    grant.riskFreeRate,
    grant.volatility,
    grant.dividendYield ?? 0,
  );
}

function yearsBetween(start: string, end: string): number {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Math.round((ms / (365 * 24 * 3600 * 1000)) * 10000) / 10000;
}

export function periodExpense(
  grant: Grant,
  periodStart: string,
  periodEnd: string,
  actualForfeitures = 0,
): PeriodExpense {
  const fv = unitFairValue(grant);
  const remainingShares = Math.max(grant.shares - actualForfeitures, 0);
  const expectedToVest =
    Math.round(remainingShares * (1 - (grant.expectedForfeitureRate ?? 0)) * 100) / 100;
  const totalCost = Math.round(expectedToVest * fv * 100) / 100;
  const elapsedEnd = Math.min(yearsBetween(grant.grantDate, periodEnd), grant.serviceYears);
  const elapsedStart = Math.min(
    Math.max(yearsBetween(grant.grantDate, periodStart), 0),
    grant.serviceYears,
  );
  const fracEnd = grant.serviceYears ? elapsedEnd / grant.serviceYears : 1;
  const fracStart = grant.serviceYears ? elapsedStart / grant.serviceYears : 0;
  const cumulativeEnd = Math.round(totalCost * fracEnd * 100) / 100;
  const cumulativeBefore = Math.round(totalCost * fracStart * 100) / 100;
  return {
    grantId: grant.grantId,
    unitFv: money(fv),
    expectedToVest: money(expectedToVest),
    totalCost: money(totalCost),
    yearsElapsed: elapsedEnd.toFixed(4),
    cumulativeBefore: money(cumulativeBefore),
    periodCost: money(cumulativeEnd - cumulativeBefore),
    remaining: money(totalCost - cumulativeEnd),
    forfeitedThisPeriod: actualForfeitures,
  };
}

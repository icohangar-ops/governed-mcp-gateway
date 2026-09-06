import { money } from "@cubiczan/shared";

export type Timing = "over_time" | "point_in_time";

export interface Contract {
  contractId: string;
  description: string;
  timing: Timing;
  transactionPrice: number;
  constrainedPrice: number;
  estimatedTotalCost: number;
  costsIncurredToDate: number;
  billingsToDate: number;
  complete?: boolean;
}

export interface Measurement {
  contractId: string;
  poc: string;
  price: string;
  revenueToDate: string;
  costsToDate: string;
  estimatedTotalLoss: string;
  lossProvision: string;
  grossProfitToDate: string;
  billings: string;
  contractAsset: string;
  contractLiability: string;
  costOfRevenue: string;
}

function n(value: number): number {
  return Math.round(value * 100) / 100;
}

export function measure(contract: Contract): Measurement {
  if (contract.constrainedPrice > contract.transactionPrice) {
    throw new Error(`${contract.contractId}: constrained price cannot exceed transaction price`);
  }
  const price = contract.constrainedPrice;
  if (contract.timing === "point_in_time") {
    const revenue = contract.complete ? price : 0;
    const costs = contract.complete ? contract.costsIncurredToDate : 0;
    return {
      contractId: contract.contractId,
      poc: contract.complete ? "1.0000" : "0.0000",
      price: money(price),
      revenueToDate: money(revenue),
      costsToDate: money(costs),
      estimatedTotalLoss: money(0),
      lossProvision: money(0),
      grossProfitToDate: money(revenue - costs),
      billings: money(contract.billingsToDate),
      contractAsset: money(Math.max(revenue - contract.billingsToDate, 0)),
      contractLiability: money(Math.max(contract.billingsToDate - revenue, 0)),
      costOfRevenue: money(costs),
    };
  }
  if (contract.estimatedTotalCost <= 0) {
    throw new Error(`${contract.contractId}: estimated total cost must be positive`);
  }
  let poc = Math.round((contract.costsIncurredToDate / contract.estimatedTotalCost) * 10000) / 10000;
  if (poc > 1) poc = 1;
  const revenue = n(price * poc);
  const estimatedProfit = n(price - contract.estimatedTotalCost);
  const estimatedLoss = estimatedProfit < 0 ? n(-estimatedProfit) : 0;
  let gp: number;
  let costOfRevenue: number;
  let lossProvision: number;
  if (estimatedLoss > 0) {
    gp = n(-estimatedLoss);
    costOfRevenue = n(revenue - gp);
    lossProvision = Math.max(n(estimatedLoss - n(contract.costsIncurredToDate - revenue)), 0);
  } else {
    gp = n(revenue - contract.costsIncurredToDate);
    costOfRevenue = contract.costsIncurredToDate;
    lossProvision = 0;
  }
  return {
    contractId: contract.contractId,
    poc: poc.toFixed(4),
    price: money(price),
    revenueToDate: money(revenue),
    costsToDate: money(contract.costsIncurredToDate),
    estimatedTotalLoss: money(estimatedLoss),
    lossProvision: money(lossProvision),
    grossProfitToDate: money(gp),
    billings: money(contract.billingsToDate),
    contractAsset: money(Math.max(revenue - contract.billingsToDate, 0)),
    contractLiability: money(Math.max(contract.billingsToDate - revenue, 0)),
    costOfRevenue: money(costOfRevenue),
  };
}

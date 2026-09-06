import { canonicalJson, hmacHex, isoNow, newId } from "./util.ts";

export interface LedgerRecord {
  id: string;
  ts: string;
  event: string;
  actor: string;
  inputs: unknown;
  sources: string[];
  confidence?: string;
  rationale?: string;
  prevSig: string;
  sig: string;
}

export class AuditLedger {
  readonly records: LedgerRecord[] = [];

  constructor(private readonly key: string) {}

  append(partial: Omit<LedgerRecord, "id" | "ts" | "prevSig" | "sig"> & { ts?: string }): LedgerRecord {
    const prevSig = this.records.at(-1)?.sig ?? "";
    const record: LedgerRecord = {
      id: newId("aud"),
      ts: partial.ts ?? isoNow(),
      event: partial.event,
      actor: partial.actor,
      inputs: partial.inputs,
      sources: partial.sources,
      confidence: partial.confidence,
      rationale: partial.rationale,
      prevSig,
      sig: "",
    };
    record.sig = hmacHex(this.key, canonicalJson(record) + prevSig);
    this.records.push(record);
    return record;
  }

  verify(): { ok: boolean; brokenAt?: number } {
    let prev = "";
    for (let i = 0; i < this.records.length; i += 1) {
      const rec = this.records[i];
      if (rec.prevSig !== prev) return { ok: false, brokenAt: i };
      const expected = hmacHex(this.key, canonicalJson(rec) + rec.prevSig);
      if (expected !== rec.sig) return { ok: false, brokenAt: i };
      prev = rec.sig;
    }
    return { ok: true };
  }
}

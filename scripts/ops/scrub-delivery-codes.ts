/**
 * One-off clean-up after Phase 1: removes player codes that older code left in
 * clear in the message log (message_deliveries). See src/lib/messaging/scrubCodes.ts
 * for what a row becomes: `vars.code` dropped (a queued announcement row to a
 * player keeps a `code_ref` and reads the code at send time), every spelling of the
 * code in the stored message replaced by "[removed]", and the code part of
 * "Send code"'s idempotency key replaced. Rows: every row with a `vars.code`, and
 * every row whose purpose is access_code / access_codes.
 *
 *   SUPABASE_URL=… SUPABASE_KEY=<secret key> npx tsx scripts/ops/scrub-delivery-codes.ts            # counts only (dry run)
 *   SUPABASE_URL=… SUPABASE_KEY=<secret key> npx tsx scripts/ops/scrub-delivery-codes.ts --apply    # writes
 *
 * A dry run by default; prints counts only, never a code or an address. Safe to run
 * again. scripts/ops/hash-player-codes.ts runs it too (after hashing).
 */
import { db } from "../../src/lib/supabase";
import { CODE_PURPOSES, scrubDeliveryRow, type StoredDelivery } from "../../src/lib/messaging/scrubCodes";

const COLS = "id, announcement_id, purpose, status, recipient_kind, recipient_id, vars, payload, idempotency_key";
const PAGE = 500;

export interface ScrubCounts {
  scanned: number;
  withCode: number;
  vars: number;
  payload: number;
  keys: number;
  stopped: number;
  written: number;
}

async function pages(filter: "purpose" | "vars", visit: (rows: StoredDelivery[]) => Promise<void>) {
  for (let from = 0; ; from += PAGE) {
    const base = db().from("message_deliveries").select(COLS).order("id").range(from, from + PAGE - 1);
    const { data, error } = await (filter === "purpose" ? base.in("purpose", [...CODE_PURPOSES]) : base.not("vars->>code", "is", null));
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as StoredDelivery[];
    await visit(rows);
    if (rows.length < PAGE) return;
  }
}

/** Scrubs (or, with `dryRun`, counts) every delivery row that still holds a code. */
export async function scrubDeliveryCodes({ dryRun }: { dryRun: boolean }): Promise<ScrubCounts> {
  const counts: ScrubCounts = { scanned: 0, withCode: 0, vars: 0, payload: 0, keys: 0, stopped: 0, written: 0 };
  const seen = new Set<string>();
  const plans: { id: string; patch: ReturnType<typeof scrubDeliveryRow> }[] = [];
  for (const filter of ["purpose", "vars"] as const) {
    await pages(filter, async (rows) => {
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        counts.scanned++;
        const patch = scrubDeliveryRow(r);
        if (!patch) continue;
        counts.withCode++;
        if (patch.vars) counts.vars++;
        if (patch.payload !== undefined) counts.payload++;
        if (patch.idempotency_key) counts.keys++;
        if (patch.status) counts.stopped++;
        plans.push({ id: r.id, patch });
      }
    });
  }
  // Written after reading, so a page never shifts under the scan.
  if (!dryRun) {
    for (const { id, patch } of plans) {
      const { error } = await db().from("message_deliveries").update(patch!).eq("id", id);
      if (error) throw new Error(error.message);
      counts.written++;
    }
  }
  return counts;
}

export function describe(c: ScrubCounts, dryRun: boolean, howToWrite = "pass --apply to write"): string {
  return `Delivery rows scanned: ${c.scanned}; holding a code: ${c.withCode} (vars ${c.vars}, message ${c.payload}, idempotency key ${c.keys}; queued sends stopped ${c.stopped}); ${dryRun ? `dry run, nothing written (${howToWrite})` : `scrubbed ${c.written}`}.`;
}

async function main() {
  const dryRun = !process.argv.includes("--apply");
  const c = await scrubDeliveryCodes({ dryRun });
  console.log(describe(c, dryRun));
}

if (process.argv[1]?.endsWith("scrub-delivery-codes.ts")) {
  void main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

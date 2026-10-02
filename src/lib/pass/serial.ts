/**
 * Pass serials count up per event from 1. The next one is the highest taken plus
 * one (never a row count: deleted passes leave gaps, and a count would then keep
 * landing on serials that are still in use). Two phones opening at the same
 * moment can pick the same number; the database's unique (event, serial) refuses
 * the second, which then reads the highest again and tries the next one.
 */
export type InsertOutcome = "ok" | "taken" | "error";

export const SERIAL_TRIES = 25;

export async function allocateSerial(ops: {
  /** The highest serial in use for the event, 0 when none. */
  highest: () => Promise<number>;
  /** Tries to insert with this serial. "taken" is a unique violation. */
  insert: (serial: number) => Promise<InsertOutcome>;
  /** After a unique violation: did the owner's own pass appear meanwhile (a double tap)? */
  ownerHasPass: () => Promise<boolean>;
  tries?: number;
}): Promise<number | null> {
  const tries = ops.tries ?? SERIAL_TRIES;
  let floor = 0;
  for (let attempt = 0; attempt < tries; attempt++) {
    // A read that lags behind a refused insert must not pick the same number again.
    const serial = Math.max((await ops.highest()) + 1, floor + 1);
    const outcome = await ops.insert(serial);
    if (outcome === "ok") return serial;
    if (outcome === "error") return null;
    if (await ops.ownerHasPass()) return null;
    floor = serial;
  }
  return null;
}

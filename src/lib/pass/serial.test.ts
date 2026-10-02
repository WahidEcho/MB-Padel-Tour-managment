import { describe, expect, it } from "vitest";
import { allocateSerial, type InsertOutcome } from "./serial";

/** An event's passes as a set of serials, with the database's unique (event, serial). */
function event(serials: number[]) {
  const taken = new Set(serials);
  return {
    taken,
    highest: async () => (taken.size ? Math.max(...taken) : 0),
    insert: async (s: number): Promise<InsertOutcome> => {
      if (taken.has(s)) return "taken";
      taken.add(s);
      return "ok";
    },
    ownerHasPass: async () => false,
  };
}

describe("pass serials", () => {
  it("starts at 1", async () => {
    expect(await allocateSerial(event([]))).toBe(1);
  });

  it("keeps working after many passes were deleted (a row count would collide every time)", async () => {
    // Twenty passes, then fifteen deleted from the middle: five rows left, highest is 20.
    const e = event([1, 2, 3, 4, 20]);
    expect(await allocateSerial(e)).toBe(21);
    expect(await allocateSerial(e)).toBe(22);
  });

  it("retries when another phone takes the same number at the same moment", async () => {
    const e = event([1, 2, 3]);
    let raced = 0;
    const s = await allocateSerial({
      ...e,
      // The read lags: two phones keep seeing 3 while others insert 4, 5, 6.
      highest: async () => 3,
      insert: async (n) => {
        if (raced < 3) {
          raced++;
          e.taken.add(n);
          return "taken";
        }
        return e.insert(n);
      },
    });
    expect(s).toBe(7);
  });

  it("stops when the owner's own pass appeared (a double tap) or the insert fails", async () => {
    const e = event([1]);
    expect(await allocateSerial({ ...e, insert: async () => "taken", ownerHasPass: async () => true })).toBeNull();
    expect(await allocateSerial({ ...e, insert: async () => "error" })).toBeNull();
  });

  it("gives up after enough tries instead of looping forever", async () => {
    let calls = 0;
    const s = await allocateSerial({ highest: async () => 0, insert: async () => (calls++, "taken"), ownerHasPass: async () => false, tries: 10 });
    expect(s).toBeNull();
    expect(calls).toBe(10);
  });
});

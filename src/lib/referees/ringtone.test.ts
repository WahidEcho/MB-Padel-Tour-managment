import { describe, expect, it, vi } from "vitest";

vi.mock("../supabase", () => ({ db: () => ({}) }));
const { ringsWithAlarm } = await import("./assistance");

describe("which phones ring calls with the Move Score ringtone", () => {
  it("1.0.3 and later; older versions keep their channel and sound", () => {
    for (const v of ["1.0.3", "1.0.10", "1.1.0", "2.0.0"]) expect(ringsWithAlarm(v)).toBe(true);
    for (const v of ["1.0.2", "1.0.1", "1.0.0", "", null, undefined, "abc"]) expect(ringsWithAlarm(v)).toBe(false);
  });
});

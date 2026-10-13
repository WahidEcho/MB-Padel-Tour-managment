import { describe, expect, it } from "vitest";
import { inDiscoverOrder, parseDiscoverOrder } from "./discoverOrder";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const G = "00000000-0000-4000-8000-0000000000ff";

describe("parseDiscoverOrder", () => {
  it("keeps ids only, once, in order", () => {
    expect(parseDiscoverOrder([B, A, B, "x", 3, null])).toEqual([B, A]);
    expect(parseDiscoverOrder({ ids: [A] })).toEqual([]);
    expect(parseDiscoverOrder(null)).toEqual([]);
  });
});

describe("inDiscoverOrder", () => {
  const items = [
    { id: A, group: null },
    { id: B, group: G },
    { id: C, group: null },
  ];
  const keys = (x: (typeof items)[number]) => [x.id, x.group];

  it("puts listed items first, by their own id or their group's", () => {
    expect(inDiscoverOrder(items, keys, [C, G]).map((x) => x.id)).toEqual([C, B, A]);
  });

  it("leaves the order alone when nothing is listed", () => {
    expect(inDiscoverOrder(items, keys, []).map((x) => x.id)).toEqual([A, B, C]);
  });
});

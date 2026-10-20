import { describe, expect, it } from "vitest";
import { clientIpFrom } from "./ratelimit";

const h = (o: Record<string, string>) => new Headers(o);

describe("clientIpFrom (audit L8)", () => {
  it("on Vercel reads Vercel's own header, never a client's X-Forwarded-For", () => {
    const env = { VERCEL: "1" };
    expect(clientIpFrom(h({ "x-forwarded-for": "6.6.6.6", "x-vercel-forwarded-for": "203.0.113.9", "x-real-ip": "203.0.113.9" }), env)).toBe("203.0.113.9");
    expect(clientIpFrom(h({ "x-forwarded-for": "6.6.6.6", "x-real-ip": "203.0.113.7" }), env)).toBe("203.0.113.7");
    expect(clientIpFrom(h({ "x-forwarded-for": "6.6.6.6" }), env)).toBe("unknown");
  });
  it("elsewhere (local, E2E) takes X-Forwarded-For's first hop, then x-real-ip", () => {
    expect(clientIpFrom(h({ "x-forwarded-for": "198.51.100.4, 10.0.0.1" }), {})).toBe("198.51.100.4");
    expect(clientIpFrom(h({ "x-real-ip": "198.51.100.5" }), {})).toBe("198.51.100.5");
    expect(clientIpFrom(h({}), {})).toBe("unknown");
  });
});

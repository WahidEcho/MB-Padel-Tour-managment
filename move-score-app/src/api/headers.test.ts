import { describe, expect, it } from "vitest";
import { credentialHeaders } from "./headers";

const phone = { installToken: "inst.1.sig", userToken: null, staffToken: "staff-token" };

describe("credential headers", () => {
  it("never sends the referee console's token with a personal call (the pass bug)", () => {
    const h = credentialHeaders("me", "/api/mobile/v1/me/pass", phone);
    expect(h["X-Staff-Token"]).toBeUndefined();
    expect(Object.values(h)).not.toContain("staff-token");
    expect(Object.values(h)).not.toContain("Bearer staff-token");
    expect(h["X-Install-Token"]).toBe("inst.1.sig");
  });
  it("sends the account session on personal calls when signed in", () => {
    expect(credentialHeaders("me", "/api/mobile/v1/me/pass", { ...phone, userToken: "u" }).Authorization).toBe("Bearer u");
  });
  it("sends the staff token only on referee calls, with the install token", () => {
    const h = credentialHeaders("staff", "/api/mobile/v1/referee/tournaments", phone);
    expect(h.Authorization).toBe("Bearer staff-token");
    expect(h["X-Install-Token"]).toBe("inst.1.sig");
  });
  it("sends nothing on public reads, except the install token for a match's state", () => {
    expect(credentialHeaders("public", "/api/mobile/v1/discover", phone)).toEqual({ Accept: "application/json" });
    expect(credentialHeaders("public", "/api/matches/abc/state", phone)["X-Install-Token"]).toBe("inst.1.sig");
  });
});

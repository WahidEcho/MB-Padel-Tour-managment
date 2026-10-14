import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Refusal, formResult, isRefusal, refusal } from "./refusal";

describe("refusals answer the form instead of an error page", () => {
  it("returns a Refusal's words, and the work's own message when it went through", async () => {
    await expect(formResult(async () => refusal("Type REFUND to confirm."))).resolves.toEqual({ ok: false, message: "Type REFUND to confirm." });
    await expect(formResult(async () => "Refunded EGP 500.")).resolves.toEqual({ ok: true, message: "Refunded EGP 500." });
    await expect(formResult(async () => undefined, "Saved.")).resolves.toEqual({ ok: true, message: "Saved." });
  });

  it("rethrows everything else (guards, database failures, redirects)", async () => {
    await expect(formResult(async () => { throw new Error("Not found"); })).rejects.toThrow("Not found");
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/x;307;" });
    await expect(formResult(async () => { throw redirect; })).rejects.toBe(redirect);
  });

  it("recognises a Refusal (and a subclass) by brand too", () => {
    class Full extends Refusal {}
    expect(isRefusal(new Full("The event is full"))).toBe(true);
    expect(isRefusal(new Error("x"))).toBe(false);
    expect(isRefusal(null)).toBe(false);
  });

  it("the registrations page's actions answer their forms and the refund confirm is checked on the server", () => {
    const actions = readFileSync(join(__dirname, "..", "app", "admin", "tournaments", "[id]", "registrations", "actions.ts"), "utf8");
    for (const name of ["saveRegistrationSettings", "decideRegistrationAction", "markVenuePaidAction", "refundRegistrationAction", "pairRegistrationsAction"]) {
      expect(actions).toMatch(new RegExp(`export async function ${name}\\(_prev: FormState, formData: FormData\\): Promise<FormState>`));
    }
    expect(actions).toMatch(/toUpperCase\(\) !== "REFUND"\) refusal\("Type REFUND to confirm\."\)/);
    const page = readFileSync(join(__dirname, "..", "app", "admin", "tournaments", "[id]", "registrations", "page.tsx"), "utf8");
    expect(page).not.toMatch(/<form\b/);
    expect(page).toMatch(/pattern="REFUND"/);
  });
});

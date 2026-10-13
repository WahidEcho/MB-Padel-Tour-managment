/**
 * Phase 1 security review (0026): the pure rules. The database side (the email
 * fallback, the scope of an offer, merges, the per-phone guess budget) is attacked
 * end to end in scripts/e2e/mobile-api.ts.
 */
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codesReady, localDatabase, openPlayerCode, playerCodePepper, sealPlayerCode } from "./codeVault";
import { scrubDeliveryRow, REMOVED, type StoredDelivery } from "../messaging/scrubCodes";
import { planDeliveries, type Recipient } from "../messaging/recipients";

const PEPPER = "p".repeat(40);

describe("L4: the derived pepper only for a local database", () => {
  it("knows a local database", () => {
    expect(localDatabase(undefined)).toBe(true);
    expect(localDatabase("http://localhost:54321")).toBe(true);
    expect(localDatabase("http://127.0.0.1:54321")).toBe(true);
    expect(localDatabase("http://[::1]:54321")).toBe(true);
    expect(localDatabase("https://dwyztzywuscljqklhqij.supabase.co")).toBe(false);
    expect(localDatabase("https://localhost.example.com")).toBe(false);
    expect(localDatabase("not a url")).toBe(false);
  });
  it("refuses to derive a pepper against a real project", () => {
    const live = { NODE_ENV: "development", AUTH_SECRET: "a", SUPABASE_URL: "https://dwyztzywuscljqklhqij.supabase.co" };
    expect(() => playerCodePepper(live)).toThrow(/not local/);
    expect(codesReady(live)).toBe(false);
    expect(playerCodePepper({ ...live, PLAYER_CODE_PEPPER: PEPPER })).toBe(PEPPER);
    expect(playerCodePepper({ ...live, SUPABASE_URL: "http://localhost:54321" })).toHaveLength(43);
  });
});

describe("L5: a seal's tag is the full 16 bytes", () => {
  it("refuses a truncated tag", () => {
    const sealed = sealPlayerCode("ABCD2345", PEPPER);
    const [v, iv, tag, body] = sealed.split(".");
    expect(openPlayerCode(sealed, PEPPER)).toBe("ABCD2345");
    const short = [v, iv, Buffer.from(tag!, "base64url").subarray(0, 4).toString("base64url"), body].join(".");
    expect(openPlayerCode(short, PEPPER)).toBeNull();
    // A seal made with a 4-byte tag on purpose does not open either.
    const key = createHmac("sha256", PEPPER).update("mb-player-code-seal:v1").digest();
    const iv2 = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv2, { authTagLength: 4 });
    const enc = Buffer.concat([c.update("ABCD2345", "utf8"), c.final()]);
    expect(openPlayerCode(["v1", iv2.toString("base64url"), c.getAuthTag().toString("base64url"), enc.toString("base64url")].join("."), PEPPER)).toBeNull();
  });
});

describe("M3: codes left in the message log", () => {
  const base: StoredDelivery = { id: "11111111-2222-3333-4444-555555555555", announcement_id: null, purpose: "access_code", status: "sent", recipient_kind: "player", recipient_id: "p1", vars: null, payload: null, idempotency_key: null };
  it("scrubs Send code's vars, message and idempotency key", () => {
    const row: StoredDelivery = {
      ...base,
      vars: { name: "Adam", code: "ABCD-2345", tournament: "Cup" },
      payload: { kind: "email", subject: "Your code", html: "<b>ABCD-2345</b> or abcd2345", text: "Code: ABCD-2345 (ABCD2345)" },
      idempotency_key: "player-code:p1:email:ABCD2345:2026-10-13T08:53",
    };
    const p = scrubDeliveryRow(row)!;
    const all = JSON.stringify(p);
    expect(all).not.toMatch(/ABCD-?2345/i);
    expect(p.vars).toEqual({ name: "Adam", tournament: "Cup" });
    expect(JSON.stringify(p.payload)).toContain(REMOVED);
    expect(p.idempotency_key).toBe("player-code:p1:email:scrubbed-1111111122223333:2026-10-13T08:53");
    expect(p.status).toBeUndefined(); // already sent: nothing to stop
  });
  it("finds the code in a key alone, and stops a queued send whose message lost it", () => {
    const p = scrubDeliveryRow({ ...base, status: "queued", payload: { kind: "wa_text", text: "Your code ABCD-2345" }, idempotency_key: "player-code:p1:whatsapp:ABCD2345:2026-10-13T08:53" })!;
    expect(JSON.stringify(p)).not.toContain("2345");
    expect(p.status).toBe("failed");
  });
  it("leaves a fingerprint key and a row without a code alone", () => {
    expect(scrubDeliveryRow({ ...base, idempotency_key: "player-code:p1:email:0123456789abcdef:2026-10-13T08:53", vars: { name: "A" } })).toBeNull();
    expect(scrubDeliveryRow({ ...base, purpose: "announcement", vars: { name: "A", code_ref: "p1" } })).toBeNull();
  });
  it("an old queued announcement row to a player keeps a code reference instead", () => {
    const p = scrubDeliveryRow({ ...base, announcement_id: "a1", purpose: "access_codes", status: "queued", vars: { name: "A", code: "ABCD-2345" } })!;
    expect(p.vars).toEqual({ name: "A", code_ref: "p1" });
    expect(p.status).toBeUndefined();
  });
  it("the drain reads only code_ref", () => {
    const src = readFileSync(join(__dirname, "../messaging/queue.ts"), "utf8");
    expect(src).not.toMatch(/row\.vars\?\.code\b(?!_ref)/);
  });
});

describe("L3: a player's code never goes to the team's contact number", () => {
  const r = (phoneSource: "player" | "team"): Recipient => ({
    kind: "player",
    id: `p-${phoneSource}`,
    name: "A",
    email: null,
    phone: phoneSource === "team" ? "+201001112233" : "+201001112244",
    vars: { name: "A", code: "ABCD-2345", code_ref: `p-${phoneSource}` },
    sources: { email: null, phone: phoneSource },
  });
  it("skips it in a codes announcement", () => {
    const { rows, preview } = planDeliveries([r("player"), r("team")], ["whatsapp"], { requireCode: true });
    expect(rows.find((x) => x.recipient_id === "p-team")?.status).toBe("skipped");
    expect(rows.find((x) => x.recipient_id === "p-team")?.error_code).toBe("team_contact");
    expect(rows.find((x) => x.recipient_id === "p-player")?.status).toBe("queued");
    expect(preview.whatsapp.reachable).toBe(1);
  });
  it("drops the code from any other message to it", () => {
    const { rows } = planDeliveries([r("team")], ["whatsapp"]);
    expect(rows[0]!.status).toBe("queued");
    expect(rows[0]!.vars.code).toBeNull();
    expect(rows[0]!.vars.code_ref).toBeNull();
  });
});

describe("H1/strictBody: the routes as written", () => {
  const route = (p: string) => readFileSync(join(__dirname, "../../app/api/mobile/v1", p), "utf8");
  it("PATCH /me/player and POST /me/player/claim take known fields only", () => {
    expect(route("me/player/route.ts")).toMatch(/strictBody\(request, \["phone"\]\)/);
    expect(route("me/player/claim/route.ts")).toMatch(/strictBody\(request, \["code"\]\)/);
  });
  it("the player's own number never lands in players.phone", () => {
    const claims = readFileSync(join(__dirname, "claims.ts"), "utf8");
    const fn = claims.slice(claims.indexOf("export async function setMyPhone"), claims.indexOf("export type PhotoCheck"));
    expect(fn).toMatch(/self_reported_phone: e164/);
    expect(fn).not.toMatch(/\{ phone: e164/);
  });
  it("the email fallback sends only to the account's own address", () => {
    const src = readFileSync(join(__dirname, "phoneLink.ts"), "utf8");
    expect(src).not.toMatch(/emailsForPhone/);
    expect(src).toMatch(/sendOneTimeCode\(\{ channel: "email", to: email, code \}\)/);
  });
});

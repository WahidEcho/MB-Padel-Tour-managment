import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REGISTRATION_SETTINGS,
  archiveAt,
  canMove,
  charges,
  endOfDay,
  initialStatus,
  minorFromMajor,
  moneyLabel,
  paymentOptions,
  peoplePerEntry,
  refundAllowed,
  refundAmount,
  registrationClosedReason,
  registrationSettings,
  statusAfterApproval,
  storedRegistrationSettings,
} from "./rules";
import { signatureHeader, verifySignature } from "./signature";
import { moveTickConfig, parseWebhook } from "./moveTick";

const SECRET = "s".repeat(40);
const REF = "0b7c3f3e-2a7e-4d55-9d1f-5f0d8c9f2a11";

describe("settings", () => {
  it("defaults are the conservative ones the owner has not overruled yet", () => {
    expect(DEFAULT_REGISTRATION_SETTINGS.open).toBe(false);
    expect(DEFAULT_REGISTRATION_SETTINGS.approvalMode).toBe("organiser");
    expect(DEFAULT_REGISTRATION_SETTINGS.teamPayer).toBe("registrant");
    expect(DEFAULT_REGISTRATION_SETTINGS.refundFeePercent).toBe(0);
    expect(registrationSettings(null)).toEqual(DEFAULT_REGISTRATION_SETTINGS);
  });
  it("cleans bad input to the defaults and clamps ranges", () => {
    const s = registrationSettings({ open: "yes", entry_type: "squad", team_size: 99, approval_mode: "x", fee_amount: -5, payment: "bitcoin", refund_fee_percent: 80, capacity: "0" });
    expect(s.open).toBe(false);
    expect(s.entryType).toBe("team");
    expect(s.teamSize).toBe(8);
    expect(s.approvalMode).toBe("organiser");
    expect(s.feeAmount).toBe(0);
    expect(s.payment).toBe("free");
    expect(s.refundFeePercent).toBe(20);
    expect(s.capacity).toBeNull();
  });
  it("a fee is never free; no fee is always free; individual entry is one person", () => {
    expect(registrationSettings({ feeAmount: 5000, payment: "free" }).payment).toBe("venue");
    expect(registrationSettings({ feeAmount: 0, payment: "online" }).payment).toBe("free");
    expect(registrationSettings({ entryType: "individual", teamSize: 4 }).teamSize).toBe(1);
    expect(peoplePerEntry({ entryType: "individual", teamSize: 1 })).toBe(1);
    expect(peoplePerEntry({ entryType: "team", teamSize: 2 })).toBe(2);
  });
  it("round-trips through the stored row", () => {
    const s = registrationSettings({ open: true, entryType: "team", teamSize: 2, approvalMode: "automatic", feeAmount: 25000, payment: "online_or_venue", teamPayer: "each_player", refundFeePercent: 3, capacity: 16, closesAt: "2026-11-01T10:00:00Z", note: "Bring water" });
    expect(registrationSettings(storedRegistrationSettings(s))).toEqual(s);
  });
});

describe("payment options and charges", () => {
  const paid = { feeAmount: 25000, payment: "online_or_venue" as const };
  it("online only for an organisation with Move Tick; otherwise pay at the venue", () => {
    expect(paymentOptions(paid, true)).toEqual(["online", "venue"]);
    expect(paymentOptions(paid, false)).toEqual(["venue"]);
    expect(paymentOptions({ feeAmount: 25000, payment: "online" }, false)).toEqual(["venue"]);
    expect(paymentOptions({ feeAmount: 25000, payment: "online" }, true)).toEqual(["online"]);
    expect(paymentOptions({ feeAmount: 0, payment: "online" }, true)).toEqual(["free"]);
  });
  it("the registrant pays for the team by default; each player's share otherwise", () => {
    const team = { feeAmount: 25000, entryType: "team" as const, teamSize: 2 };
    expect(charges({ ...team, teamPayer: "registrant" }, "online")).toEqual({ online: 50000, venue: 0, total: 50000 });
    expect(charges({ ...team, teamPayer: "each_player" }, "online")).toEqual({ online: 25000, venue: 25000, total: 50000 });
    expect(charges({ ...team, teamPayer: "registrant" }, "venue")).toEqual({ online: 0, venue: 50000, total: 50000 });
    expect(charges({ ...team, teamPayer: "registrant" }, "free")).toEqual({ online: 0, venue: 0, total: 0 });
  });
  it("approval comes before payment", () => {
    expect(initialStatus({ approvalMode: "organiser" }, 50000)).toBe("pending_approval");
    expect(initialStatus({ approvalMode: "automatic" }, 50000)).toBe("awaiting_payment");
    expect(initialStatus({ approvalMode: "automatic" }, 0)).toBe("confirmed");
    expect(statusAfterApproval(50000, false)).toBe("awaiting_payment");
    expect(statusAfterApproval(50000, true)).toBe("confirmed");
    expect(statusAfterApproval(0, false)).toBe("confirmed");
  });
  it("only the allowed moves", () => {
    expect(canMove("pending_approval", "confirmed")).toBe(true);
    expect(canMove("awaiting_payment", "confirmed")).toBe(true);
    expect(canMove("confirmed", "refunded")).toBe(true);
    expect(canMove("refunded", "confirmed")).toBe(false);
    expect(canMove("refused", "confirmed")).toBe(false);
    expect(canMove("cancelled", "awaiting_payment")).toBe(false);
  });
  it("money labels and typed amounts", () => {
    expect(moneyLabel(25000)).toBe("EGP 250");
    expect(moneyLabel(25050)).toBe("EGP 250.50");
    expect(minorFromMajor("250")).toBe(25000);
    expect(minorFromMajor("250.5")).toBe(25050);
    expect(minorFromMajor("abc")).toBeNull();
    expect(minorFromMajor("-1")).toBeNull();
  });
});

describe("open, refunds and archiving", () => {
  const now = Date.parse("2026-11-01T12:00:00Z");
  it("closed, deadline, full and finished", () => {
    const s = { open: true, closesAt: null, capacity: 2 };
    expect(registrationClosedReason({ ...s, open: false }, { status: "active" }, 0, now)).toBe("closed");
    expect(registrationClosedReason(s, { status: "completed" }, 0, now)).toBe("finished");
    expect(registrationClosedReason({ ...s, closesAt: "2026-11-01T11:00:00Z" }, { status: "active" }, 0, now)).toBe("deadline");
    expect(registrationClosedReason(s, { status: "active", startsAt: "2026-11-01T11:00:00Z" }, 0, now)).toBe("deadline");
    expect(registrationClosedReason(s, { status: "active" }, 2, now)).toBe("full");
    expect(registrationClosedReason(s, { status: "active" }, 1, now)).toBeNull();
  });
  it("refunds until 24 hours before the start time, never without one", () => {
    expect(refundAllowed(null, now)).toEqual({ ok: false, reason: "no_start_time", cutoff: null });
    expect(refundAllowed("2026-11-02T12:00:01Z", now).ok).toBe(true);
    expect(refundAllowed("2026-11-02T11:59:59Z", now)).toMatchObject({ ok: false, reason: "too_late" });
  });
  it("a refund gives everything back unless a card fee is kept", () => {
    expect(refundAmount(50000, 0)).toBe(50000);
    expect(refundAmount(50000, 3)).toBe(48500);
    expect(refundAmount(50000, 99)).toBe(40000);
  });
  it("archives 24 h after the last day ends in the event's zone, or after completion if later", () => {
    const eod = endOfDay("2026-11-02", "Africa/Cairo")!;
    expect(new Date(eod).toISOString()).toBe("2026-11-02T21:59:59.999Z");
    expect(archiveAt({ endsOn: "2026-11-02", timezone: "Africa/Cairo", status: "completed", completedAt: "2026-11-02T18:00:00Z" })).toBe(eod + 86400_000);
    expect(archiveAt({ endsOn: "2026-11-02", timezone: "Africa/Cairo", status: "completed", completedAt: "2026-11-04T08:00:00Z" })).toBe(Date.parse("2026-11-05T08:00:00Z"));
    expect(archiveAt({ endsOn: "2026-11-02", timezone: "Africa/Cairo", status: "active", completedAt: null })).toBeNull();
    expect(archiveAt({ endsOn: null, timezone: null, status: "draft", completedAt: null })).toBeNull();
  });
});

describe("Move Tick webhook signatures", () => {
  const body = JSON.stringify({ id: "evt_1", type: "payment.succeeded", data: { sessionId: "pts_1", reference: REF, amount: 50000, currency: "EGP", testMode: true } });
  const at = Date.parse("2026-11-01T12:00:00Z");
  it("accepts its own signature within five minutes", () => {
    const h = signatureHeader(SECRET, body, at);
    expect(verifySignature(h, body, SECRET, at + 299_000).ok).toBe(true);
  });
  it("refuses stale, future, tampered, foreign and malformed ones", () => {
    const h = signatureHeader(SECRET, body, at);
    expect(verifySignature(h, body, SECRET, at + 301_000)).toEqual({ ok: false, reason: "stale" });
    expect(verifySignature(h, body, SECRET, at - 301_000)).toEqual({ ok: false, reason: "stale" });
    expect(verifySignature(h, body.replace("50000", "5"), SECRET, at)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySignature(signatureHeader("x".repeat(40), body, at), body, SECRET, at)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySignature(null, body, SECRET, at)).toEqual({ ok: false, reason: "missing" });
    expect(verifySignature("t=abc,v1=zz", body, SECRET, at)).toEqual({ ok: false, reason: "malformed" });
    expect(verifySignature(h, body, "short", at)).toEqual({ ok: false, reason: "no_secret" });
  });
  it("one matching v1 among several is enough (secret rotation)", () => {
    const h = signatureHeader(SECRET, body, at);
    const other = signatureHeader("y".repeat(40), body, at).split(",")[1];
    expect(verifySignature(`${h},${other}`, body, SECRET, at).ok).toBe(true);
  });
});

describe("Move Tick contract shapes", () => {
  it("parses only well-formed events", () => {
    const ok = parseWebhook(JSON.stringify({ id: "evt_1", type: "payment.refunded", createdAt: "2026-11-01T12:00:00Z", data: { sessionId: "pts_1", reference: REF.toUpperCase(), amount: 50000, currency: "EGP", refundedAmount: 50000, testMode: false } }));
    expect(ok?.data.reference).toBe(REF);
    expect(ok?.data.refundedAmount).toBe(50000);
    expect(parseWebhook("not json")).toBeNull();
    expect(parseWebhook(JSON.stringify({ id: "evt_1", type: "payment.stolen", data: {} }))).toBeNull();
    expect(parseWebhook(JSON.stringify({ id: "evt_1", type: "payment.succeeded", data: { sessionId: "s", reference: "not-a-uuid", amount: 1, currency: "EGP" } }))).toBeNull();
    expect(parseWebhook(JSON.stringify({ id: "evt_1", type: "payment.succeeded", data: { sessionId: "s", reference: REF, amount: 1.5, currency: "EGP" } }))).toBeNull();
  });
  it("configuration: all three values, https (http only on localhost), mode", () => {
    const env = { MOVE_TICK_API_URL: "https://move-tick.mbeg.org", MOVE_TICK_PARTNER_KEY: "k".repeat(32), MOVE_TICK_WEBHOOK_SECRET: SECRET };
    expect(moveTickConfig({})).toBeNull();
    expect(moveTickConfig({ ...env, MOVE_TICK_WEBHOOK_SECRET: "" })).toBeNull();
    expect(moveTickConfig({ ...env, MOVE_TICK_PARTNER_KEY: "short" })).toBeNull();
    expect(moveTickConfig({ ...env, MOVE_TICK_API_URL: "http://move-tick.mbeg.org" })).toBeNull();
    expect(moveTickConfig({ ...env, MOVE_TICK_API_URL: "http://localhost:54399" })?.apiUrl).toBe("http://localhost:54399");
    expect(moveTickConfig({ ...env, NODE_ENV: "production" })?.mode).toBe("live");
    expect(moveTickConfig({ ...env, MOVE_TICK_MODE: "test", NODE_ENV: "production" })?.mode).toBe("test");
  });
});

describe("registration code never trusts a client amount", () => {
  const server = readFileSync(join(__dirname, "server.ts"), "utf8");
  it("the checkout amount is the registration row's own", () => {
    expect(server).toMatch(/amount: reg\.amount_online/);
    expect(server).toMatch(/amount: payment\.amount,\s*\n\s*currency: "EGP"/);
  });
  it("a paid webhook must match the stored amount and currency", () => {
    expect(server).toMatch(/e\.data\.amount !== payment\.amount \|\| e\.data\.currency !== payment\.currency/);
  });
  it("public registration views never carry a phone or email", () => {
    const fn = server.slice(server.indexOf("export async function toPublicRegistration"), server.indexOf("export async function statusView"));
    expect(fn).toMatch(/people: \(r\.people \?\? \[\]\)\.map\(\(p\) => \(\{ name: p\.name \}\)\)/);
    expect(fn).not.toMatch(/\.phone|\.email/);
  });
});

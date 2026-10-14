import { afterEach, describe, expect, it, vi } from "vitest";
import { asSession, createCheckout, expireCheckout, keyMode, paymentMethodTypes, refundIntent, retrieveCheckout, sessionIdMode, sessionMoney, xpayConfig, type XpayConfig } from "./xpay";
import { eventOutcome, parseXpayEvent, verifyXpaySignature, xpaySignatureFor, xpaySignatureHeader } from "./xpayWebhook";
import { paymentProvider } from "./provider";

const SECRET = "whsec_test_0123456789abcdef";
const KEY = "sk_test_0123456789abcdef";

describe("XPay configuration", () => {
  const env = { XPAY_SECRET_KEY: KEY, XPAY_WEBHOOK_SECRET: SECRET };
  it("the mode is the key's prefix; anything else is not configured (fail closed)", () => {
    expect(keyMode(KEY)).toBe("test");
    expect(keyMode("sk_live_0123456789abcdef")).toBe("live");
    expect(keyMode("pk_test_0123456789abcdef")).toBeNull();
    expect(keyMode("sk_test_")).toBeNull();
    expect(keyMode("")).toBeNull();
    expect(keyMode(undefined)).toBeNull();
    expect(xpayConfig(env)?.mode).toBe("test");
    expect(xpayConfig({ ...env, XPAY_SECRET_KEY: "garbage-key-1234567890" })).toBeNull();
  });
  it("needs a webhook secret, and https (http only for a local fake with a test key)", () => {
    expect(xpayConfig({ XPAY_SECRET_KEY: KEY })).toBeNull();
    expect(xpayConfig(env)?.apiBase).toBe("https://api.xpay.app");
    expect(xpayConfig({ ...env, XPAY_API_BASE: "http://api.xpay.app" })).toBeNull();
    expect(xpayConfig({ ...env, XPAY_API_BASE: "http://localhost:54419/" })?.apiBase).toBe("http://localhost:54419");
    expect(xpayConfig({ ...env, XPAY_SECRET_KEY: "sk_live_0123456789abcdef", XPAY_API_BASE: "http://localhost:54419" })).toBeNull();
  });
  it("payment method types: known names only, so a typo cannot refuse every checkout", () => {
    expect(paymentMethodTypes(undefined)).toBeNull();
    expect(paymentMethodTypes(" card, VALU ,card,visa ")).toEqual(["card", "valu"]);
    expect(paymentMethodTypes("visa")).toBeNull();
  });
});

describe("payment provider switch", () => {
  const mt = { MOVE_TICK_API_URL: "https://move-tick.mbeg.org", MOVE_TICK_PARTNER_KEY: "k".repeat(32), MOVE_TICK_WEBHOOK_SECRET: "s".repeat(32) };
  const xp = { XPAY_SECRET_KEY: KEY, XPAY_WEBHOOK_SECRET: SECRET };
  it("XPay by default once its key is set; Move Tick otherwise; none when neither", () => {
    expect(paymentProvider({})).toBeNull();
    expect(paymentProvider(mt)).toBe("move_tick");
    expect(paymentProvider(xp)).toBe("xpay");
    expect(paymentProvider({ ...mt, ...xp })).toBe("xpay");
  });
  it("PAYMENT_PROVIDER picks one; named but not configured, or unknown, gives none", () => {
    expect(paymentProvider({ ...mt, ...xp, PAYMENT_PROVIDER: "move_tick" })).toBe("move_tick");
    expect(paymentProvider({ ...mt, PAYMENT_PROVIDER: "xpay" })).toBeNull();
    expect(paymentProvider({ ...xp, PAYMENT_PROVIDER: "move_tick" })).toBeNull();
    expect(paymentProvider({ ...mt, ...xp, PAYMENT_PROVIDER: "stripe" })).toBeNull();
    // A set but broken XPay key never falls back to another provider.
    expect(paymentProvider({ ...mt, XPAY_SECRET_KEY: "oops" })).toBeNull();
  });
});

describe("XPay webhook signatures", () => {
  const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
  const now = 1_760_000_000_000;
  it("accepts XPay's header; refuses a wrong secret, a changed body, a stale or future time, a malformed header", () => {
    expect(verifyXpaySignature(xpaySignatureHeader(SECRET, body, now), body, SECRET, now).ok).toBe(true);
    expect(verifyXpaySignature(xpaySignatureHeader("whsec_other_0123456789", body, now), body, SECRET, now)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyXpaySignature(xpaySignatureHeader(SECRET, body, now), body + " ", SECRET, now)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyXpaySignature(xpaySignatureHeader(SECRET, body, now - 301_000), body, SECRET, now)).toEqual({ ok: false, reason: "stale" });
    expect(verifyXpaySignature(xpaySignatureHeader(SECRET, body, now + 301_000), body, SECRET, now)).toEqual({ ok: false, reason: "stale" });
    expect(verifyXpaySignature(null, body, SECRET, now)).toEqual({ ok: false, reason: "missing" });
    expect(verifyXpaySignature("v1=abc", body, SECRET, now)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyXpaySignature("t=1,v1=" + "0".repeat(64), body, "", now)).toEqual({ ok: false, reason: "no_secret" });
  });
  it("one matching v1 of several is enough (secret rotation); other schemes are ignored", () => {
    const t = Math.floor(now / 1000);
    const good = xpaySignatureFor(SECRET, t, body);
    expect(verifyXpaySignature(`t=${t},v0=zzz,v1=${"0".repeat(64)},v1=${good}`, body, SECRET, now).ok).toBe(true);
  });
});

const session = (over: Record<string, unknown> = {}) => ({
  id: "cs_test_abc123",
  object: "checkout.session",
  status: "complete",
  paymentStatus: "paid",
  amountTotal: 25000,
  currency: "EGP",
  metadata: { app: "move-score", registration_id: "11111111-1111-4111-8111-111111111111", payment_id: "22222222-2222-4222-8222-222222222222" },
  paymentIntent: { id: "pi_1", status: "SUCCEEDED" },
  url: "https://checkout.xpay.app/cs_test_abc123",
  ...over,
});

describe("XPay events", () => {
  it("parses a checkout event's session; a body that is not an event is null", () => {
    const e = parseXpayEvent(JSON.stringify({ id: "evt_1", type: "checkout.session.completed", livemode: false, data: { object: session() } }));
    expect(e?.session?.id).toBe("cs_test_abc123");
    expect(e?.session?.intentId).toBe("pi_1");
    expect(e?.session?.intentStatus).toBe("SUCCEEDED");
    expect(e?.livemode).toBe(false);
    expect(parseXpayEvent("not json")).toBeNull();
    expect(parseXpayEvent(JSON.stringify({ type: "x" }))).toBeNull();
    expect(parseXpayEvent(JSON.stringify({ id: "evt 1; drop", type: "x" }))).toBeNull();
    // Other event types are events (acknowledged), with no session.
    expect(parseXpayEvent(JSON.stringify({ id: "evt_2", type: "payout.paid", data: { object: { id: "po_1", status: "paid" } } }))?.session).toBeNull();
  });
  it("fulfils on paymentStatus paid only: a completed unpaid page (a reference to pay later) waits", () => {
    expect(eventOutcome("checkout.session.completed", { paymentStatus: "paid" })).toBe("payment.succeeded");
    expect(eventOutcome("checkout.session.completed", { paymentStatus: "unpaid" })).toBe("awaiting");
    expect(eventOutcome("checkout.session.async_payment_succeeded", { paymentStatus: "paid" })).toBe("payment.succeeded");
    expect(eventOutcome("checkout.session.async_payment_succeeded", { paymentStatus: "unpaid" })).toBe("awaiting");
    expect(eventOutcome("checkout.session.async_payment_failed", { paymentStatus: "unpaid" })).toBe("payment.failed");
    expect(eventOutcome("checkout.session.async_payment_failed", { paymentStatus: "paid" })).toBe("payment.succeeded");
    expect(eventOutcome("checkout.session.expired", { paymentStatus: "unpaid" })).toBe("payment.expired");
    expect(eventOutcome("charge.refunded", { paymentStatus: "paid" })).toBeNull();
  });
  it("a session may be closed only when no card can still complete on it", () => {
    const s = (o: Record<string, unknown>) => asSession(session(o))!;
    expect(sessionMoney(s({}))).toBe("paid");
    expect(sessionMoney(s({ status: "open", paymentStatus: "unpaid", paymentIntent: null }))).toBe("releasable");
    expect(sessionMoney(s({ status: "open", paymentStatus: "unpaid", paymentIntent: { id: "pi", status: "requires_payment_method" } }))).toBe("releasable");
    expect(sessionMoney(s({ status: "open", paymentStatus: "unpaid", paymentIntent: { id: "pi", status: "REQUIRES_ACTION" } }))).toBe("settling");
    expect(sessionMoney(s({ status: "open", paymentStatus: "unpaid", paymentIntent: { id: "pi" } }))).toBe("settling");
    expect(sessionMoney(s({ status: "complete", paymentStatus: "unpaid", paymentIntent: null }))).toBe("settling");
    expect(sessionIdMode("cs_test_x")).toBe("test");
    expect(sessionIdMode("cs_live_x")).toBe("live");
    expect(sessionIdMode("sess_x")).toBeNull();
  });
});

describe("XPay client requests", () => {
  const cfg: XpayConfig = { apiBase: "https://api.xpay.app", secretKey: KEY, webhookSecret: SECRET, mode: "test", paymentMethodTypes: ["card"] };
  afterEach(() => vi.unstubAllGlobals());
  const stub = (answers: { status: number; body: unknown }[]) => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const a = answers.shift() ?? { status: 500, body: {} };
        return new Response(JSON.stringify(a.body), { status: a.status });
      }),
    );
    return calls;
  };
  const input = { amount: 25000, description: "Cup — entry", returnUrl: "https://tour.mbeg.org/register/status?r=x&s=y", registrationId: "11111111-1111-4111-8111-111111111111", paymentId: "22222222-2222-4222-8222-222222222222" };

  it("creates a checkout: minor units, our metadata, an idempotency key from the payment id, a 30-minute page", async () => {
    const calls = stub([{ status: 200, body: session({ status: "open", paymentStatus: "unpaid", paymentIntent: null }) }]);
    const s = await createCheckout(cfg, input);
    expect(s.url).toBe("https://checkout.xpay.app/cs_test_abc123");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(calls[0]!.url).toBe("https://api.xpay.app/checkout/sessions");
    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe(`movescore-checkout-${input.paymentId}`);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(body.lineItems[0].priceData).toEqual({ currency: "EGP", unitAmount: 25000, productData: { name: "Cup — entry" } });
    expect(body.metadata).toEqual({ app: "move-score", registration_id: input.registrationId, payment_id: input.paymentId });
    expect(body.afterCompletion.redirect.url).toBe(input.returnUrl);
    expect(body.expiresAfterMinutes).toBe(30);
    expect(body.paymentMethodTypes).toEqual(["card"]);
  });
  it("retries without the expiry when XPay does not take it; refuses an answer for another amount or mode", async () => {
    const calls = stub([
      { status: 400, body: { error: { code: "parameter_unknown", param: "expiresAfterMinutes" } } },
      { status: 200, body: session({ status: "open", paymentStatus: "unpaid" }) },
    ]);
    await createCheckout(cfg, input);
    expect(JSON.parse(String(calls[1]!.init.body)).expiresAfterMinutes).toBeUndefined();
    stub([{ status: 200, body: session({ amountTotal: 100 }) }]);
    await expect(createCheckout(cfg, input)).rejects.toThrow(/another amount/);
    stub([{ status: 200, body: session({ id: "cs_live_zzz" }) }]);
    await expect(createCheckout(cfg, input)).rejects.toThrow(/wrong mode/);
    stub([{ status: 200, body: session({ url: "http://evil.example/pay" }) }]);
    await expect(createCheckout(cfg, input)).rejects.toThrow(/unexpected/);
  });
  it("expire reads the session back when XPay refuses (not open any more); refunds name the intent, in full", async () => {
    const calls = stub([
      { status: 400, body: { error: { code: "session_not_open" } } },
      { status: 200, body: session() },
      { status: 200, body: { id: "re_1", status: "succeeded" } },
    ]);
    const s = await expireCheckout(cfg, "cs_test_abc123");
    expect(s.paymentStatus).toBe("paid");
    expect(calls[0]!.url).toBe("https://api.xpay.app/checkout/sessions/cs_test_abc123/expire");
    expect(calls[1]!.init.method).toBe("GET");
    const r = await refundIntent(cfg, { intentId: "pi_1", paymentId: input.paymentId });
    expect(r).toEqual({ refundId: "re_1", status: "succeeded" });
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ paymentIntentId: "pi_1" });
    expect((calls[2]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe(`movescore-refund-full-${input.paymentId}`);
    stub([{ status: 200, body: { id: "re_2", status: "failed" } }]);
    await expect(refundIntent(cfg, { intentId: "pi_1", paymentId: input.paymentId })).rejects.toThrow(/did not take/);
    stub([{ status: 200, body: session({ id: "cs_test_other" }) }]);
    await expect(retrieveCheckout(cfg, "cs_test_abc123")).rejects.toThrow(/unexpected/);
  });
});

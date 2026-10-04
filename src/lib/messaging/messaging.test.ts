import { afterEach, describe, expect, it, vi } from "vitest";
import { maskPhone, toE164, waRecipient } from "./phone";
import { canAdvance, summarize, timestampFor } from "./status";
import { fillVars, missingFields, mergeVars, renderEmail, textToHtml } from "./render";
import { describeResendError, fromHeader, isValidEmail, mapResendEvent, normalizeEmail, replyTo, resendBody, signSvix, verifySvixSignature } from "./email";
import {
  describeGraphError,
  describeTemplate,
  isStopRequest,
  isTransientWaError,
  parseWaWebhook,
  sanitizeParam,
  signMeta,
  templatePayload,
  verifyMetaSignature,
  waErrorReason,
  windowOpen,
} from "./whatsapp";
import { parsePastedList, planDeliveries, type Recipient } from "./recipients";
import { announcementTemplate, defaultParams, transactionalEmail, transactionalWhatsApp } from "./templates";
import { validateCompose, type ComposeInput } from "./compose";
import { parseAudience, channelsFor } from "./audienceSpec";
// audience.ts reaches the database only when called; pickContact is pure.
import { pickContact } from "./audience";

describe("phone", () => {
  it("normalises Egyptian numbers to E.164", () => {
    expect(toE164("0100 123 4567")).toBe("+201001234567");
    expect(toE164("+20 100 123 4567")).toBe("+201001234567");
    expect(toE164("00201001234567")).toBe("+201001234567");
    expect(toE164("1001234567")).toBe("+201001234567");
    expect(toE164("٠١٠٠١٢٣٤٥٦٧")).toBe("+201001234567");
  });
  it("rejects Egyptian landlines and junk, keeps other countries with +", () => {
    expect(toE164("02 2345 6789")).toBeNull();
    expect(toE164("12")).toBeNull();
    expect(toE164("")).toBeNull();
    expect(toE164("+44 7911 123456")).toBe("+447911123456");
  });
  it("formats for WhatsApp and masks", () => {
    expect(waRecipient("+201001234567")).toBe("201001234567");
    expect(maskPhone("+201001234567")).toBe("+20100•••4567");
    expect(maskPhone(null)).toBe("—");
  });
});

describe("status", () => {
  it("only moves forward; failures are never masked", () => {
    expect(canAdvance("sending", "sent")).toBe(true);
    expect(canAdvance("sent", "delivered")).toBe(true);
    expect(canAdvance("read", "delivered")).toBe(false);
    expect(canAdvance("delivered", "sent")).toBe(false);
    expect(canAdvance("failed", "delivered")).toBe(false);
    expect(canAdvance("sent", "failed")).toBe(true);
    expect(canAdvance("delivered", "complained")).toBe(true);
    expect(canAdvance("skipped", "sent")).toBe(false);
    expect(timestampFor("bounced")).toBe("failed_at");
  });
  it("summarises a funnel per channel", () => {
    const s = summarize([
      { channel: "whatsapp", status: "read", not_on_whatsapp: false, n: 3 },
      { channel: "whatsapp", status: "delivered", not_on_whatsapp: false, n: 2 },
      { channel: "whatsapp", status: "failed", not_on_whatsapp: true, n: 4 },
      { channel: "whatsapp", status: "failed", not_on_whatsapp: false, n: 1 },
      { channel: "email", status: "bounced", not_on_whatsapp: null, n: 1 },
      { channel: "email", status: "queued", not_on_whatsapp: null, n: 5 },
      { channel: "email", status: "skipped", not_on_whatsapp: null, n: 2 },
    ]);
    expect(s.whatsapp).toMatchObject({ total: 10, sent: 5, delivered: 5, read: 3, failed: 5, notOnWhatsApp: 4 });
    expect(s.email).toMatchObject({ total: 8, pending: 5, bounced: 1, skipped: 2, sent: 0 });
    expect(s.all.total).toBe(18);
  });
});

describe("render", () => {
  it("fills merge fields and derives first name", () => {
    expect(fillVars("Hi {first_name}, code {code}. {unknown}", { name: "Omar Khaled", code: "AB12" })).toBe("Hi Omar, code AB12. {unknown}");
    expect(fillVars("{tournament}!", {})).toBe("!");
    expect(missingFields("Hi {name}, {code} {tournament}", { name: "A", code: "" })).toEqual(["code", "tournament"]);
    expect(mergeVars({ tournament: "Open", link: "x" }, { tournament: null, name: "A" })).toEqual({ tournament: "Open", link: "x", name: "A" });
  });
  it("escapes HTML and links URLs", () => {
    const html = textToHtml("<b>Hi</b>\nsee https://tour.mbeg.org/t/x.\n\nbye");
    expect(html).toContain("&lt;b&gt;Hi&lt;/b&gt;<br>");
    expect(html).toContain('<a href="https://tour.mbeg.org/t/x"');
    expect(html.match(/<p /g)?.length).toBe(2);
  });
  it("renders a branded email with code box and button", () => {
    const e = renderEmail({ title: "Code for {name}", body: "Hello {first_name}", code: "{code}", cta: { label: "Open", url: "{app_link}" } }, { name: "Sara Ali", code: "ZX9", app_link: "https://x.test/app" });
    expect(e.subject).toBe("Code for Sara Ali");
    expect(e.html).toContain('alt="Move Score"');
    expect(e.html).toContain("is made by <a href=\"https://mbeg.org\"");
    expect(e.html).toContain("ZX9");
    expect(e.html).toContain('href="https://x.test/app"');
    expect(e.text).toContain("Your code: ZX9");
    expect(e.text).toContain("Open: https://x.test/app");
    expect(e.text).toContain("Move Score is made by Move Beyond");
    expect(e.text).toContain("registered as a player");
  });
  it("escapes organiser text and merge values in the email", () => {
    const e = renderEmail({ title: "Hi {name}", body: "<img src=x onerror=alert(1)> {name}" }, { name: "<Omar>" });
    expect(e.subject).toBe("Hi <Omar>");
    expect(e.html).not.toContain("<img src=x");
    expect(e.html).not.toContain("<Omar>");
    expect(e.html).toContain("&lt;Omar&gt;");
  });
});

describe("email (Resend)", () => {
  it("sends as Move Score from no-reply, replies to info@mbeg.org", () => {
    const env = (e: Record<string, string> = {}) => e as NodeJS.ProcessEnv;
    expect(fromHeader(env())).toBe("Move Score <no-reply@mbeg.org>");
    expect(fromHeader(env({ RESEND_FROM_EMAIL: "news@mbeg.org", RESEND_FROM_NAME: 'Move "Beyond"' }))).toBe("Move Beyond <news@mbeg.org>");
    expect(replyTo(env())).toBe("info@mbeg.org");
    expect(replyTo(env({ RESEND_REPLY_TO: "help@mbeg.org" }))).toBe("help@mbeg.org");
    const body = resendBody({ deliveryId: "d1", to: "a@x.test", subject: "s", html: "h", text: "t" }, fromHeader(env()));
    expect(body).toMatchObject({ from: "Move Score <no-reply@mbeg.org>", reply_to: "info@mbeg.org", to: ["a@x.test"] });
  });
  it("validates addresses", () => {
    expect(isValidEmail("a.b+c@mbeg.org")).toBe(true);
    expect(isValidEmail("nope@")).toBe(false);
    expect(normalizeEmail("  Omar@Example.COM ")).toBe("omar@example.com");
    expect(normalizeEmail("omar at example")).toBeNull();
  });
  it("verifies Svix signatures and refuses tampering or stale timestamps", () => {
    const secret = `whsec_${Buffer.from("super-secret-key-material").toString("base64")}`;
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "e1" } });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signSvix(secret, "msg_1", ts, body);
    expect(verifySvixSignature(secret, { id: "msg_1", timestamp: ts, signature: `v1,bogus ${sig}` }, body)).toBe(true);
    expect(verifySvixSignature(secret, { id: "msg_1", timestamp: ts, signature: sig }, body.replace("e1", "e2"))).toBe(false);
    expect(verifySvixSignature(secret, { id: "msg_2", timestamp: ts, signature: sig }, body)).toBe(false);
    expect(verifySvixSignature(secret, { id: "msg_1", timestamp: ts, signature: sig }, body, Date.now() + 10 * 60_000)).toBe(false);
    expect(verifySvixSignature(undefined, { id: "msg_1", timestamp: ts, signature: sig }, body)).toBe(false);
  });
  it("maps webhook events", () => {
    expect(mapResendEvent({ type: "email.delivered", data: { email_id: "e1" } })).toMatchObject({ providerId: "e1", status: "delivered" });
    expect(mapResendEvent({ type: "email.opened", data: { email_id: "e1" } })?.status).toBe("read");
    const b = mapResendEvent({ type: "email.bounced", data: { email_id: "e1", tags: { delivery: "d1" }, bounce: { type: "Permanent", subType: "General", message: "No such user" } } });
    expect(b).toMatchObject({ status: "bounced", deliveryId: "d1", errorCode: "General" });
    expect(b?.errorReason).toContain("No such user");
    expect(mapResendEvent({ type: "email.complained", data: { email_id: "e1", tags: [{ name: "delivery", value: "d2" }] } })).toMatchObject({ status: "complained", deliveryId: "d2" });
    expect(mapResendEvent({ type: "email.delivery_delayed", data: { email_id: "e1" } })).toBeNull();
  });
  it("words errors and knows which to retry", () => {
    expect(describeResendError(429, { name: "rate_limit_exceeded" }).transient).toBe(true);
    expect(describeResendError(503, null).transient).toBe(true);
    expect(describeResendError(422, { name: "validation_error", message: "Invalid `to` field" })).toMatchObject({ transient: false, reason: "Invalid `to` field" });
    expect(describeResendError(403, { name: "validation_error", message: "domain not verified" }).reason).toContain("verify the RESEND_FROM_EMAIL domain");
  });
});

describe("WhatsApp", () => {
  const tpl = describeTemplate({
    name: "mb_new_tournament",
    language: "en",
    status: "APPROVED",
    category: "MARKETING",
    components: [
      { type: "HEADER", format: "IMAGE" },
      { type: "BODY", text: "Hi {{1}}, {{2}} is open. {{3}}" },
      { type: "FOOTER", text: "Move Beyond" },
      { type: "BUTTONS", buttons: [{ type: "URL", text: "Open", url: "https://tour.mbeg.org/t/{{1}}" }, { type: "URL", text: "Site", url: "https://mbeg.org" }] },
    ],
  });
  it("describes what a template needs", () => {
    expect(tpl).toMatchObject({ bodyParams: 3, headerFormat: "IMAGE", footer: "Move Beyond" });
    expect(tpl.urlButtons).toEqual([{ index: 0, text: "Open", url: "https://tour.mbeg.org/t/{{1}}" }]);
  });
  it("builds template payloads with flattened variables", () => {
    const p = templatePayload("201001234567", { name: "x", language: "en", bodyParams: ["Omar", "Line one\n\nLine two\twith     spaces"], headerImageUrl: "https://i.test/a.jpg", buttonParams: [{ index: 0, value: "spring-open" }] });
    expect(p.to).toBe("201001234567");
    const comps = p.template.components as { type: string; parameters: { text?: string }[] }[];
    expect(comps.map((c) => c.type)).toEqual(["header", "body", "button"]);
    expect(comps[1]!.parameters[1]!.text).toBe("Line one · Line two · with   spaces");
    expect(templatePayload("2010", { name: "hello_world", language: "en_US", bodyParams: [] }).template).not.toHaveProperty("components");
    expect(sanitizeParam("")).toBe("-");
    expect(sanitizeParam("x".repeat(2000)).length).toBe(1000);
  });
  it("explains error codes, 131026 first of all", () => {
    expect(waErrorReason(131026)).toBe("Not on WhatsApp / undeliverable");
    expect(waErrorReason("999999", "Odd")).toBe("Odd");
    expect(isTransientWaError(130429)).toBe(true);
    expect(isTransientWaError(131026)).toBe(false);
    expect(isTransientWaError(null, 503)).toBe(true);
    const e = describeGraphError(400, { code: 132001, message: "(#132001) Template name does not exist in the translation", error_data: { details: "template name (mb_x) does not exist in en" } });
    expect(e.reason).toContain("Template does not exist");
    expect(e.reason).toContain("mb_x");
    expect(e.transient).toBe(false);
  });
  it("verifies X-Hub-Signature-256", () => {
    const body = '{"entry":[]}';
    expect(verifyMetaSignature("s3cret", body, signMeta("s3cret", body))).toBe(true);
    expect(verifyMetaSignature("s3cret", body + " ", signMeta("s3cret", body))).toBe(false);
    expect(verifyMetaSignature(undefined, body, signMeta("s3cret", body))).toBe(false);
    expect(verifyMetaSignature("s3cret", body, "sha1=abc")).toBe(false);
  });
  it("parses statuses (with error codes) and inbound messages", () => {
    const { updates, inbound } = parseWaWebhook({
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                statuses: [
                  { id: "wamid.A", status: "delivered", timestamp: "1700000000" },
                  { id: "wamid.B", status: "failed", timestamp: "1700000001", errors: [{ code: 131026, title: "Message undeliverable" }] },
                  { id: "wamid.C", status: "deleted" },
                ],
                messages: [{ from: "201001234567", timestamp: "1700000002", text: { body: "STOP" } }],
              },
            },
          ],
        },
      ],
    });
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ providerId: "wamid.A", status: "delivered", at: new Date(1700000000_000).toISOString() });
    expect(updates[1]).toMatchObject({ providerId: "wamid.B", status: "failed", errorCode: "131026", errorReason: "Not on WhatsApp / undeliverable" });
    expect(inbound).toEqual([{ phone: "+201001234567", at: new Date(1700000002_000).toISOString(), text: "STOP" }]);
    expect(isStopRequest("stop")).toBe(true);
    expect(isStopRequest("إلغاء")).toBe(true);
    expect(isStopRequest("please stop by the court")).toBe(false);
  });
  it("knows when the 24-hour window is open", () => {
    const now = Date.parse("2026-10-03T12:00:00Z");
    expect(windowOpen("2026-10-03T00:00:00Z", now)).toBe(true);
    expect(windowOpen("2026-10-02T12:01:00Z", now)).toBe(false);
    expect(windowOpen(null, now)).toBe(false);
  });
});

describe("recipients", () => {
  const people: Recipient[] = [
    { kind: "player", id: "1", name: "Omar", email: "omar@x.test", phone: "01001234567", vars: { name: "Omar", code: "C1" } },
    { kind: "player", id: "2", name: "Sara", email: null, phone: "0100 123 4567", vars: { name: "Sara", code: null } },
    { kind: "player", id: "3", name: "Ali", email: "bad@", phone: "02 2345 6789", vars: { name: "Ali", code: "C3" } },
    { kind: "player", id: "4", name: "Mona", email: "mona@x.test", phone: "01112223334", vars: { name: "Mona", code: "C4" }, optedOut: ["whatsapp"] },
    { kind: "player", id: "5", name: "Hana", email: "hana@x.test", phone: "01212223334", vars: { name: "Hana", code: "C5" } },
  ];
  it("plans one row per person and channel, with reasons for the rest", () => {
    const { rows, preview } = planDeliveries(people, ["email", "whatsapp"], { waOptedOut: new Set(["+201212223334"]) });
    expect(preview.email).toMatchObject({ reachable: 3, missing: 1, invalid: 1 });
    expect(preview.whatsapp).toMatchObject({ reachable: 1, duplicates: 1, invalid: 1, optedOut: 2 });
    const wa = rows.filter((r) => r.channel === "whatsapp");
    expect(wa.find((r) => r.recipient_id === "1")?.address).toBe("+201001234567");
    expect(wa.find((r) => r.recipient_id === "3")).toMatchObject({ status: "skipped", error_code: "bad_phone", address: "02 2345 6789" });
    expect(wa.find((r) => r.recipient_id === "4")?.error_code).toBe("opted_out");
    expect(wa.find((r) => r.recipient_id === "5")?.error_code).toBe("wa_stop");
    expect(wa.some((r) => r.recipient_id === "2")).toBe(false);
    expect(rows.find((r) => r.channel === "email" && r.recipient_id === "2")).toMatchObject({ status: "skipped", error_code: "no_email" });
  });
  it("holds back people without a code when codes are required", () => {
    const { preview, rows } = planDeliveries(people.slice(0, 2), ["whatsapp", "email"], { requireCode: true });
    expect(preview.whatsapp.reachable).toBe(1);
    expect(rows.filter((r) => r.error_code === "no_code")).toHaveLength(0); // Sara's number is a duplicate; she has no email
    const solo = planDeliveries([people[1]!], ["whatsapp"], { requireCode: true });
    expect(solo.rows[0]).toMatchObject({ status: "skipped", error_code: "no_code" });
  });
  it("parses a pasted list", () => {
    const { recipients, rejected } = parsePastedList("Omar Khaled, omar@x.test, 0100 123 4567\n+201112223334\nhana@x.test; Hana\njust a name\n\n");
    expect(recipients).toHaveLength(3);
    expect(recipients[0]).toMatchObject({ name: "Omar Khaled", email: "omar@x.test", phone: "0100 123 4567" });
    expect(recipients[1]).toMatchObject({ name: "", phone: "+201112223334" });
    expect(recipients[2]).toMatchObject({ name: "Hana", email: "hana@x.test" });
    expect(rejected).toEqual(["just a name"]);
  });
});

describe("templates and compose", () => {
  it("maps template variables per recipient", () => {
    const t = announcementTemplate(
      { name: "mb_announcement", language: "en", params: [{ field: "first_name" }, { field: "title" }, { field: "message" }, { field: "custom", text: "Code {code}" }] },
      { title: "Hello {first_name}", body: "Line 1\nLine 2", vars: { name: "Omar Khaled", code: "Z1" } },
    );
    expect(t.bodyParams).toEqual(["Omar", "Hello Omar", "Line 1\nLine 2", "Code Z1"]);
    expect(defaultParams(2, "access_codes")).toEqual([{ field: "first_name", text: "" }, { field: "code", text: "" }]);
  });
  it("renders transactional messages", () => {
    const e = transactionalEmail("access_code", { name: "Sara Ali", code: "Q7", app_link: "https://a.test" });
    expect(e.subject).toBe("Your Move Score player code");
    expect(e.html).toContain("Q7");
    expect(transactionalWhatsApp("access_code", { name: "Sara Ali", code: "Q7", app_link: "https://a.test" })).toMatchObject({ name: "mb_access_code", bodyParams: ["Sara", "Q7", "https://a.test"] });
    const c = transactionalEmail("confirmation", { name: "Sara", title: "Registration received", message: "We have your entry for {tournament}.", tournament: "Spring Open" });
    expect(c.subject).toBe("Registration received");
    expect(c.text).toContain("We have your entry for Spring Open.");
  });
  it("checks the composer input", () => {
    const base: ComposeInput = { kind: "announcement", title: "Hi", body: "Body", channels: ["email"], audience: { type: "all_players" }, whatsapp: null, cta: null, tournamentId: null };
    expect(validateCompose(base, null)).toEqual([]);
    expect(validateCompose({ ...base, channels: ["push"] }, null)).toContain("App push cannot reach this audience.");
    expect(validateCompose({ ...base, channels: ["whatsapp"] }, null)).toContain("Choose an approved WhatsApp template.");
    const spec = describeTemplate({ name: "t", language: "en", status: "APPROVED", components: [{ type: "BODY", text: "{{1}} {{2}}" }] });
    const errs = validateCompose({ ...base, kind: "access_codes", channels: ["whatsapp"], whatsapp: { name: "t", language: "en", params: [{ field: "first_name" }] } }, spec);
    expect(errs).toContain('Template "t" needs 2 variable(s); 1 set.');
    expect(errs).toContain("The WhatsApp template does not include the access code.");
    expect(validateCompose({ ...base, cta: { label: "x", url: "http://insecure" } }, null)).toContain("The button link must start with https://");
    expect(validateCompose({ ...base, cta: { label: "x", url: "{link}" } }, null)).toEqual([]);
  });
  it("parses audiences", () => {
    expect(parseAudience({ type: "nation", nationCode: "egy" })).toEqual({ type: "nation", nationCode: "EGY" });
    expect(() => parseAudience({ type: "tournament" })).toThrow();
    expect(() => parseAudience({ type: "everyone" })).toThrow();
    expect(channelsFor("app_users")).toEqual({ email: false, whatsapp: false, push: true });
  });
});

describe("transport (dry run)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  it("never touches the network in dry-run mode", async () => {
    vi.stubEnv("MESSAGING_DRY_RUN", "1");
    vi.stubEnv("RESEND_API_KEY", "re_live_key_that_must_not_be_used");
    vi.stubEnv("WA_CLOUD_ACCESS_TOKEN", "token");
    vi.stubEnv("WA_CLOUD_PHONE_NUMBER_ID", "123");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { sendEmailChunk, sendWhatsApp } = await import("./transport");
    const out = await sendEmailChunk([
      { deliveryId: "d1", to: "a@x.test", subject: "s", html: "h", text: "t" },
      { deliveryId: "d2", to: "b@fail.test", subject: "s", html: "h", text: "t" },
    ]);
    expect(out[0]!.ok).toBe(true);
    expect(out[1]).toMatchObject({ ok: false, transient: false });
    expect((await sendWhatsApp("+201001234567", { text: "hi" })).ok).toBe(true);
    expect(await sendWhatsApp("+201001239999", { text: "hi" })).toMatchObject({ ok: false, code: "131009" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("refuses to send when a channel is not configured", async () => {
    vi.stubEnv("MESSAGING_DRY_RUN", "");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("WA_CLOUD_ACCESS_TOKEN", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { sendEmailChunk, sendWhatsApp } = await import("./transport");
    expect((await sendEmailChunk([{ deliveryId: "d1", to: "a@x.test", subject: "s", html: "h", text: "t" }]))[0]).toMatchObject({ ok: false, code: "not_configured" });
    expect(await sendWhatsApp("+201001234567", { text: "hi" })).toMatchObject({ ok: false, code: "not_configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("sends a Resend batch and splits it when validation fails", async () => {
    vi.stubEnv("MESSAGING_DRY_RUN", "");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("RESEND_FROM_EMAIL", "news@mbeg.org");
    vi.stubEnv("RESEND_FROM_NAME", "Move Beyond");
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url: String(url), body, headers: init?.headers as Record<string, string> });
      if (String(url).endsWith("/emails/batch")) return new Response(JSON.stringify({ name: "validation_error", message: "Invalid `to` field" }), { status: 422 });
      const to = (body as { to: string[] }).to[0]!;
      if (to.startsWith("bad")) return new Response(JSON.stringify({ name: "validation_error", message: "Invalid `to` field" }), { status: 422 });
      return new Response(JSON.stringify({ id: `id-${to}` }), { status: 200 });
    });
    const { sendEmailChunk } = await import("./transport");
    const out = await sendEmailChunk([
      { deliveryId: "d1", to: "a@x.test", subject: "s", html: "h", text: "t" },
      { deliveryId: "d2", to: "bad@x.test", subject: "s", html: "h", text: "t" },
    ]);
    expect(out).toEqual([
      { ok: true, providerId: "id-a@x.test" },
      { ok: false, code: "validation_error", reason: "Invalid `to` field", transient: false },
    ]);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails/batch");
    expect((calls[0]!.body as { from: string }[])[0]!.from).toBe("Move Beyond <news@mbeg.org>");
    expect((calls[0]!.body as { reply_to: string }[])[0]!.reply_to).toBe("info@mbeg.org");
    expect(calls[1]!.headers["Idempotency-Key"]).toBe("delivery-d1");
    expect((calls[1]!.body as { tags: unknown }).tags).toEqual([{ name: "delivery", value: "d1" }]);
  });
});

describe("contact source", () => {
  it("prefers the player's own contact, then the profile, then the team phone", () => {
    const prof = { mobile_normalized: "+201001234567", email: "prof@x.test" };
    expect(pickContact({ phone: "+201112223334", email: "own@x.test" }, prof, "+201228887776")).toEqual({
      email: { value: "own@x.test", source: "player" },
      phone: { value: "+201112223334", source: "player" },
    });
    expect(pickContact({}, prof, "+201228887776")).toEqual({ email: { value: "prof@x.test", source: "profile" }, phone: { value: "+201001234567", source: "profile" } });
    expect(pickContact({}, undefined, "01228887776")).toEqual({ email: null, phone: { value: "01228887776", source: "team" } });
  });
  it("formats access codes for messages", async () => {
    const e = transactionalEmail("access_code", { name: "Sara Ali", code: "ABCD-EFGH", tournament: "Spring Open", app_link: "https://a.test" });
    expect(e.text).toContain("player code for Spring Open");
    expect(e.text).toContain("open Account, tap Player code");
  });
});

/**
 * Registration and payment (plan Phase 9), end to end on the stand-in, with a
 * fake Move Tick inside this script (the partner API of docs/move-tick-partner-api.md).
 *
 *   1. Settings and info: the defaults (closed, first paid first in, registrant pays,
 *      no card fee), Move Beyond online + venue; another organisation is offered the
 *      venue only, whatever it saves.
 *   2. Organiser mode: team registration in the app, strict body (a client amount is
 *      refused), approval (a 24 h approval hold), a Move Tick checkout for the server's
 *      amount, the payment webhook: bad signature, stale timestamp and wrong mode
 *      refused; the real one confirms, makes the team and links the registrant's own
 *      row only; a replay (same id, or a fresh id) changes nothing; an amount mismatch
 *      is held for review.
 *   2b. First paid, first in (the default): registering holds no place and opens no
 *      checkout; Pay takes a 15-minute checkout hold only while a place is free (two
 *      players racing for the last place: one checkout, the other "This event is
 *      full" before any checkout); the paid one is confirmed with no organiser step;
 *      a failed / expired checkout or a lapsed hold frees the place; a payment that
 *      lands when the event is full is flagged, the admins emailed, and refunded in
 *      full; a free event confirms at once while places remain.
 *   2c. Entry type both: a team and solo players in one event (fees per player,
 *      capacity counted in players: a team no longer fits where a solo still does),
 *      solo players paired by the organiser.
 *   3. Individual entries: a friendly session (free, first paid first in, the
 *      account's own profile), and web guests in a padel tournament paired by the organiser.
 *   4. Pay at the venue: approve, then "paid at the venue".
 *   5. Refunds, always in full: before the 24 h cut-off (Move Tick refunds; the entry
 *      leaves the event), refused after it, refused for a manager and the shared
 *      password, and a refund that Move Tick confirms later by webhook.
 *   6. Cross-organisation attacks and other accounts: another organisation's admin
 *      cannot see, approve, refuse, record or refund; another account's registration
 *      answers like a missing one; web form honeypot and rate limit.
 *   7. Archive job: links of an event that ended over a day ago are archived; a
 *      running event's are not.
 *
 * Stand-in only; creates and deletes its own data.
 *
 *   npm run localdb                                          # terminal 1
 *   npm run build                                            # no `next dev` running
 *   (set -a; . ./.env.localdb; set +a; PUBLIC_SITE_URL=http://localhost:3077 PUSH_DRY_RUN=1 MESSAGING_DRY_RUN=1 npx next start -p 3077)
 *   BASE_URL=http://localhost:3077 npm run e2e:registration
 */
import http from "node:http";
import { createHmac, randomUUID, randomInt } from "node:crypto";
import { db } from "../../src/lib/supabase";
import { createFriendlySession } from "../../src/lib/friendly/ops";
import { signatureHeader } from "../../src/lib/registration/signature";
import { callAction, actionOk, form } from "./lib/actions";
import { sessionToken, staffToken } from "./lib/session";
import { appUser, assertStandIn, BASE_URL, bearer, check, cookie, finish, http as call, section, type Who } from "./lib/fixtures";

assertStandIn("registration.ts");

const tag = randomUUID().slice(0, 6);
const ACTIONS = "src/app/admin/tournaments/[id]/registrations/actions.ts";
const MT_URL = process.env.MOVE_TICK_API_URL ?? "";
const MT_KEY = process.env.MOVE_TICK_PARTNER_KEY ?? "";
const MT_SECRET = process.env.MOVE_TICK_WEBHOOK_SECRET ?? "";
if (!MT_URL || !MT_KEY || MT_SECRET.length < 32) {
  console.error("registration.ts needs MOVE_TICK_API_URL, MOVE_TICK_PARTNER_KEY and MOVE_TICK_WEBHOOK_SECRET in .env.localdb (and the server started with them).");
  process.exit(1);
}

/* ---------------- the fake Move Tick ---------------- */

interface FakeSession {
  sessionId: string;
  reference: string;
  amount: number;
  status: string;
  idem: string;
  returnUrl: string;
}
const mt = {
  sessions: new Map<string, FakeSession>(),
  calls: [] as { path: string; auth: string | null; body: unknown }[],
  /** "refunded" answers at once; "refund_pending" waits for a webhook. */
  refundMode: "refunded" as "refunded" | "refund_pending",
};
function fakeMoveTick(): http.Server {
  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const auth = req.headers.authorization ?? null;
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      mt.calls.push({ path: req.url ?? "", auth, body });
      if (auth !== `Bearer ${MT_KEY}`) return send(401, { code: "UNAUTHENTICATED" });
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/api/partner/v1/payment-sessions") {
        const idem = String(req.headers["idempotency-key"] ?? "");
        const prior = [...mt.sessions.values()].find((s) => s.idem === idem);
        const s =
          prior ??
          ({ sessionId: `pts_test_${randomUUID().slice(0, 12)}`, reference: String(body?.reference), amount: Number(body?.amount), status: "open", idem, returnUrl: String(body?.returnUrl) } satisfies FakeSession);
        mt.sessions.set(s.sessionId, s);
        // Move Tick's partner checkouts live 15 minutes (the place hold Move Score takes for them).
        return send(201, { sessionId: s.sessionId, checkoutUrl: `${MT_URL}/checkout/${s.sessionId}`, status: s.status, amount: s.amount, currency: "EGP", reference: s.reference, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), testMode: true });
      }
      const one = /^\/api\/partner\/v1\/payment-sessions\/([^/]+)$/.exec(url);
      if (req.method === "GET" && one) {
        const s = mt.sessions.get(decodeURIComponent(one[1]!));
        if (!s) return send(404, { code: "PAYMENT_NOT_FOUND" });
        return send(200, { sessionId: s.sessionId, checkoutUrl: `${MT_URL}/checkout/${s.sessionId}`, status: s.status, amount: s.amount, currency: "EGP", reference: s.reference, expiresAt: null, testMode: true });
      }
      const refund = /^\/api\/partner\/v1\/payment-sessions\/([^/]+)\/refund$/.exec(url);
      if (req.method === "POST" && refund) {
        const s = mt.sessions.get(decodeURIComponent(refund[1]!));
        if (!s || s.status !== "paid" || body?.reference !== s.reference) return send(404, { code: "PAYMENT_NOT_FOUND" });
        if (Number(body?.amount) !== s.amount) return send(422, { code: "PARTIAL_REFUND_UNSUPPORTED" });
        s.status = mt.refundMode === "refunded" ? "refunded" : "refund_pending";
        return send(200, { refundId: `re_${randomUUID().slice(0, 8)}`, status: s.status });
      }
      return send(404, { code: "NOT_FOUND" });
    });
  });
}

/* ---------------- helpers ---------------- */

// The signed links, made here the way the server makes them (AUTH_SECRET is the server's, in .env.localdb).
const signed = (purpose: string, id: string) => createHmac("sha256", process.env.AUTH_SECRET ?? "").update(`${purpose}:v1:${id}`).digest("base64url").slice(0, 32);
const statusTok = (id: string) => signed("mb-registration-status", id);
const confirmTok = (id: string) => signed("mb-registration-confirm", id);
let ipSeq = 0;
const freshIp = () => `10.${60 + (Math.floor(++ipSeq / 250) % 100)}.${randomInt(1, 250)}.${(ipSeq % 250) + 1}`;
/** The button on /register/confirm, as the browser posts it. */
async function confirmLink(id: string, c = confirmTok(id)) {
  const res = await fetch(`${BASE_URL}/api/register/confirm`, { method: "POST", body: new URLSearchParams({ r: id, c }), redirect: "manual", headers: xff(freshIp()) });
  return { status: res.status, location: res.headers.get("location") ?? "" };
}
/** Web guest registration (the public form). */
async function guestRegister(slug: string, person: { name: string; phone?: string; email: string }, extra: Record<string, unknown> = {}, ip = freshIp()) {
  const res = await fetch(`${BASE_URL}/api/register/${slug}`, { method: "POST", headers: { "Content-Type": "application/json", ...xff(ip) }, body: JSON.stringify({ people: [{ phone: phone(), ...person }], website: "", ...extra }) });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; message?: string; statusUrl?: string | null } | null;
  const id = json?.statusUrl ? new URL(json.statusUrl).searchParams.get("r") : null;
  return { status: res.status, json, id };
}
async function deliveriesOf(regId: string) {
  const { data } = await db().from("message_deliveries").select("idempotency_key, channel, address, vars, status").like("idempotency_key", `registration:${regId}:%`);
  return (data ?? []) as { idempotency_key: string; channel: string; address: string; vars: Record<string, unknown>; status: string }[];
}
async function onlinePayments(regId: string) {
  const { data } = await db().from("registration_payments").select("id, status, session_id, paid_at, review_reason, amount").eq("registration_id", regId).eq("method", "online").order("created_at");
  return (data ?? []) as { id: string; status: string; session_id: string | null; paid_at: string | null; review_reason: string | null; amount: number }[];
}
/** The stand-in's SQL door (scripts/localdb/server.mjs), for faults no request can cause. */
async function standinSql(query: string) {
  const res = await fetch(`${process.env.SUPABASE_URL}/__sql`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
  if (!res.ok) throw new Error(`__sql ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const phone = () => `010${String(randomInt(10_000_000, 99_999_999))}`;
const actor = (token: string): Who => cookie(token);
const xff = (ip: string): Who => ({ "X-Forwarded-For": ip });
const act = (name: string, fields: Record<string, string | string[]>, who: Who, tournamentId: string) => {
  const f = form({});
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return callAction(ACTIONS, name, [f], who, { id: tournamentId });
};

async function webhook(evt: Record<string, unknown>, opts: { secret?: string; at?: number; header?: string | null } = {}) {
  const raw = JSON.stringify(evt);
  const header = opts.header === undefined ? signatureHeader(opts.secret ?? MT_SECRET, raw, opts.at ?? Date.now()) : opts.header;
  const res = await fetch(`${BASE_URL}/api/webhooks/move-tick`, { method: "POST", headers: { "Content-Type": "application/json", ...(header ? { "MoveTick-Signature": header } : {}) }, body: raw });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}
const paidEvent = (s: FakeSession, over: Record<string, unknown> = {}, id = `evt_${randomUUID().slice(0, 12)}`) => ({
  id,
  type: "payment.succeeded",
  createdAt: new Date().toISOString(),
  data: { sessionId: s.sessionId, reference: s.reference, amount: s.amount, currency: "EGP", testMode: true, ...over },
});

async function reg(id: string) {
  const { data } = await db().from("registrations").select("*").eq("id", id).single();
  return data as Record<string, unknown> & { status: string; team_id: string | null; player_id: string | null; entry_ids: string[]; paid_at: string | null; venue_paid_at: string | null; amount_online: number; amount_venue: number; materialized_at: string | null };
}
/** The app's Pay button. */
const payNow = (id: string, who: Who) => call("POST", `/api/mobile/v1/me/registrations/${id}/pay`, who, {});

async function settings(tournamentId: string, fields: Record<string, string>, who: Who) {
  const r = await act("saveRegistrationSettings", { tournament_id: tournamentId, open: "on", entry_type: "team", team_size: "2", approval_mode: "organiser", fee: "250", payment: "online_or_venue", team_payer: "registrant", capacity: "", closes_at: "", note: "", ...fields }, who, tournamentId);
  if (!actionOk(r)) throw new Error(`settings: ${r.status} ${r.text.slice(0, 300)}`);
}

const created = { tournaments: [] as string[], orgs: [] as string[], users: [] as string[], members: [] as string[], phones: [] as string[] };

async function main() {
  const server = fakeMoveTick();
  const port = Number(new URL(MT_URL).port || 80);
  await new Promise<void>((ok) => server.listen(port, ok));
  try {
    const { data: mbRow } = await db().from("organizations").select("id").eq("slug", "move-beyond").single();
    const MB = (mbRow as { id: string }).id;
    const { data: bRow } = await db().from("organizations").insert({ slug: `e2e-reg-b-${tag}`, name: `E2E Reg Org B ${tag}`, status: "approved" }).select("id").single();
    const B = (bRow as { id: string }).id;
    created.orgs.push(B);

    const member = async (who: string, orgId: string, role: "admin" | "manager") => {
      const u = await appUser(`e2e.reg.${who}.${tag}@example.com`);
      created.users.push(u.userId);
      const { data } = await db().from("organization_members").insert({ organization_id: orgId, auth_user_id: u.userId, invited_email: `e2e.reg.${who}.${tag}@example.com`, role, status: "active" }).select("id").single();
      created.members.push((data as { id: string }).id);
      return actor(staffToken({ kind: "member", userId: u.userId, orgId, role }));
    };
    const mbAdmin = await member("mbadmin", MB, "admin");
    const mbManager = await member("mbmanager", MB, "manager");
    const bAdmin = await member("badmin", B, "admin");
    const shared = cookie(sessionToken("admin"));
    const player = async (who: string) => {
      const u = await appUser(`e2e.reg.${who}.${tag}@example.com`);
      created.users.push(u.userId);
      // Each player on its own network address (the app's per-address registration limit is 30 an hour).
      return { ...u, who: { ...bearer(u.token), ...xff(freshIp()) } };
    };
    const U1 = await player("u1");
    const U2 = await player("u2");
    const U3 = await player("u3");
    const U4 = await player("u4");
    const U5 = await player("u5");
    const U6 = await player("u6");

    const event = async (name: string, orgId: string, opts: { startsInHours?: number; endsOn?: string; status?: string; sport?: string } = {}) => {
      const starts = new Date(Date.now() + (opts.startsInHours ?? 72) * 3600_000);
      const { data, error } = await db()
        .from("tournaments")
        .insert({
          name: `${name} ${tag}`,
          slug: `e2e-reg-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${tag}`,
          sport: opts.sport ?? "padel",
          status: opts.status ?? "active",
          is_demo: true,
          organization_id: orgId,
          starts_at: starts.toISOString(),
          starts_on: starts.toISOString().slice(0, 10),
          ends_on: opts.endsOn ?? starts.toISOString().slice(0, 10),
        })
        .select("id, slug")
        .single();
      if (error) throw new Error(`tournament: ${error.message}`);
      created.tournaments.push((data as { id: string }).id);
      return data as { id: string; slug: string };
    };

    /* ---------------- 1 ---------------- */
    section("settings and what players are offered");
    const T1 = await event("Team Cup", MB);
    const before = await call("GET", `/api/mobile/v1/t/${T1.slug}/registration`);
    check(before.status === 200 && before.json?.open === false && before.json?.approval === "on_payment" && before.json?.teamPayer === "registrant" && !("refundFeePercent" in (before.json ?? {})) && before.json?.checkoutHoldMinutes === 15, "a new event is closed, first paid first in, registrant pays, no card-fee setting (the owner's defaults)", before.json);
    await settings(T1.id, {}, mbAdmin);
    const info = await call("GET", `/api/mobile/v1/t/${T1.slug}/registration`);
    check(info.status === 200 && info.json?.open === true && JSON.stringify(info.json?.paymentOptions) === JSON.stringify(["online", "venue"]) && info.json?.feePerPlayer === 25000 && info.json?.people === 2, "Move Beyond's event offers Move Tick and the venue, EGP 250 per player, teams of 2", info.json);
    check(typeof info.json?.refundsUntil === "string" && Math.abs(Date.parse(String(info.json?.refundsUntil)) - (Date.parse(String((info.json?.event as { startsAt: string }).startsAt)) - 86400_000)) < 1000, "refunds until 24 hours before the start time", info.json?.refundsUntil);
    const web = await fetch(`${BASE_URL}/register/${T1.slug}`);
    check(web.status === 200 && (await web.text()).includes("Team Cup"), "the public web registration page opens");

    const TB = await event("Club Cup", B);
    await settings(TB.id, { payment: "online" }, bAdmin);
    const infoB = await call("GET", `/api/mobile/v1/t/${TB.slug}/registration`);
    check(JSON.stringify(infoB.json?.paymentOptions) === JSON.stringify(["venue"]), "another organisation is offered the venue only, even when it saved online", infoB.json?.paymentOptions);
    const bOnline = await call("POST", `/api/mobile/v1/t/${TB.slug}/registration`, U6.who, { people: [{ name: "Bee One", phone: phone() }, { name: "Bee Two" }], payment: "online" });
    check(bOnline.status === 400, "another organisation cannot take an online payment", bOnline.json);
    const bVenue = await call("POST", `/api/mobile/v1/t/${TB.slug}/registration`, U6.who, { people: [{ name: "Bee One", phone: phone() }, { name: "Bee Two" }], payment: "venue" });
    const RB = String((bVenue.json?.registration as { id: string } | undefined)?.id);
    check(bVenue.status === 201 && bVenue.json?.checkoutUrl === null && (await reg(RB)).amount_venue === 50000, "it registers to pay at the venue", bVenue.json);
    const bPays = await db().from("registration_payments").select("id").eq("registration_id", RB);
    check((bPays.data ?? []).length === 0, "no Move Tick session was ever made for it");

    /* ---------------- 2 ---------------- */
    section("team registration, approval, Move Tick payment");
    const p1 = phone();
    const p2 = phone();
    created.phones.push(p1, p2);
    const tampered = await call("POST", `/api/mobile/v1/t/${T1.slug}/registration`, U1.who, { people: [{ name: "Una One", phone: p1 }, { name: "Pat Partner", phone: p2 }], payment: "online", amount: 1 });
    check(tampered.status === 400, "a body with an amount (or any unknown field) is refused", tampered.status);
    const noAuth = await call("POST", `/api/mobile/v1/t/${T1.slug}/registration`, {}, { people: [{ name: "Una One", phone: p1 }, { name: "Pat Partner" }], payment: "online" });
    check(noAuth.status === 401, "registering in the app needs a signed-in account");
    const r1 = await call("POST", `/api/mobile/v1/t/${T1.slug}/registration`, U1.who, { people: [{ name: "Una One", phone: p1, email: `una.${tag}@example.com` }, { name: "Pat Partner", phone: p2 }], teamName: "Una & Pat", payment: "online" });
    const R1 = String((r1.json?.registration as { id: string } | undefined)?.id);
    check(r1.status === 201 && (r1.json?.registration as { status: string }).status === "pending_approval" && r1.json?.checkoutUrl === null, "registered: waiting for the organiser, nothing to pay yet", r1.json);
    check(!/\+20|example\.com/.test(r1.text), "the app's answer holds names only (no phone, no email)", r1.text.slice(0, 300));
    const again = await call("POST", `/api/mobile/v1/t/${T1.slug}/registration`, U1.who, { people: [{ name: "Una One", phone: p1 }, { name: "Pat Partner", phone: p2 }], payment: "online" });
    check(again.status === 409 && again.json?.code === "already_registered", "one live entry per account per event", again.json);
    const payEarly = await call("POST", `/api/mobile/v1/me/registrations/${R1}/pay`, U1.who, {});
    check(payEarly.status === 409, "no payment before the organiser approves", payEarly.json);

    const approve = await act("decideRegistrationAction", { registration_id: R1, decision: "approve" }, mbAdmin, T1.id);
    const approved = await reg(R1);
    check(actionOk(approve) && approved.status === "awaiting_payment" && approved.hold_kind === "approval" && Math.abs(Date.parse(String(approved.hold_until)) - (Date.now() + 24 * 3600_000)) < 120_000, "organiser mode: the approval keeps the place for 24 hours while it is paid", { status: approved.status, kind: approved.hold_kind, until: approved.hold_until });
    const pay = await call("POST", `/api/mobile/v1/me/registrations/${R1}/pay`, U1.who, {});
    const s1 = [...mt.sessions.values()].find((s) => s.reference === R1)!;
    check(pay.status === 200 && String(pay.json?.checkoutUrl).startsWith(`${MT_URL}/checkout/`) && s1?.amount === 50000, "a Move Tick checkout for the server's amount (the registrant pays for the team: EGP 500)", { status: pay.status, amount: s1?.amount });
    const call1 = mt.calls.find((c) => c.path === "/api/partner/v1/payment-sessions" && (c.body as { reference?: string })?.reference === R1);
    check(call1?.auth === `Bearer ${MT_KEY}` && (call1?.body as { currency: string; returnUrl: string }).currency === "EGP" && /\/register\/status\?r=/.test((call1?.body as { returnUrl: string }).returnUrl), "the partner call carries the key, EGP, the reference and a signed return URL");
    const pay2 = await call("POST", `/api/mobile/v1/me/registrations/${R1}/pay`, U1.who, {});
    check(pay2.json?.checkoutUrl === pay.json?.checkoutUrl && [...mt.sessions.values()].filter((s) => s.reference === R1).length === 1, "paying again reuses the open checkout");
    const status = await fetch(s1.returnUrl);
    check(status.status === 200 && /waiting for payment/i.test(await status.text()), "the return page shows the status with the signed link");
    const forged = await fetch(s1.returnUrl.replace(/s=[^&]+/, "s=forged"));
    check(/Registration not found/.test(await forged.text()), "a forged status link shows nothing");

    const evt = paidEvent(s1);
    const unsigned = await webhook(evt, { header: null });
    const badSig = await webhook(evt, { secret: "z".repeat(40) });
    const stale = await webhook(evt, { at: Date.now() - 6 * 60_000 });
    const future = await webhook(evt, { at: Date.now() + 6 * 60_000 });
    check(unsigned.status === 401 && badSig.status === 401 && stale.status === 401 && future.status === 401 && (await reg(R1)).status === "awaiting_payment", "unsigned, wrongly signed, stale and future-dated webhooks are refused; nothing changes", [unsigned.status, badSig.status, stale.status, future.status]);
    const wrongMode = await webhook(paidEvent(s1, { testMode: false }));
    check(wrongMode.status === 200 && (await reg(R1)).status === "awaiting_payment", "a live-mode event for a test-mode payment changes nothing", wrongMode.json);
    const wrongRef = await webhook(paidEvent(s1, { reference: randomUUID() }));
    check(wrongRef.status === 200 && (await reg(R1)).status === "awaiting_payment", "an event whose reference is not the session's registration changes nothing (and says nothing)", wrongRef.json);

    const ok = await webhook(evt);
    s1.status = "paid";
    const after = await reg(R1);
    check(ok.status === 200 && after.status === "confirmed" && Boolean(after.paid_at) && Boolean(after.team_id), "the signed payment confirms the entry and makes its team", { status: ok.status, reg: after.status });
    const { data: teamPlayers } = await db().from("players").select("id, full_name, player_order, player_profile_id, phone").eq("team_id", after.team_id!).order("player_order");
    const tp = (teamPlayers ?? []) as { id: string; full_name: string; player_profile_id: string | null; phone: string | null }[];
    const { data: claims } = await db().from("player_claims").select("user_id, player_id, proof").in("player_id", tp.map((p) => p.id));
    const cl = (claims ?? []) as { user_id: string; player_id: string; proof: string }[];
    check(tp.length === 2 && cl.length === 1 && cl[0]!.player_id === after.player_id && cl[0]!.user_id === U1.userId && cl[0]!.proof === "registration", "the registrant's own row is linked to their account (proof: registration); the partner's row to nobody", cl);
    const { data: prof } = await db().from("player_profiles").select("id, auth_user_id, mobile_normalized").eq("auth_user_id", U1.userId).maybeSingle();
    check(Boolean(prof) && tp[1]!.player_profile_id === null && (prof as { mobile_normalized: string | null }).mobile_normalized === null, "the account got its own profile (no unproven mobile on it); the partner's row joined no profile", prof);
    const replay = await webhook(evt);
    const fresh = await webhook(paidEvent(s1));
    const { count: teams } = await db().from("teams").select("id", { count: "exact", head: true }).eq("tournament_id", T1.id);
    const { count: paidAudits } = await db().from("audit_logs").select("id", { count: "exact", head: true }).eq("entity_id", R1).eq("action", "REGISTRATION_PAID");
    check(replay.status === 200 && replay.json?.duplicate === true && fresh.status === 200 && teams === 1 && paidAudits === 1, "a replayed event (same id, or a fresh id) changes nothing: one team, one payment", { replay: replay.json, teams, paidAudits });
    const mine = await call("GET", "/api/mobile/v1/me/registrations", U1.who);
    const mineR1 = (mine.json?.registrations as { id: string; status: string; linked: boolean; paid: boolean }[] | undefined)?.find((x) => x.id === R1);
    check(mine.status === 200 && mineR1?.status === "confirmed" && mineR1.linked && mineR1.paid && !/\+20|una\./.test(mine.text), "My registrations: confirmed, paid, linked, names only", mineR1);

    // An amount Move Tick reports differently is held for review, never confirmed.
    const r4 = await call("POST", `/api/mobile/v1/t/${T1.slug}/registration`, U4.who, { people: [{ name: "Mia Mismatch", phone: phone() }, { name: "Max Mismatch" }], payment: "online" });
    const R4 = String((r4.json?.registration as { id: string }).id);
    await act("decideRegistrationAction", { registration_id: R4, decision: "approve" }, mbAdmin, T1.id);
    await call("POST", `/api/mobile/v1/me/registrations/${R4}/pay`, U4.who, {});
    const s4 = [...mt.sessions.values()].find((s) => s.reference === R4)!;
    const mis = await webhook(paidEvent(s4, { amount: 100 }));
    const { data: p4 } = await db().from("registration_payments").select("status").eq("session_id", s4.sessionId).single();
    check(mis.status === 200 && (await reg(R4)).status === "awaiting_payment" && (p4 as { status: string }).status === "needs_review", "an amount that is not the server's is held for review, never confirmed", p4);
    const cancel4 = await call("POST", `/api/mobile/v1/me/registrations/${R4}/cancel`, U4.who, {});
    check(cancel4.status === 200 && (await reg(R4)).status === "cancelled", "the player cancels an unpaid entry");

    /* ---------------- 2b ---------------- */
    section("first paid, first in (the default)");
    const sessionsFor = (ref: string) => [...mt.sessions.values()].filter((x) => x.reference === ref);
    const idOf = (r: { json: Record<string, unknown> | null }) => String((r.json?.registration as { id?: string } | undefined)?.id ?? "");
    const solo = (slug: string, who: Who, name: string, extra: Record<string, unknown> = {}) => call("POST", `/api/mobile/v1/t/${slug}/registration`, who, { people: [{ name, phone: phone() }], payment: "online", ...extra });
    const mbAdminEmail = `e2e.reg.mbadmin.${tag}@example.com`;

    const TF1 = await event("First Paid Cup", MB);
    await settings(TF1.id, { entry_type: "individual", fee: "250", payment: "online", approval_mode: "on_payment", capacity: "1" }, mbAdmin);
    const FA = await player("fa");
    const FB = await player("fb");
    const FC = await player("fc");
    const ra = await solo(TF1.slug, FA.who, "Fay First");
    const RA = idOf(ra);
    const ga = await reg(RA);
    check(
      ra.status === 201 && ga.status === "awaiting_payment" && ga.hold_until === null && ra.json?.checkoutUrl === null && sessionsFor(RA).length === 0 && (ra.json?.registration as { canPay?: boolean } | undefined)?.canPay === true,
      "registering holds no place and opens no checkout: the entry waits for its payment",
      { status: ga.status, hold: ga.hold_until, sessions: sessionsFor(RA).length },
    );
    const rb = await solo(TF1.slug, FB.who, "Fred Second");
    const RB2 = idOf(rb);
    const infoF = await call("GET", `/api/mobile/v1/t/${TF1.slug}/registration`);
    check(rb.status === 201 && infoF.json?.open === true && infoF.json?.placesLeft === 1 && infoF.json?.approval === "on_payment", "an unpaid entry takes no place: a second player registers for the last place too", { rb: rb.status, info: infoF.json });
    const [pa, pb] = await Promise.all([payNow(RA, FA.who), payNow(RB2, FB.who)]);
    const aWon = pa.status === 200;
    const winner = aWon ? { id: RA, who: FA.who } : { id: RB2, who: FB.who };
    const loser = aWon ? { id: RB2, who: FB.who, res: pb } : { id: RA, who: FA.who, res: pa };
    check(
      [pa.status, pb.status].sort().join(",") === "200,409" && loser.res.json?.code === "full" && /full/i.test(String(loser.res.json?.error)) && sessionsFor(loser.id).length === 0 && sessionsFor(winner.id).length === 1,
      "two players press Pay at once for the last place: one checkout; the other is told the event is full before any checkout",
      { a: pa.status, b: pb.status, loser: loser.res.json },
    );
    const wr = await reg(winner.id);
    check(wr.hold_kind === "checkout" && Math.abs(Date.parse(String(wr.hold_until)) - (Date.now() + 15 * 60_000)) < 60_000, "the open checkout keeps the place for 15 minutes (the Move Tick checkout's lifetime)", { kind: wr.hold_kind, until: wr.hold_until });
    const infoHeld = await call("GET", `/api/mobile/v1/t/${TF1.slug}/registration`);
    check(infoHeld.json?.open === false && infoHeld.json?.closedMessage === "This event is full." && infoHeld.json?.placesLeft === 0, "while it is open the event shows as full", infoHeld.json);
    const repay = await payNow(winner.id, winner.who);
    check(repay.status === 200 && sessionsFor(winner.id).length === 1 && (await reg(winner.id)).hold_until === wr.hold_until, "pressing Pay again reuses the checkout and never stretches the hold");
    const sw = sessionsFor(winner.id)[0]!;
    await webhook(paidEvent(sw));
    sw.status = "paid";
    const wc = await reg(winner.id);
    check(
      wc.status === "confirmed" && wc.decided_at === null && Boolean(wc.paid_at) && (await deliveriesOf(winner.id)).some((d) => d.idempotency_key.includes(":confirmed")),
      "the full payment confirms the entry at once, with no organiser step (and the player is emailed)",
      { status: wc.status, decided: wc.decided_at },
    );
    const loserAgain = await payNow(loser.id, loser.who);
    const third = await solo(TF1.slug, FC.who, "Flo Third");
    check(loserAgain.status === 409 && loserAgain.json?.code === "full" && third.status === 409 && third.json?.code === "full", "the other player still cannot pay, and nobody else can register: the event is full", { pay: loserAgain.status, third: third.status });

    // A checkout that expires (or fails) gives its place back; so does a hold that ran out on its own.
    const TF2 = await event("Hold Expiry Cup", MB);
    await settings(TF2.id, { entry_type: "individual", fee: "250", payment: "online", approval_mode: "on_payment", capacity: "1" }, mbAdmin);
    const HA = await player("ha");
    const HB = await player("hb");
    const HC = await player("hc");
    const RHA = idOf(await solo(TF2.slug, HA.who, "Hana Hold"));
    const RHB = idOf(await solo(TF2.slug, HB.who, "Hugo Hold"));
    await payNow(RHA, HA.who);
    const sHA = sessionsFor(RHA)[0]!;
    const blocked = await payNow(RHB, HB.who);
    check(blocked.status === 409 && blocked.json?.code === "full", "while the first player's checkout is open, the place is theirs", blocked.json);
    const exp = await webhook({ id: `evt_${randomUUID().slice(0, 12)}`, type: "payment.expired", createdAt: new Date().toISOString(), data: { sessionId: sHA.sessionId, reference: RHA, amount: sHA.amount, currency: "EGP", refundedAmount: null, testMode: true } });
    sHA.status = "expired";
    const ha = await reg(RHA);
    const infoFreed = await call("GET", `/api/mobile/v1/t/${TF2.slug}/registration`);
    check(exp.status === 200 && Date.parse(String(ha.hold_until)) <= Date.now() && ha.status === "awaiting_payment" && infoFreed.json?.open === true && infoFreed.json?.placesLeft === 1, "Move Tick reports the checkout expired: its place is free again", { hold: ha.hold_until, info: infoFreed.json });
    const pHB = await payNow(RHB, HB.who);
    check(pHB.status === 200 && sessionsFor(RHB).length === 1, "…and the next player can pay", pHB.json);
    await db().from("registrations").update({ hold_until: new Date(Date.now() - 1000).toISOString() }).eq("id", RHB);
    const infoLapsed = await call("GET", `/api/mobile/v1/t/${TF2.slug}/registration`);
    check(infoLapsed.json?.open === true && infoLapsed.json?.placesLeft === 1, "a checkout hold that ran out (15 minutes, no word from Move Tick) frees the place on its own", infoLapsed.json);
    const RHC = idOf(await solo(TF2.slug, HC.who, "Hal Hold"));
    const pHC = await payNow(RHC, HC.who);
    check(pHC.status === 200, "someone else takes the place by paying", pHC.json);
    const sHB = sessionsFor(RHB)[0]!;
    await webhook(paidEvent(sHB));
    sHB.status = "paid";
    const hbPay = (await onlinePayments(RHB)).find((p) => p.session_id === sHB.sessionId);
    const hbMail = await deliveriesOf(RHB);
    const { count: overfill } = await db().from("registrations").select("id", { count: "exact", head: true }).eq("tournament_id", TF2.id).eq("status", "confirmed");
    check(
      (await reg(RHB)).status === "awaiting_payment" && hbPay?.status === "needs_review" && (overfill ?? 0) === 0 && hbMail.some((d) => d.idempotency_key.includes(":review:") && d.address === mbAdminEmail) && hbMail.some((d) => /:full:/.test(d.idempotency_key)),
      "a payment landing when the event is already full is not confirmed: flagged for a refund, the admins and the player emailed",
      { pay: hbPay?.status, review: hbPay?.review_reason, mail: hbMail.map((d) => d.idempotency_key) },
    );
    const refHB = await act("refundRegistrationAction", { registration_id: RHB, payment_id: hbPay?.id ?? "", confirm: "REFUND", reason: "event full" }, mbAdmin, TF2.id);
    const callHB = mt.calls.find((c) => /\/refund$/.test(c.path) && (c.body as { reference?: string })?.reference === RHB);
    check(actionOk(refHB) && (callHB?.body as { amount?: number } | undefined)?.amount === 25000 && (await onlinePayments(RHB)).find((p) => p.id === hbPay?.id)?.status === "refunded", "one click refunds the flagged payment in full", { ok: actionOk(refHB), call: callHB?.body });
    const sHC = sessionsFor(RHC)[0]!;
    await webhook(paidEvent(sHC));
    sHC.status = "paid";
    check((await reg(RHC)).status === "confirmed", "the player whose checkout held the place is confirmed by their payment");

    // A free event: confirmed on registration while places remain.
    const TF3 = await event("Free First Cup", MB);
    await settings(TF3.id, { entry_type: "individual", fee: "0", payment: "free", approval_mode: "on_payment", capacity: "1" }, mbAdmin);
    const fr1 = await solo(TF3.slug, (await player("fr1")).who, "Fran Free", { payment: "free" });
    const fr2 = await solo(TF3.slug, (await player("fr2")).who, "Finn Free", { payment: "free" });
    check(fr1.status === 201 && (await reg(idOf(fr1))).status === "confirmed" && fr2.status === 409 && fr2.json?.code === "full", "a free event confirms on registration while places remain, then is full", { fr1: fr1.status, fr2: fr2.status });

    /* ---------------- 2c ---------------- */
    section("entry type both: solo players and teams in one event");
    const TBo = await event("Mixed Cup", MB);
    await settings(TBo.id, { entry_type: "both", team_size: "2", fee: "250", payment: "online_or_venue", approval_mode: "on_payment", capacity: "2" }, mbAdmin);
    const infoBo = await call("GET", `/api/mobile/v1/t/${TBo.slug}/registration`);
    check(infoBo.json?.entryType === "both" && infoBo.json?.people === 2 && JSON.stringify(infoBo.json?.entryKinds) === JSON.stringify(["team", "individual"]) && infoBo.json?.placesLeft === 4, "an event that takes both offers a team of 2 or a solo entry; 2 teams = 4 player places", infoBo.json);
    const BT = await player("bt");
    const BS = await player("bs");
    const BX = await player("bx");
    const rt = await call("POST", `/api/mobile/v1/t/${TBo.slug}/registration`, BT.who, { people: [{ name: "Tia Team", phone: phone() }, { name: "Tom Team" }], teamName: "Tia & Tom", entryType: "team", payment: "venue" });
    const gt = await reg(idOf(rt));
    check(rt.status === 201 && gt.status === "confirmed" && gt.entry_type === "team" && gt.amount_venue === 50000 && Boolean(gt.team_id), "a team paying at the venue is in at once, for both players' fees (EGP 500 at the venue)", { status: gt.status, venue: gt.amount_venue });
    const rs = await call("POST", `/api/mobile/v1/t/${TBo.slug}/registration`, BS.who, { people: [{ name: "Sol Solo", phone: phone() }], entryType: "individual", payment: "online" });
    const RS = idOf(rs);
    const gs = await reg(RS);
    await payNow(RS, BS.who);
    const ss = sessionsFor(RS)[0];
    check(rs.status === 201 && gs.entry_type === "individual" && gs.amount_online === 25000 && ss?.amount === 25000, "a solo player pays one player's fee online (EGP 250)", { kind: gs.entry_type, online: gs.amount_online, checkout: ss?.amount });
    if (ss) {
      await webhook(paidEvent(ss));
      ss.status = "paid";
    }
    const gs2 = await reg(RS);
    check(gs2.status === "confirmed" && !gs2.materialized_at, "paid: the solo player is in, waiting to be paired", { status: gs2.status });
    const infoMid = await call("GET", `/api/mobile/v1/t/${TBo.slug}/registration`);
    const teamLate = await call("POST", `/api/mobile/v1/t/${TBo.slug}/registration`, BX.who, { people: [{ name: "Xan Late", phone: phone() }, { name: "Xia Late" }], entryType: "team", payment: "venue" });
    const badKind = await call("POST", `/api/mobile/v1/t/${TBo.slug}/registration`, BX.who, { people: [{ name: "Xan Late", phone: phone() }], entryType: "squad", payment: "venue" });
    check(
      infoMid.json?.open === true && JSON.stringify(infoMid.json?.entryKinds) === JSON.stringify(["individual"]) && infoMid.json?.placesLeft === 1 && teamLate.status === 409 && teamLate.json?.code === "full" && badKind.status === 400,
      "with 3 of 4 places taken a team no longer fits but a solo player still does (and an unknown entry kind is refused)",
      { info: infoMid.json?.entryKinds, team: teamLate.status, bad: badKind.status },
    );
    const gB = await guestRegister(TBo.slug, { name: "Gwen Guest", email: `gwen.${tag}@example.com` }, { entryType: "individual", payment: "venue" });
    if (gB.id) await confirmLink(gB.id);
    const gg = gB.id ? await reg(gB.id) : null;
    const infoBoFull = await call("GET", `/api/mobile/v1/t/${TBo.slug}/registration`);
    check(gg?.status === "confirmed" && gg.entry_type === "individual" && gg.amount_venue === 25000 && infoBoFull.json?.open === false, "a web guest enters solo too (confirmed by the emailed link); now the event is full", { status: gg?.status, open: infoBoFull.json?.open });
    const pairBo = await act("pairRegistrationsAction", { tournament_id: TBo.id, registration_ids: [RS, gB.id ?? ""] }, mbAdmin, TBo.id);
    const { count: teamsBo } = await db().from("teams").select("id", { count: "exact", head: true }).eq("tournament_id", TBo.id);
    check(actionOk(pairBo) && teamsBo === 2 && Boolean((await reg(RS)).team_id), "the organiser pairs the two solo players: two teams fill the two places", { teamsBo });

    /* ---------------- 3 ---------------- */
    section("individual entries");
    const S = await createFriendlySession({ name: `E2E Reg Night ${tag}`, seasonId: null, startsAt: new Date(Date.now() + 48 * 3600_000).toISOString(), durationMinutes: 120, courtCount: 2, pairingMode: "americano", rankingModel: "win_points", setsToWinMatch: 1, gamesToWinSet: 6, maxPlayers: null, registrationDeadline: null, organizationId: MB, actorRole: "admin" });
    const ST = (S as { tournament_id: string }).tournament_id;
    created.tournaments.push(ST);
    const { data: st } = await db().from("tournaments").select("slug").eq("id", ST).single();
    const sSlug = (st as { slug: string }).slug;
    await settings(ST, { entry_type: "individual", fee: "0", payment: "free", approval_mode: "on_payment" }, mbAdmin);
    const p3 = phone();
    created.phones.push(p3);
    const r3 = await call("POST", `/api/mobile/v1/t/${sSlug}/registration`, U3.who, { people: [{ name: "Sam Single", phone: p3 }] });
    const R3 = String((r3.json?.registration as { id: string } | undefined)?.id);
    const g3 = await reg(R3);
    const { data: p3prof } = await db().from("player_profiles").select("id").eq("auth_user_id", U3.userId).maybeSingle();
    const { data: entry } = await db().from("friendly_entries").select("player_profile_id, approval").eq("session_id", (S as { id: string }).id);
    check(r3.status === 201 && g3.status === "confirmed" && (g3.entry_ids ?? []).length === 1 && ((entry ?? []) as { player_profile_id: string; approval: string }[]).some((e) => e.player_profile_id === (p3prof as { id: string } | null)?.id && e.approval === "approved"), "a free individual session entry is confirmed at once, as the account's own profile", { status: g3.status, entry });

    const T3 = await event("Singles Pool", MB);
    await settings(T3.id, { entry_type: "individual", fee: "0", payment: "free", approval_mode: "on_payment" }, mbAdmin);
    const g = async (ip: string, name: string) => {
      const res = await fetch(`${BASE_URL}/api/register/${T3.slug}`, { method: "POST", headers: { "Content-Type": "application/json", ...xff(ip) }, body: JSON.stringify({ people: [{ name, phone: phone(), email: `${name.split(" ")[0]!.toLowerCase()}.${tag}@example.com` }], website: "" }) });
      return { status: res.status, json: (await res.json()) as { ok: boolean; message: string; statusUrl: string | null } };
    };
    const g1 = await g(`10.9.${randomInt(1, 250)}.1`, "Gina Guest");
    const g2 = await g(`10.9.${randomInt(1, 250)}.2`, "Gus Guest");
    const { data: pre } = await db().from("registrations").select("id, status, notify_email").eq("tournament_id", T3.id);
    const pl = (pre ?? []) as { id: string; status: string; notify_email: string | null }[];
    check(g1.json.ok && g2.json.ok && pl.length === 2 && pl.every((x) => x.status === "unconfirmed" && !x.notify_email), "web guests wait for the link emailed to them (unconfirmed: no place, no organiser)", pl);
    const linkSent = await deliveriesOf(pl[0]!.id);
    check(linkSent.length === 1 && linkSent[0]!.channel === "email" && /:confirm$/.test(linkSent[0]!.idempotency_key) && !JSON.stringify(linkSent[0]!.vars).includes(confirmTok(pl[0]!.id)), "the one message to the typed address is the link, by email, and the link is never stored", linkSent.map((d) => d.idempotency_key));
    const byStatusLink = await confirmLink(pl[0]!.id, statusTok(pl[0]!.id));
    check(byStatusLink.status === 303 && /e=not_found/.test(byStatusLink.location) && (await reg(pl[0]!.id)).status === "unconfirmed", "the status link (shown to whoever filled the form) cannot confirm the address", byStatusLink.location);
    const scanned = await fetch(`${BASE_URL}/register/confirm?r=${pl[0]!.id}&c=${confirmTok(pl[0]!.id)}`);
    check(scanned.status === 200 && (await scanned.text()).includes("Confirm my registration") && (await reg(pl[0]!.id)).status === "unconfirmed", "opening the link only shows the button (a mail scanner confirms nothing)");
    for (const x of pl) {
      const c = await confirmLink(x.id);
      check(c.status === 303 && c.location.includes("/register/status?r="), "the guest confirms with the button: back to the signed status page", c);
    }
    const { data: guests } = await db().from("registrations").select("id, status, materialized_at, auth_user_id").eq("tournament_id", T3.id);
    const gl = (guests ?? []) as { id: string; status: string; materialized_at: string | null; auth_user_id: string | null }[];
    check(gl.length === 2 && gl.every((x) => x.status === "confirmed" && !x.materialized_at && !x.auth_user_id), "web guests register as individuals; padel singles wait to be paired", gl);
    const pairB = await act("pairRegistrationsAction", { tournament_id: T3.id, registration_ids: gl.map((x) => x.id) }, bAdmin, T3.id);
    check(!actionOk(pairB), "another organisation cannot pair them");
    const pairMixed = await act("pairRegistrationsAction", { tournament_id: T3.id, registration_ids: [gl[0]!.id, R1] }, mbAdmin, T3.id);
    check(!actionOk(pairMixed), "an entry of another event cannot be paired in");
    const pair = await act("pairRegistrationsAction", { tournament_id: T3.id, registration_ids: gl.map((x) => x.id) }, mbAdmin, T3.id);
    const paired = await reg(gl[0]!.id);
    const { data: pairPlayers } = await db().from("players").select("id").eq("team_id", paired.team_id ?? randomUUID());
    const { count: guestClaims } = await db().from("player_claims").select("player_id", { count: "exact", head: true }).in("player_id", ((pairPlayers ?? []) as { id: string }[]).map((p) => p.id));
    check(actionOk(pair) && Boolean(paired.team_id) && (pairPlayers ?? []).length === 2 && guestClaims === 0, "the organiser pairs them into one team; guests' rows are linked to nobody", pair.text.slice(0, 200));
    const honey = await fetch(`${BASE_URL}/api/register/${T3.slug}`, { method: "POST", headers: { "Content-Type": "application/json", ...xff("10.8.0.9") }, body: JSON.stringify({ people: [{ name: "Bot Bot", phone: phone(), email: `bot.${tag}@example.com` }], website: "http://spam" }) });
    const { count: afterHoney } = await db().from("registrations").select("id", { count: "exact", head: true }).eq("tournament_id", T3.id);
    check(honey.status === 200 && afterHoney === 2, "the honeypot answers like a success and writes nothing");
    const burstIp = `10.7.${randomInt(1, 250)}.7`;
    const burst: number[] = [];
    for (let i = 0; i < 6; i++) burst.push((await fetch(`${BASE_URL}/api/register/${T3.slug}`, { method: "POST", headers: { "Content-Type": "application/json", ...xff(burstIp) }, body: "{}" })).status);
    check(burst.slice(0, 5).every((s) => s === 400) && burst[5] === 429, "the web form is rate-limited per address (counted before the work)", burst);

    /* ---------------- 4 ---------------- */
    section("pay at the venue");
    const T4 = await event("Venue Cup", MB);
    await settings(T4.id, { payment: "venue" }, mbAdmin);
    const r5 = await call("POST", `/api/mobile/v1/t/${T4.slug}/registration`, U5.who, { people: [{ name: "Vic Venue", phone: phone() }, { name: "Val Venue" }], payment: "venue" });
    const R5 = String((r5.json?.registration as { id: string }).id);
    await act("decideRegistrationAction", { registration_id: R5, decision: "approve" }, mbAdmin, T4.id);
    const v1 = await reg(R5);
    check(v1.status === "confirmed" && v1.amount_venue === 50000 && v1.amount_online === 0 && Boolean(v1.team_id), "approved: confirmed with EGP 500 due at the venue", v1);
    const vB = await act("markVenuePaidAction", { registration_id: R5 }, bAdmin, T4.id);
    check(!actionOk(vB) && !(await reg(R5)).venue_paid_at, "another organisation cannot record it paid");
    const vPaid = await act("markVenuePaidAction", { registration_id: R5 }, mbManager, T4.id);
    const v2 = await reg(R5);
    const { data: vrow } = await db().from("registration_payments").select("method, amount, status").eq("registration_id", R5);
    check(actionOk(vPaid) && Boolean(v2.venue_paid_at) && JSON.stringify(vrow) === JSON.stringify([{ method: "venue", amount: 50000, status: "paid" }]), "a manager records the payment at the venue", vrow);

    /* ---------------- 5 ---------------- */
    section("refunds");
    const P1 = (await onlinePayments(R1)).find((p) => p.status === "paid")?.id ?? "";
    const refShared = await act("refundRegistrationAction", { registration_id: R1, payment_id: P1, confirm: "REFUND", reason: "e2e" }, shared, T1.id);
    const refManager = await act("refundRegistrationAction", { registration_id: R1, payment_id: P1, confirm: "REFUND", reason: "e2e" }, mbManager, T1.id);
    const refB = await act("refundRegistrationAction", { registration_id: R1, payment_id: P1, confirm: "REFUND", reason: "e2e" }, bAdmin, T1.id);
    const refNoConfirm = await act("refundRegistrationAction", { registration_id: R1, payment_id: P1, confirm: "", reason: "e2e" }, mbAdmin, T1.id);
    check(!actionOk(refShared) && !actionOk(refManager) && !actionOk(refB) && !actionOk(refNoConfirm) && (await reg(R1)).status === "confirmed", "refunds: not the shared password, not a manager, not another organisation, not without typing REFUND");
    const askRefund = await call("POST", `/api/mobile/v1/me/registrations/${R1}/refund-request`, U1.who, {});
    check(askRefund.status === 200 && (askRefund.json?.registration as { refundRequested: boolean }).refundRequested, "the player asks for a refund (nothing is refunded by that)");
    const refund = await act("refundRegistrationAction", { registration_id: R1, payment_id: P1, confirm: "REFUND", reason: "e2e" }, mbAdmin, T1.id);
    const refunded = await reg(R1);
    const { data: team1 } = await db().from("teams").select("id").eq("id", after.team_id!).maybeSingle();
    const { count: refundAudits } = await db().from("audit_logs").select("id", { count: "exact", head: true }).eq("entity_id", R1).in("action", ["REGISTRATION_REFUND_REQUESTED", "REGISTRATION_REFUNDED"]);
    const mtRefund = mt.calls.find((c) => /\/refund$/.test(c.path) && (c.body as { reference?: string })?.reference === R1);
    check(actionOk(refund) && refunded.status === "refunded" && !team1 && refundAudits === 2 && (mtRefund?.body as { amount: number }).amount === 50000, "before the cut-off the admin refunds in full through Move Tick: audited, the team leaves the event", { status: refunded.status, refundAudits });
    const refundTwice = await act("refundRegistrationAction", { registration_id: R1, payment_id: P1, confirm: "REFUND", reason: "e2e" }, mbAdmin, T1.id);
    check(!actionOk(refundTwice), "a refunded entry cannot be refunded twice");

    // After the cut-off: the event starts in 10 hours.
    const T5 = await event("Late Cup", MB, { startsInHours: 10 });
    await settings(T5.id, { approval_mode: "on_payment", payment: "online" }, mbAdmin);
    const r6 = await call("POST", `/api/mobile/v1/t/${T5.slug}/registration`, U2.who, { people: [{ name: "Lou Late", phone: phone() }, { name: "Lee Late" }], payment: "online" });
    const R6 = String((r6.json?.registration as { id: string }).id);
    const p6 = await payNow(R6, U2.who);
    check(r6.status === 201 && r6.json?.checkoutUrl === null && String(p6.json?.checkoutUrl).startsWith(MT_URL), "first paid, first in: registering opens no checkout; Pay does");
    const s6 = [...mt.sessions.values()].find((s) => s.reference === R6)!;
    await webhook(paidEvent(s6));
    s6.status = "paid";
    const P6 = (await onlinePayments(R6)).find((p) => p.status === "paid")?.id ?? "";
    const late = await act("refundRegistrationAction", { registration_id: R6, payment_id: P6, confirm: "REFUND", reason: "e2e" }, mbAdmin, T5.id);
    const lateCalls = mt.calls.filter((c) => /\/refund$/.test(c.path) && (c.body as { reference?: string })?.reference === R6).length;
    check(!actionOk(late) && lateCalls === 0 && (await reg(R6)).status === "confirmed", "after the cut-off the refund is refused (Move Tick is never asked)", late.status);
    const askLate = await call("POST", `/api/mobile/v1/me/registrations/${R6}/refund-request`, U2.who, {});
    check(askLate.status === 409, "and the player cannot ask for one");

    // A refund Move Tick confirms later, by webhook.
    const T6 = await event("Pending Refund Cup", MB);
    await settings(T6.id, { approval_mode: "on_payment", payment: "online" }, mbAdmin);
    const r7 = await call("POST", `/api/mobile/v1/t/${T6.slug}/registration`, U5.who, { people: [{ name: "Ray Refund", phone: phone() }, { name: "Rex Refund" }], payment: "online" });
    const R7 = String((r7.json?.registration as { id: string }).id);
    await payNow(R7, U5.who);
    const s7 = [...mt.sessions.values()].find((s) => s.reference === R7)!;
    await webhook(paidEvent(s7));
    s7.status = "paid";
    mt.refundMode = "refund_pending";
    const P7 = (await onlinePayments(R7)).find((p) => p.status === "paid")?.id ?? "";
    const ref7 = await act("refundRegistrationAction", { registration_id: R7, payment_id: P7, confirm: "REFUND", reason: "e2e" }, mbAdmin, T6.id);
    const mid = await reg(R7);
    const refundEvt = { id: `evt_${randomUUID().slice(0, 12)}`, type: "payment.refunded", createdAt: new Date().toISOString(), data: { sessionId: s7.sessionId, reference: R7, amount: s7.amount, currency: "EGP", refundedAmount: s7.amount, testMode: true } };
    const w7 = await webhook(refundEvt);
    const w7b = await webhook(refundEvt);
    check(actionOk(ref7) && mid.status === "confirmed" && w7.status === 200 && w7b.json?.duplicate === true && (await reg(R7)).status === "refunded", "a refund Move Tick confirms by webhook lands once", { mid: mid.status });
    mt.refundMode = "refunded";

    // A webhook that never arrived: My registrations asks Move Tick and catches up (once).
    const r8 = await call("POST", `/api/mobile/v1/t/${T6.slug}/registration`, U4.who, { people: [{ name: "Lost Hook", phone: phone() }, { name: "Lost Partner" }], payment: "online" });
    const R8 = String((r8.json?.registration as { id: string }).id);
    await payNow(R8, U4.who);
    const s8 = [...mt.sessions.values()].find((s) => s.reference === R8)!;
    s8.status = "paid";
    const list8 = await call("GET", "/api/mobile/v1/me/registrations", U4.who);
    const list8b = await call("GET", "/api/mobile/v1/me/registrations", U4.who);
    const { count: teams8 } = await db().from("teams").select("id", { count: "exact", head: true }).eq("tournament_id", T6.id);
    check(
      (list8.json?.registrations as { id: string; status: string }[]).find((x) => x.id === R8)?.status === "confirmed" && list8b.status === 200 && (await reg(R8)).status === "confirmed" && teams8 === 1,
      "a lost webhook is recovered by asking Move Tick (authenticated), once",
      { teams8 },
    );

    /* ---------------- 6 ---------------- */
    section("other organisations and other accounts");
    const bApprove = await act("decideRegistrationAction", { registration_id: R5, decision: "refuse" }, bAdmin, T4.id);
    check(!actionOk(bApprove) && (await reg(R5)).status === "confirmed", "another organisation's admin cannot refuse Move Beyond's entry");
    const bSettings = await act("saveRegistrationSettings", { tournament_id: T1.id, open: "", entry_type: "team", team_size: "2", approval_mode: "on_payment", fee: "1", payment: "venue", team_payer: "registrant" }, bAdmin, T1.id);
    check(!actionOk(bSettings), "nor change its settings");
    const bPage = await fetch(`${BASE_URL}/admin/tournaments/${T1.id}/registrations`, { headers: bAdmin, redirect: "manual" });
    const bPageText = await bPage.text();
    check(bPage.status === 404 && !bPageText.includes("Una One"), "nor open its registrations page", bPage.status);
    const mbOnB = await act("decideRegistrationAction", { registration_id: RB, decision: "approve" }, mbAdmin, TB.id);
    check(!actionOk(mbOnB) && (await reg(RB)).status === "pending_approval", "and Move Beyond's admin cannot approve the other organisation's entry");
    const mbPage = await fetch(`${BASE_URL}/admin/tournaments/${T1.id}/registrations`, { headers: mbAdmin, redirect: "manual" });
    check(mbPage.status === 200 && (await mbPage.text()).includes("Una One"), "Move Beyond's admin sees its own registrations");
    const other = await call("POST", `/api/mobile/v1/me/registrations/${R5}/cancel`, U2.who, {});
    const missing = await call("POST", `/api/mobile/v1/me/registrations/${randomUUID()}/cancel`, U2.who, {});
    check(other.status === 404 && missing.status === 404 && other.text === missing.text && (await reg(R5)).status === "confirmed", "another account's registration answers exactly like a missing one", [other.status, missing.status]);
    const otherList = await call("GET", "/api/mobile/v1/me/registrations", U2.who);
    check(!(otherList.json?.registrations as { id: string }[]).some((x) => x.id === R5 || x.id === R1), "nor shows in another account's list");
    const unknownWebhook = await webhook({ id: `evt_${randomUUID().slice(0, 12)}`, type: "payment.succeeded", createdAt: new Date().toISOString(), data: { sessionId: "pts_test_nope", reference: randomUUID(), amount: 1, currency: "EGP", testMode: true } });
    check(unknownWebhook.status === 200 && unknownWebhook.json?.duplicate === false, "an event about nothing of ours answers like any other");

    /* ---------------- 6b ---------------- */
    section("security review of Phase 9: each attack, replayed");
    const attack = async (label: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        check(false, `${label}: the attack's run threw`, err instanceof Error ? err.message : String(err));
      }
    };
    const sessionsOf = (ref: string) => [...mt.sessions.values()].filter((x) => x.reference === ref);
    const regId = (r: { json: Record<string, unknown> | null }) => String((r.json?.registration as { id?: string } | undefined)?.id ?? "");
    const entryRow = async (id: string) => (await db().from("friendly_entries").select("approval, source, hidden, preferred_partner_profile_id, updated_at").eq("id", id).single()).data;
    const sessionEvent = async (name: string) => {
      const S = await createFriendlySession({ name: `E2E Reg ${name} ${tag}`, seasonId: null, startsAt: new Date(Date.now() + 48 * 3600_000).toISOString(), durationMinutes: 120, courtCount: 2, pairingMode: "americano", rankingModel: "win_points", setsToWinMatch: 1, gamesToWinSet: 6, maxPlayers: null, registrationDeadline: null, organizationId: MB, actorRole: "admin" });
      const tid = (S as { tournament_id: string }).tournament_id;
      created.tournaments.push(tid);
      const { data } = await db().from("tournaments").select("slug").eq("id", tid).single();
      return { id: tid, sessionId: (S as { id: string }).id, slug: (data as { slug: string }).slug };
    };
    const victimProfile = async (name: string) => {
      const p = phone();
      created.phones.push(p);
      const { data } = await db().from("player_profiles").insert({ public_name: `${name} ${tag}`, mobile_normalized: `+20${p.slice(1)}`, approval_status: "approved" }).select("id").single();
      return { id: (data as { id: string }).id, phone: p };
    };

    await attack("H1", async () => {
      const S2 = await sessionEvent("Partner Night");
      await settings(S2.id, { entry_type: "team", team_size: "2", fee: "0", payment: "free", approval_mode: "on_payment" }, mbAdmin);
      // The victim already has an entry in the session, as the organiser left it (waitlisted, hidden).
      const V = await victimProfile("Vera Victim");
      const { data: ve } = await db().from("friendly_entries").insert({ session_id: S2.sessionId, player_profile_id: V.id, source: "admin", approval: "waitlisted", hidden: true }).select("id").single();
      const VE = (ve as { id: string }).id;
      const before = await entryRow(VE);
      const U7 = await player("u7");
      const att = await call("POST", `/api/mobile/v1/t/${S2.slug}/registration`, U7.who, { people: [{ name: "Andy Attacker", phone: phone() }, { name: "Vera", phone: V.phone }] });
      const RA = regId(att);
      const mid = await entryRow(VE);
      check(att.status === 201 && JSON.stringify(mid) === JSON.stringify(before), "H1: a registration naming another player's number leaves that player's entry exactly as it was (not approved, unhidden or re-pointed)", { status: att.status, before, mid });
      const ra = await reg(RA);
      check(Array.isArray(ra.entry_ids) && !ra.entry_ids.includes(VE), "H1: only the entries the registration made are recorded on it", ra.entry_ids);
      const cancel = await call("POST", `/api/mobile/v1/me/registrations/${RA}/cancel`, U7.who, {});
      check(cancel.status === 200 && JSON.stringify(await entryRow(VE)) === JSON.stringify(before), "H1: cancelling it withdraws nothing of the other player's", cancel.status);
      // A player found by a typed number, with no entry yet: their new entry waits for the organiser.
      const W = await victimProfile("Wes Wanted");
      const U8 = await player("u8");
      const att2 = await call("POST", `/api/mobile/v1/t/${S2.slug}/registration`, U8.who, { people: [{ name: "Ann Other", phone: phone() }, { name: "Wes", phone: W.phone }] });
      const { data: we } = await db().from("friendly_entries").select("approval").eq("session_id", S2.sessionId).eq("player_profile_id", W.id).maybeSingle();
      check(att2.status === 201 && (we as { approval: string } | null)?.approval === "pending", "H1: a partner matched by a typed number enters as pending, for the organiser", we);
    });

    await attack("M1", async () => {
      const TM = await event("Double Cup", MB, { startsInHours: 10 });
      await settings(TM.id, { approval_mode: "on_payment", payment: "online" }, mbAdmin);
      const U9 = await player("u9");
      const r = await call("POST", `/api/mobile/v1/t/${TM.slug}/registration`, U9.who, { people: [{ name: "Dee Double", phone: phone() }, { name: "Dan Double" }], payment: "online" });
      const RD = regId(r);
      await payNow(RD, U9.who);
      const sA = sessionsOf(RD)[0]!;
      await db().from("registration_payments").update({ expires_at: new Date(Date.now() + 30_000).toISOString() }).eq("session_id", sA.sessionId);
      const again = await call("POST", `/api/mobile/v1/me/registrations/${RD}/pay`, U9.who, {});
      check(again.status === 200 && again.json?.checkoutUrl === `${MT_URL}/checkout/${sA.sessionId}` && sessionsOf(RD).length === 1, "M1: paying again in the checkout's last minute reuses it (never a second checkout)", { status: again.status, sessions: sessionsOf(RD).length });
      await db().from("registration_payments").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("session_id", sA.sessionId);
      const stale = await call("POST", `/api/mobile/v1/me/registrations/${RD}/pay`, U9.who, {});
      check(stale.status === 409 && sessionsOf(RD).length === 1, "M1: a checkout whose time ran out is not replaced while Move Tick still has it open", { status: stale.status, sessions: sessionsOf(RD).length });
      const { data: extra, error: dupErr } = await db().from("registration_payments").insert({ registration_id: RD, organization_id: MB, method: "online", provider: "move_tick", amount: 50000, currency: "EGP", status: "created", test_mode: true }).select("id");
      check(Boolean(dupErr), "M1: the database refuses a second open checkout for one registration");
      if (!dupErr && extra?.length) await db().from("registration_payments").delete().eq("id", (extra as { id: string }[])[0]!.id);
      // The first checkout is paid; then an older checkout of the same entry is paid as well.
      await webhook(paidEvent(sA));
      sA.status = "paid";
      const sB: FakeSession = { sessionId: `pts_test_dup_${randomUUID().slice(0, 8)}`, reference: RD, amount: 50000, status: "paid", idem: `dup-${tag}`, returnUrl: sA.returnUrl };
      mt.sessions.set(sB.sessionId, sB);
      await db().from("registration_payments").insert({ registration_id: RD, organization_id: MB, method: "online", provider: "move_tick", amount: 50000, currency: "EGP", status: "expired", session_id: sB.sessionId, test_mode: true });
      const second = await webhook(paidEvent(sB));
      const pays = await onlinePayments(RD);
      const payA = pays.find((p) => p.session_id === sA.sessionId);
      const payB = pays.find((p) => p.session_id === sB.sessionId);
      check(second.status === 200 && payA?.status === "paid" && payB?.status === "needs_review" && /second payment/i.test(payB.review_reason ?? ""), "M1: a second payment for an entry already paid is flagged on its own, to refund", pays.map((p) => [p.status, p.review_reason]));
      const alert = (await deliveriesOf(RD)).filter((d) => d.idempotency_key.includes(":review:"));
      check(alert.some((d) => d.address === `e2e.reg.mbadmin.${tag}@example.com`), "M1: the organisation's admins are emailed about it", alert.map((d) => d.address));
      const refB = await act("refundRegistrationAction", { registration_id: RD, payment_id: payB?.id ?? "", confirm: "REFUND", reason: "duplicate" }, mbAdmin, TM.id);
      const calls = mt.calls.filter((c) => /\/refund$/.test(c.path) && (c.body as { reference?: string })?.reference === RD);
      const after = await reg(RD);
      const { count: teamsM } = await db().from("teams").select("id", { count: "exact", head: true }).eq("tournament_id", TM.id);
      check(
        actionOk(refB) && calls.length === 1 && calls[0]!.path.includes(sB.sessionId) && after.status === "confirmed" && (await onlinePayments(RD)).find((p) => p.id === payA?.id)?.status === "paid" && teamsM === 1,
        "M1/L4: the duplicate is refunded by its own id (after the 24 h cut-off too: it bought nothing); the entry and its first payment stay",
        { ok: actionOk(refB), calls: calls.map((c) => c.path), status: after.status, teamsM },
      );
      const bWithA = await act("refundRegistrationAction", { registration_id: RB, payment_id: payA?.id ?? "", confirm: "REFUND", reason: "x" }, bAdmin, TB.id);
      check(!actionOk(bWithA) && (await onlinePayments(RD)).find((p) => p.id === payA?.id)?.status === "paid", "M1: another organisation cannot refund Move Beyond's payment by naming its id on its own registration");
    });

    await attack("M2", async () => {
      const TP = await event("Same Name Pool", MB);
      await settings(TP.id, { entry_type: "individual", fee: "0", payment: "free", approval_mode: "on_payment" }, mbAdmin);
      const U10 = await player("u10");
      const U11 = await player("u11");
      const a = regId(await call("POST", `/api/mobile/v1/t/${TP.slug}/registration`, U10.who, { people: [{ name: "Sam Same", phone: phone() }] }));
      const b = regId(await call("POST", `/api/mobile/v1/t/${TP.slug}/registration`, U11.who, { people: [{ name: "Sam Same", phone: phone() }] }));
      const pairSame = await act("pairRegistrationsAction", { tournament_id: TP.id, registration_ids: [a, b] }, mbAdmin, TP.id);
      const ra = await reg(a);
      const rb = await reg(b);
      const { data: rows } = await db().from("players").select("id, player_order").eq("team_id", ra.team_id ?? randomUUID());
      const order = new Map(((rows ?? []) as { id: string; player_order: number }[]).map((x) => [x.id, x.player_order]));
      const { data: cl } = await db().from("player_claims").select("user_id, player_id").in("user_id", [U10.userId, U11.userId]);
      const claims = new Map(((cl ?? []) as { user_id: string; player_id: string }[]).map((x) => [x.user_id, x.player_id]));
      check(
        actionOk(pairSame) && ra.player_id !== rb.player_id && order.get(ra.player_id ?? "") === 1 && order.get(rb.player_id ?? "") === 2 && claims.get(U10.userId) === ra.player_id && claims.get(U11.userId) === rb.player_id,
        "M2: two players with the same name, paired: each registration (and account) gets its own row, by place, never by name",
        { a: ra.player_id, b: rb.player_id, claims: Object.fromEntries(claims) },
      );
    });

    await attack("M3", async () => {
      const TM3 = await event("Message Cup", MB);
      await settings(TM3.id, { entry_type: "individual", fee: "0", payment: "free", approval_mode: "organiser" }, mbAdmin);
      const anon = await fetch(`${process.env.SUPABASE_URL}/auth/v1/signup`, { method: "POST", headers: { apikey: process.env.SUPABASE_KEY ?? "", "Content-Type": "application/json" }, body: "{}" });
      const anonTok = ((await anon.json()) as { access_token?: string }).access_token ?? "";
      const byAnon = await call("POST", `/api/mobile/v1/t/${TM3.slug}/registration`, bearer(anonTok), { people: [{ name: "Throwaway", phone: phone(), email: `victim.anon.${tag}@example.com` }] });
      check(anon.ok && byAnon.status === 403 && byAnon.json?.code === "email_required", "M3: an anonymous (player-code) account cannot register", { anon: anon.status, status: byAnon.status });
      const U12 = await player("u12");
      const r = await call("POST", `/api/mobile/v1/t/${TM3.slug}/registration`, U12.who, { people: [{ name: "Click http://evil.example now", phone: phone(), email: `victim.${tag}@example.com` }] });
      const RM = regId(r);
      await act("decideRegistrationAction", { registration_id: RM, decision: "approve" }, mbAdmin, TM3.id);
      const dl = await deliveriesOf(RM);
      check(
        r.status === 201 && dl.length >= 1 && dl.every((d) => d.channel === "email" && d.address === `e2e.reg.u12.${tag}@example.com` && !JSON.stringify(d.vars).includes("evil.example")),
        "M3: an app account's messages go to its own confirmed email only, never the typed address or phone, with no typed name in them",
        dl.map((d) => [d.channel, d.address]),
      );
      const g = await guestRegister(TM3.slug, { name: "Win a prize at evil.example", email: `victim2.${tag}@example.com` });
      const gd = g.id ? await deliveriesOf(g.id) : [];
      check(g.status === 200 && gd.length === 1 && gd[0]!.channel === "email" && /:confirm$/.test(gd[0]!.idempotency_key) && !JSON.stringify(gd[0]!.vars).includes("evil.example"), "M3: a guest's typed address gets one email, the confirmation link, with no typed name in it (and never WhatsApp)", gd.map((d) => [d.idempotency_key, d.channel]));
      const same = `victim3.${tag}@example.com`;
      const tries: number[] = [];
      for (let i = 0; i < 4; i++) tries.push((await guestRegister(TM3.slug, { name: `Spam ${i}`, email: same })).status);
      check(tries.slice(0, 3).every((x) => x === 200) && tries[3] === 429, "M3: the web form is limited per typed email address too (3 a day), from any address", tries);
    });

    await attack("M4", async () => {
      const TC = await event("Small Cup", MB);
      await settings(TC.id, { entry_type: "individual", fee: "0", payment: "free", approval_mode: "organiser", capacity: "1" }, mbAdmin);
      const U13 = await player("u13");
      const U14 = await player("u14");
      const a = await call("POST", `/api/mobile/v1/t/${TC.slug}/registration`, U13.who, { people: [{ name: "Cap One", phone: phone() }] });
      const b = await call("POST", `/api/mobile/v1/t/${TC.slug}/registration`, U14.who, { people: [{ name: "Cap Two", phone: phone() }] });
      const infoC = await call("GET", `/api/mobile/v1/t/${TC.slug}/registration`);
      check(a.status === 201 && b.status === 201 && infoC.json?.open === true, "M4: requests waiting for the organiser never fill the event", { a: a.status, b: b.status, open: infoC.json?.open });
      await act("decideRegistrationAction", { registration_id: regId(a), decision: "approve" }, mbAdmin, TC.id);
      const second = await act("decideRegistrationAction", { registration_id: regId(b), decision: "approve" }, mbAdmin, TC.id);
      check((await reg(regId(a))).status === "confirmed" && !actionOk(second) && (await reg(regId(b))).status === "pending_approval", "M4: once full, approving one more is refused", second.status);
      const TC2 = await event("Race Cup", MB);
      await settings(TC2.id, { entry_type: "individual", fee: "0", payment: "free", approval_mode: "on_payment", capacity: "1" }, mbAdmin);
      const racers = [await player("u15"), await player("u16"), await player("u17")];
      const raced = await Promise.all(racers.map((u, i) => call("POST", `/api/mobile/v1/t/${TC2.slug}/registration`, u.who, { people: [{ name: `Racer ${i}`, phone: phone() }] })));
      const { count: in2 } = await db().from("registrations").select("id", { count: "exact", head: true }).eq("tournament_id", TC2.id).eq("status", "confirmed");
      check(in2 === 1 && raced.filter((x) => x.status === 409).length === 2, "M4: three registrations at once for the last place: exactly one gets it (atomic)", { confirmed: in2, statuses: raced.map((x) => x.status) });
      const TC3 = await event("Dedupe Pool", MB);
      await settings(TC3.id, { entry_type: "individual", fee: "0", payment: "free", approval_mode: "on_payment" }, mbAdmin);
      const email = `twice.${tag}@example.com`;
      const g1 = await guestRegister(TC3.slug, { name: "Twice One", email });
      const g2 = await guestRegister(TC3.slug, { name: "Twice Two", email });
      const c1 = g1.id ? await confirmLink(g1.id) : null;
      const c2 = g2.id ? await confirmLink(g2.id) : null;
      const { count: live3 } = await db().from("registrations").select("id", { count: "exact", head: true }).eq("tournament_id", TC3.id).in("status", ["pending_approval", "awaiting_payment", "confirmed"]);
      check(live3 === 1 && /status\?r=/.test(c1?.location ?? "") && /e=already_registered/.test(c2?.location ?? ""), "M4: one verified email holds one entry per event (guests deduped)", { live3, c2: c2?.location });
    });

    await attack("M4 holds", async () => {
      // Organiser mode: the approval keeps the place 24 h; pressing Pay near its end stretches it once, never past 24 h + 15 min.
      const TH = await event("Hold Cup", MB);
      await settings(TH.id, { entry_type: "individual", fee: "250", payment: "online", approval_mode: "organiser", capacity: "1" }, mbAdmin);
      const U23 = await player("u23");
      const RH = regId(await call("POST", `/api/mobile/v1/t/${TH.slug}/registration`, U23.who, { people: [{ name: "Holly Hold", phone: phone() }], payment: "online" }));
      await act("decideRegistrationAction", { registration_id: RH, decision: "approve" }, mbAdmin, TH.id);
      await payNow(RH, U23.who);
      const sH = sessionsOf(RH)[0]!;
      // 30 hours after approval, with ten minutes of hold left: paying again stretches nothing.
      const ten = new Date(Date.now() + 10 * 60_000).toISOString();
      await db().from("registrations").update({ hold_started_at: new Date(Date.now() - 30 * 3600_000).toISOString(), hold_until: ten }).eq("id", RH);
      await payNow(RH, U23.who);
      const h1 = await reg(RH);
      check(Date.parse(String(h1.hold_until)) <= Date.parse(ten) + 1000, "M4: pressing Pay again after the 24 h hold window keeps no place (the hold is not renewed)", h1.hold_until);
      // The hold runs out; the organiser approves someone else, who takes the place; the first entry can no longer pay.
      await db().from("registrations").update({ hold_until: new Date(Date.now() - 60_000).toISOString() }).eq("id", RH);
      const U24 = await player("u24");
      const other = regId(await call("POST", `/api/mobile/v1/t/${TH.slug}/registration`, U24.who, { people: [{ name: "Otto Other", phone: phone() }], payment: "online" }));
      const approveOther = await act("decideRegistrationAction", { registration_id: other, decision: "approve" }, mbAdmin, TH.id);
      const lapsedPay = await payNow(RH, U23.who);
      check(actionOk(approveOther) && lapsedPay.status === 409 && lapsedPay.json?.code === "full", "M4: once its hold ran out and the place was taken, the entry cannot pay (not even on its still-open checkout)", { approve: actionOk(approveOther), pay: lapsedPay.status, code: lapsedPay.json?.code });
      await webhook(paidEvent(sH));
      const ph = (await onlinePayments(RH)).find((p) => p.session_id === sH.sessionId);
      const { count: inH } = await db().from("registrations").select("id", { count: "exact", head: true }).eq("tournament_id", TH.id).eq("status", "confirmed");
      check((await reg(RH)).status === "awaiting_payment" && ph?.status === "needs_review" && (inH ?? 0) === 0, "M4: a payment landing after the hold ran out never overfills the event: it is held for a refund", { status: ph?.status, review: ph?.review_reason });
    });

    await attack("L1", async () => {
      const TL = await event("Fault Cup", MB);
      await settings(TL.id, { approval_mode: "on_payment", payment: "online" }, mbAdmin);
      const U18 = await player("u18");
      const RL = regId(await call("POST", `/api/mobile/v1/t/${TL.slug}/registration`, U18.who, { people: [{ name: "Faye Fault", phone: phone() }, { name: "Finn Fault" }], payment: "online" }));
      await payNow(RL, U18.who);
      const sL = sessionsOf(RL)[0]!;
      await standinSql("alter table move_tick_events add constraint e2e_l1_fault check (event_id not like 'evt_l1fault%')");
      const evtId = `evt_l1fault_${randomUUID().slice(0, 8)}`;
      let faulty: Awaited<ReturnType<typeof webhook>>;
      try {
        faulty = await webhook(paidEvent(sL, {}, evtId));
      } finally {
        await standinSql("alter table move_tick_events drop constraint if exists e2e_l1_fault");
      }
      check(faulty.status === 500 && (await reg(RL)).status === "awaiting_payment", "L1: a database error recording the event id is an error (Move Tick retries), never taken for a duplicate", faulty.json);
      const retry = await webhook(paidEvent(sL, {}, evtId));
      sL.status = "paid";
      check(retry.status === 200 && (await reg(RL)).status === "confirmed", "L1: the retry of that event then applies", retry.json);
      const U19 = await player("u19");
      const RL2 = regId(await call("POST", `/api/mobile/v1/t/${TL.slug}/registration`, U19.who, { people: [{ name: "Lex Late", phone: phone() }, { name: "Lia Late" }], payment: "online" }));
      await payNow(RL2, U19.who);
      const sL2 = sessionsOf(RL2)[0]!;
      await db().from("registration_payments").update({ status: "expired" }).eq("session_id", sL2.sessionId);
      sL2.status = "paid";
      await fetch(`${BASE_URL}/register/status?r=${RL2}&s=${statusTok(RL2)}`);
      check((await reg(RL2)).status === "confirmed", "L1: reconciliation also asks about a checkout marked expired here (a late payment is not lost)", (await reg(RL2)).status);
    });

    await attack("L2", async () => {
      const TG = await event("Guest Pay Cup", MB);
      await settings(TG.id, { entry_type: "individual", fee: "250", payment: "online", approval_mode: "organiser" }, mbAdmin);
      const g = await guestRegister(TG.slug, { name: "Gail Guest", email: `gail.${tag}@example.com` });
      const GR = g.id ?? "";
      await confirmLink(GR);
      await act("decideRegistrationAction", { registration_id: GR, decision: "approve" }, mbAdmin, TG.id);
      const told = (await deliveriesOf(GR)).find((d) => d.idempotency_key.endsWith(":awaiting_payment"));
      check((await reg(GR)).status === "awaiting_payment" && told?.address === `gail.${tag}@example.com` && String(told?.vars?.link ?? "").includes(`/register/status?r=${GR}`), "L2: an approved guest is emailed the link to their status page", told?.vars);
      const page = await fetch(`${BASE_URL}/register/status?r=${GR}&s=${statusTok(GR)}`);
      check(page.status === 200 && (await page.text()).replace(/<!-- -->/g, "").includes("Pay EGP 250"), "L2: the signed status page offers Pay");
      const pay = await fetch(`${BASE_URL}/api/register/pay`, { method: "POST", body: new URLSearchParams({ r: GR, s: statusTok(GR) }), redirect: "manual", headers: xff(freshIp()) });
      check(pay.status === 303 && (pay.headers.get("location") ?? "").startsWith(`${MT_URL}/checkout/`) && sessionsOf(GR)[0]?.amount === 25000, "L2: …which opens a Move Tick checkout for the server's amount", { status: pay.status, location: pay.headers.get("location") });
      const forged = await fetch(`${BASE_URL}/api/register/pay`, { method: "POST", body: new URLSearchParams({ r: GR, s: "forged" }), redirect: "manual", headers: xff(freshIp()) });
      check(forged.status === 303 && !(forged.headers.get("location") ?? "").startsWith(MT_URL), "L2: a forged status token pays nothing");
    });

    await attack("L3", async () => {
      const { data: prof } = await db().from("player_profiles").select("email").eq("auth_user_id", U1.userId).maybeSingle();
      check(Boolean(prof) && (prof as { email: string | null }).email === null, "L3: the email typed on a registration is not copied onto the account's new profile", prof);
    });

    await attack("L4", async () => {
      const TX = await event("External Refund Cup", MB);
      await settings(TX.id, { approval_mode: "on_payment", payment: "online" }, mbAdmin);
      const U20 = await player("u20");
      const RX = regId(await call("POST", `/api/mobile/v1/t/${TX.slug}/registration`, U20.who, { people: [{ name: "Ed External", phone: phone() }, { name: "Eve External" }], payment: "online" }));
      await payNow(RX, U20.who);
      const sX = sessionsOf(RX)[0]!;
      await webhook(paidEvent(sX));
      sX.status = "refunded";
      const w = await webhook({ id: `evt_${randomUUID().slice(0, 12)}`, type: "payment.refunded", createdAt: new Date().toISOString(), data: { sessionId: sX.sessionId, reference: RX, amount: sX.amount, currency: "EGP", refundedAmount: sX.amount, testMode: true } });
      const { count: ext } = await db().from("audit_logs").select("id", { count: "exact", head: true }).eq("entity_id", RX).eq("action", "REGISTRATION_REFUND_EXTERNAL");
      const alerts = (await deliveriesOf(RX)).filter((d) => d.idempotency_key.includes(":external-refund:"));
      check(w.status === 200 && (await reg(RX)).status === "refunded" && ext === 1 && alerts.some((d) => d.address === `e2e.reg.mbadmin.${tag}@example.com`), "L4: a refund Move Tick made on its own is recorded, audited apart, and the admins are emailed", { ext, alerts: alerts.length });
    });

    await attack("L5", async () => {
      const TF = await event("Half Team Cup", MB);
      await settings(TF.id, { fee: "0", payment: "free", approval_mode: "on_payment" }, mbAdmin);
      const teamName = `L5 Fault ${tag}`;
      await standinSql(`create or replace function e2e_l5_fault() returns trigger language plpgsql as $f$ begin if new.team_id is not null and new.team_name = '${teamName}' then raise exception 'e2e_l5_fault'; end if; return new; end $f$; drop trigger if exists e2e_l5_fault on registrations; create trigger e2e_l5_fault before update on registrations for each row execute function e2e_l5_fault();`);
      let rf: Awaited<ReturnType<typeof call>>;
      try {
        const U21 = await player("u21");
        rf = await call("POST", `/api/mobile/v1/t/${TF.slug}/registration`, U21.who, { people: [{ name: "Hal Half", phone: phone() }, { name: "Hap Half" }], teamName });
      } finally {
        await standinSql("drop trigger if exists e2e_l5_fault on registrations; drop function if exists e2e_l5_fault();");
      }
      const { count: teamsF } = await db().from("teams").select("id", { count: "exact", head: true }).eq("tournament_id", TF.id);
      const { count: playersF } = await db().from("players").select("id", { count: "exact", head: true }).eq("tournament_id", TF.id);
      const rr = await reg(regId(rf));
      check(rf.status === 201 && teamsF === 0 && playersF === 0 && !rr.team_id && !rr.materialized_at, "L5: an entry that fails half-way leaves no half-made team behind (and can be made again)", { teamsF, playersF, materialized: rr.materialized_at });
    });

    await attack("L6", async () => {
      const TV = await event("Status Views Cup", MB);
      await settings(TV.id, { approval_mode: "on_payment", payment: "online" }, mbAdmin);
      const U22 = await player("u22");
      const RV = regId(await call("POST", `/api/mobile/v1/t/${TV.slug}/registration`, U22.who, { people: [{ name: "Viv Views", phone: phone() }, { name: "Val Views" }], payment: "online" }));
      await payNow(RV, U22.who);
      const sV = sessionsOf(RV)[0]!;
      const gets = () => mt.calls.filter((c) => c.path === `/api/partner/v1/payment-sessions/${sV.sessionId}` && c.body === null).length;
      const before = gets();
      for (let i = 0; i < 4; i++) await fetch(`${BASE_URL}/register/status?r=${RV}&s=${statusTok(RV)}`);
      check(gets() - before <= 1, "L6: four status-page views in a row ask Move Tick at most once (per payment, per 30 s)", gets() - before);
    });

    /* ---------------- 7 ---------------- */
    section("archive job");
    const past = new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10);
    await db().from("tournaments").update({ ends_on: past, status: "completed", updated_at: new Date(Date.now() - 2 * 86400_000).toISOString() }).eq("id", T4.id);
    const cron = await fetch(`${BASE_URL}/api/internal/messages/drain`, { method: "POST", headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
    const cronJson = (await cron.json()) as { claimsArchived?: number };
    const { data: t4claims } = await db().from("player_claims").select("archived_at").eq("player_id", v2.player_id!);
    const { count: t5Live } = await db().from("player_claims").select("player_id", { count: "exact", head: true }).eq("user_id", U2.userId).is("archived_at", null);
    check(cron.status === 200 && ((t4claims ?? []) as { archived_at: string | null }[]).length === 1 && Boolean((t4claims as { archived_at: string | null }[])[0]!.archived_at) && (cronJson.claimsArchived ?? 0) >= 1, "the cron archives the links of an event that ended over a day ago", cronJson);
    check((t5Live ?? 0) >= 1, "a running event's links stay live", t5Live);
  } finally {
    server.close();
    await cleanup();
  }
  finish("registration");
}

async function cleanup() {
  const t = created.tournaments;
  const { data: regs } = t.length ? await db().from("registrations").select("id").in("tournament_id", t) : { data: [] };
  const regIds = ((regs ?? []) as { id: string }[]).map((r) => r.id);
  if (regIds.length) {
    await db().from("move_tick_events").delete().in("reference", regIds);
    for (const id of regIds) await db().from("message_deliveries").delete().like("idempotency_key", `registration:${id}:%`);
  }
  if (t.length) {
    await db().from("audit_logs").delete().in("tournament_id", t);
    await db().from("tournaments").delete().in("id", t);
  }
  if (created.users.length) {
    await db().from("player_claims").delete().in("user_id", created.users);
    const { data: profs } = await db().from("player_profiles").select("id").in("auth_user_id", created.users);
    const ids = ((profs ?? []) as { id: string }[]).map((p) => p.id);
    if (ids.length) {
      await db().from("organization_players").delete().in("player_profile_id", ids);
      await db().from("player_profiles").delete().in("id", ids);
    }
  }
  if (created.phones.length) {
    const mobiles = created.phones.map((p) => `+20${p.slice(1)}`);
    const { data: profs } = await db().from("player_profiles").select("id").in("mobile_normalized", mobiles);
    const ids = ((profs ?? []) as { id: string }[]).map((p) => p.id);
    if (ids.length) {
      await db().from("organization_players").delete().in("player_profile_id", ids);
      await db().from("player_profiles").delete().in("id", ids);
    }
  }
  if (created.members.length) await db().from("organization_members").delete().in("id", created.members);
  if (created.orgs.length) {
    await db().from("audit_logs").delete().in("organization_id", created.orgs);
    await db().from("organizations").delete().in("id", created.orgs);
  }
  await db().from("request_counters").delete().like("bucket_key", "reg-%");
  const { count } = t.length ? await db().from("tournaments").select("id", { count: "exact", head: true }).in("id", t) : { count: 0 };
  check((count ?? 0) === 0, "cleanup: every event and registration made here is gone");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

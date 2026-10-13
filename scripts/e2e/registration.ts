/**
 * Registration and payment (plan Phase 9), end to end on the stand-in, with a
 * fake Move Tick inside this script (the partner API of docs/move-tick-partner-api.md).
 *
 *   1. Settings and info: team entry, organiser approval, Move Beyond online + venue;
 *      another organisation is offered the venue only, whatever it saves.
 *   2. Team registration in the app: strict body (a client amount is refused),
 *      approval, a Move Tick checkout for the server's amount, the payment webhook:
 *      bad signature, stale timestamp and wrong mode refused; the real one confirms,
 *      makes the team and links the registrant's own row only; a replay (same id, or
 *      a fresh id) changes nothing; an amount mismatch is held for review.
 *   3. Individual entries: a friendly session (free, automatic, the account's own
 *      profile), and web guests in a padel tournament paired by the organiser.
 *   4. Pay at the venue: approve, then "paid at the venue".
 *   5. Refunds: before the 24 h cut-off (Move Tick refunds; the entry leaves the
 *      event), refused after it, refused for a manager and the shared password, and
 *      a refund that Move Tick confirms later by webhook.
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
import { randomUUID, randomInt } from "node:crypto";
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
        return send(201, { sessionId: s.sessionId, checkoutUrl: `${MT_URL}/checkout/${s.sessionId}`, status: s.status, amount: s.amount, currency: "EGP", reference: s.reference, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), testMode: true });
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
async function settings(tournamentId: string, fields: Record<string, string>, who: Who) {
  const r = await act("saveRegistrationSettings", { tournament_id: tournamentId, open: "on", entry_type: "team", team_size: "2", approval_mode: "organiser", fee: "250", payment: "online_or_venue", team_payer: "registrant", refund_fee_percent: "0", capacity: "", closes_at: "", note: "", ...fields }, who, tournamentId);
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
      return { ...u, who: bearer(u.token) };
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
    check(before.status === 200 && before.json?.open === false && before.json?.approval === "organiser" && before.json?.teamPayer === "registrant" && before.json?.refundFeePercent === 0, "a new event is closed, organiser approves, registrant pays, full refunds (the defaults)", before.json);
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
    check(actionOk(approve) && (await reg(R1)).status === "awaiting_payment", "the organiser approves: awaiting payment", approve.text.slice(0, 200));
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

    /* ---------------- 3 ---------------- */
    section("individual entries");
    const S = await createFriendlySession({ name: `E2E Reg Night ${tag}`, seasonId: null, startsAt: new Date(Date.now() + 48 * 3600_000).toISOString(), durationMinutes: 120, courtCount: 2, pairingMode: "americano", rankingModel: "win_points", setsToWinMatch: 1, gamesToWinSet: 6, maxPlayers: null, registrationDeadline: null, organizationId: MB, actorRole: "admin" });
    const ST = (S as { tournament_id: string }).tournament_id;
    created.tournaments.push(ST);
    const { data: st } = await db().from("tournaments").select("slug").eq("id", ST).single();
    const sSlug = (st as { slug: string }).slug;
    await settings(ST, { entry_type: "individual", fee: "0", payment: "free", approval_mode: "automatic" }, mbAdmin);
    const p3 = phone();
    created.phones.push(p3);
    const r3 = await call("POST", `/api/mobile/v1/t/${sSlug}/registration`, U3.who, { people: [{ name: "Sam Single", phone: p3 }] });
    const R3 = String((r3.json?.registration as { id: string } | undefined)?.id);
    const g3 = await reg(R3);
    const { data: p3prof } = await db().from("player_profiles").select("id").eq("auth_user_id", U3.userId).maybeSingle();
    const { data: entry } = await db().from("friendly_entries").select("player_profile_id, approval").eq("session_id", (S as { id: string }).id);
    check(r3.status === 201 && g3.status === "confirmed" && (g3.entry_ids ?? []).length === 1 && ((entry ?? []) as { player_profile_id: string; approval: string }[]).some((e) => e.player_profile_id === (p3prof as { id: string } | null)?.id && e.approval === "approved"), "a free individual session entry is confirmed at once, as the account's own profile", { status: g3.status, entry });

    const T3 = await event("Singles Pool", MB);
    await settings(T3.id, { entry_type: "individual", fee: "0", payment: "free", approval_mode: "automatic" }, mbAdmin);
    const g = async (ip: string, name: string) => {
      const res = await fetch(`${BASE_URL}/api/register/${T3.slug}`, { method: "POST", headers: { "Content-Type": "application/json", ...xff(ip) }, body: JSON.stringify({ people: [{ name, phone: phone(), email: `${name.split(" ")[0]!.toLowerCase()}.${tag}@example.com` }], website: "" }) });
      return { status: res.status, json: (await res.json()) as { ok: boolean; message: string; statusUrl: string | null } };
    };
    const g1 = await g(`10.9.${randomInt(1, 250)}.1`, "Gina Guest");
    const g2 = await g(`10.9.${randomInt(1, 250)}.2`, "Gus Guest");
    const { data: guests } = await db().from("registrations").select("id, status, materialized_at, auth_user_id").eq("tournament_id", T3.id);
    const gl = (guests ?? []) as { id: string; status: string; materialized_at: string | null; auth_user_id: string | null }[];
    check(g1.json.ok && g2.json.ok && gl.length === 2 && gl.every((x) => x.status === "confirmed" && !x.materialized_at && !x.auth_user_id), "web guests register as individuals; padel singles wait to be paired", gl);
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
    const refShared = await act("refundRegistrationAction", { registration_id: R1, confirm: "REFUND", reason: "e2e" }, shared, T1.id);
    const refManager = await act("refundRegistrationAction", { registration_id: R1, confirm: "REFUND", reason: "e2e" }, mbManager, T1.id);
    const refB = await act("refundRegistrationAction", { registration_id: R1, confirm: "REFUND", reason: "e2e" }, bAdmin, T1.id);
    const refNoConfirm = await act("refundRegistrationAction", { registration_id: R1, confirm: "", reason: "e2e" }, mbAdmin, T1.id);
    check(!actionOk(refShared) && !actionOk(refManager) && !actionOk(refB) && !actionOk(refNoConfirm) && (await reg(R1)).status === "confirmed", "refunds: not the shared password, not a manager, not another organisation, not without typing REFUND");
    const askRefund = await call("POST", `/api/mobile/v1/me/registrations/${R1}/refund-request`, U1.who, {});
    check(askRefund.status === 200 && (askRefund.json?.registration as { refundRequested: boolean }).refundRequested, "the player asks for a refund (nothing is refunded by that)");
    const refund = await act("refundRegistrationAction", { registration_id: R1, confirm: "REFUND", reason: "e2e" }, mbAdmin, T1.id);
    const refunded = await reg(R1);
    const { data: team1 } = await db().from("teams").select("id").eq("id", after.team_id!).maybeSingle();
    const { count: refundAudits } = await db().from("audit_logs").select("id", { count: "exact", head: true }).eq("entity_id", R1).in("action", ["REGISTRATION_REFUND_REQUESTED", "REGISTRATION_REFUNDED"]);
    const mtRefund = mt.calls.find((c) => /\/refund$/.test(c.path) && (c.body as { reference?: string })?.reference === R1);
    check(actionOk(refund) && refunded.status === "refunded" && !team1 && refundAudits === 2 && (mtRefund?.body as { amount: number }).amount === 50000, "before the cut-off the admin refunds in full through Move Tick: audited, the team leaves the event", { status: refunded.status, refundAudits });
    const refundTwice = await act("refundRegistrationAction", { registration_id: R1, confirm: "REFUND", reason: "e2e" }, mbAdmin, T1.id);
    check(!actionOk(refundTwice), "a refunded entry cannot be refunded twice");

    // After the cut-off: the event starts in 10 hours.
    const T5 = await event("Late Cup", MB, { startsInHours: 10 });
    await settings(T5.id, { approval_mode: "automatic", payment: "online" }, mbAdmin);
    const r6 = await call("POST", `/api/mobile/v1/t/${T5.slug}/registration`, U2.who, { people: [{ name: "Lou Late", phone: phone() }, { name: "Lee Late" }], payment: "online" });
    const R6 = String((r6.json?.registration as { id: string }).id);
    check(r6.status === 201 && String(r6.json?.checkoutUrl).startsWith(MT_URL), "automatic approval: the checkout comes straight back");
    const s6 = [...mt.sessions.values()].find((s) => s.reference === R6)!;
    await webhook(paidEvent(s6));
    s6.status = "paid";
    const late = await act("refundRegistrationAction", { registration_id: R6, confirm: "REFUND", reason: "e2e" }, mbAdmin, T5.id);
    const lateCalls = mt.calls.filter((c) => /\/refund$/.test(c.path) && (c.body as { reference?: string })?.reference === R6).length;
    check(!actionOk(late) && lateCalls === 0 && (await reg(R6)).status === "confirmed", "after the cut-off the refund is refused (Move Tick is never asked)", late.status);
    const askLate = await call("POST", `/api/mobile/v1/me/registrations/${R6}/refund-request`, U2.who, {});
    check(askLate.status === 409, "and the player cannot ask for one");

    // A refund Move Tick confirms later, by webhook.
    const T6 = await event("Pending Refund Cup", MB);
    await settings(T6.id, { approval_mode: "automatic", payment: "online" }, mbAdmin);
    const r7 = await call("POST", `/api/mobile/v1/t/${T6.slug}/registration`, U5.who, { people: [{ name: "Ray Refund", phone: phone() }, { name: "Rex Refund" }], payment: "online" });
    const R7 = String((r7.json?.registration as { id: string }).id);
    const s7 = [...mt.sessions.values()].find((s) => s.reference === R7)!;
    await webhook(paidEvent(s7));
    s7.status = "paid";
    mt.refundMode = "refund_pending";
    const ref7 = await act("refundRegistrationAction", { registration_id: R7, confirm: "REFUND", reason: "e2e" }, mbAdmin, T6.id);
    const mid = await reg(R7);
    const refundEvt = { id: `evt_${randomUUID().slice(0, 12)}`, type: "payment.refunded", createdAt: new Date().toISOString(), data: { sessionId: s7.sessionId, reference: R7, amount: s7.amount, currency: "EGP", refundedAmount: s7.amount, testMode: true } };
    const w7 = await webhook(refundEvt);
    const w7b = await webhook(refundEvt);
    check(actionOk(ref7) && mid.status === "confirmed" && w7.status === 200 && w7b.json?.duplicate === true && (await reg(R7)).status === "refunded", "a refund Move Tick confirms by webhook lands once", { mid: mid.status });
    mt.refundMode = "refunded";

    // A webhook that never arrived: My registrations asks Move Tick and catches up (once).
    const r8 = await call("POST", `/api/mobile/v1/t/${T6.slug}/registration`, U4.who, { people: [{ name: "Lost Hook", phone: phone() }, { name: "Lost Partner" }], payment: "online" });
    const R8 = String((r8.json?.registration as { id: string }).id);
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
    const bSettings = await act("saveRegistrationSettings", { tournament_id: T1.id, open: "", entry_type: "team", team_size: "2", approval_mode: "automatic", fee: "1", payment: "venue", team_payer: "registrant", refund_fee_percent: "0" }, bAdmin, T1.id);
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

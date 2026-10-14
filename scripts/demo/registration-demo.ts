/**
 * Registration demo for a manual browser walkthrough on the local stand-in
 * (never the live project: it refuses a non-localhost SUPABASE_URL).
 *
 * Seeds two Move Beyond tournaments that start in 3 days, open for registration:
 *   - "Registration Demo Cup": first paid, first in (on_payment), entry type both
 *     (solo or a team of 2), EGP 500 per player online, capacity 2 entries
 *     (2 teams = 4 player places; a solo player fills one).
 *   - "Registration Demo Cup (approval)": the organiser approves each entry, teams
 *     of 2, EGP 500 per player online, capacity 2.
 * and a demo Move Beyond admin account (its own account, so it may refund), then
 * prints the admin and public URLs, the admin's sign-in cookie, and how to pay
 * with the fake payment provider (XPay, or Move Tick with PAYMENT_PROVIDER=move_tick).
 * Running it again replaces both events.
 *
 *   npm run localdb                                                        # terminal 1
 *   npm run build   (no `next dev` running; delete .next/cache first if disk is tight)
 *   (set -a; . ./.env.localdb; set +a; PUBLIC_SITE_URL=http://localhost:3077 \
 *     PUSH_DRY_RUN=1 MESSAGING_DRY_RUN=1 npx next start -p 3077)            # terminal 2
 *   npx tsx --env-file=.env.localdb scripts/demo/fake-xpay.ts              # terminal 3 (XPay, the default
 *       # once XPAY_SECRET_KEY is in .env.localdb; with PAYMENT_PROVIDER=move_tick on the server: fake-move-tick.ts)
 *   npx tsx --env-file=.env.localdb scripts/demo/registration-demo.ts      # seed + instructions
 *   npx tsx --env-file=.env.localdb scripts/demo/registration-demo.ts links
 *       # the demo events' registrations: each one's signed status link, and the email
 *       # confirmation link of a web guest (emails are not sent with MESSAGING_DRY_RUN=1)
 *   npx tsx --env-file=.env.localdb scripts/demo/registration-demo.ts session
 *       # a fresh sign-in cookie line for the demo admin, without reseeding
 *   npx tsx --env-file=.env.localdb scripts/demo/registration-demo.ts remove
 */
import { createHmac } from "node:crypto";
import { db } from "../../src/lib/supabase";
import { staffToken } from "../e2e/lib/session";
import { paymentProvider } from "../../src/lib/payments/provider";
import { appUser } from "../e2e/lib/fixtures";

const SUPA = process.env.SUPABASE_URL ?? "";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(SUPA)) {
  console.error("registration-demo runs against the local stand-in only (SUPABASE_URL=http://localhost:54321, from .env.localdb).");
  process.exit(1);
}
const SITE = (process.env.PUBLIC_SITE_URL ?? process.env.BASE_URL ?? "http://localhost:3077").replace(/\/+$/, "");
const SLUGS = { cup: "registration-demo-cup", approval: "registration-demo-approval" };
const ADMIN_EMAIL = "demo.registration.admin@example.com";

const signed = (purpose: string, id: string) => createHmac("sha256", process.env.AUTH_SECRET ?? "").update(`${purpose}:v1:${id}`).digest("base64url").slice(0, 32);

async function moveBeyond(): Promise<string> {
  const { data } = await db().from("organizations").select("id").eq("slug", "move-beyond").maybeSingle();
  if (!data) throw new Error("No move-beyond organisation on the stand-in: start it fresh with `npm run localdb`.");
  return (data as { id: string }).id;
}

async function removeEvents(): Promise<void> {
  const { data } = await db().from("tournaments").select("id").in("slug", Object.values(SLUGS));
  const ids = ((data ?? []) as { id: string }[]).map((t) => t.id);
  if (!ids.length) return;
  const { data: regs } = await db().from("registrations").select("id").in("tournament_id", ids);
  const regIds = ((regs ?? []) as { id: string }[]).map((r) => r.id);
  if (regIds.length) {
    await db().from("move_tick_events").delete().in("reference", regIds);
    for (const id of regIds) await db().from("message_deliveries").delete().like("idempotency_key", `registration:${id}:%`);
  }
  await db().from("audit_logs").delete().in("tournament_id", ids);
  await db().from("tournaments").delete().in("id", ids);
}

async function event(name: string, slug: string, org: string, settings: Record<string, unknown>) {
  const starts = new Date(Date.now() + 3 * 86400_000);
  starts.setUTCMinutes(0, 0, 0);
  const { data, error } = await db()
    .from("tournaments")
    .insert({ name, slug, sport: "padel", status: "active", is_demo: true, organization_id: org, starts_at: starts.toISOString(), starts_on: starts.toISOString().slice(0, 10), ends_on: starts.toISOString().slice(0, 10), timezone: "Africa/Cairo" })
    .select("id")
    .single();
  if (error) throw new Error(`${name}: ${error.message}`);
  const id = (data as { id: string }).id;
  const { error: se } = await db()
    .from("registration_settings")
    .upsert({ tournament_id: id, organization_id: org, open: true, currency: "EGP", updated_by: "registration-demo", ...settings }, { onConflict: "tournament_id" });
  if (se) throw new Error(`${name} settings: ${se.message}`);
  return { id, starts };
}

async function demoAdmin(org: string): Promise<string> {
  const u = await appUser(ADMIN_EMAIL);
  const { data } = await db().from("organization_members").select("id").eq("organization_id", org).eq("auth_user_id", u.userId).maybeSingle();
  if (!data) {
    const { error } = await db().from("organization_members").insert({ organization_id: org, auth_user_id: u.userId, invited_email: ADMIN_EMAIL, role: "admin", status: "active" });
    if (error) throw new Error(`demo admin: ${error.message}`);
  } else await db().from("organization_members").update({ role: "admin", status: "active" }).eq("id", (data as { id: string }).id);
  return staffToken({ kind: "member", userId: u.userId, orgId: org, role: "admin" });
}

async function seed() {
  const org = await moveBeyond();
  await removeEvents();
  const cup = await event("Registration Demo Cup", SLUGS.cup, org, {
    entry_type: "both",
    team_size: 2,
    approval_mode: "on_payment",
    fee_amount: 50000,
    payment: "online",
    team_payer: "registrant",
    capacity: 2,
  });
  const approval = await event("Registration Demo Cup (approval)", SLUGS.approval, org, {
    entry_type: "team",
    team_size: 2,
    approval_mode: "organiser",
    fee_amount: 50000,
    payment: "online",
    team_payer: "registrant",
    capacity: 2,
  });
  const token = await demoAdmin(org);
  const provider = paymentProvider(process.env);
  const mt = process.env.MOVE_TICK_API_URL ?? "(MOVE_TICK_API_URL is not set in .env.localdb)";
  const xp = process.env.XPAY_API_BASE ?? "(XPAY_API_BASE is not set in .env.localdb)";
  console.log(`
Registration demo seeded on the stand-in (starts ${cup.starts.toISOString()}; refunds until 24 h before).

1. Registration Demo Cup — first paid, first in; solo or team of 2; EGP 500 per player online; 2 entries (4 player places)
   Public form:  ${SITE}/register/${SLUGS.cup}
   App API:      ${SITE}/api/mobile/v1/t/${SLUGS.cup}/registration
   Admin:        ${SITE}/admin/tournaments/${cup.id}/registrations

2. Registration Demo Cup (approval) — the organiser approves each entry; teams of 2; EGP 500 per player online; 2 teams
   Public form:  ${SITE}/register/${SLUGS.approval}
   Admin:        ${SITE}/admin/tournaments/${approval.id}/registrations

Sign in as the demo Move Beyond admin (its own account: may approve, pair and refund). Open ${SITE}, then in
the browser's DevTools console run (valid 24 hours; run this script again for a fresh one):

   document.cookie = "mb_session=${token}; path=/";

(The shared ADMIN_PASSWORD at ${SITE}/admin also works for approving and pairing, but never for refunds.)

${
    provider === "xpay"
      ? `Paying (XPay, the server's provider when XPAY_SECRET_KEY is set): the fake XPay must be running (terminal 3):
   npx tsx --env-file=.env.localdb scripts/demo/fake-xpay.ts
It listens on ${xp} and sends signed webhooks to ${SITE}/api/webhooks/xpay. Its checkout page has
"Pay by card (test)", "Card declined (test)" (the page stays open, as XPay's) and "Pay later: get a reference
(test)" (Fawry-style: then "Reference paid" or "Reference expired"). A checkout keeps your place 15 minutes;
Move Score then closes the page at XPay (Pay again, or the cron); XPay's own page lives 30 minutes.`
      : `Paying (Move Tick): the fake Move Tick must be running (terminal 3):
   npx tsx --env-file=.env.localdb scripts/demo/fake-move-tick.ts
It listens on ${mt} and sends signed webhooks to ${SITE}/api/webhooks/move-tick. Its checkout page has
"Pay (test)" and "Fail (test)"; a checkout keeps your place 15 minutes, after which the page offers
"Pay late (test)" for 5 more minutes (a late payment into a full event is flagged for a full refund).
Shorter clock for the demo: FAKE_MT_TTL_MINUTES=2 FAKE_MT_CLOSE_AFTER_MINUTES=2.`
  }

Walkthrough (web guests; emails are not sent with MESSAGING_DRY_RUN=1, so use the links command):
  a. Open the public form of the Cup, register "On my own" with any email → "we emailed you a link".
  b. npx tsx --env-file=.env.localdb scripts/demo/registration-demo.ts links → open the "confirm" link,
     press "Confirm my registration" → the status page shows "Waiting for payment" and a Pay button.
     No place is held yet (Admin shows "holds no place until paid").
  c. Press Pay → fake checkout → "Pay (test)" / "Pay by card (test)" → back on the status page: Confirmed (no organiser step).
  d. Register a team and a second solo player the same way: the event fills at 4 player places; Pay for
     an entry that no longer fits answers "This event is full" before any checkout. Pair the two solo
     players in Admin. Refund a payment (type REFUND): always the full amount.
  e. On the approval cup: register a team → Admin → Approve → the status page's Pay button.
`);
}

async function links() {
  const { data: ev } = await db().from("tournaments").select("id, slug, name").in("slug", Object.values(SLUGS));
  const events = (ev ?? []) as { id: string; slug: string; name: string }[];
  if (!events.length) return console.log("No demo events: run the script without arguments first.");
  for (const e of events) {
    const { data } = await db().from("registrations").select("id, status, entry_type, people, hold_until, created_at").eq("tournament_id", e.id).order("created_at");
    const regs = (data ?? []) as { id: string; status: string; entry_type: string; people: { name: string }[]; hold_until: string | null }[];
    console.log(`\n${e.name} (${regs.length} registration${regs.length === 1 ? "" : "s"})`);
    for (const r of regs) {
      // Only an entry still waiting for its payment keeps a place by its hold (a confirmed entry's hold_until is left over).
      const held = r.status === "awaiting_payment" && r.hold_until && Date.parse(r.hold_until) > Date.now() ? ` · place kept until ${new Date(r.hold_until).toLocaleTimeString()}` : "";
      console.log(`  ${r.people.map((p) => p.name).join(" / ")} — ${r.entry_type}, ${r.status}${held}`);
      if (r.status === "unconfirmed") console.log(`    confirm: ${SITE}/register/confirm?r=${r.id}&c=${signed("mb-registration-confirm", r.id)}`);
      console.log(`    status:  ${SITE}/register/status?r=${r.id}&s=${signed("mb-registration-status", r.id)}`);
    }
  }
}

/** A fresh sign-in for the demo admin (the seed prints one too, but reseeding clears the demo events). */
async function session(): Promise<void> {
  const token = await demoAdmin(await moveBeyond());
  console.log(`Open ${SITE}, then in the browser's DevTools console run (valid 24 hours):\n\n   document.cookie = "mb_session=${token}; path=/";\n`);
}

const mode = process.argv[2] ?? "seed";
(mode === "links" ? links() : mode === "session" ? session() : mode === "remove" ? removeEvents().then(() => console.log("Demo events removed.")) : seed()).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

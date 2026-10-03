/**
 * Announcements end to end, on the stand-in only and in dry run (nothing is sent):
 * players with and without email/phone, an opted-out player and a bad number;
 * an announcement by email + WhatsApp is queued, drained in chunks, then signed
 * provider webhooks report delivered / read / bounced / "not on WhatsApp"; the
 * admin pages, CSV export, retry, the cron drain route and sendTransactional
 * (with idempotency) are checked. Creates and deletes its own data.
 *
 *   LOCALDB_PORT=54338 npm run localdb
 *   SUPABASE_URL=http://localhost:54338 MESSAGING_DRY_RUN=1 RESEND_WEBHOOK_SECRET=… WA_CLOUD_APP_SECRET=… \
 *     WA_CLOUD_VERIFY_TOKEN=… npx next dev -p 3088
 *   npx tsx --env-file=.env.e2e-messaging scripts/e2e/messaging.ts
 *
 * The env file must point SUPABASE_URL at the stand-in and set MESSAGING_DRY_RUN=1
 * plus the same three webhook secrets as the dev server; the script refuses to
 * run otherwise.
 */
import { randomInt, randomUUID } from "crypto";
import { newAccessCode } from "../../src/lib/players/accessCode";
import { db } from "../../src/lib/supabase";
import { signSvix } from "../../src/lib/messaging/email";
import { signMeta } from "../../src/lib/messaging/whatsapp";
import { drainMessages, sendTransactional, startAnnouncement } from "../../src/lib/messaging/queue";
import { BASE_URL, authHeaders } from "./lib/session";

let failed = 0;
function check(ok: boolean, label: string, detail?: unknown) {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!ok) failed++;
}

async function rows(announcementId: string) {
  const { data } = await db()
    .from("message_deliveries")
    .select("id, channel, recipient_name, address, status, error_code, error_reason, provider_message_id, attempts")
    .eq("announcement_id", announcementId);
  return (data ?? []) as { id: string; channel: string; recipient_name: string; address: string | null; status: string; error_code: string | null; error_reason: string | null; provider_message_id: string | null; attempts: number }[];
}

async function resendHook(event: unknown) {
  const body = JSON.stringify(event);
  const id = `msg_${randomUUID()}`;
  const ts = String(Math.floor(Date.now() / 1000));
  return fetch(`${BASE_URL}/api/webhooks/resend`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "svix-id": id, "svix-timestamp": ts, "svix-signature": signSvix(process.env.RESEND_WEBHOOK_SECRET!, id, ts, body) },
    body,
  });
}

async function waHook(payload: unknown, secret = process.env.WA_CLOUD_APP_SECRET!) {
  const body = JSON.stringify(payload);
  return fetch(`${BASE_URL}/api/webhooks/whatsapp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signMeta(secret, body) },
    body,
  });
}

const waStatus = (id: string, status: string, errors?: unknown[]) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "waba", changes: [{ field: "messages", value: { statuses: [{ id, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: "x", ...(errors ? { errors } : {}) }] } }] }],
});

async function main() {
  if (!/localhost|127\.0\.0\.1/.test(process.env.SUPABASE_URL ?? "")) throw new Error("Refusing: SUPABASE_URL is not the local stand-in");
  if (process.env.MESSAGING_DRY_RUN !== "1") throw new Error("Refusing: MESSAGING_DRY_RUN=1 is required");

  // The server must be in dry run too, before anything is queued.
  const cron = await fetch(`${BASE_URL}/api/internal/messages/drain`, { method: "POST", headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
  const cronJson = (await cron.json().catch(() => null)) as { transport?: string } | null;
  check(cron.status === 200 && cronJson?.transport === "dry-run", "server drain route answers in dry run", cronJson);
  if (cronJson?.transport !== "dry-run") throw new Error("Server is not in dry run — stopping before anything is queued");
  const denied = await fetch(`${BASE_URL}/api/internal/messages/drain`, { method: "POST", headers: { Authorization: "Bearer nope" } });
  check(denied.status === 401, "drain route refuses a wrong CRON_SECRET");

  const tag = randomUUID().slice(0, 6);
  const { data: t } = await db()
    .from("tournaments")
    .insert({ name: `Msg Open ${tag}`, slug: `msg-open-${tag}`, sport: "padel", kind: "tournament", status: "active" })
    .select("id, slug")
    .single();
  const tid = (t as { id: string }).id;
  const profileIds: string[] = [];
  let announcementId: string | null = null;
  try {
    // Profiles: full details, email only, phone only (Not on WhatsApp later), bad phone, opted out of WhatsApp.
    const people = [
      { public_name: `Omar ${tag}`, email: `omar-${tag}@x.test`, mobile_normalized: `+2010${tag.replace(/\D/g, "0").padEnd(8, "1").slice(0, 8)}` },
      { public_name: `Sara ${tag}`, email: `sara-${tag}@x.test`, mobile_normalized: null },
      { public_name: `Ali ${tag}`, email: null, mobile_normalized: "+201112220001" },
      { public_name: `Mona ${tag}`, email: `mona-${tag}@fail.test`, mobile_normalized: "+20223456789" },
      { public_name: `Hana ${tag}`, email: `hana-${tag}@x.test`, mobile_normalized: "+201212220002" },
    ];
    const { data: profs, error: pErr } = await db()
      .from("player_profiles")
      .insert(people.map((p) => ({ ...p, approval_status: "approved" })))
      .select("id, public_name");
    if (pErr) throw new Error(pErr.message);
    const byName = new Map(((profs ?? []) as { id: string; public_name: string }[]).map((p) => [p.public_name.split(" ")[0]!, p.id]));
    profileIds.push(...byName.values());
    await db().from("player_consents").insert({ player_profile_id: byName.get("Hana"), channel: "whatsapp", granted: false, revoked_at: new Date().toISOString(), source: "player" });

    const { data: teams } = await db()
      .from("teams")
      .insert([
        { tournament_id: tid, team_name: `Team A ${tag}`, phone: null },
        { tournament_id: tid, team_name: `Team B ${tag}`, phone: "01001119999" },
      ])
      .select("id");
    const [ta, tb] = (teams ?? []) as { id: string }[];
    await db()
      .from("players")
      .insert([
        { tournament_id: tid, team_id: ta!.id, player_order: 1, full_name: `Omar ${tag}`, player_profile_id: byName.get("Omar"), access_code: newAccessCode(randomInt), email: `own-omar-${tag}@x.test`, phone: null },
        { tournament_id: tid, team_id: ta!.id, player_order: 2, full_name: `Sara ${tag}`, player_profile_id: byName.get("Sara"), access_code: null, email: null, phone: null },
        { tournament_id: tid, team_id: tb!.id, player_order: 1, full_name: `Guest ${tag}`, player_profile_id: null, access_code: newAccessCode(randomInt), email: null, phone: null },
      ]);

    // ---- announcement to this tournament's players, email + WhatsApp
    const { data: ann } = await db()
      .from("message_announcements")
      .insert({
        kind: "access_codes",
        title: "Your code for {tournament}",
        body: "Hi {first_name}, your code is {code}.",
        channels: ["email", "whatsapp"],
        audience: { type: "tournament", tournamentId: tid },
        whatsapp_template: { name: "mb_access_code", language: "en", params: [{ field: "first_name" }, { field: "code" }, { field: "app_link" }] },
        tournament_id: tid,
        created_by: "admin",
      })
      .select("id")
      .single();
    announcementId = (ann as { id: string }).id;
    const started = await startAnnouncement(announcementId);
    // Omar: email + WA; Sara: email skipped? no — she has no code → skipped both; Guest: team phone (ends 9999 → dry-run Meta rejects), no email.
    check(started.queued === 3, "codes: queued Omar's email + WhatsApp and Guest's WhatsApp", started);
    let again: unknown = null;
    try {
      await startAnnouncement(announcementId);
    } catch (e) {
      again = (e as Error).message;
    }
    check(again === "This announcement has already been sent", "a second Send cannot enqueue twice", again);

    const drained = await drainMessages({ budgetMs: 15_000, announcementId });
    check(drained.transport === "dry-run" && drained.remaining === 0, "drain sent everything in dry run", drained);
    let r = await rows(announcementId);
    const omarWa = r.find((x) => x.channel === "whatsapp" && x.recipient_name.startsWith("Omar"));
    const guestWa = r.find((x) => x.channel === "whatsapp" && x.recipient_name.startsWith("Guest"));
    const saraEmail = r.find((x) => x.channel === "email" && x.recipient_name.startsWith("Sara"));
    check(omarWa?.status === "sent" && !!omarWa.provider_message_id?.startsWith("wamid."), "Omar's WhatsApp is sent with a wamid", omarWa?.status);
    check(guestWa?.status === "failed" && guestWa.error_code === "131009", "Guest's bad template parameter failed at send time", guestWa);
    check(saraEmail?.status === "skipped" && saraEmail.error_code === "no_code", "Sara has no code: recorded as not sent", saraEmail?.error_reason);
    const omarEmailRow = r.find((x) => x.channel === "email" && x.recipient_name.startsWith("Omar"));
    check(omarEmailRow?.address === `own-omar-${tag}@x.test`, "the player's own email (players.email) wins over the profile's", omarEmailRow?.address);
    const { data: a1 } = await db().from("message_announcements").select("status, recipients_total").eq("id", announcementId).single();
    check((a1 as { status: string }).status === "sent", "announcement is marked sent when nothing is left", a1);

    // ---- WhatsApp webhooks
    const verify = await fetch(`${BASE_URL}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(process.env.WA_CLOUD_VERIFY_TOKEN!)}&hub.challenge=12345`);
    check(verify.status === 200 && (await verify.text()) === "12345", "WhatsApp handshake echoes hub.challenge");
    const badVerify = await fetch(`${BASE_URL}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`);
    check(badVerify.status === 403, "WhatsApp handshake refuses a wrong verify token");
    const forged = await waHook(waStatus(omarWa!.provider_message_id!, "read"), "not-the-secret");
    check(forged.status === 401, "WhatsApp webhook refuses a forged signature");
    await waHook(waStatus(omarWa!.provider_message_id!, "read"));
    await waHook(waStatus(omarWa!.provider_message_id!, "delivered")); // late, must not step back
    r = await rows(announcementId);
    check(r.find((x) => x.id === omarWa!.id)?.status === "read", "read stays read after a late 'delivered'");

    // ---- second announcement: all players, email + WhatsApp, then provider reports
    const { data: ann2 } = await db()
      .from("message_announcements")
      .insert({
        kind: "announcement",
        title: "Season news",
        body: "Hi {first_name},\nthe new season starts soon.",
        channels: ["email", "whatsapp"],
        audience: { type: "list", list: [`Omar ${tag}, omar-${tag}@x.test, ${people[0]!.mobile_normalized}`, `Ali ${tag}, +201112220001`, `Mona ${tag}, mona-${tag}@fail.test, 02 2345 6789`, `Hana ${tag}, hana-${tag}@x.test`, "no contact here"].join("\n") },
        whatsapp_template: { name: "mb_announcement", language: "en", params: [{ field: "first_name" }, { field: "title" }, { field: "message" }] },
        created_by: "admin",
      })
      .select("id")
      .single();
    const a2 = (ann2 as { id: string }).id;
    const s2 = await startAnnouncement(a2);
    check(s2.queued === 5 && s2.skipped === 3, "list: 3 emails + 2 WhatsApp queued; Mona's bad number, Ali's and Hana's missing addresses recorded", s2);
    await drainMessages({ budgetMs: 15_000, announcementId: a2 });
    r = await rows(a2);
    const monaEmail = r.find((x) => x.channel === "email" && x.recipient_name.startsWith("Mona"));
    check(monaEmail?.status === "failed" && monaEmail.error_code === "validation_error", "Resend rejection is recorded with its reason", monaEmail?.error_reason);
    const aliWa = r.find((x) => x.channel === "whatsapp" && x.recipient_name.startsWith("Ali"))!;
    const omarEmail = r.find((x) => x.channel === "email" && x.recipient_name.startsWith("Omar"))!;
    const hanaEmail = r.find((x) => x.channel === "email" && x.recipient_name.startsWith("Hana"))!;
    // Ali's number has no WhatsApp: Meta reports failed 131026.
    const hookRes = await waHook(waStatus(aliWa.provider_message_id!, "failed", [{ code: 131026, title: "Message undeliverable", error_data: { details: "Message Undeliverable." } }]));
    check(hookRes.status === 200, "WhatsApp failure report accepted");
    await resendHook({ type: "email.delivered", created_at: new Date().toISOString(), data: { email_id: omarEmail.provider_message_id } });
    await resendHook({ type: "email.opened", created_at: new Date().toISOString(), data: { email_id: omarEmail.provider_message_id } });
    // A bounce found by the delivery tag (as when the report beats our own write).
    await resendHook({ type: "email.bounced", created_at: new Date().toISOString(), data: { email_id: "unknown-id", tags: { delivery: hanaEmail.id }, bounce: { type: "Permanent", subType: "Suppressed", message: "Address is on the suppression list" } } });
    const unsigned = await fetch(`${BASE_URL}/api/webhooks/resend`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    check(unsigned.status === 401, "Resend webhook refuses an unsigned request");
    r = await rows(a2);
    check(r.find((x) => x.id === aliWa.id)?.error_reason === "Not on WhatsApp / undeliverable", "Ali is shown as Not on WhatsApp", r.find((x) => x.id === aliWa.id));
    check(r.find((x) => x.id === omarEmail.id)?.status === "read", "Omar's email: delivered then opened");
    check(r.find((x) => x.id === hanaEmail.id)?.status === "bounced", "Hana's email bounced (matched by tag)", r.find((x) => x.id === hanaEmail.id)?.error_reason);

    // ---- admin pages, filters and CSV
    const list = await fetch(`${BASE_URL}/admin/announcements`, { headers: authHeaders("admin") });
    const listHtml = await list.text();
    check(list.status === 200 && listHtml.includes("Season news") && listHtml.includes("Announcements"), "announcements list renders with the new entries");
    const anon = await fetch(`${BASE_URL}/admin/announcements`, { redirect: "manual" });
    check(anon.status >= 300 && anon.status < 400, "announcements need a staff login", anon.status);
    const refereeCsv = await fetch(`${BASE_URL}/admin/announcements/${a2}/export`, { headers: authHeaders("referee") });
    check(refereeCsv.status === 403, "a referee cannot export recipients");
    const detail = await fetch(`${BASE_URL}/admin/announcements/${a2}?filter=not_on_whatsapp`, { headers: authHeaders("admin") });
    const detailHtml = await detail.text();
    check(detail.status === 200 && detailHtml.includes(`Ali ${tag}`) && !detailHtml.includes(`Omar ${tag}</td>`), "'Not on WhatsApp' filter shows Ali only");
    const csv = await fetch(`${BASE_URL}/admin/announcements/${a2}/export`, { headers: authHeaders("admin") });
    const csvText = await csv.text();
    check(csv.status === 200 && csvText.includes("Not on WhatsApp") && csvText.includes("Bounced") && csvText.split("\r\n").length >= 9, "CSV export lists every recipient with status and reason", csvText.split("\r\n").length);

    // ---- retry failed: Mona's Resend rejection goes back to the queue (and fails again in dry run)
    const { retryFailed } = await import("../../src/lib/messaging/queue");
    const retried = await retryFailed(a2);
    check(retried === 1, "Retry failed re-queues Mona's email but not Ali's 'not on WhatsApp'", retried);
    await drainMessages({ budgetMs: 10_000, announcementId: a2 });
    r = await rows(a2);
    const failedNow = r.filter((x) => x.status === "failed").map((x) => `${x.recipient_name.split(" ")[0]}:${x.channel}:${x.attempts}`).sort();
    check(failedNow.join() === "Ali:whatsapp:1,Mona:email:1", "after retry: Mona failed again (fresh attempt), Ali untouched", failedNow);

    // ---- transactional, with idempotency
    const key = `e2e-confirm-${tag}`;
    const t1 = await sendTransactional({ to: `omar-${tag}@x.test`, channel: "email", template: "confirmation", vars: { name: `Omar ${tag}`, title: "Registration received", message: "We have your entry." }, idempotencyKey: key });
    const t2 = await sendTransactional({ to: `omar-${tag}@x.test`, channel: "email", template: "confirmation", vars: { name: `Omar ${tag}`, title: "Registration received", message: "We have your entry." }, idempotencyKey: key });
    check(t1.ok && t1.deliveryId === t2.deliveryId, "sendTransactional sends once per idempotency key", { t1, t2 });
    const t3 = await sendTransactional({ to: "0100 999", channel: "whatsapp", template: "access_code", vars: { name: "X", code: "Y" } });
    check(!t3.ok && t3.status === "skipped", "sendTransactional records an invalid number instead of sending", t3);
    // Inbound "STOP" opts the number out; the next transactional WhatsApp is not sent.
    await waHook({ entry: [{ changes: [{ field: "messages", value: { messages: [{ from: "201112220001", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "STOP" } }] } }] }] });
    const t4 = await sendTransactional({ to: "+201112220001", channel: "whatsapp", template: "access_code", vars: { name: "Ali", code: "Z" } });
    check(!t4.ok && t4.error === "Asked us to stop WhatsApp messages", "a number that wrote STOP is not messaged", t4);
    await db().from("message_deliveries").delete().in("id", [t1.deliveryId, t3.deliveryId, t4.deliveryId].filter(Boolean) as string[]);
    await db().from("message_announcements").delete().eq("id", a2);
  } finally {
    if (announcementId) await db().from("message_announcements").delete().eq("id", announcementId);
    await db().from("whatsapp_contacts").delete().eq("phone", "+201112220001");
    await db().from("players").delete().eq("tournament_id", tid);
    await db().from("teams").delete().eq("tournament_id", tid);
    await db().from("tournaments").delete().eq("id", tid);
    if (profileIds.length) {
      await db().from("player_consents").delete().in("player_profile_id", profileIds);
      await db().from("player_profiles").delete().in("id", profileIds);
    }
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nAll messaging checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

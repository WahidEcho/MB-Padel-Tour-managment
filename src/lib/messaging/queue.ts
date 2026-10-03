/**
 * The send queue: every recipient of every message is a message_deliveries row,
 * written before anything is sent, so the console can always say who a message
 * reached and who it did not.
 *
 *   start   — an announcement's audience is resolved and every row inserted
 *             ('queued', or 'skipped' with the reason). Draft → sending is a
 *             compare-and-set, so a double click cannot enqueue twice.
 *   drain   — claims queued rows (queued → sending, compare-and-set, so two
 *             drains never send one row twice), sends email in batches of 100
 *             and WhatsApp a few at a time, and records each outcome. Runs in
 *             time-boxed chunks: from the admin page while it is open, right
 *             after Send, and every minute from the database cron job.
 *   webhooks— move rows forward (sent → delivered → read, or failed / bounced).
 *
 * Retries: a transient error (rate limit, provider down) puts the row back to
 * 'queued' until MAX_ATTEMPTS. A drain that dies mid-send leaves rows 'sending';
 * they return to the queue after STUCK_AFTER_MS (a person may then, rarely, get
 * a message twice — never none).
 */
import { after } from "next/server";
import { db } from "../supabase";
import { notifyAnnouncement, notifyBroadcast } from "../notify/hooks";
import { resolveAudience, type Audience } from "./audience";
import { BATCH_LIMIT, normalizeEmail, type EmailMessage, type SendOutcome, type StatusUpdate } from "./email";
import { toE164 } from "./phone";
import { planDeliveries, type PlannedDelivery } from "./recipients";
import { mergeVars, renderEmail, type Vars } from "./render";
import { appLink, tournamentLink } from "./links";
import { canAdvance, timestampFor, type Channel, type DeliveryStatus } from "./status";
import { announcementTemplate, transactionalEmail, transactionalText, transactionalWhatsApp, type TransactionalTemplate, type WaTemplateChoice } from "./templates";
import { sendEmailChunk, sendWhatsApp, transportMode } from "./transport";
import { isStopRequest, windowOpen, type InboundMessage, type TemplateSend } from "./whatsapp";

export const MAX_ATTEMPTS = 5;
export const STUCK_AFTER_MS = 5 * 60_000;
const WA_CONCURRENCY = 8;
/** Resend allows a few requests a second; one batch request per 550 ms stays under it. */
const EMAIL_GAP_MS = 550;

export type AnnouncementKind = "announcement" | "access_codes" | "new_tournament";

export interface AnnouncementRow {
  id: string;
  kind: AnnouncementKind;
  title: string;
  body: string;
  channels: string[];
  audience: Audience;
  whatsapp_template: WaTemplateChoice | null;
  cta: { label: string; url: string } | null;
  tournament_id: string | null;
  status: "draft" | "sending" | "sent" | "cancelled";
  recipients_total: number;
  push_dedupe_key: string | null;
  created_by: string | null;
  created_at: string;
  sent_at: string | null;
  completed_at: string | null;
}

interface DeliveryRow {
  id: string;
  announcement_id: string | null;
  channel: Channel;
  address: string | null;
  vars: Vars;
  payload: Payload | null;
  attempts: number;
  status: DeliveryStatus;
}

/** Transactional and test rows carry their rendered message. */
type Payload =
  | { kind: "email"; subject: string; html: string; text: string }
  | { kind: "wa_template"; template: TemplateSend }
  | { kind: "wa_text"; text: string };

const nowIso = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  }));
}

/* ---------------- what one row says ---------------- */

/** The email for one announcement recipient. */
export function announcementEmail(a: Pick<AnnouncementRow, "kind" | "title" | "body" | "cta">, vars: Vars) {
  return renderEmail({ title: a.title, body: a.body, cta: a.cta, code: a.kind === "access_codes" ? "{code}" : null }, vars);
}

function messageFor(row: DeliveryRow, a: AnnouncementRow | null): { email?: EmailMessage; wa?: { template: TemplateSend } | { text: string }; error?: string } {
  const p = row.payload;
  if (row.channel === "email") {
    if (p?.kind === "email") return { email: { deliveryId: row.id, to: row.address!, subject: p.subject, html: p.html, text: p.text } };
    if (!a) return { error: "Nothing to send" };
    const e = announcementEmail(a, row.vars);
    return { email: { deliveryId: row.id, to: row.address!, ...e } };
  }
  if (p?.kind === "wa_template") return { wa: { template: p.template } };
  if (p?.kind === "wa_text") return { wa: { text: p.text } };
  if (!a?.whatsapp_template?.name) return { error: "No WhatsApp template chosen" };
  return { wa: { template: announcementTemplate(a.whatsapp_template, { title: a.title, body: a.body, vars: row.vars }) } };
}

/* ---------------- recording outcomes ---------------- */

async function recordOutcome(row: DeliveryRow, out: SendOutcome) {
  const at = nowIso();
  const attempts = row.attempts + 1;
  if (out.ok) {
    // Only 'sending' becomes 'sent': a webhook may already have moved it on.
    const { data } = await db()
      .from("message_deliveries")
      .update({ status: "sent", provider_message_id: out.providerId, sent_at: at, attempts, error_code: null, error_reason: null, updated_at: at })
      .eq("id", row.id)
      .eq("status", "sending")
      .select("id");
    if (!data?.length) await db().from("message_deliveries").update({ provider_message_id: out.providerId, attempts, updated_at: at }).eq("id", row.id);
    return;
  }
  const retry = out.transient && attempts < MAX_ATTEMPTS;
  await db()
    .from("message_deliveries")
    .update({
      status: retry ? "queued" : "failed",
      error_code: out.code.slice(0, 60),
      error_reason: (retry ? `${out.reason} (try ${attempts} of ${MAX_ATTEMPTS})` : out.reason).slice(0, 500),
      attempts,
      failed_at: retry ? null : at,
      updated_at: at,
    })
    .eq("id", row.id)
    .eq("status", "sending");
}

/* ---------------- drain ---------------- */

export async function recoverStuck(): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_AFTER_MS).toISOString();
  await db()
    .from("message_deliveries")
    .update({ status: "failed", error_code: "stuck", error_reason: "Sending was interrupted too many times", failed_at: nowIso() })
    .eq("status", "sending")
    .lt("claimed_at", cutoff)
    .gte("attempts", MAX_ATTEMPTS - 1);
  await db().from("message_deliveries").update({ status: "queued" }).eq("status", "sending").lt("claimed_at", cutoff).lt("attempts", MAX_ATTEMPTS - 1);
}

export interface DrainResult {
  transport: "dry-run" | "live";
  claimed: number;
  sent: number;
  failed: number;
  retrying: number;
  remaining: number;
}

/**
 * Sends queued rows until `budgetMs` runs out or the queue is empty. Pass an
 * announcement id to work on that one only (the admin page's progress loop).
 */
export async function drainMessages(opts: { budgetMs?: number; announcementId?: string } = {}): Promise<DrainResult> {
  const deadline = Date.now() + (opts.budgetMs ?? 20_000);
  const result: DrainResult = { transport: transportMode(), claimed: 0, sent: 0, failed: 0, retrying: 0, remaining: 0 };
  await recoverStuck();
  const announcements = new Map<string, AnnouncementRow | null>();
  const touched = new Set<string>();

  while (Date.now() < deadline - 3000) {
    let q = db()
      .from("message_deliveries")
      .select("id, announcement_id, channel, address, vars, payload, attempts, status")
      .eq("status", "queued")
      .order("created_at")
      .limit(BATCH_LIMIT);
    if (opts.announcementId) q = q.eq("announcement_id", opts.announcementId);
    const { data: due, error } = await q;
    if (error) throw new Error(error.message);
    if (!due?.length) break;

    const { data: claimedRows } = await db()
      .from("message_deliveries")
      .update({ status: "sending", claimed_at: nowIso() })
      .in("id", (due as DeliveryRow[]).map((r) => r.id))
      .eq("status", "queued")
      .select("id");
    const claimedIds = new Set(((claimedRows ?? []) as { id: string }[]).map((r) => r.id));
    const rows = (due as DeliveryRow[]).filter((r) => claimedIds.has(r.id)).map((r) => ({ ...r, status: "sending" as const }));
    if (!rows.length) continue;
    result.claimed += rows.length;

    for (const id of new Set(rows.map((r) => r.announcement_id).filter((x): x is string => !!x))) {
      touched.add(id);
      if (!announcements.has(id)) {
        const { data } = await db().from("message_announcements").select("*").eq("id", id).maybeSingle();
        announcements.set(id, (data as AnnouncementRow | null) ?? null);
      }
    }

    const emails: { row: DeliveryRow; msg: EmailMessage }[] = [];
    const was: { row: DeliveryRow; msg: { template: TemplateSend } | { text: string } }[] = [];
    for (const row of rows) {
      const a = row.announcement_id ? announcements.get(row.announcement_id) ?? null : null;
      if (a?.status === "cancelled") {
        await db().from("message_deliveries").update({ status: "skipped", error_code: "cancelled", error_reason: "Announcement cancelled before it was sent" }).eq("id", row.id);
        continue;
      }
      const m = messageFor(row, a);
      if (m.error || !row.address) {
        await recordOutcome(row, { ok: false, code: "nothing_to_send", reason: m.error ?? "No address", transient: false });
        result.failed++;
      } else if (m.email) emails.push({ row, msg: m.email });
      else if (m.wa) was.push({ row, msg: m.wa });
    }

    const tally = async (row: DeliveryRow, out: SendOutcome) => {
      await recordOutcome(row, out);
      if (out.ok) result.sent++;
      else if (out.transient && row.attempts + 1 < MAX_ATTEMPTS) result.retrying++;
      else result.failed++;
    };

    for (let i = 0; i < emails.length; i += BATCH_LIMIT) {
      const chunk = emails.slice(i, i + BATCH_LIMIT);
      const outcomes = await sendEmailChunk(chunk.map((c) => c.msg));
      await pool(chunk.map((c, j) => ({ row: c.row, out: outcomes[j]! })), 10, (x) => tally(x.row, x.out));
      if (transportMode() === "live") await sleep(EMAIL_GAP_MS);
    }
    await pool(was, WA_CONCURRENCY, async ({ row, msg }) => tally(row, await sendWhatsApp(row.address!, msg)));

    // Everything left in this batch was a transient failure: stop hammering, the next run retries.
    if (result.retrying && !result.sent) break;
  }

  for (const id of touched) await finishIfDone(id);
  let rq = db().from("message_deliveries").select("id", { count: "exact", head: true }).in("status", ["queued", "sending"]);
  if (opts.announcementId) rq = rq.eq("announcement_id", opts.announcementId);
  const { count } = await rq;
  result.remaining = count ?? 0;
  return result;
}

/** An announcement with nothing left to send is 'sent'. */
export async function finishIfDone(announcementId: string): Promise<boolean> {
  const { count } = await db()
    .from("message_deliveries")
    .select("id", { count: "exact", head: true })
    .eq("announcement_id", announcementId)
    .eq("is_test", false)
    .in("status", ["queued", "sending"]);
  if ((count ?? 0) > 0) return false;
  await db().from("message_announcements").update({ status: "sent", completed_at: nowIso(), updated_at: nowIso() }).eq("id", announcementId).eq("status", "sending");
  return true;
}

/** Runs a drain after the response when inside a request (never throws); a no-op elsewhere. */
export function kickDrain(announcementId?: string) {
  const run = async () => {
    try {
      await drainMessages({ budgetMs: 25_000, announcementId });
    } catch (err) {
      console.error("[messaging] drain failed", err);
    }
  };
  try {
    after(run);
  } catch {
    // Outside a request (a script): the caller or the scheduled drain sends.
  }
}

/* ---------------- announcements ---------------- */

export interface StartResult {
  queued: number;
  skipped: number;
  push: boolean;
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function waOptOuts(): Promise<Set<string>> {
  const { data } = await db().from("whatsapp_contacts").select("phone").not("opted_out_at", "is", null).limit(10000);
  return new Set(((data ?? []) as { phone: string }[]).map((r) => r.phone));
}

/** Values every recipient of an announcement shares: its tournament and the app link. */
export async function baseVars(tournamentId: string | null): Promise<Vars> {
  const vars: Vars = { app_link: appLink() };
  if (tournamentId) {
    const { data } = await db().from("tournaments").select("name, slug").eq("id", tournamentId).maybeSingle();
    const t = data as { name: string; slug: string } | null;
    if (t) Object.assign(vars, { tournament: t.name, link: tournamentLink(t.slug) });
  }
  return vars;
}

/** The audience with announcement-wide values filled in. */
export async function recipientsOf(a: Pick<AnnouncementRow, "audience" | "tournament_id">) {
  const [resolved, base] = await Promise.all([resolveAudience(a.audience), baseVars(a.tournament_id)]);
  return { ...resolved, recipients: resolved.recipients.map((r) => ({ ...r, vars: mergeVars(base, r.vars) })), base };
}

/** Resolve, plan and insert every delivery row; push via the app outbox. Draft → sending once. */
export async function startAnnouncement(id: string): Promise<StartResult> {
  const { data: claimed } = await db()
    .from("message_announcements")
    .update({ status: "sending", sent_at: nowIso(), updated_at: nowIso() })
    .eq("id", id)
    .eq("status", "draft")
    .select("*")
    .maybeSingle();
  if (!claimed) throw new Error("This announcement has already been sent");
  const a = claimed as AnnouncementRow;
  try {
    const channels = a.channels.filter((c): c is Channel => c === "email" || c === "whatsapp");
    const { recipients } = await recipientsOf(a);
    const { rows } = planDeliveries(recipients, channels, { requireCode: a.kind === "access_codes", waOptedOut: await waOptOuts() });
    for (const part of chunk(rows, 500)) {
      const { error } = await db().from("message_deliveries").insert(part.map((r: PlannedDelivery) => ({ ...r, announcement_id: id, purpose: a.kind })));
      if (error) throw new Error(error.message);
    }
    const queued = rows.filter((r) => r.status === "queued").length;
    const push = a.channels.includes("push") ? await startPush(a) : false;
    await db().from("message_announcements").update({ recipients_total: rows.length, updated_at: nowIso() }).eq("id", id);
    if (!queued) await finishIfDone(id);
    else kickDrain(id);
    return { queued, skipped: rows.length - queued, push };
  } catch (err) {
    // Nothing went out yet (rows are only sent by the drain): let the organiser try again.
    await db().from("message_deliveries").delete().eq("announcement_id", id).eq("status", "queued");
    await db().from("message_deliveries").delete().eq("announcement_id", id).eq("status", "skipped");
    await db().from("message_announcements").update({ status: "draft", sent_at: null }).eq("id", id);
    throw err;
  }
}

async function startPush(a: AnnouncementRow): Promise<boolean> {
  const body = a.body.replace(/\{[a-z_]+\}/g, "").trim();
  if (a.audience.type === "tournament") {
    const { data, error } = await db()
      .from("announcements")
      .insert({ tournament_id: a.audience.tournamentId, title: a.title.slice(0, 120), body: body.slice(0, 600) || null, level: "major", created_by_role: a.created_by })
      .select("id")
      .single();
    if (error) {
      console.error("[messaging] in-app announcement failed", error.message);
      return false;
    }
    const inApp = (data as { id: string }).id;
    await notifyAnnouncement(inApp);
    await db().from("message_announcements").update({ push_dedupe_key: `announcement:${inApp}` }).eq("id", a.id);
    return true;
  }
  if (a.audience.type === "nation" || a.audience.type === "app_users") {
    await notifyBroadcast({
      id: a.id,
      title: a.title,
      body,
      target: a.audience.type === "nation" ? { kind: "nation", code: a.audience.nationCode } : { kind: "all" },
    });
    await db().from("message_announcements").update({ push_dedupe_key: `broadcast:${a.id}` }).eq("id", a.id);
    return true;
  }
  return false;
}

/** WhatsApp failures another try cannot fix: no WhatsApp on the number, or the person stopped marketing messages. */
export const HOPELESS_CODES = ["131026", "131050"];

/**
 * Failed rows go back to the queue, except bounces, "not sent" rows and the
 * hopeless WhatsApp codes above. Returns how many.
 */
export async function retryFailed(announcementId: string, channel?: Channel): Promise<number> {
  let q = db()
    .from("message_deliveries")
    .update({ status: "queued", attempts: 0, error_code: null, error_reason: null, failed_at: null, claimed_at: null, updated_at: nowIso() })
    .eq("announcement_id", announcementId)
    .eq("is_test", false)
    .eq("status", "failed")
    .or(`error_code.is.null,error_code.not.in.(${HOPELESS_CODES.join(",")})`);
  if (channel) q = q.eq("channel", channel);
  const { data, error } = await q.select("id");
  if (error) throw new Error(error.message);
  const n = data?.length ?? 0;
  if (n) {
    await db().from("message_announcements").update({ status: "sending", completed_at: null, updated_at: nowIso() }).eq("id", announcementId).in("status", ["sent", "sending"]);
    kickDrain(announcementId);
  }
  return n;
}

/* ---------------- tests and transactional ---------------- */

export interface SendResult {
  ok: boolean;
  deliveryId: string | null;
  status: DeliveryStatus;
  error?: string;
}

async function sendRowNow(insert: Record<string, unknown>, msg: { email?: EmailMessage; wa?: { template: TemplateSend } | { text: string } }): Promise<SendResult> {
  const { data, error } = await db()
    .from("message_deliveries")
    .insert({ ...insert, status: "sending", claimed_at: nowIso() })
    .select("id, announcement_id, channel, address, vars, payload, attempts, status")
    .single();
  if (error) throw new Error(error.message);
  const row = data as DeliveryRow;
  const out = msg.email ? (await sendEmailChunk([{ ...msg.email, deliveryId: row.id }]))[0]! : await sendWhatsApp(row.address!, msg.wa!);
  await recordOutcome(row, out);
  if (out.ok) return { ok: true, deliveryId: row.id, status: "sent" };
  const retry = out.transient && row.attempts + 1 < MAX_ATTEMPTS;
  if (retry) kickDrain();
  return { ok: false, deliveryId: row.id, status: retry ? "queued" : "failed", error: out.reason };
}

async function skippedRow(insert: Record<string, unknown>, code: string, reason: string): Promise<SendResult> {
  const { data } = await db()
    .from("message_deliveries")
    .insert({ ...insert, status: "skipped", error_code: code, error_reason: reason })
    .select("id")
    .single();
  return { ok: false, deliveryId: (data as { id: string } | null)?.id ?? null, status: "skipped", error: reason };
}

/** Is the free-form WhatsApp window open for this number? */
async function waWindow(e164: string): Promise<{ open: boolean; optedOut: boolean }> {
  const { data } = await db().from("whatsapp_contacts").select("last_inbound_at, opted_out_at").eq("phone", e164).maybeSingle();
  const c = data as { last_inbound_at: string | null; opted_out_at: string | null } | null;
  return { open: windowOpen(c?.last_inbound_at), optedOut: !!c?.opted_out_at };
}

/**
 * Sends one transactional message (a confirmation, a code, a notice) now, and
 * logs it in message_deliveries. With an `idempotencyKey`, a repeat call returns
 * the first attempt's result instead of sending again.
 *
 * WhatsApp: free-form text when the person wrote to us in the last 24 hours,
 * otherwise the catalogue's approved template.
 */
export async function sendTransactional(input: {
  to: string;
  channel: Channel;
  template: TransactionalTemplate;
  vars: Vars;
  idempotencyKey?: string;
  recipient?: { kind: "player_profile" | "player" | "adhoc"; id?: string | null; name?: string | null };
}): Promise<SendResult> {
  if (input.idempotencyKey) {
    const { data } = await db().from("message_deliveries").select("id, status, error_reason").eq("idempotency_key", input.idempotencyKey).maybeSingle();
    const prior = data as { id: string; status: DeliveryStatus; error_reason: string | null } | null;
    if (prior) return { ok: !["failed", "bounced", "skipped", "complained"].includes(prior.status), deliveryId: prior.id, status: prior.status, error: prior.error_reason ?? undefined };
  }
  const address = input.channel === "email" ? normalizeEmail(input.to) : toE164(input.to);
  const base = {
    announcement_id: null,
    channel: input.channel,
    purpose: input.template,
    recipient_kind: input.recipient?.kind ?? "adhoc",
    recipient_id: input.recipient?.id ?? null,
    recipient_name: input.recipient?.name ?? input.vars.name ?? null,
    address: address ?? input.to.slice(0, 120),
    vars: input.vars,
    idempotency_key: input.idempotencyKey ?? null,
  };
  if (!address) return skippedRow(base, input.channel === "email" ? "bad_email" : "bad_phone", input.channel === "email" ? "Email address is not valid" : "Phone number is not a valid mobile number");

  if (input.channel === "email") {
    const e = transactionalEmail(input.template, input.vars);
    const payload: Payload = { kind: "email", ...e };
    return sendRowNow({ ...base, payload }, { email: { deliveryId: "", to: address, ...e } });
  }
  const w = await waWindow(address);
  if (w.optedOut) return skippedRow(base, "wa_stop", "Asked us to stop WhatsApp messages");
  const payload: Payload = w.open
    ? { kind: "wa_text", text: transactionalText(input.template, input.vars) }
    : { kind: "wa_template", template: transactionalWhatsApp(input.template, input.vars) };
  return sendRowNow({ ...base, payload }, { wa: payload.kind === "wa_text" ? { text: payload.text } : { template: payload.template } });
}

/** "Send test to me": the announcement as one recipient would get it, to an address the admin typed. */
export async function sendTestMessage(
  a: Pick<AnnouncementRow, "kind" | "title" | "body" | "cta" | "whatsapp_template">,
  to: { email?: string | null; phone?: string | null },
  vars: Vars,
): Promise<{ email?: SendResult; whatsapp?: SendResult }> {
  const out: { email?: SendResult; whatsapp?: SendResult } = {};
  const base = { announcement_id: null, purpose: "test", is_test: true, recipient_kind: "adhoc", recipient_name: "Test", vars };
  if (to.email) {
    const address = normalizeEmail(to.email);
    if (!address) out.email = { ok: false, deliveryId: null, status: "skipped", error: "That email address is not valid" };
    else {
      const e = announcementEmail(a, vars);
      const subject = `[Test] ${e.subject}`;
      out.email = await sendRowNow({ ...base, channel: "email", address, payload: { kind: "email", ...e, subject } }, { email: { deliveryId: "", to: address, ...e, subject } });
    }
  }
  if (to.phone) {
    const address = toE164(to.phone);
    if (!address) out.whatsapp = { ok: false, deliveryId: null, status: "skipped", error: "That phone number is not a valid mobile number" };
    else if (!a.whatsapp_template?.name) out.whatsapp = { ok: false, deliveryId: null, status: "skipped", error: "Choose a WhatsApp template first" };
    else {
      const template = announcementTemplate(a.whatsapp_template, { title: a.title, body: a.body, vars });
      out.whatsapp = await sendRowNow({ ...base, channel: "whatsapp", address, payload: { kind: "wa_template", template } }, { wa: { template } });
    }
  }
  return out;
}

/* ---------------- webhooks ---------------- */

/**
 * Applies provider reports. Rows are found by the provider's message id, or (for
 * email, when the report beats our own write) by the delivery id tag. A status
 * only moves forward. Returns how many rows changed and the reports that matched
 * no row (another platform's messages, or a report that beat our own write).
 */
export async function applyStatusUpdates(updates: StatusUpdate[]): Promise<{ changed: number; missing: StatusUpdate[] }> {
  let changed = 0;
  const missing: StatusUpdate[] = [];
  for (const u of updates) {
    type Found = { id: string; status: DeliveryStatus; provider_message_id: string | null };
    let row: Found | null = null;
    if (u.providerId) {
      const { data } = await db().from("message_deliveries").select("id, status, provider_message_id").eq("provider_message_id", u.providerId).maybeSingle();
      row = data as Found | null;
    }
    if (!row && u.deliveryId && /^[0-9a-f-]{36}$/i.test(u.deliveryId)) {
      const { data } = await db().from("message_deliveries").select("id, status, provider_message_id").eq("id", u.deliveryId).maybeSingle();
      row = data as Found | null;
    }
    if (!row) {
      missing.push(u);
      continue;
    }
    if (!canAdvance(row.status, u.status)) continue;
    const patch: Record<string, unknown> = { status: u.status, updated_at: nowIso() };
    const col = timestampFor(u.status);
    if (col) patch[col] = u.at;
    if (u.errorCode !== undefined) patch.error_code = u.errorCode;
    if (u.errorReason !== undefined) patch.error_reason = u.errorReason;
    if (!row.provider_message_id && u.providerId) patch.provider_message_id = u.providerId;
    // Compare-and-set on the status we read, so two reports racing cannot step backwards.
    const { data } = await db().from("message_deliveries").update(patch).eq("id", row.id).eq("status", row.status).select("id");
    if (data?.length) changed++;
  }
  return { changed, missing };
}

/** Inbound WhatsApp messages open the 24-hour window; "STOP" opts the number out. */
export async function recordInbound(inbound: InboundMessage[]): Promise<void> {
  for (const m of inbound) {
    const patch: Record<string, unknown> = { phone: m.phone, last_inbound_at: m.at, updated_at: nowIso() };
    if (isStopRequest(m.text)) patch.opted_out_at = m.at;
    else if (m.text && /^\s*start\s*$/i.test(m.text)) patch.opted_out_at = null;
    await db().from("whatsapp_contacts").upsert(patch, { onConflict: "phone" });
  }
}

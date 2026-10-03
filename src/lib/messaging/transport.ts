/**
 * The only place messages leave the server.
 *
 * MESSAGING_DRY_RUN=1 swaps both providers for a stand-in that never touches the
 * network and answers like they do (an id per accepted message). Tests and the
 * end-to-end script run that way. In the stand-in, addresses at "fail.test" are
 * rejected by "Resend", and numbers ending 9999 by "Meta", so failure paths can
 * be exercised too.
 */
import { createHash, randomUUID } from "crypto";
import { BATCH_LIMIT, describeResendError, fromHeader, replyTo, resendBody, resendRequest, type EmailMessage, type SendOutcome } from "./email";
import { describeGraphError, graphRequest, templatePayload, textPayload, waConfig, type TemplateSend } from "./whatsapp";
import { waRecipient } from "./phone";

export type TransportMode = "dry-run" | "live";

export function transportMode(env: NodeJS.ProcessEnv = process.env): TransportMode {
  return env.MESSAGING_DRY_RUN === "1" || env.MESSAGING_DRY_RUN === "true" ? "dry-run" : "live";
}

export function channelReady(channel: "email" | "whatsapp", env: NodeJS.ProcessEnv = process.env): { ok: boolean; why?: string } {
  if (transportMode(env) === "dry-run") return { ok: true };
  if (channel === "email") {
    if (!env.RESEND_API_KEY) return { ok: false, why: "RESEND_API_KEY is not set" };
    return { ok: true };
  }
  return waConfig(env) ? { ok: true } : { ok: false, why: "WA_CLOUD_ACCESS_TOKEN / WA_CLOUD_PHONE_NUMBER_ID are not set" };
}

const notConfigured = (why: string): SendOutcome => ({ ok: false, code: "not_configured", reason: `Not configured: ${why}`, transient: false });

/* ---------------- email ---------------- */

function dryEmail(m: EmailMessage): SendOutcome {
  if (m.to.endsWith("@fail.test")) return { ok: false, code: "validation_error", reason: "Invalid `to` field (dry run)", transient: false };
  return { ok: true, providerId: `dry_${randomUUID()}` };
}

async function sendOneEmail(m: EmailMessage, apiKey: string, from: string, reply: string): Promise<SendOutcome> {
  try {
    const { status, json } = await resendRequest("/emails", resendBody(m, from, reply), { apiKey, idempotencyKey: `delivery-${m.deliveryId}` });
    const body = json as { id?: string; name?: string; message?: string } | null;
    if (status < 300 && body?.id) return { ok: true, providerId: body.id };
    return { ok: false, ...describeResendError(status, body) };
  } catch (err) {
    return { ok: false, code: "network", reason: `Could not reach Resend: ${err instanceof Error ? err.message : String(err)}`, transient: true };
  }
}

/**
 * Sends up to BATCH_LIMIT emails, one outcome per message in the same order.
 * A rejected batch is retried one by one so a single bad address cannot hold
 * back the other ninety-nine.
 */
export async function sendEmailChunk(msgs: EmailMessage[]): Promise<SendOutcome[]> {
  if (msgs.length > BATCH_LIMIT) throw new Error(`At most ${BATCH_LIMIT} emails per chunk`);
  if (transportMode() === "dry-run") return msgs.map(dryEmail);
  const ready = channelReady("email");
  if (!ready.ok) return msgs.map(() => notConfigured(ready.why!));
  const apiKey = process.env.RESEND_API_KEY!;
  const from = fromHeader();
  const reply = replyTo();
  if (msgs.length === 1) return [await sendOneEmail(msgs[0]!, apiKey, from, reply)];
  try {
    const { status, json } = await resendRequest("/emails/batch", msgs.map((m) => resendBody(m, from, reply)), {
      apiKey,
      idempotencyKey: `batch-${createHash("sha256").update(msgs.map((m) => m.deliveryId).join(",")).digest("hex")}`,
      timeoutMs: 30_000,
    });
    const body = json as { data?: { id: string }[]; name?: string; message?: string } | null;
    if (status < 300 && body?.data?.length === msgs.length) return body.data.map((d) => ({ ok: true as const, providerId: d.id }));
    const err = describeResendError(status, body);
    if (err.transient) return msgs.map(() => ({ ok: false as const, ...err }));
  } catch (err) {
    const reason = `Could not reach Resend: ${err instanceof Error ? err.message : String(err)}`;
    return msgs.map(() => ({ ok: false as const, code: "network", reason, transient: true }));
  }
  // Validation failed somewhere in the batch: find out where, one at a time.
  const out: SendOutcome[] = [];
  for (const m of msgs) {
    out.push(await sendOneEmail(m, apiKey, from, reply));
    await new Promise((r) => setTimeout(r, 550));
  }
  return out;
}

/* ---------------- WhatsApp ---------------- */

export async function sendWhatsApp(e164: string, message: { template: TemplateSend } | { text: string }): Promise<SendOutcome> {
  const to = waRecipient(e164);
  if (transportMode() === "dry-run") {
    if (to.endsWith("9999")) return { ok: false, code: "131009", reason: "A parameter value is not valid (dry run)", transient: false };
    return { ok: true, providerId: `wamid.DRY${randomUUID().replace(/-/g, "")}` };
  }
  const cfg = waConfig();
  if (!cfg) return notConfigured("WA_CLOUD_ACCESS_TOKEN / WA_CLOUD_PHONE_NUMBER_ID are not set");
  const payload = "template" in message ? templatePayload(to, message.template) : textPayload(to, message.text);
  try {
    const { status, json } = await graphRequest(cfg, "POST", `${cfg.phoneNumberId}/messages`, payload);
    const id = json?.messages?.[0]?.id;
    if (status < 300 && id) return { ok: true, providerId: id };
    return { ok: false, ...describeGraphError(status, json?.error) };
  } catch (err) {
    return { ok: false, code: "network", reason: `Could not reach WhatsApp: ${err instanceof Error ? err.message : String(err)}`, transient: true };
  }
}

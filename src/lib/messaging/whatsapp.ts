/**
 * WhatsApp Cloud API (Meta Graph API, no SDK), following the Move-Tick sender.
 *
 * Business-initiated messages must be approved templates; free-form text is only
 * delivered inside the 24 hours after the person last wrote to us. Template
 * variables cannot contain line breaks, tabs or more than four spaces in a row
 * (Meta error 132018), so parameter text is flattened before sending.
 *
 * A send that Meta accepts is only "sent": whether it reached the phone arrives
 * later on the webhook, and that is where a number without WhatsApp shows up
 * (error 131026). The pure parts here are tested; `graphRequest` is the network.
 */
import { createHmac, timingSafeEqual } from "crypto";
import type { DeliveryStatus } from "./status";
import type { StatusUpdate } from "./email";

export const GRAPH_HOST = "https://graph.facebook.com";
export const DEFAULT_API_VERSION = "v21.0";

export interface WaConfig {
  accessToken: string;
  phoneNumberId: string;
  wabaId: string | null;
  apiVersion: string;
}

export function waConfig(env: NodeJS.ProcessEnv = process.env): WaConfig | null {
  const accessToken = env.WA_CLOUD_ACCESS_TOKEN;
  const phoneNumberId = env.WA_CLOUD_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) return null;
  return { accessToken, phoneNumberId, wabaId: env.WA_CLOUD_WABA_ID || null, apiVersion: env.WA_CLOUD_API_VERSION || DEFAULT_API_VERSION };
}

/* ---------------- templates ---------------- */

export interface TemplateComponentDef {
  type: string;
  format?: string;
  text?: string;
  buttons?: { type: string; text?: string; url?: string }[];
}

export interface TemplateDef {
  name: string;
  language: string;
  status: string;
  category?: string;
  components?: TemplateComponentDef[];
}

/** What a caller must supply to send a template. */
export interface TemplateSpec {
  name: string;
  language: string;
  status: string;
  category: string | null;
  headerFormat: string | null;
  headerText: string | null;
  bodyText: string;
  bodyParams: number;
  /** Dynamic URL buttons (a {{1}} at the end of the URL), in button order. */
  urlButtons: { index: number; text: string; url: string }[];
  footer: string | null;
}

function countPlaceholders(text: string | undefined): number {
  const nums = [...(text ?? "").matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

export function describeTemplate(t: TemplateDef): TemplateSpec {
  const spec: TemplateSpec = {
    name: t.name,
    language: t.language,
    status: t.status,
    category: t.category ?? null,
    headerFormat: null,
    headerText: null,
    bodyText: "",
    bodyParams: 0,
    urlButtons: [],
    footer: null,
  };
  for (const c of t.components ?? []) {
    if (c.type === "HEADER") {
      spec.headerFormat = c.format ?? null;
      spec.headerText = c.text ?? null;
    } else if (c.type === "BODY") {
      spec.bodyText = c.text ?? "";
      spec.bodyParams = countPlaceholders(c.text);
    } else if (c.type === "FOOTER") {
      spec.footer = c.text ?? null;
    } else if (c.type === "BUTTONS") {
      (c.buttons ?? []).forEach((b, index) => {
        if (b.type === "URL" && (b.url ?? "").includes("{{")) spec.urlButtons.push({ index, text: b.text ?? "", url: b.url ?? "" });
      });
    }
  }
  return spec;
}

/** Meta refuses new lines, tabs and 5+ spaces inside a variable, and empty variables. */
export function sanitizeParam(value: string, max = 1000): string {
  const flat = value.replace(/[\r\n\t]+/g, " · ").replace(/ {4,}/g, "   ").replace(/( · )+/g, " · ").trim();
  const clipped = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return clipped || "-";
}

export interface TemplateSend {
  name: string;
  language: string;
  bodyParams: string[];
  headerImageUrl?: string | null;
  /** One value per dynamic URL button, in order. */
  buttonParams?: { index: number; value: string }[];
}

export function templatePayload(to: string, t: TemplateSend) {
  const components: Record<string, unknown>[] = [];
  if (t.headerImageUrl) components.push({ type: "header", parameters: [{ type: "image", image: { link: t.headerImageUrl } }] });
  // A template without variables must not get an empty body component (132000).
  if (t.bodyParams.length) components.push({ type: "body", parameters: t.bodyParams.map((p) => ({ type: "text", text: sanitizeParam(p) })) });
  for (const b of t.buttonParams ?? []) {
    components.push({ type: "button", sub_type: "url", index: String(b.index), parameters: [{ type: "text", text: sanitizeParam(b.value, 200) }] });
  }
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: { name: t.name, language: { code: t.language }, ...(components.length ? { components } : {}) },
  };
}

export function textPayload(to: string, body: string) {
  return { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: true, body: body.slice(0, 4096) } };
}

/* ---------------- errors ---------------- */

/** Meta error codes in words an organiser can act on. */
export const WA_ERRORS: Record<string, string> = {
  "131026": "Not on WhatsApp / undeliverable",
  "131047": "Outside the 24-hour window — needs an approved template",
  "131049": "Held back by Meta to protect engagement (marketing limit) — try again in a day or two",
  "131050": "The person stopped marketing messages from us",
  "131051": "Unsupported message type",
  "131052": "Media could not be downloaded",
  "131053": "Media could not be uploaded",
  "131000": "Something went wrong at Meta",
  "131005": "Access denied — check the token's WhatsApp permissions",
  "131008": "A required parameter is missing",
  "131009": "A parameter value is not valid",
  "131016": "WhatsApp is temporarily unavailable",
  "131021": "Cannot message our own number",
  "131030": "Number not in the allowed list (test phone number)",
  "131031": "WhatsApp Business account is locked",
  "131042": "Payment problem on the WhatsApp Business account",
  "131045": "Sender number is not registered",
  "131048": "Spam rate limit reached",
  "131056": "Too many messages to this number in a short time",
  "131057": "WhatsApp Business account is in maintenance",
  "132000": "The number of template variables does not match the approved template",
  "132001": "Template does not exist or is not approved in this language",
  "132005": "Message too long once the variables are filled in",
  "132007": "Template text breaks WhatsApp's formatting rules",
  "132012": "A template variable has the wrong format",
  "132015": "Template is paused (low quality)",
  "132016": "Template is disabled",
  "132018": "A template variable has line breaks or too many spaces",
  "133010": "Sender number is not registered on WhatsApp",
  "130429": "WhatsApp throughput limit reached",
  "368": "Temporarily blocked for a policy violation",
  "190": "WhatsApp access token expired or invalid",
  "100": "Invalid parameter (often the phone number)",
  "4": "Too many API calls",
  "80007": "WhatsApp Business account rate limit reached",
  "1": "Unknown Meta error",
  "2": "Meta service temporarily unavailable",
};

/** Codes where the same message may go through later. */
const TRANSIENT = new Set(["1", "2", "4", "80007", "130429", "131000", "131016", "131048", "131056", "131057", "133004"]);

export function waErrorReason(code: string | number | null | undefined, fallback?: string | null): string {
  const key = code == null ? "" : String(code);
  return WA_ERRORS[key] ?? (fallback ? fallback : key ? `WhatsApp error ${key}` : "WhatsApp error");
}

export function isTransientWaError(code: string | number | null | undefined, httpStatus?: number): boolean {
  if (httpStatus && httpStatus >= 500) return true;
  if (httpStatus === 429) return true;
  return code != null && TRANSIENT.has(String(code));
}

export interface GraphError {
  message?: string;
  code?: number;
  error_subcode?: number;
  error_user_msg?: string;
  error_data?: { details?: string };
}

/** A send response → outcome, keeping Meta's own detail where our wording is generic. */
export function describeGraphError(status: number, err: GraphError | undefined): { code: string; reason: string; transient: boolean } {
  const code = err?.code != null ? String(err.code) : `http_${status}`;
  const detail = err?.error_data?.details ?? err?.error_user_msg ?? err?.message ?? null;
  const known = WA_ERRORS[code];
  return {
    code,
    reason: (known ? (detail && !detail.startsWith("(#") ? `${known} — ${detail}` : known) : detail ?? `WhatsApp error ${status}`).slice(0, 500),
    transient: isTransientWaError(code, status),
  };
}

/* ---------------- webhooks ---------------- */

/** Meta's X-Hub-Signature-256: HMAC-SHA256 of the raw body with the app secret. Fails closed. */
export function verifyMetaSignature(appSecret: string | undefined, rawBody: string, header: string | null): boolean {
  if (!appSecret || !header || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const got = header.slice(7);
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

export function signMeta(appSecret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

const STATUS_MAP: Record<string, DeliveryStatus> = { sent: "sent", delivered: "delivered", read: "read", failed: "failed" };

export interface WaWebhook {
  object?: string;
  entry?: {
    changes?: {
      field?: string;
      value?: {
        statuses?: {
          id?: string;
          status?: string;
          timestamp?: string;
          recipient_id?: string;
          errors?: { code?: number; title?: string; message?: string; error_data?: { details?: string } }[];
        }[];
        messages?: { from?: string; timestamp?: string; type?: string; text?: { body?: string } }[];
      };
    }[];
  }[];
}

export interface InboundMessage {
  phone: string;
  at: string;
  text: string | null;
}

function tsToIso(ts: string | undefined): string {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : new Date().toISOString();
}

/** Status changes and inbound messages in one webhook call. */
export function parseWaWebhook(body: WaWebhook): { updates: StatusUpdate[]; inbound: InboundMessage[] } {
  const updates: StatusUpdate[] = [];
  const inbound: InboundMessage[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages" || !change.value) continue;
      for (const s of change.value.statuses ?? []) {
        const status = STATUS_MAP[s.status ?? ""];
        if (!s.id || !status) continue;
        const err = s.errors?.[0];
        const code = err?.code != null ? String(err.code) : null;
        updates.push({
          providerId: s.id,
          deliveryId: null,
          status,
          at: tsToIso(s.timestamp),
          ...(status === "failed"
            ? { errorCode: code ?? "failed", errorReason: waErrorReason(code, err?.error_data?.details ?? err?.title ?? err?.message) }
            : {}),
        });
      }
      for (const m of change.value.messages ?? []) {
        if (!m.from) continue;
        inbound.push({ phone: `+${m.from.replace(/\D/g, "")}`, at: tsToIso(m.timestamp), text: m.text?.body ?? null });
      }
    }
  }
  return { updates, inbound };
}

/** "STOP" and friends, in English and Arabic. */
export function isStopRequest(text: string | null): boolean {
  if (!text) return false;
  return /^\s*(stop|unsubscribe|stop all|cancel|الغاء|إلغاء|توقف|ايقاف|إيقاف)\s*[.!]?\s*$/i.test(text);
}

/** Is the free-form 24-hour window open for a number last heard from at `lastInbound`? */
export function windowOpen(lastInbound: string | null | undefined, nowMs = Date.now()): boolean {
  if (!lastInbound) return false;
  const t = Date.parse(lastInbound);
  // A few minutes of margin: the message must arrive inside the window, not just leave.
  return Number.isFinite(t) && nowMs - t < 24 * 3600_000 - 5 * 60_000;
}

/* ---------------- network ---------------- */

export async function graphRequest(
  cfg: WaConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  timeoutMs = 15_000,
): Promise<{ status: number; json: { error?: GraphError; messages?: { id: string }[]; data?: TemplateDef[]; paging?: { next?: string } } | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path.startsWith("https://") ? path : `${GRAPH_HOST}/${cfg.apiVersion}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${cfg.accessToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/** Approved (and other) templates on the WhatsApp Business Account. Read-only. */
export async function listTemplates(cfg: WaConfig): Promise<TemplateSpec[]> {
  if (!cfg.wabaId) throw new Error("WA_CLOUD_WABA_ID is not set");
  const out: TemplateSpec[] = [];
  let url: string = `${cfg.wabaId}/message_templates?limit=100&fields=name,language,status,category,components`;
  for (let page = 0; page < 5 && url; page++) {
    const { status, json } = await graphRequest(cfg, "GET", url);
    if (status >= 400 || !json) throw new Error(json?.error?.message ?? `Template list failed (${status})`);
    for (const t of json.data ?? []) out.push(describeTemplate(t));
    url = json.paging?.next ?? "";
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
}

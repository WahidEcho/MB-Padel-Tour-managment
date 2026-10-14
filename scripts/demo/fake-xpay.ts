/**
 * A fake XPay for a manual walkthrough of registration and payment on the local
 * stand-in (docs/xpay-direct.md). Never against the real XPay: it refuses any
 * non-localhost address and any key that is not sk_test_. It speaks the slice of
 * XPay's API Move Score uses (src/lib/payments/xpay.ts) and serves a tiny hosted
 * "checkout" page with test buttons, firing the signed webhooks XPay sends.
 * Nothing is charged; there is no card.
 *
 *   POST /checkout/sessions              create (Idempotency-Key: a retry gets the same session)
 *   GET  /checkout/sessions/{id}         read (Move Score reconciles with it)
 *   POST /checkout/sessions/{id}/expire  close an open page (Move Score, when its 15-minute hold ends)
 *   POST /refunds                        { paymentIntentId }: a full refund
 *   GET  /checkout/{id}                  the "checkout": Pay by card / Card declined /
 *                                        Pay later (a Fawry-style reference), then
 *                                        Reference paid / Reference expired
 *
 * Like XPay, the page itself lives 30 minutes (XPAY_SESSION_EXPIRES_AFTER_MINUTES);
 * Move Score closes it after its 15-minute hold (Pay again, or the cron in
 * /api/internal/messages/drain), so a late payment can be tried in between.
 *
 *   npm run localdb                                                       # terminal 1
 *   (set -a; . ./.env.localdb; set +a; PAYMENT_PROVIDER=xpay PUBLIC_SITE_URL=http://localhost:3077 \
 *     PUSH_DRY_RUN=1 MESSAGING_DRY_RUN=1 npx next start -p 3077)            # terminal 2 (after npm run build)
 *   npx tsx --env-file=.env.localdb scripts/demo/fake-xpay.ts             # terminal 3
 *
 * Reads XPAY_API_BASE (its own address, e.g. http://localhost:54419), XPAY_SECRET_KEY (sk_test_…)
 * and XPAY_WEBHOOK_SECRET from .env.localdb; MOVE_SCORE_URL (default http://localhost:3077) is where
 * the webhooks go. FAKE_XPAY_PAGE_MINUTES shortens the page's own lifetime for a demo.
 * Do not run it while `npm run e2e:registration` runs with XPay (that script starts its own on the same port).
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { xpaySignatureHeader } from "../../src/lib/payments/xpayWebhook";

const API = (process.env.XPAY_API_BASE ?? "").replace(/\/+$/, "");
const KEY = process.env.XPAY_SECRET_KEY ?? "";
const SECRET = process.env.XPAY_WEBHOOK_SECRET ?? "";
const MOVE_SCORE = (process.env.MOVE_SCORE_URL ?? "http://localhost:3077").replace(/\/+$/, "");
const PAGE_MS = Number(process.env.FAKE_XPAY_PAGE_MINUTES ?? 30) * 60_000;

const local = (u: string) => {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(u).hostname);
  } catch {
    return false;
  }
};
if (!API || !local(API) || !local(MOVE_SCORE) || !KEY.startsWith("sk_test_") || SECRET.length < 16) {
  console.error("fake-xpay: needs XPAY_API_BASE (localhost), XPAY_SECRET_KEY (sk_test_…) and XPAY_WEBHOOK_SECRET from .env.localdb, and a localhost MOVE_SCORE_URL.");
  process.exit(1);
}

/** open → paid | awaiting (a reference to pay later) → paid | failed; open → expired; paid → refunded. */
type Status = "open" | "awaiting" | "paid" | "failed" | "expired" | "refunded";
interface Session {
  id: string;
  amount: number;
  name: string;
  returnUrl: string;
  metadata: Record<string, string>;
  idem: string;
  status: Status;
  intent: string | null;
  createdAt: number;
  expiresAt: number;
}
const sessions = new Map<string, Session>();

function view(s: Session) {
  const paid = s.status === "paid" || s.status === "refunded";
  return {
    id: s.id,
    object: "checkout.session",
    status: paid || s.status === "awaiting" || s.status === "failed" ? "complete" : s.status === "expired" ? "expired" : "open",
    paymentStatus: paid ? "paid" : "unpaid",
    amountTotal: s.amount,
    currency: "EGP",
    metadata: s.metadata,
    paymentIntent: s.intent ? { id: s.intent, status: paid ? "SUCCEEDED" : s.status === "failed" ? "FAILED" : "PROCESSING" } : null,
    paymentIntentId: s.intent,
    url: `${API}/checkout/${s.id}`,
    expiresAt: new Date(s.expiresAt).toISOString(),
  };
}

async function sendEvent(s: Session, type: string) {
  const raw = JSON.stringify({ id: `evt_${randomUUID().replace(/-/g, "").slice(0, 24)}`, object: "event", type, livemode: false, created: Math.floor(Date.now() / 1000), data: { object: view(s) } });
  try {
    const res = await fetch(`${MOVE_SCORE}/api/webhooks/xpay`, { method: "POST", headers: { "Content-Type": "application/json", "XPay-Signature": xpaySignatureHeader(SECRET, raw) }, body: raw });
    console.log(`[fake-xpay] ${type} for ${s.id} → Move Score ${res.status} ${(await res.text()).slice(0, 120)}`);
  } catch (e) {
    console.error(`[fake-xpay] ${type} not delivered:`, e instanceof Error ? e.message : e);
  }
}

/** XPay's own expiry: an open page past its lifetime is expired (and the event sent). */
function sweep() {
  for (const s of sessions.values()) {
    if (s.status === "open" && Date.now() > s.expiresAt) {
      s.status = "expired";
      void sendEvent(s, "checkout.session.expired");
    }
  }
}
setInterval(sweep, 15_000).unref();

const money = (minor: number) => `EGP ${(minor / 100).toLocaleString("en-US")}`;
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const btn = (s: Session, action: string, label: string, cls: string) => `<form method="post" action="/checkout/${s.id}/${action}"><button class="${cls}">${label}</button></form>`;

function page(s: Session, note = ""): string {
  const back = `<p><a href="${esc(s.returnUrl)}">Back to Move Score</a></p>`;
  let body: string;
  if (s.status === "open") {
    const left = Math.max(0, Math.round((s.expiresAt - Date.now()) / 60_000));
    body = `<p class="amt">${money(s.amount)}</p>
      <p class="muted">This page stays payable for about ${left} more minutes (XPay's own lifetime). Move Score keeps your place for 15 minutes and closes this page after that.</p>
      ${note ? `<p class="note">${esc(note)}</p>` : ""}
      ${btn(s, "pay", "Pay by card (test)", "pay")}${btn(s, "decline", "Card declined (test)", "fail")}${btn(s, "later", "Pay later: get a reference (test)", "alt")}`;
  } else if (s.status === "awaiting") {
    body = `<p class="amt">${money(s.amount)}</p><p class="muted">A reference to pay later was issued (Fawry-style). Move Score waits for it.</p>
      ${btn(s, "ref-paid", "Reference paid (test)", "pay")}${btn(s, "ref-expired", "Reference expired (test)", "fail")}${back}`;
  } else {
    body = `<p class="st">This checkout is <b>${s.status}</b>.</p>${back}`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>XPay (fake) checkout</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 16px;color:#111}h1{font-size:18px}.amt{font-size:32px;font-weight:700;margin:8px 0}.muted{color:#555;font-size:14px}.note{color:#b91c1c;font-weight:600}
button{width:100%;padding:12px;border-radius:10px;border:0;font-size:16px;font-weight:600;margin-top:10px;cursor:pointer}.pay{background:#0a7d32;color:#fff}.fail{background:#eee}.alt{background:#dbeafe}.tag{display:inline-block;background:#fde68a;border-radius:6px;padding:2px 8px;font-size:12px;font-weight:600}</style></head>
<body><span class="tag">FAKE XPAY · TEST MODE · no card, no money</span><h1>${esc(s.name)}</h1>${body}</body></html>`;
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const html = (status: number, text: string) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
      res.end(text);
    };
    const url = (req.url ?? "").split("?")[0]!;
    // The hosted checkout (the payer's browser).
    const co = /^\/checkout\/(?!sessions(?:\/|$))([^/]+)(?:\/(pay|decline|later|ref-paid|ref-expired))?$/.exec(url);
    if (co) {
      const s = sessions.get(decodeURIComponent(co[1]!));
      if (!s) return html(404, "No such checkout");
      const act = co[2];
      if (req.method === "POST" && act) {
        const to = (location: string) => {
          res.writeHead(303, { Location: location });
          res.end();
        };
        if (act === "decline" && s.status === "open") return html(200, page(s, "Your card was declined. Nothing was charged: try another card."));
        if (act === "pay" && s.status === "open") {
          s.status = "paid";
          s.intent ??= `pi_test_${randomUUID().slice(0, 12)}`;
          await sendEvent(s, "checkout.session.completed");
          return to(s.returnUrl);
        }
        if (act === "later" && s.status === "open") {
          s.status = "awaiting";
          s.intent ??= `pi_test_${randomUUID().slice(0, 12)}`;
          await sendEvent(s, "checkout.session.completed");
          return to(`/checkout/${s.id}`);
        }
        if (act === "ref-paid" && s.status === "awaiting") {
          s.status = "paid";
          await sendEvent(s, "checkout.session.async_payment_succeeded");
          return to(s.returnUrl);
        }
        if (act === "ref-expired" && s.status === "awaiting") {
          s.status = "failed";
          await sendEvent(s, "checkout.session.async_payment_failed");
          return to(s.returnUrl);
        }
      }
      return html(200, page(s));
    }
    // The API (Move Score's server).
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: { code: "invalid_api_key" } });
    let body: Record<string, unknown> | null = null;
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    } catch {
      return send(400, { error: { code: "invalid_json" } });
    }
    if (req.method === "POST" && url === "/checkout/sessions") {
      const idem = String(req.headers["idempotency-key"] ?? "");
      if (!idem) return send(400, { error: { code: "idempotency_key_required" } });
      const prior = [...sessions.values()].find((s) => s.idem === idem);
      if (prior) return send(200, view(prior));
      const item = ((body?.lineItems as Record<string, unknown>[] | undefined) ?? [])[0] as { priceData?: { unitAmount?: number; currency?: string; productData?: { name?: string } }; quantity?: number } | undefined;
      const amount = Number(item?.priceData?.unitAmount) * Number(item?.quantity ?? 1);
      if (!Number.isInteger(amount) || amount < 5000 || item?.priceData?.currency !== "EGP") return send(400, { error: { code: "amount_too_small", message: "EGP 50 is the card minimum." } });
      const now = Date.now();
      const minutes = Number(body?.expiresAfterMinutes ?? 24 * 60);
      const s: Session = {
        id: `cs_test_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        amount,
        name: String(item?.priceData?.productData?.name ?? "Entry"),
        returnUrl: String((body?.afterCompletion as { redirect?: { url?: string } } | undefined)?.redirect?.url ?? MOVE_SCORE),
        metadata: (body?.metadata ?? {}) as Record<string, string>,
        idem,
        status: "open",
        intent: null,
        createdAt: now,
        expiresAt: now + Math.min(PAGE_MS, Math.max(30, minutes) * 60_000),
      };
      sessions.set(s.id, s);
      console.log(`[fake-xpay] checkout ${s.id} for ${s.metadata.registration_id ?? "?"}: ${money(s.amount)} → ${API}/checkout/${s.id}`);
      return send(200, view(s));
    }
    const one = /^\/checkout\/sessions\/([^/]+)$/.exec(url);
    if (req.method === "GET" && one) {
      const s = sessions.get(decodeURIComponent(one[1]!));
      return s ? send(200, view(s)) : send(404, { error: { code: "resource_missing" } });
    }
    const expire = /^\/checkout\/sessions\/([^/]+)\/expire$/.exec(url);
    if (req.method === "POST" && expire) {
      const s = sessions.get(decodeURIComponent(expire[1]!));
      if (!s) return send(404, { error: { code: "resource_missing" } });
      if (s.status !== "open") return send(400, { error: { code: "session_not_open" } });
      s.status = "expired";
      console.log(`[fake-xpay] ${s.id} expired by Move Score`);
      return send(200, view(s));
    }
    if (req.method === "POST" && url === "/refunds") {
      const s = [...sessions.values()].find((x) => x.intent && x.intent === body?.paymentIntentId);
      if (!s || (s.status !== "paid" && s.status !== "refunded")) return send(400, { error: { code: "charge_not_refundable" } });
      s.status = "refunded";
      console.log(`[fake-xpay] refunded ${money(s.amount)} (${s.intent})`);
      return send(200, { id: `re_test_${randomUUID().slice(0, 12)}`, status: "succeeded", paymentIntentId: s.intent, amount: s.amount });
    }
    return send(404, { error: { code: "not_found" } });
  });
});

const port = Number(new URL(API).port || 80);
server.listen(port, () => {
  console.log(`[fake-xpay] listening on ${API} (pages live ${PAGE_MS / 60_000} min); webhooks → ${MOVE_SCORE}/api/webhooks/xpay`);
});

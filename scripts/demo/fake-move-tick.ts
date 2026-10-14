/**
 * A fake Move Tick for a manual walkthrough of registration and payment on the
 * local stand-in (never against a real Move Tick: it refuses any non-localhost URL).
 * It speaks the partner API of docs/move-tick-partner-api.md and serves a tiny
 * hosted "checkout" page with test buttons, firing the signed webhooks Move Score
 * expects. Nothing is charged; there is no card.
 *
 *   POST /api/partner/v1/payment-sessions            create (Idempotency-Key; one open per reference)
 *   GET  /api/partner/v1/payment-sessions/{id}       read (Move Score reconciles with it)
 *   POST /api/partner/v1/payment-sessions/{id}/refund full refunds only
 *   GET  /checkout/{id}                              the "checkout": Pay (test) / Fail (test)
 *
 * A checkout lives 15 minutes (as Move Tick's partner checkouts: the place Move
 * Score keeps for it). Like the real one, the page is only closed by the
 * housekeeping sweep a few minutes later (5 here), so you can try a late payment:
 * after 15 minutes the page offers "Pay late (test)" until it is closed.
 *
 *   npm run localdb                                                       # terminal 1
 *   (set -a; . ./.env.localdb; set +a; PUBLIC_SITE_URL=http://localhost:3077 \
 *     PUSH_DRY_RUN=1 MESSAGING_DRY_RUN=1 npx next start -p 3077)           # terminal 2 (after npm run build)
 *   npx tsx --env-file=.env.localdb scripts/demo/fake-move-tick.ts        # terminal 3
 *
 * Reads MOVE_TICK_API_URL (its own address, e.g. http://localhost:54399), MOVE_TICK_PARTNER_KEY,
 * MOVE_TICK_WEBHOOK_SECRET from .env.localdb; MOVE_SCORE_URL (default http://localhost:3077) is
 * where the webhooks go. FAKE_MT_TTL_MINUTES / FAKE_MT_CLOSE_AFTER_MINUTES shorten the clock for a demo.
 * Do not run it while `npm run e2e:registration` runs (that script starts its own on the same port).
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { signatureHeader } from "../../src/lib/registration/signature";

const API = (process.env.MOVE_TICK_API_URL ?? "").replace(/\/+$/, "");
const KEY = process.env.MOVE_TICK_PARTNER_KEY ?? "";
const SECRET = process.env.MOVE_TICK_WEBHOOK_SECRET ?? "";
const MOVE_SCORE = (process.env.MOVE_SCORE_URL ?? "http://localhost:3077").replace(/\/+$/, "");
const TTL_MS = Number(process.env.FAKE_MT_TTL_MINUTES ?? 15) * 60_000;
const CLOSE_AFTER_MS = Number(process.env.FAKE_MT_CLOSE_AFTER_MINUTES ?? 5) * 60_000;

const local = (u: string) => {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(u).hostname);
  } catch {
    return false;
  }
};
if (!API || !local(API) || !local(MOVE_SCORE) || KEY.length < 32 || SECRET.length < 32) {
  console.error("fake-move-tick: needs MOVE_TICK_API_URL (localhost), MOVE_TICK_PARTNER_KEY and MOVE_TICK_WEBHOOK_SECRET (32+ characters) from .env.localdb, and a localhost MOVE_SCORE_URL.");
  process.exit(1);
}

type Status = "open" | "paid" | "failed" | "expired" | "refunded";
interface Session {
  sessionId: string;
  reference: string;
  amount: number;
  description: string;
  returnUrl: string;
  idem: string;
  status: Status;
  createdAt: number;
  expiresAt: number;
}
const sessions = new Map<string, Session>();

const view = (s: Session) => ({
  sessionId: s.sessionId,
  checkoutUrl: `${API}/checkout/${s.sessionId}`,
  status: s.status,
  amount: s.amount,
  currency: "EGP",
  reference: s.reference,
  expiresAt: new Date(s.expiresAt).toISOString(),
  testMode: true,
});

async function sendWebhook(s: Session, type: "payment.succeeded" | "payment.failed" | "payment.expired" | "payment.refunded") {
  const raw = JSON.stringify({
    id: `evt_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
    type,
    createdAt: new Date().toISOString(),
    data: { sessionId: s.sessionId, reference: s.reference, amount: s.amount, currency: "EGP", refundedAmount: type === "payment.refunded" ? s.amount : null, testMode: true },
  });
  try {
    const res = await fetch(`${MOVE_SCORE}/api/webhooks/move-tick`, { method: "POST", headers: { "Content-Type": "application/json", "MoveTick-Signature": signatureHeader(SECRET, raw, Date.now()) }, body: raw });
    console.log(`[fake-move-tick] ${type} for ${s.reference} → Move Score ${res.status} ${(await res.text()).slice(0, 120)}`);
  } catch (e) {
    console.error(`[fake-move-tick] ${type} not delivered:`, e instanceof Error ? e.message : e);
  }
}

/** Housekeeping, like Move Tick's cron: a page is closed a few minutes after its time ran out. */
function sweep() {
  for (const s of sessions.values()) {
    if (s.status === "open" && Date.now() > s.expiresAt + CLOSE_AFTER_MS) {
      s.status = "expired";
      void sendWebhook(s, "payment.expired");
    }
  }
}
setInterval(sweep, 15_000).unref();

const money = (minor: number) => `EGP ${(minor / 100).toLocaleString("en-US")}`;
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(s: Session): string {
  const now = Date.now();
  const late = s.status === "open" && now > s.expiresAt;
  const left = Math.max(0, Math.round((s.expiresAt - now) / 1000));
  const body =
    s.status !== "open"
      ? `<p class="st">This checkout is <b>${s.status}</b>.</p><p><a href="${esc(s.returnUrl)}">Back to Move Score</a></p>`
      : `<p class="amt">${money(s.amount)}</p>
         <p class="muted">${late ? "The place Move Score kept for this checkout has run out (15 minutes). The page is still open until Move Tick closes it: a payment now is accepted, and Move Score confirms it only if a place is still free (otherwise it is flagged for a full refund)." : `Move Score keeps your place for <b id="t">${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}</b> while this checkout is open.`}</p>
         <form method="post" action="/checkout/${s.sessionId}/pay"><button class="pay">${late ? "Pay late (test)" : "Pay (test)"}</button></form>
         <form method="post" action="/checkout/${s.sessionId}/fail"><button class="fail">Fail (test)</button></form>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Move Tick (fake) checkout</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 16px;color:#111}h1{font-size:18px}.amt{font-size:32px;font-weight:700;margin:8px 0}.muted{color:#555;font-size:14px}
button{width:100%;padding:12px;border-radius:10px;border:0;font-size:16px;font-weight:600;margin-top:10px;cursor:pointer}.pay{background:#0a7d32;color:#fff}.fail{background:#eee}.tag{display:inline-block;background:#fde68a;border-radius:6px;padding:2px 8px;font-size:12px;font-weight:600}</style></head>
<body><span class="tag">FAKE MOVE TICK · TEST MODE · no card, no money</span><h1>${esc(s.description)}</h1>${body}
${s.status === "open" && !late ? `<script>let n=${left};setInterval(()=>{n=Math.max(0,n-1);const e=document.getElementById("t");if(e)e.textContent=Math.floor(n/60)+":"+String(n%60).padStart(2,"0");if(n===0)location.reload()},1000)</script>` : ""}</body></html>`;
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? "";
    // The hosted checkout (the payer's browser).
    const co = /^\/checkout\/([^/?]+)(?:\/(pay|fail))?$/.exec(url.split("?")[0]!);
    if (co) {
      const s = sessions.get(decodeURIComponent(co[1]!));
      if (!s) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("No such checkout");
      }
      if (req.method === "POST" && co[2] && s.status === "open") {
        s.status = co[2] === "pay" ? "paid" : "failed";
        await sendWebhook(s, co[2] === "pay" ? "payment.succeeded" : "payment.failed");
        res.writeHead(303, { Location: s.returnUrl });
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page(s));
    }
    // The partner API (Move Score's server).
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { code: "UNAUTHENTICATED", error: "Bad partner key" });
    let body: Record<string, unknown> | null = null;
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    } catch {
      return send(400, { code: "INVALID_BODY" });
    }
    if (req.method === "POST" && url === "/api/partner/v1/payment-sessions") {
      const idem = String(req.headers["idempotency-key"] ?? "");
      const prior = [...sessions.values()].find((s) => s.idem === idem);
      if (prior) return send(200, view(prior));
      const reference = String(body?.reference ?? "");
      const sibs = [...sessions.values()].filter((s) => s.reference === reference);
      if (sibs.some((s) => s.status === "paid" || s.status === "refunded")) return send(409, { code: "ORDER_ALREADY_PAID", error: "This reference is already paid." });
      for (const open of sibs.filter((s) => s.status === "open")) {
        if (Date.now() <= open.expiresAt) return send(409, { code: "PAYMENT_SESSION_OPEN", error: "A checkout for this reference is still open." });
        // Lapsed: closed first (the partner told), as Move Tick does before opening another.
        open.status = "expired";
        await sendWebhook(open, "payment.expired");
      }
      const now = Date.now();
      const s: Session = { sessionId: `pts_test_${randomUUID().slice(0, 12)}`, reference, amount: Number(body?.amount), description: String(body?.description ?? "Entry"), returnUrl: String(body?.returnUrl ?? MOVE_SCORE), idem, status: "open", createdAt: now, expiresAt: now + TTL_MS };
      sessions.set(s.sessionId, s);
      console.log(`[fake-move-tick] checkout ${s.sessionId} for ${reference}: ${money(s.amount)} → ${API}/checkout/${s.sessionId}`);
      return send(201, view(s));
    }
    const one = /^\/api\/partner\/v1\/payment-sessions\/([^/]+)$/.exec(url);
    if (req.method === "GET" && one) {
      const s = sessions.get(decodeURIComponent(one[1]!));
      return s ? send(200, view(s)) : send(404, { code: "PAYMENT_NOT_FOUND" });
    }
    const refund = /^\/api\/partner\/v1\/payment-sessions\/([^/]+)\/refund$/.exec(url);
    if (req.method === "POST" && refund) {
      const s = sessions.get(decodeURIComponent(refund[1]!));
      if (!s || body?.reference !== s.reference) return send(404, { code: "PAYMENT_NOT_FOUND" });
      if (s.status === "refunded") return send(200, { refundId: `re_${s.sessionId}`, status: "refunded" });
      if (s.status !== "paid") return send(409, { code: "REFUND_PAYMENT_NOT_CHARGED" });
      if (Number(body?.amount) !== s.amount) return send(422, { code: "PARTIAL_REFUND_UNSUPPORTED" });
      s.status = "refunded";
      console.log(`[fake-move-tick] refunded ${money(s.amount)} for ${s.reference}`);
      setTimeout(() => void sendWebhook(s, "payment.refunded"), 500);
      return send(200, { refundId: `re_${s.sessionId}`, status: "refunded" });
    }
    return send(404, { code: "NOT_FOUND" });
  });
});

const port = Number(new URL(API).port || 80);
server.listen(port, () => {
  console.log(`[fake-move-tick] listening on ${API} (checkouts live ${TTL_MS / 60_000} min, closed ${CLOSE_AFTER_MS / 60_000} min later); webhooks → ${MOVE_SCORE}/api/webhooks/move-tick`);
});

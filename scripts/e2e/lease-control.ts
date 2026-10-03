/**
 * Who scores a match, end to end, with the consoles' own lease logic
 * (nextLeaseView / claimedLeaseView / createLeaseOrder from src/lib/scoringLease)
 * driven against the real routes. The regression it guards: a referee phone
 * whose install token was missing or stale saw its own lease as another
 * device's, stopped renewing, and lost control on every poll ("whenever I open
 * a match it takes control from me … I take it for 1 second and it takes it
 * from me again").
 *
 *   1. One phone, no install token: opens, claims, and keeps control across a
 *      full lease term and more (polls and renewals as the app makes them).
 *   2. The same phone re-opens the match (a second console, same device id):
 *      no fight, the lease is not re-acquired, both keep seeing it as theirs.
 *   3. A web console asks for control, the phone sends its points and hands
 *      over: the web console keeps it; the phone says "Control moved", stops
 *      renewing and never takes it back (no ping-pong), its re-claim is refused.
 *   4. A queued point is never lost: the phone loses a lapsed lease while away
 *      with an unsent point, its sync is refused (kept, not dropped), and once
 *      it holds the match again the same point is accepted.
 *
 * Stand-in only (it waits out real lease terms). Creates and deletes its own data.
 *
 *   npm run localdb                                    # another terminal
 *   npx next dev -p 3077  (env from .env.localdb)      # another terminal
 *   npx tsx --env-file=.env.localdb scripts/e2e/lease-control.ts
 */
import { randomUUID } from "crypto";
import { db } from "../../src/lib/supabase";
import { awardPoint, initialScoreState, type ScoreState } from "../../src/lib/scoring/engine";
import { DEFAULT_SCORING_CONFIG } from "../../src/lib/types";
import {
  LEASE_RENEW_MS,
  LEASE_TTL_MS,
  NO_LEASE_VIEW,
  claimedLeaseView,
  createLeaseOrder,
  nextLeaseView,
  type LeaseSideView,
  type SeenLease,
} from "../../src/lib/scoringLease";
import { BASE_URL } from "./lib/session";

if (!/localhost|127\.0\.0\.1/.test(process.env.SUPABASE_URL ?? "")) throw new Error("lease-control runs against the local stand-in only");

let failed = 0;
function check(ok: boolean, label: string, detail?: unknown) {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!ok) failed++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

/** A scoring console as the app's useLease runs it: poll, claim, renew while holding, request, answer. */
class Console {
  view: LeaseSideView = NO_LEASE_VIEW;
  order = createLeaseOrder();
  renewals = 0;
  /** Every isController seen by a poll, in order. */
  history: boolean[] = [];
  private lastRenew = 0;
  constructor(
    private matchId: string,
    readonly deviceId: string,
    readonly label: string,
    private auth: Record<string, string>,
  ) {}
  private post(action: string, body: Record<string, unknown>) {
    return call("POST", `/api/matches/${this.matchId}/${action}`, { headers: this.auth, body: { deviceId: this.deviceId, ...body } });
  }
  async change<T>(fn: () => Promise<T>) {
    this.order.changed();
    try {
      return await fn();
    } finally {
      this.order.changed();
    }
  }
  async poll() {
    const t = this.order.ask();
    // No install token: the phone is recognised by the device id its claims carry.
    const r = await call("GET", `/api/matches/${this.matchId}/state`, { headers: { "X-Device-Id": this.deviceId } });
    if (!this.order.fresh(t)) return;
    this.view = nextLeaseView(this.view, (r.json?.lease as SeenLease | null) ?? null, this.deviceId);
    this.history.push(this.view.isController);
  }
  async claim() {
    const r = await this.change(() => this.post("claim", { deviceLabel: this.label }));
    const holder = r.json?.holder as { deviceLabel?: string | null } | undefined;
    this.view = claimedLeaseView(this.view, r.json?.controller === true, holder?.deviceLabel ?? null);
    return r.json?.controller === true;
  }
  /** One app tick: poll, and renew on the heartbeat while holding. */
  async tick(now: number) {
    await this.poll();
    if (this.view.isController && now - this.lastRenew >= LEASE_RENEW_MS) {
      this.lastRenew = now;
      const r = await this.post("renew-lease", {});
      this.renewals++;
      if (r.json?.renewed === false) await this.poll();
    }
  }
  request() {
    return this.change(() => this.post("request-control", { deviceLabel: this.label }));
  }
  async respond(accept: boolean) {
    await this.change(() => this.post("respond-control", { accept }));
    await this.poll();
  }
}

/** Runs consoles side by side, one tick a second, for `ms`. */
async function run(ms: number, consoles: Console[]) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (const c of consoles) await c.tick(Date.now());
    await sleep(1_000);
  }
}

async function main() {
  const tag = randomUUID().slice(0, 6);
  const { data: t } = await db()
    .from("tournaments")
    .insert({ name: `E2E Lease ${tag}`, slug: `e2e-lease-${tag}`, sport: "padel", kind: "tournament", status: "active", format_config: { type: "group_knockout" } })
    .select("*")
    .single();
  const tid = t!.id as string;
  try {
    const { data: teams } = await db()
      .from("teams")
      .insert([
        { tournament_id: tid, team_name: "Reds", seed_number: 1 },
        { tournament_id: tid, team_name: "Blues", seed_number: 2 },
      ])
      .select("*");
    const [ra, rb] = teams!;
    const { data: m } = await db()
      .from("matches")
      .insert({ tournament_id: tid, stage: "group", round_name: "Group A", match_order: 1, team_a_id: ra!.id, team_b_id: rb!.id, status: "scheduled" })
      .select("*")
      .single();
    const mid = m!.id as string;
    const staff = await call("POST", "/api/mobile/v1/staff/session", { body: { code: process.env.REFEREE_PASSWORD } });
    check(staff.status === 200, "The referee code gives a token");
    const auth = { Authorization: `Bearer ${staff.json!.token}` };

    // ---- 1. one phone, no install token, keeps control
    const phone = new Console(mid, `ios-${randomUUID()}`, "iPhone · app", auth);
    await phone.poll();
    check(await phone.claim(), "The phone opens the match and takes control");
    phone.history = [];
    await run(LEASE_TTL_MS + 5_000, [phone]);
    check(phone.history.length >= 8 && phone.history.every(Boolean), "It keeps control on every poll across a full lease term and more (no install token)", phone.history.map(Number).join(""));
    check(phone.renewals >= 3, "It keeps renewing while it holds the match", phone.renewals);
    const picker = await call("GET", `/api/mobile/v1/referee/tournaments/${tid}/matches`, { headers: { ...auth, "X-Device-Id": phone.deviceId } });
    const row = (picker.json?.matches as { id: string; heldBy: { heldByYou?: boolean } | null }[] | undefined)?.find((x) => x.id === mid);
    check(row?.heldBy?.heldByYou === true, "The match list says this phone holds it", row?.heldBy);
    const pub = await call("GET", `/api/matches/${mid}/state`);
    check(!JSON.stringify(pub.json).includes(phone.deviceId) && (pub.json?.lease as SeenLease).heldByYou === false, "The public state still shows only a handle");
    const guess = await call("GET", `/api/matches/${mid}/state`, { headers: { "X-Device-Id": `ios-${randomUUID()}` } });
    check((guess.json?.lease as SeenLease).heldByYou === false && !JSON.stringify(guess.json).includes(phone.deviceId), "Another device id is not told it holds the match, nor shown the phone's id");

    // ---- 2. the same phone re-opens the match
    const { data: before } = await db().from("scoring_leases").select("acquired_at").eq("match_id", mid).single();
    const again = new Console(mid, phone.deviceId, phone.label, auth);
    await again.poll();
    check(again.view.isController, "Re-opened, the same phone sees the match as its own before claiming");
    check(await again.claim(), "Its re-claim succeeds");
    const { data: after } = await db().from("scoring_leases").select("acquired_at").eq("match_id", mid).single();
    check(before!.acquired_at === after!.acquired_at, "It is the same lease, not a new acquisition");
    phone.history = [];
    again.history = [];
    await run(6_000, [phone, again]);
    check([...phone.history, ...again.history].every(Boolean), "Both screens of the one phone keep control: it never fights itself");

    // ---- 3. a web console asks; the phone sends its points and hands over
    let state: ScoreState = initialScoreState("A");
    let n = 0;
    const ev = (type: string, prev: ScoreState | null, next: ScoreState, team: string | null) => ({
      client_event_id: randomUUID(),
      event_number: ++n,
      event_type: type,
      team_id: team,
      previous_state: prev,
      new_state: next,
      payload: type === "MATCH_STARTED" ? { first_server: "A" } : null,
      created_at_client: new Date().toISOString(),
    });
    const start = ev("MATCH_STARTED", null, state, null);
    const p1Next = awardPoint(state, "A", DEFAULT_SCORING_CONFIG);
    const p1 = ev("POINT_AWARDED", state, p1Next, ra!.id);
    state = p1Next;
    const sent = await call("POST", `/api/matches/${mid}/events`, { headers: auth, body: { deviceId: phone.deviceId, events: [start, p1] } });
    check(sent.status === 200 && sent.json?.last_event_number === 2, "The phone's points reach the server while it holds the match", sent.json?.last_event_number);

    const web = new Console(mid, randomUUID(), "Web console", auth);
    await web.poll();
    check(web.view.heldByOther && !web.view.isController, "The web console opens read-only");
    check(!(await web.claim()), "A second device cannot just claim a held match");
    const asked = await web.request();
    check(asked.status === 200, "The web console asks for control", asked.json);
    await phone.poll();
    check(phone.view.incomingRequest?.deviceLabel === "Web console", "The phone sees the request", phone.view.incomingRequest);
    await phone.respond(true);
    await web.poll();
    check(web.view.isController && web.view.gained === 1, "The web console holds the match after the handover");
    check(!phone.view.isController && phone.view.lostTo === "Web console", "The phone says control moved to the web console", phone.view);

    phone.history = [];
    web.history = [];
    const renewalsBefore = phone.renewals;
    await run(LEASE_TTL_MS + 3_000, [phone, web]);
    check(web.history.every(Boolean), "The web console keeps control across a full lease term (no ping-pong)", web.history.map(Number).join(""));
    check(phone.history.every((x) => !x), "The phone never takes it back", phone.history.map(Number).join(""));
    check(phone.renewals === renewalsBefore, "The phone stopped renewing", phone.renewals - renewalsBefore);
    check(phone.view.lostTo === "Web console", "It keeps saying where control went");
    const steal = await phone.claim();
    check(!steal && phone.view.lostTo === "Web console", "Back from the background, its re-claim is refused, never a steal");
    const stale = await call("POST", `/api/matches/${mid}/renew-lease`, { headers: auth, body: { deviceId: phone.deviceId } });
    check(stale.json?.renewed === false, "A late renewal from the old holder changes nothing");
    await web.poll();
    check(web.view.isController, "The web console still holds the match after that late renewal");

    // ---- 4. a queued point is never lost
    await web.change(() => call("POST", `/api/matches/${mid}/release-lease`, { headers: auth, body: { deviceId: web.deviceId } }));
    check(await phone.claim(), "Released, the phone takes the match back");
    const p2Next = awardPoint(state, "B", DEFAULT_SCORING_CONFIG);
    const p2 = ev("POINT_AWARDED", state, p2Next, rb!.id);
    // The phone goes out of signal with p2 queued; its lease runs out and the web console takes the free match.
    await sleep(LEASE_TTL_MS + 1_000);
    check(await web.claim(), "The lapsed lease goes to the web console");
    const refused = await call("POST", `/api/matches/${mid}/events`, { headers: auth, body: { deviceId: phone.deviceId, events: [p2] } });
    check(refused.status === 409 && (refused.json?.conflict as string) === "device_lock", "The phone's queued point is refused while it does not hold the match (kept on the phone)");
    const { count: none } = await db().from("score_events").select("id", { count: "exact", head: true }).eq("client_event_id", p2.client_event_id);
    check(none === 0, "Nothing of it was stored");
    await phone.poll();
    check(phone.view.lostTo === "Web console", "The phone says control moved");
    await phone.request();
    await web.poll();
    await web.respond(true);
    await phone.poll();
    check(phone.view.isController && phone.view.lostTo === null, "Asked and handed back, the phone holds the match again");
    const resent = await call("POST", `/api/matches/${mid}/events`, { headers: auth, body: { deviceId: phone.deviceId, events: [p2] } });
    check(resent.status === 200 && resent.json?.last_event_number === 3, "The same queued point is accepted: nothing lost", resent.json);
  } finally {
    await db().from("tournaments").delete().eq("id", tid);
  }
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

void main();

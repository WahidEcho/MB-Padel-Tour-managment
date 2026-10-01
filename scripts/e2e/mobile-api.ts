/**
 * The Move Score app's API, end to end: a phone registers, follows a nation,
 * a referee signs in with the code and scores a rubber through the hardened
 * events route, the alert outbox fills, the shadow check catches a bad point,
 * and the pass unlocks with the venue code. Creates and deletes its own data.
 *
 *   npm run localdb                         # in another terminal
 *   npx tsx --env-file=.env.localdb scripts/e2e/mobile-api.ts
 */
import { randomUUID } from "crypto";
import { db } from "../../src/lib/supabase";
import { awardPoint, initialScoreState, type ScoreState } from "../../src/lib/scoring/engine";
import { DEFAULT_SCORING_CONFIG } from "../../src/lib/types";
import { rotatingCode } from "../../src/lib/pass/venueCode";
import { BASE_URL } from "./lib/session";

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
  const json = await res.json().catch(() => null);
  return { status: res.status, json, cache: res.headers.get("cache-control") ?? "" };
}

async function main() {
  const tag = randomUUID().slice(0, 6);
  // ---- fixtures
  const { data: group } = await db().from("event_groups").insert({ slug: `e2e-${tag}`, name: `E2E Finals ${tag}`, featured_rank: 1, country_code: null }).select("*").single();
  const { data: t } = await db()
    .from("tournaments")
    .insert({
      name: `E2E App ${tag}`,
      slug: `e2e-app-${tag}`,
      sport: "tennis",
      kind: "tournament",
      status: "active",
      public_access_enabled: true,
      format_config: { type: "group_knockout", ties: { rubbers: ["S2", "S1", "D"] } },
      event_group_id: group!.id,
      timezone: "Africa/Cairo",
      venue_name: "Smash Sporting Club",
      city: "Cairo",
    })
    .select("*")
    .single();
  const tid = t!.id as string;
  try {
    const { data: teams } = await db()
      .from("teams")
      .insert([
        { tournament_id: tid, team_name: "Egypt", nation_code: "EGY", iso2: "eg", seed_number: 1, phone: "+201000000000", notes: "private note" },
        { tournament_id: tid, team_name: "Japan", nation_code: "JPN", iso2: "jp", seed_number: 2 },
      ])
      .select("*");
    const egy = teams!.find((x) => x.nation_code === "EGY")!;
    const jpn = teams!.find((x) => x.nation_code === "JPN")!;
    const { data: players } = await db()
      .from("players")
      .insert([
        { tournament_id: tid, team_id: egy.id, full_name: "Adam Hassan", player_order: 1 },
        { tournament_id: tid, team_id: jpn.id, full_name: "Jun Sato", player_order: 1 },
      ])
      .select("*");
    const pA = players!.find((p) => p.team_id === egy.id)!;
    const pB = players!.find((p) => p.team_id === jpn.id)!;
    const { data: court } = await db().from("courts").insert({ tournament_id: tid, court_name: "Court 1", court_order: 1 }).select("*").single();
    const { data: tie } = await db()
      .from("ties")
      .insert({ tournament_id: tid, stage: "group", round_no: 1, tie_order: 1, team_a_id: egy.id, team_b_id: jpn.id, court_id: court!.id, status: "live" })
      .select("*")
      .single();
    const { data: rubber } = await db()
      .from("matches")
      .insert({
        tournament_id: tid,
        stage: "group",
        round_name: "Group A · S1",
        match_order: 1,
        court_id: court!.id,
        team_a_id: egy.id,
        team_b_id: jpn.id,
        status: "scheduled",
        tie_id: tie!.id,
        rubber_no: 1,
        rubber_type: "S1",
        team_a_player_ids: [pA.id],
        team_b_player_ids: [pB.id],
      })
      .select("*")
      .single();
    const mid = rubber!.id as string;

    // ---- public reads
    const disc = await call("GET", "/api/mobile/v1/discover?demo=0");
    const featured = disc.json?.featured?.find((g: { id: string }) => g.id === group!.id);
    check(disc.status === 200 && Boolean(featured), "Discover shows the featured event group", featured?.tournaments?.length);
    check(/s-maxage=30/.test(disc.cache), "Discover is shareable at the CDN", disc.cache);
    const bundle = await call("GET", `/api/mobile/v1/t/${t!.slug}/bundle`);
    check(bundle.status === 200 && bundle.json.teams.length === 2, "Bundle has both nations");
    check(!JSON.stringify(bundle.json).includes("+2010") && !JSON.stringify(bundle.json).includes("private note"), "Bundle carries no phone or notes");
    check(bundle.json.tournament.isTies === true && bundle.json.teams[0].iso2 !== undefined, "Bundle knows it is a nations event, with flags");

    // ---- a phone registers and follows Egypt
    const installationId = `e2e-${randomUUID()}`;
    const reg = await call("POST", "/api/mobile/v1/devices", { body: { installationId, platform: "ios", expoPushToken: `ExponentPushToken[e2e${tag}abcdefghij]`, appVersion: "1.0.0" } });
    check(reg.status === 200 && typeof reg.json.installToken === "string", "A phone registers without an account");
    const inst = { "x-install-token": reg.json.installToken as string };
    const fol = await call("POST", "/api/mobile/v1/me/follows", { headers: inst, body: { add: [{ kind: "nation", key: "EGY", tournamentId: tid }, { kind: "match", key: mid, tournamentId: tid }] } });
    check(fol.status === 200 && fol.json.follows.length === 2, "It follows Egypt and stars the rubber", fol.json?.follows?.length);
    check(/no-store/.test(fol.cache), "Personal answers are never cached", fol.cache);
    const forged = await call("GET", "/api/mobile/v1/me/follows", { headers: { "x-install-token": `${installationId}.forged` } });
    check(forged.status === 401, "A forged install token is refused");

    // ---- referee
    const wrong = await call("POST", "/api/mobile/v1/staff/session", { body: { code: "not-the-code" } });
    check(wrong.status === 401, "A wrong referee code is refused");
    const staff = await call("POST", "/api/mobile/v1/staff/session", { body: { code: process.env.REFEREE_PASSWORD } });
    check(staff.status === 200 && staff.json.role === "referee", "The referee code gives a referee token");
    const ref = { Authorization: `Bearer ${staff.json.token}` };
    const boot = await call("GET", `/api/mobile/v1/referee/matches/${mid}/bootstrap`, { headers: ref });
    check(boot.status === 200 && boot.json.tennis === true && boot.json.sideA?.name?.includes("Hassan"), "Bootstrap gives rules and the nominated sides", boot.json?.sideA?.name);
    const noAuth = await call("GET", `/api/mobile/v1/referee/matches/${mid}/bootstrap`);
    check(noAuth.status === 403, "Bootstrap needs the referee token");

    const deviceId = `phone-${tag}`;
    const claim = await call("POST", `/api/matches/${mid}/claim`, { headers: ref, body: { deviceId, deviceLabel: "E2E phone" } });
    check(claim.status === 200 && claim.json.controller === true, "The phone takes control of the free rubber");
    const config = { ...DEFAULT_SCORING_CONFIG };
    let state: ScoreState = initialScoreState("A");
    let n = 0;
    const event = (type: string, prev: ScoreState | null, next: ScoreState, teamId: string | null = null, payload: Record<string, unknown> | null = null) => ({
      client_event_id: randomUUID(),
      event_number: ++n,
      event_type: type,
      team_id: teamId,
      previous_state: prev,
      new_state: next,
      payload,
      created_at_client: new Date().toISOString(),
    });
    const batch = [event("MATCH_STARTED", null, state, null, { first_server: "A" })];
    for (const w of ["A", "A", "B", "A"] as const) {
      const next = awardPoint(state, w, config);
      batch.push(event("POINT_AWARDED", state, next, w === "A" ? egy.id : jpn.id));
      state = next;
    }
    const sync = await call("POST", `/api/matches/${mid}/events`, { headers: ref, body: { deviceId, events: batch } });
    check(sync.status === 200 && sync.json.last_event_number === 5, "Five events sync in one batch", sync.json?.last_event_number);
    const replay = await call("POST", `/api/matches/${mid}/events`, { headers: ref, body: { deviceId, events: batch } });
    check(replay.status === 200 && replay.json.applied.length === 0, "Re-sending the same batch changes nothing");

    const bad = await call("POST", `/api/matches/${mid}/events`, { headers: ref, body: { deviceId, events: [{ ...event("POINT_AWARDED", state, state, "intruder"), event_number: 6 }] } });
    check(bad.status === 400, "A point for a team not in the match is refused before anything is stored", bad.json?.error);
    n = 5;
    const typeBad = await call("POST", `/api/matches/${mid}/events`, { headers: ref, body: { deviceId, events: [event("DROP_EVERYTHING", state, state)] } });
    check(typeBad.status === 400, "An unknown event type is refused");
    n = 5;
    // A point whose state the engine would not produce: stored (shadow mode), and logged.
    const lie = { ...state, teamB: { ...state.teamB, games: state.teamB.games + 3 } };
    const lieRes = await call("POST", `/api/matches/${mid}/events`, { headers: ref, body: { deviceId, events: [event("POINT_AWARDED", state, lie, egy.id)] } });
    check(lieRes.status === 200, "Shadow mode stores a disagreeing point rather than stalling the phone");
    state = lie;

    // Another phone cannot score while this one holds the rubber.
    const other = await call("POST", `/api/matches/${mid}/events`, { headers: ref, body: { deviceId: "intruder-phone", events: [{ ...event("POINT_AWARDED", state, awardPoint(state, "A", config), egy.id) }] } });
    check(other.status === 409 && other.json.conflict === "device_lock", "A second phone is held off by the lease");
    n--;

    // Heal: snapshot made to lag behind the stored events, as after a failed request.
    await db().from("match_score_snapshots").update({ last_event_number: 3 }).eq("match_id", mid);
    const next = awardPoint(state, "B", config);
    const healed = await call("POST", `/api/matches/${mid}/events`, { headers: ref, body: { deviceId, events: [event("POINT_AWARDED", state, next, jpn.id)] } });
    check(healed.status === 200 && healed.json.last_event_number === 7, "A snapshot left behind by a failed request is healed, not stuck", healed.json);
    state = next;

    await sleep(2500);
    const { data: mism } = await db().from("audit_logs").select("new_value").eq("action", "SCORE_SHADOW_MISMATCH").eq("entity_id", mid);
    check((mism ?? []).length >= 1, "The shadow check logged the disagreeing point", (mism ?? [])[0]?.new_value);
    const { data: outbox } = await db().from("notification_events").select("kind, payload, dedupe_key").eq("match_id", mid);
    const live = (outbox ?? []).find((r) => r.kind === "match_live");
    check(Boolean(live), "Starting the rubber put a 'live now' alert in the outbox", live?.payload?.title);
    check(Boolean(live?.payload?.targets?.some((x: { kind: string; key: string }) => x.kind === "match" && x.key === mid)), "The alert targets the starred rubber");

    // Delivery: the outbox resolves to this phone exactly once (Expo itself is not called here).
    const { recipientsFor } = await import("../../src/lib/notify/drain");
    const phones = await recipientsFor(live?.payload?.targets ?? [], "live");
    check(phones.length === 0, "'Live' alerts are off by default, so the phone is not alerted", phones.length);
    const finishedPhones = await recipientsFor([{ kind: "nation", key: "EGY" }, { kind: "match", key: mid }], "finished");
    check(finishedPhones.length === 1, "Following the nation and starring the match still makes one phone, once", finishedPhones.length);

    const liveFeed = await call("GET", `/api/mobile/v1/t/${t!.slug}/live`);
    const m = liveFeed.json.matches.find((x: { id: string }) => x.id === mid);
    check(m?.status === "live" && m.score?.points != null, "The live feed shows the rubber live with its points", m?.score);
    check(/s-maxage=2/.test(liveFeed.cache), "The live feed is cached for two seconds at the CDN", liveFeed.cache);
    const tl = await call("GET", `/api/mobile/v1/matches/${mid}/timeline`);
    check(tl.status === 200 && tl.json.points.length === 6, "The timeline has the six points that stand", tl.json?.points?.length);

    // ---- pass
    const pass = await call("POST", "/api/mobile/v1/me/pass", { headers: inst, body: { group: group!.id, holderName: "E2E Fan", nationCode: "EGY" } });
    check(pass.status === 200 && pass.json.pass.serial >= 1 && pass.json.pass.edition === "spectator", "A spectator pass opens with a serial", pass.json?.pass?.serial);
    check(pass.json.pass.pins.includes("EGY"), "Following Egypt earned the Egypt pin");
    const expired = await call("POST", "/api/mobile/v1/passes/unlock", { headers: inst, body: { groupSlug: group!.slug, code: "AAAAAAAA" } });
    check(expired.status === 400, "A wrong venue code does not unlock");
    const unlock = await call("POST", "/api/mobile/v1/passes/unlock", { headers: inst, body: { groupSlug: group!.slug, code: rotatingCode(group!.slug) } });
    check(unlock.status === 200 && unlock.json.pass.onsiteUnlockedAt && unlock.json.pass.stamps.length === 1, "The venue code unlocks the on-site edition and stamps today", unlock.json?.stampedDay);
    const staffPass = await call("POST", "/api/mobile/v1/me/pass", {
      headers: { "x-install-token": (await call("POST", "/api/mobile/v1/devices", { body: { installationId: `e2e-${randomUUID()}`, platform: "android" } })).json.installToken, "x-staff-token": staff.json.token },
      body: { group: group!.id },
    });
    check(staffPass.json?.pass?.edition === "staff" && staffPass.json.pass.staffRole === "referee", "A referee's phone gets the accreditation edition");

    // ---- cheers
    const cheer = await call("POST", `/api/mobile/v1/ties/${tie!.id}/cheer`, { headers: inst, body: { nation: "EGY", n: 12 } });
    const cheers = await call("GET", `/api/mobile/v1/ties/${tie!.id}/cheers`);
    check(cheer.status === 200 && cheers.json.cheers.find((c: { nation: string }) => c.nation === "EGY")?.count === 12, "Cheers add up on the tie's crowd meter");

    // ---- schedule change → alert
    const { scheduleTie } = await import("../../src/lib/tennis/tieOps");
    await scheduleTie(tie!.id, court!.id, "2026-11-04T13:30:00.000Z", "admin");
    await sleep(300);
    const { data: sched } = await db().from("notification_events").select("kind, payload, fire_at").eq("tie_id", tie!.id);
    const s = (sched ?? []).find((r) => r.kind === "tie_scheduled" || r.kind === "tie_rescheduled");
    check(Boolean(s) && /15:30/.test(s!.payload.body), "Scheduling the tie queues an alert in Cairo time", s?.payload?.body);
  } finally {
    await db().from("tournaments").delete().eq("id", tid);
    await db().from("event_groups").delete().eq("id", group!.id);
    await db().from("push_devices").delete().like("installation_id", "e2e-%");
    await db().from("follows").delete().like("owner_id", "e2e-%");
  }
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

void main();

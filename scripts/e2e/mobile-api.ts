/**
 * The Move Score app's API, end to end: a phone registers, follows a nation,
 * a referee signs in with the code and scores a rubber through the hardened
 * events route, the alert outbox fills, the shadow check catches a bad point,
 * the pass unlocks with the venue code (always the attendee's, never a referee's),
 * fans check in to matches for points, and the Apple Wallet route answers. Creates
 * and deletes its own data.
 *
 *   npm run localdb                         # in another terminal
 *   npx tsx --env-file=.env.localdb scripts/e2e/mobile-api.ts
 */
import { createHash, createHmac, randomUUID } from "crypto";
import { db } from "../../src/lib/supabase";
import { awardPoint, initialScoreState, type ScoreState } from "../../src/lib/scoring/engine";
import { DEFAULT_SCORING_CONFIG } from "../../src/lib/types";
import { matchPrintedCode, matchScreenCode, rotatingCode } from "../../src/lib/pass/venueCode";
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
    check(String(reg.json.installToken).split(".").length === 3, "Its token carries a server-chosen nonce");
    const inst = { "x-install-token": reg.json.installToken as string };
    const hijack = await call("POST", "/api/mobile/v1/devices", { body: { installationId, platform: "android" } });
    check(hijack.status === 409 && hijack.json.code === "install_taken", "Nobody else can register a known installation id for a token", hijack.status);
    const oldFormat = `${installationId}.${createHmac("sha256", process.env.AUTH_SECRET!).update(`install:${installationId}`).digest("base64url")}`;
    const stale = await call("POST", "/api/mobile/v1/devices", { headers: { "x-install-token": oldFormat }, body: { installationId, platform: "ios" } });
    check(stale.status === 409, "An old-format token no longer re-registers its id (the app starts over with a fresh one)", stale.status);
    const oldMe = await call("GET", "/api/mobile/v1/me/follows", { headers: { "x-install-token": oldFormat } });
    check(oldMe.status === 401, "An old-format token is refused on personal routes");
    // Signed out: a re-registration with the phone's own token and no session unlinks the account.
    await db().from("push_devices").update({ user_id: randomUUID() }).eq("installation_id", installationId);
    const again = await call("POST", "/api/mobile/v1/devices", { headers: inst, body: { installationId, platform: "ios", expoPushToken: `ExponentPushToken[e2e${tag}abcdefghij]`, appVersion: "1.0.1" } });
    const { data: unlinked } = await db().from("push_devices").select("user_id, app_version").eq("installation_id", installationId).single();
    check(again.status === 200 && again.json.installToken === inst["x-install-token"], "The phone re-registers with its own token", again.status);
    check(unlinked?.user_id === null && unlinked?.app_version === "1.0.1", "Re-registering without a session unlinks the phone from the account", unlinked);
    // ---- the Account alerts switch
    const pushToken = async () => (await db().from("push_devices").select("expo_push_token").eq("installation_id", installationId).single()).data?.expo_push_token ?? null;
    check(reg.json.tokenAccepted === true && again.json.tokenAccepted === true, "The server says it kept the phone's push token", reg.json.tokenAccepted);
    const badToken = await call("POST", "/api/mobile/v1/devices", { headers: inst, body: { installationId, platform: "ios", expoPushToken: "not-a-push-token", alerts: true } });
    check(badToken.status === 200 && badToken.json.tokenAccepted === false, "A malformed push token is reported, not silently dropped", badToken.json);
    check((await pushToken()) === `ExponentPushToken[e2e${tag}abcdefghij]`, "...and the phone's good token stays");
    const quiet = await call("POST", "/api/mobile/v1/devices", { headers: inst, body: { installationId, platform: "ios", expoPushToken: null, alerts: true } });
    check(quiet.status === 200 && quiet.json.tokenAccepted === null && (await pushToken()) !== null, "A launch without a token (alerts still on) keeps the token", quiet.json);
    const offSwitch = await call("POST", "/api/mobile/v1/devices", { headers: inst, body: { installationId, platform: "ios", expoPushToken: `ExponentPushToken[e2e${tag}abcdefghij]`, alerts: false } });
    check(offSwitch.status === 200 && (await pushToken()) === null, "Switching alerts off forgets the phone's push token", offSwitch.json);
    const onSwitch = await call("POST", "/api/mobile/v1/devices", { headers: inst, body: { installationId, platform: "ios", expoPushToken: `ExponentPushToken[e2e${tag}abcdefghij]`, alerts: true } });
    check(onSwitch.json?.tokenAccepted === true && (await pushToken()) === `ExponentPushToken[e2e${tag}abcdefghij]`, "Switching alerts back on registers the token again");
    const prefsSet = await call("PATCH", "/api/mobile/v1/me/prefs", { headers: inst, body: { live: true, major: false } });
    const prefsGot = await call("GET", "/api/mobile/v1/me/prefs", { headers: inst });
    check(prefsSet.status === 200 && prefsGot.json?.prefs?.live === true && prefsGot.json?.prefs?.major === false && prefsGot.json?.prefs?.finished === true, "Alert types are saved for the phone", prefsGot.json);
    check((await call("GET", "/api/mobile/v1/me/prefs")).status === 401, "Alert types need the phone's install token");
    await call("PATCH", "/api/mobile/v1/me/prefs", { headers: inst, body: {} }); // back to the defaults for the alert checks below
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

    // The app scores under its installation id, as the real console does.
    const deviceId = installationId;
    const claim = await call("POST", `/api/matches/${mid}/claim`, { headers: ref, body: { deviceId, deviceLabel: "E2E phone" } });
    check(claim.status === 200 && claim.json.controller === true, "The phone takes control of the free rubber");
    const mine = await call("GET", `/api/matches/${mid}/state`, { headers: inst });
    check(mine.json?.lease?.deviceId === installationId && mine.json.lease.heldByYou === true, "The holding phone sees its own id in the match state", mine.json?.lease);
    const publicState = await call("GET", `/api/matches/${mid}/state`);
    check(
      publicState.status === 200 && !JSON.stringify(publicState.json).includes(installationId) && publicState.json.lease?.heldByYou === false,
      "The public match state shows a handle, never the phone's installation id",
      publicState.json?.lease?.deviceId,
    );
    const picker = await call("GET", `/api/mobile/v1/referee/tournaments/${tid}/matches`, { headers: { ...ref, ...inst } });
    const pick = picker.json?.matches?.find((x: { id: string }) => x.id === mid);
    check(pick?.heldBy?.deviceId === installationId && pick.heldBy.heldByYou === true, "The referee picker tells this phone it holds the rubber", pick?.heldBy);
    const otherPicker = await call("GET", `/api/mobile/v1/referee/tournaments/${tid}/matches`, { headers: ref });
    check(!JSON.stringify(otherPicker.json).includes(installationId), "Another referee's picker shows a handle, not the installation id");
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
    check(
      staffPass.status === 200 && staffPass.json?.pass?.edition === "spectator" && staffPass.json.pass.staffRole === null,
      "A phone signed in to the referee console still gets the attendee's pass, never a referee accreditation",
      staffPass.json?.pass?.edition,
    );
    // A pass an older server turned into an accreditation is served as the attendee's.
    await db().from("event_passes").update({ edition: "staff", staff_role: "referee" }).eq("id", pass.json.pass.id);
    const oldStaff = await call("GET", `/api/mobile/v1/me/pass?group=${group!.id}`, { headers: inst });
    check(oldStaff.json?.pass?.edition === "spectator" && oldStaff.json.pass.staffRole === null, "Every pass reads as the attendee's");

    // ---- match check-in (court TV code, printed code), points and the pass's list
    const now = Date.now();
    const wrongCode = await call("POST", `/api/mobile/v1/matches/${mid}/checkin`, { headers: inst, body: { c: "AAAAAAAA" } });
    check(wrongCode.status === 400 && wrongCode.json.code === "bad_code", "A wrong match code is refused", wrongCode.json);
    const oldCode = await call("POST", `/api/mobile/v1/matches/${mid}/checkin`, { headers: inst, body: { c: matchScreenCode(mid, now - 5 * 60_000) } });
    check(oldCode.status === 410 && oldCode.json.code === "code_expired", "A court TV code from five minutes ago has expired", oldCode.json);
    const tvQr = await call("GET", `/api/matches/${mid}/checkin-qr`);
    check(tvQr.json?.open === true && String(tvQr.json.url).includes(`/m/${mid}?c=`) && String(tvQr.json.svg).startsWith("<svg"), "The court TV gets the live rubber's check-in QR", tvQr.json?.url);
    check(/no-store/.test(tvQr.cache), "The TV's check-in code is never cached");
    const tvCode = new URL(tvQr.json.url).searchParams.get("c")!;
    const checkin = await call("POST", `/api/mobile/v1/matches/${mid}/checkin`, { headers: inst, body: { c: tvCode } });
    check(checkin.status === 200 && checkin.json.status === "checked_in" && checkin.json.points === 10, "Scanning the court TV checks the pass in to the live rubber for 10 points", checkin.json?.points);
    const att = checkin.json?.pass?.attendance;
    check(att?.matches === 1 && att.points === 10 && att.list[0]?.matchId === mid && /singles/i.test(att.list[0].label) && att.list[0].a?.code === "EGY", "The pass lists the match attended and its score", att?.list?.[0]);
    const twice = await call("POST", `/api/mobile/v1/matches/${mid}/checkin`, { headers: inst, body: { c: tvCode } });
    check(twice.status === 200 && twice.json.status === "already_checked_in" && twice.json.pass.attendance.points === 10, "Scanning again says already checked in and adds nothing");
    const noPhone = await call("POST", `/api/mobile/v1/matches/${mid}/checkin`, { body: { c: tvCode } });
    check(noPhone.status === 401, "Check-in needs a registered phone");

    // A final whose other rubbers are 1-1: the deciding doubles is worth 10 + 10 + 5.
    const { data: finalTie } = await db()
      .from("ties")
      .insert({ tournament_id: tid, stage: "placement", round_no: 3, tie_order: 1, round_name: "Final", places_from: 1, places_to: 2, team_a_id: egy.id, team_b_id: jpn.id, court_id: court!.id, status: "live" })
      .select("*")
      .single();
    const finalRubber = (no: number, type: string, extra: Record<string, unknown>) => ({ tournament_id: tid, stage: "placement", round_name: `Final · ${type}`, match_order: no, team_a_id: egy.id, team_b_id: jpn.id, tie_id: finalTie!.id, rubber_no: no, rubber_type: type, ...extra });
    const { data: finalRubbers } = await db()
      .from("matches")
      .insert([
        finalRubber(1, "S2", { status: "completed", winner_team_id: egy.id, ended_at: new Date(now - 3 * 3600_000).toISOString() }),
        finalRubber(2, "S1", { status: "completed", winner_team_id: jpn.id, ended_at: new Date(now - 2 * 3600_000).toISOString() }),
        finalRubber(3, "D", { status: "live" }),
      ])
      .select("id, rubber_type");
    const s2 = finalRubbers!.find((r) => r.rubber_type === "S2")!.id as string;
    const dbl = finalRubbers!.find((r) => r.rubber_type === "D")!.id as string;
    const decider = await call("POST", `/api/mobile/v1/matches/${dbl}/checkin`, { headers: inst, body: { p: matchPrintedCode(dbl) } });
    check(decider.status === 200 && decider.json.points === 25 && decider.json.parts.length === 3, "The printed code at the final's deciding doubles is worth 25", decider.json?.parts);
    check(decider.json?.pass?.attendance?.matches === 2 && decider.json.pass.attendance.points === 35, "The pass now shows 2 matches and 35 points", decider.json?.pass?.attendance);
    const late = await call("POST", `/api/mobile/v1/matches/${s2}/checkin`, { headers: inst, body: { p: matchPrintedCode(s2) } });
    check(late.status === 409 && late.json.code === "closed", "A rubber that ended hours ago is closed for check-in", late.json);
    const { data: later } = await db()
      .from("matches")
      .insert({ tournament_id: tid, stage: "group", round_name: "Group A · S2", match_order: 9, team_a_id: egy.id, team_b_id: jpn.id, status: "scheduled", scheduled_time: new Date(now + 3 * 3600_000).toISOString() })
      .select("id")
      .single();
    const early = await call("POST", `/api/mobile/v1/matches/${later!.id}/checkin`, { headers: inst, body: { p: matchPrintedCode(later!.id) } });
    check(early.status === 409 && early.json.code === "too_early" && typeof early.json.opensAt === "string", "A match three hours away is too early, with the time check-in opens", early.json);
    const closedQr = await call("GET", `/api/matches/${later!.id}/checkin-qr`);
    check(closedQr.json?.open === false, "The TV gets no code for a match that isn't on");

    // ---- wallet
    const cfgReply = await call("GET", "/api/mobile/v1/config");
    check(cfgReply.json?.flags?.apple_wallet === true && cfgReply.json.walletReady?.apple === false, "Config shows the Apple Wallet badge and says the server can't sign passes here", cfgReply.json?.walletReady);
    const head = await fetch(`${BASE_URL}/api/mobile/v1/passes/${pass.json.pass.id}/apple`, { method: "HEAD" });
    check(head.status === 503, "Without certificates the Apple pass route says 'not set up' (the app shows a calm note)", head.status);
    const headMissing = await fetch(`${BASE_URL}/api/mobile/v1/passes/${randomUUID()}/apple`, { method: "HEAD" });
    check(headMissing.status === 404, "An unknown pass is not found");

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

    // ---- player codes (needs the stand-in's sign-in keys: npm run localdb)
    await playerCodes({ tid, slug: t!.slug, egyId: egy.id, pA, mid, inst });
  } finally {
    await db().from("tournaments").delete().like("slug", "e2e-codes-%");
    await db().from("request_counters").delete().like("bucket_key", "pcode:%");
    await db().from("request_counters").delete().like("bucket_key", "pphoto:%");
    await db().from("tournaments").delete().eq("id", tid);
    await db().from("event_groups").delete().eq("id", group!.id);
    await db().from("push_devices").delete().like("installation_id", "e2e-%");
    await db().from("follows").delete().like("owner_id", "e2e-%");
  }
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

/**
 * A signed-in app user from the stand-in's sign-in (scripts/localdb/auth.mjs):
 * its PKCE round trip, one test person per email. Null against a real project.
 */
async function userToken(email: string): Promise<string | null> {
  const auth = `${process.env.SUPABASE_URL}/auth/v1`;
  const verifier = randomUUID() + randomUUID();
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const start = `${auth}/authorize?provider=google&redirect_to=${encodeURIComponent("movescore://auth/callback")}&code_challenge=${challenge}&code_challenge_method=s256&login_hint=${encodeURIComponent(email)}`;
  const hop = await fetch(start, { redirect: "manual" }).catch(() => null);
  const code = hop?.headers.get("location") ? new URL(hop.headers.get("location")!).searchParams.get("code") : null;
  if (!code) return null;
  const res = await fetch(`${auth}/token?grant_type=pkce`, { method: "POST", body: JSON.stringify({ auth_code: code, code_verifier: verifier }) }).catch(() => null);
  if (!res?.ok) return null;
  return ((await res.json()) as { access_token: string }).access_token;
}

/**
 * Player codes: every player has one; a signed-in phone claims it and sees the
 * player's matches; the same person in another tournament comes along (same name
 * and phone) but a sibling on the parent's phone does not; phone and photo
 * updates; one account per player; brute force is stopped; an admin reset
 * unlinks; nothing private reaches public feeds or pages.
 */
async function playerCodes(ctx: { tid: string; slug: string; egyId: string; pA: { id: string }; mid: string; inst: Record<string, string> }) {
  const userA = `e2e.adam.${randomUUID().slice(0, 6)}@example.com`;
  const userB = `e2e.other.${randomUUID().slice(0, 6)}@example.com`;
  const tokA = await userToken(userA);
  const tokB = await userToken(userB);
  if (!tokA || !tokB) {
    console.log("⚠️  Skipping player codes: this database cannot mint test sign-ins (run against npm run localdb).");
    return;
  }
  const asA = { ...ctx.inst, authorization: `Bearer ${tokA}` };
  const asB = { authorization: `Bearer ${tokB}` };
  const { ACCESS_CODE_ALPHABET, formatAccessCode, isValidAccessCode } = await import("../../src/lib/players/accessCode");
  const { resetPlayerCode } = await import("../../src/lib/players/claims");

  await db().from("players").update({ phone: "+201001234567", email: "adam@example.com" }).eq("id", ctx.pA.id);
  const { data: row } = await db().from("players").select("access_code").eq("id", ctx.pA.id).single();
  const code = row!.access_code as string;
  check(isValidAccessCode(code), "A new player gets an 8-character code by default", code);

  // The same Adam in last year's event (same name and phone), and his brother on the same phone.
  const tag2 = `e2e-codes-${randomUUID().slice(0, 6)}`;
  const { data: t2 } = await db().from("tournaments").insert({ name: `E2E Codes ${tag2}`, slug: tag2, sport: "tennis", kind: "tournament", status: "completed" }).select("*").single();
  const { data: team2 } = await db().from("teams").insert({ tournament_id: t2!.id, team_name: "Egypt", nation_code: "EGY", iso2: "eg" }).select("*").single();
  const { data: p2 } = await db()
    .from("players")
    .insert([
      { tournament_id: t2!.id, team_id: team2!.id, full_name: "adam  hassan", player_order: 1, phone: "+201001234567" },
      { tournament_id: t2!.id, team_id: team2!.id, full_name: "Omar Hassan", player_order: 2, phone: "+201001234567" },
    ])
    .select("*");
  const adam2 = p2!.find((p) => p.player_order === 1)!;
  const omar = p2!.find((p) => p.player_order === 2)!;
  check(adam2.access_code !== code && isValidAccessCode(adam2.access_code), "Each tournament's row has its own code");

  // Nothing private in public feeds or pages.
  const bundle = await call("GET", `/api/mobile/v1/t/${ctx.slug}/bundle`);
  const pub = JSON.stringify(bundle.json);
  check(!pub.includes(code) && !pub.includes("+201001234567") && !pub.includes("adam@example.com"), "The app bundle carries no player code, phone or email");
  const page = await fetch(`${BASE_URL}/t/${ctx.slug}`).then((r) => r.text());
  check(!page.includes(code) && !page.includes("201001234567"), "The public tournament page carries no player code or phone");

  // Claim.
  const guest = await call("POST", "/api/mobile/v1/me/player/claim", { headers: ctx.inst, body: { code } });
  check(guest.status === 401, "A guest phone is asked to sign in first", guest.status);
  const wrongCode = [...code].map((c) => (c === "2" ? "3" : "2")).join("");
  const wrong = await call("POST", "/api/mobile/v1/me/player/claim", { headers: asA, body: { code: wrongCode } });
  check(wrong.status === 400 && /didn't work/.test(wrong.json?.error), "A wrong code gets the generic answer", wrong.json?.error);
  const typed = formatAccessCode(code).toLowerCase();
  const started = Date.now();
  const claim = await call("POST", "/api/mobile/v1/me/player/claim", { headers: asA, body: { code: `Your code: ${typed}` } });
  check(claim.status === 200 && claim.json.player.name === "Adam Hassan", "The code, pasted in lower case inside a message, links Adam", claim.json?.player?.name ?? claim.json);
  check(Date.now() - started >= 340, "The claim answer takes its fixed minimum time");
  check(/no-store/.test(claim.cache), "The profile is never cached", claim.cache);
  const entries = (claim.json?.player?.entries ?? []) as { playerId: string; timezone: string }[];
  check(entries.length === 2 && entries.some((e) => e.playerId === adam2.id) && !entries.some((e) => e.playerId === omar.id), "Adam's row in the other tournament is linked; his brother on the same phone is not", entries.map((e) => e.playerId));
  check(claim.json?.linked === 2, "The claim reports two linked rows", claim.json?.linked);
  const rubber = (claim.json?.player?.matches ?? []).find((m: { id: string }) => m.id === ctx.mid);
  check(rubber?.aName === "Egypt" && rubber?.mySide === "A" && rubber?.tournamentSlug === ctx.slug, "His matches include the rubber, with names and his side", rubber && { a: rubber.aName, side: rubber.mySide });
  check(claim.json?.player?.phone === "+201001234567" && claim.json?.player?.iso2 === "eg", "He sees his phone and nation");
  const again = await call("POST", "/api/mobile/v1/me/player/claim", { headers: asA, body: { code } });
  check(again.status === 200, "Entering the same code again is harmless");

  // Profile, phone, photo.
  const me = await call("GET", "/api/mobile/v1/me/player", { headers: asA });
  check(me.status === 200 && me.json.player.playerId === ctx.pA.id, "GET /me/player returns the linked player");
  const noUser = await call("GET", "/api/mobile/v1/me/player", { headers: ctx.inst });
  check(noUser.status === 401, "GET /me/player needs a signed-in account");
  const phone = await call("PATCH", "/api/mobile/v1/me/player", { headers: asA, body: { phone: "0100 765 4321" } });
  check(phone.status === 200 && phone.json.player.phone === "+201007654321", "His phone is saved in E.164", phone.json?.player?.phone);
  const { data: both } = await db().from("players").select("phone").in("id", [ctx.pA.id, adam2.id]);
  check((both ?? []).every((r) => r.phone === "+201007654321"), "…on every linked row");
  const badPhone = await call("PATCH", "/api/mobile/v1/me/player", { headers: asA, body: { phone: "call me" } });
  check(badPhone.status === 400, "A phone that is not a number is refused", badPhone.json?.error);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 7), Buffer.from([0xff, 0xd9])]).toString("base64");
  const photo = await call("POST", "/api/mobile/v1/me/player/photo", { headers: asA, body: { image: jpeg } });
  check(photo.status === 200 && /\/media\/players\/self\//.test(photo.json?.player?.photoUrl ?? "") && /\/render\/image\/|\.jpg/.test(photo.json.player.photoUrl), "A JPEG photo is stored and shown", photo.json?.player?.photoUrl ?? photo.json);
  const fake = await call("POST", "/api/mobile/v1/me/player/photo", { headers: asA, body: { image: Buffer.from("<svg onload=alert(1)>").toString("base64") } });
  check(fake.status === 400, "A file that is not a photo is refused", fake.json?.error);
  const huge = await call("POST", "/api/mobile/v1/me/player/photo", { headers: asA, body: { image: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1_600_000)]).toString("base64") } });
  check(huge.status === 400 || huge.status === 413, "A photo over the size limit is refused", huge.status);

  // One account per player; brute force stops.
  const stolen = await call("POST", "/api/mobile/v1/me/player/claim", { headers: asB, body: { code } });
  check(stolen.status === 409, "A second account cannot take a linked player", stolen.json?.error);
  let last = 0;
  for (let i = 0; i < 8; i++) {
    const guess = Array.from({ length: 8 }, (_, j) => ACCESS_CODE_ALPHABET[(i * 7 + j * 3) % ACCESS_CODE_ALPHABET.length]).join("");
    last = (await call("POST", "/api/mobile/v1/me/player/claim", { headers: asB, body: { code: guess } })).status;
  }
  const blocked = await call("POST", "/api/mobile/v1/me/player/claim", { headers: asB, body: { code: omar.access_code } });
  check(last === 400 && blocked.status === 429, "After eight wrong codes the account is stopped, even with a right one", blocked.status);

  // Admin page shows the code and the share links.
  const { sessionToken, COOKIE_NAME } = await import("./lib/session");
  const admin = await fetch(`${BASE_URL}/admin/tournaments/${ctx.tid}/players`, { headers: { cookie: `${COOKIE_NAME}=${sessionToken("admin")}` } });
  const html = await admin.text();
  check(admin.status === 200 && html.includes(formatAccessCode(code)) && html.includes("wa.me/201007654321") && html.includes("Linked"), "The admin Player codes page lists the code, a WhatsApp link to his number and that he is linked", admin.status);

  // Reset: the old code dies, the account lets go of everything that code linked.
  const fresh = await resetPlayerCode(ctx.pA.id);
  check(fresh !== code && isValidAccessCode(fresh), "Reset makes a new code");
  const after = await call("GET", "/api/mobile/v1/me/player", { headers: asA });
  check(after.status === 200 && after.json.player === null, "Reset unlinks the account from this player and the rows its code linked", after.json?.player?.entries?.length);
  const old = await call("POST", "/api/mobile/v1/me/player/claim", { headers: asA, body: { code } });
  check(old.status === 400, "The old code no longer works");
  const relink = await call("POST", "/api/mobile/v1/me/player/claim", { headers: asA, body: { code: fresh } });
  check(relink.status === 200, "The new code links again");
  const unlink = await call("DELETE", "/api/mobile/v1/me/player", { headers: asA });
  const gone = await call("GET", "/api/mobile/v1/me/player", { headers: asA });
  check(unlink.status === 200 && gone.json.player === null, "'Not you? Unlink' lets go of the player");
  const { data: photoLeft } = await db().from("players").select("photo_url").eq("id", ctx.pA.id).single();
  check(!photoLeft?.photo_url, "…and removes the photo the player uploaded");

  // Sign-in no longer asks for an age.
  const signin = await call("POST", "/api/mobile/v1/auth/session", { body: { provider: "google", idToken: "x.y.z" } });
  check(signin.status !== 400 || !/16/.test(signin.json?.error ?? ""), "Sign-in no longer refuses for want of an age confirmation", signin.json?.error);
}

void main();

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
    const stageRules = bundle.json.rules;
    check(
      typeof stageRules?.base?.setsToWinMatch === "number" && typeof stageRules?.stages?.final?.gamesToWinSet === "number" && Array.isArray(stageRules?.plateBrackets) && stageRules?.stages?.final?.stageOverrides === undefined,
      "Bundle carries the rules per stage, resolved (no stored overrides)",
      stageRules?.stages?.final,
    );
    check(bundle.json.sides?.redBlue === false && bundle.json.sides?.A?.short === "RED" && bundle.json.sides?.B?.short === "BLUE", "Bundle carries the red/blue sides, off by default", bundle.json.sides);
    // Match day (migration 0022): a tournament never saved reads as off; saved rules reach the bundle, sanitised.
    const md = bundle.json.tournament.matchDay;
    check(md?.on === false && md?.showcase === false && md?.courtCall === false, "Bundle carries matchDay, off until the tab is saved", md);
    await db()
      .from("tournaments")
      .update({ match_day_rules: { configured: true, courtCall: { on: true, minutes: 99 }, noShow: { maxExtensions: 9 }, secret: "x" }, updated_at: new Date().toISOString() })
      .eq("id", tid);
    await sleep(10_500); // the bundle is memoised for 10 s
    const mdBundle = await call("GET", `/api/mobile/v1/t/${t!.slug}/bundle`);
    const md2 = mdBundle.json?.tournament?.matchDay;
    check(md2?.on === true && md2?.courtCall === true && md2?.callMinutes === 30 && md2?.showcase === true, "Saved match-day rules reach the bundle, minutes clamped", md2);
    check(!JSON.stringify(mdBundle.json).includes("secret") && md2?.noShow === undefined, "The bundle carries only the public match-day switches", Object.keys(md2 ?? {}));

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
    check(prefsGot.json?.prefs?.court === true, "Court calls are on by default", prefsGot.json?.prefs);
    // An app that predates a kind must not reset it: kinds left out keep their saved values.
    await call("PATCH", "/api/mobile/v1/me/prefs", { headers: inst, body: { court: false } });
    const merged = await call("PATCH", "/api/mobile/v1/me/prefs", { headers: inst, body: { finished: false, bogus: true } });
    check(merged.json?.prefs?.court === false && merged.json?.prefs?.live === true && merged.json?.prefs?.major === false && merged.json?.prefs?.finished === false && merged.json?.prefs?.bogus === undefined, "A prefs change merges with what is saved (unknown kinds ignored)", merged.json?.prefs);
    // back to the defaults for the alert checks below
    await call("PATCH", "/api/mobile/v1/me/prefs", { headers: inst, body: { scheduled: true, starting: true, live: false, finished: true, tie: true, major: true, court: true } });
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
    check(
      boot.json?.matchDay?.courtCall?.minutes === 30 && boot.json?.matchDay?.noShow?.maxExtensions === 5 && boot.json?.scoringMode === "either",
      "Bootstrap gives the referee the full match-day rules and how to record the match",
      { courtCall: boot.json?.matchDay?.courtCall, scoringMode: boot.json?.scoringMode },
    );
    check(
      boot.json && "call" in boot.json && (boot.json.call === null || typeof boot.json.call?.status === "string") && boot.json.legs === 1,
      "Bootstrap carries the call to court (for the app's call card) and the chess legs",
      { call: boot.json?.call, legs: boot.json?.legs },
    );
    const noAuth = await call("GET", `/api/mobile/v1/referee/matches/${mid}/bootstrap`);
    check(noAuth.status === 401, "Bootstrap needs the referee token (401: signed out)", noAuth.status);

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

    // ---- live courts hero (one shared read: the featured event's courts on its live day, nothing private)
    await liveCourtsHero({ tid, tag, courtId: court!.id, tieId: tie!.id, mid, egyId: egy.id, jpnId: jpn.id, pA: pA.id, pB: pB.id });

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
    await scheduleTie(tie!.tournament_id, tie!.id, court!.id, "2026-11-04T13:30:00.000Z", "admin");
    await sleep(300);
    const { data: sched } = await db().from("notification_events").select("kind, payload, fire_at").eq("tie_id", tie!.id);
    const s = (sched ?? []).find((r) => r.kind === "tie_scheduled" || r.kind === "tie_rescheduled");
    check(Boolean(s) && /15:30/.test(s!.payload.body), "Scheduling the tie queues an alert in Cairo time", s?.payload?.body);

    // ---- player codes (needs the stand-in's sign-in keys: npm run localdb)
    await playerCodes({ tid, slug: t!.slug, egyId: egy.id, pA, mid, inst });

    // ---- Phase 1: phone codes, email match, organiser offers, merging, organisations
    await playerIdentity({ tid, tag, egyId: egy.id, jpnId: jpn.id, inst });
    // ---- Phase 1 security review (0026): each finding's exploit, refused
    await identityHardening({ tid, tag, egyId: egy.id, jpnId: jpn.id, inst });
  } finally {
    // Profiles linking made from the test's entries (and the identity fixtures) go too.
    const { data: linkedProfiles } = await db().from("players").select("player_profile_id").in("tournament_id", [tid, ...((await db().from("tournaments").select("id").like("slug", "e2e-codes-%")).data ?? []).map((x) => x.id as string)]);
    const madeProfiles = [...new Set(((linkedProfiles ?? []) as { player_profile_id: string | null }[]).map((r) => r.player_profile_id).filter((x): x is string => Boolean(x)))];
    await db().from("tournaments").delete().like("slug", "e2e-codes-%");
    await db().from("tournaments").delete().like("slug", "e2e-ident-%");
    await db().from("organizations").delete().like("slug", "e2e-ident-%");
    await db().from("request_counters").delete().like("bucket_key", "otp:%");
    await db().from("request_counters").delete().like("bucket_key", "sugg:%");
    await db().from("request_counters").delete().like("bucket_key", "pcode:%");
    await db().from("request_counters").delete().like("bucket_key", "pphoto:%");
    await db().from("tournaments").delete().eq("id", tid);
    // Merged-away fixtures first (a merged profile points at its survivor), then what linking made.
    await db().from("player_profiles").delete().like("public_name", `% E2E ${tag}`);
    if (madeProfiles.length) await db().from("player_profiles").delete().in("id", madeProfiles);
    await db().from("event_groups").delete().eq("id", group!.id);
    await db().from("push_devices").delete().like("installation_id", "e2e-%");
    await db().from("follows").delete().like("owner_id", "e2e-%");
  }
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

/** The user id inside a Supabase access token (the stand-in's), without verifying it: test bookkeeping only. */
function subOf(token: string | null): string | null {
  try {
    return JSON.parse(Buffer.from(String(token).split(".")[1] ?? "", "base64url").toString("utf8")).sub ?? null;
  } catch {
    return null;
  }
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
/**
 * The live courts hero (GET /api/mobile/v1/courts/live). Runs while the S1 rubber is live on
 * Court 1 of the featured event: a second match is called to Court 2, a player is given a phone,
 * an email and a linked profile (with its mobile number and a photo), and the answer must carry
 * the courts, scores, sides, faces and the call, and not one private value.
 */
async function liveCourtsHero(o: { tid: string; tag: string; courtId: string; tieId: string; mid: string; egyId: string; jpnId: string; pA: string; pB: string }) {
  const { data: court2 } = await db().from("courts").insert({ tournament_id: o.tid, court_name: "Court 2", court_order: 2 }).select("id").single();
  const { data: called } = await db()
    .from("matches")
    .insert({ tournament_id: o.tid, stage: "group", round_name: "Group A · Exhibition", match_order: 5, court_id: court2!.id, team_a_id: o.egyId, team_b_id: o.jpnId, status: "ready", team_a_player_ids: [o.pA], team_b_player_ids: [o.pB] })
    .select("id")
    .single();
  const now = Date.now();
  const mobile = `+2015${String(parseInt(o.tag, 16)).padStart(8, "0").slice(0, 8)}`;
  const { data: profile } = await db()
    .from("player_profiles")
    .insert({ public_name: `E2E Hero ${o.tag}`, mobile_normalized: mobile, email: `hero-${o.tag}@example.com`, notes: "profile private note", photo_url: "https://e2e.example/hero.jpg" })
    .select("id")
    .single();
  try {
    const { error: callErr } = await db().from("match_calls").insert({
      match_id: called!.id,
      tournament_id: o.tid,
      court_id: court2!.id,
      called_at: new Date(now - 60_000).toISOString(),
      deadline_at: new Date(now + 4 * 60_000).toISOString(),
      a_present_at: new Date(now - 30_000).toISOString(),
      status: "called",
      called_by_role: "referee",
      device_id: `e2e-device-${o.tag}`,
    });
    check(!callErr, "A match is called to Court 2 (match_calls)", callErr?.message);
    await db().from("players").update({ phone: "+201234567890", email: `jun-${o.tag}@example.com`, player_profile_id: profile!.id }).eq("id", o.pB);
    await db().from("tournaments").update({ app_skin: { showPhotos: true } }).eq("id", o.tid);
    const { data: codes } = await db().from("players").select("access_code").in("id", [o.pA, o.pB]);

    const hero = await call("GET", "/api/mobile/v1/courts/live");
    type HeroEvent = { tournament: { id: string; slug: string; featured: boolean; isTies: boolean; showPhotos: boolean; imAtCourt?: boolean }; courts: { name: string }[]; matches: { id: string; status: string; score: { points: unknown } | null }[]; ties: { id: string }[]; teams: { players: { id: string; photoUrl: string | null; focalX: number }[] }[]; calls: { matchId: string; presentA: boolean; presentB: boolean; deadlineAt: string }[] };
    const events = (hero.json?.events ?? []) as HeroEvent[];
    const ev = events.find((e) => e.tournament.id === o.tid);
    check(hero.status === 200 && Boolean(ev), "The live courts hero carries the featured event on its live day", events.map((e) => e.tournament.slug));
    check(/s-maxage=2/.test(hero.cache), "The hero is shared at the CDN like the live feed", hero.cache);
    check(ev?.tournament.featured === true && ev.tournament.isTies === true && ev.tournament.showPhotos === true, "It knows the event is featured, a nations event, and shows photos", ev?.tournament);
    check(typeof ev?.tournament.imAtCourt === "boolean", "It says whether players can mark themselves at court (the called card's button)", ev?.tournament.imAtCourt);
    check(JSON.stringify(ev?.courts.map((c) => c.name)) === JSON.stringify(["Court 1", "Court 2"]), "Both courts, in court order", ev?.courts);
    const rubber = ev?.matches.find((m) => m.id === o.mid);
    check(rubber?.status === "live" && rubber.score?.points != null, "The live rubber is there with its score", rubber?.score);
    check(Boolean(ev?.ties.some((x) => x.id === o.tieId)), "The tie on Court 1 is there for the tie score");
    const heroCall = ev?.calls.find((c) => c.matchId === called!.id);
    check(heroCall?.presentA === true && heroCall.presentB === false && typeof heroCall.deadlineAt === "string", "The open call reaches the hero, with who is at court", heroCall);
    const { heroCards } = await import("../../src/lib/tv/showcase");
    const scenes = ev ? Object.fromEntries(heroCards([ev as never], Date.now()).map((c) => [c.court.name, c.scene.kind])) : {};
    check(scenes["Court 1"] === "live" && scenes["Court 2"] === "called", "On the phone: Court 1 live, Court 2 called to court", scenes);
    const jun = ev?.teams.flatMap((tm) => tm.players).find((p) => p.id === o.pB);
    check(jun?.photoUrl === "https://e2e.example/hero.jpg" && typeof jun.focalX === "number", "A linked profile's photo shows on the hero, with its focal point", jun);

    const text = JSON.stringify(hero.json);
    const secrets = ["+201000000000", "private note", "+201234567890", `jun-${o.tag}@example.com`, `hero-${o.tag}@example.com`, mobile, `e2e-device-${o.tag}`, ...((codes ?? []) as { access_code: string | null }[]).map((c) => c.access_code ?? "").filter(Boolean)];
    const leaked = secrets.filter((v) => text.includes(v));
    check(leaked.length === 0, "The hero carries no phone, email, access code, mobile number, note or device", leaked);
    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          keys.add(k);
          walk(x);
        }
      }
    };
    walk(hero.json);
    const privateKeys = ["phone", "email", "access_code", "accessCode", "mobile_normalized", "notes", "device_id", "player_profile_id", "player_profiles", "called_by_role", "answer"].filter((k) => keys.has(k));
    check(privateKeys.length === 0, "No private field name anywhere in the hero", privateKeys);
    check((await call("GET", "/api/mobile/v1/courts/live?demo=yes")).status === 400, "A malformed demo switch is refused");

    // The organiser switches the showcase off on the Match day tab: the event leaves the hero.
    const { data: before } = await db().from("tournaments").select("match_day_rules").eq("id", o.tid).single();
    await db().from("tournaments").update({ match_day_rules: { configured: true, showcase: { on: false } } }).eq("id", o.tid);
    await sleep(1_700); // the hero is memoised for 1.5 s
    const off = await call("GET", "/api/mobile/v1/courts/live");
    check(off.status === 200 && !((off.json?.events ?? []) as HeroEvent[]).some((e) => e.tournament.id === o.tid), "Switching the showcase off takes the event off the hero");
    await db().from("tournaments").update({ match_day_rules: before?.match_day_rules ?? {} }).eq("id", o.tid);
  } finally {
    await db().from("matches").delete().eq("id", called!.id);
    await db().from("courts").delete().eq("id", court2!.id);
    await db().from("players").update({ phone: null, email: null, player_profile_id: null }).eq("id", o.pB);
    await db().from("tournaments").update({ app_skin: {} }).eq("id", o.tid);
    await db().from("player_profiles").delete().eq("id", profile!.id);
  }
}

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

  // A profile an earlier, interrupted run made from Adam's entry would hold his number: best-effort tidy.
  await db().from("player_profiles").delete().eq("mobile_normalized", "+201001234567").eq("public_name", "Adam Hassan");
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

  // Phase 1: the code is now stored hashed (and sealed for the organiser), the plain copy gone;
  // the player had no profile, so one was made from his entry and speaks for this account.
  const { hashPlayerCode, openPlayerCode } = await import("../../src/lib/players/codeVault");
  const { data: stored } = await db().from("players").select("access_code, access_code_hash, access_code_sealed, player_profile_id").eq("id", ctx.pA.id).single();
  check(stored?.access_code === null && stored?.access_code_hash === hashPlayerCode(code) && openPlayerCode(stored?.access_code_sealed) === code, "Once used, the code is kept only as a keyed hash (and sealed for the organiser)", { plain: stored?.access_code, hashed: Boolean(stored?.access_code_hash) });
  const { data: madeProfile } = await db().from("player_profiles").select("id, public_name, mobile_normalized, email, auth_user_id").eq("id", stored?.player_profile_id ?? randomUUID()).maybeSingle();
  check(madeProfile?.public_name === "Adam Hassan" && madeProfile.mobile_normalized === "+201001234567" && madeProfile.auth_user_id === subOf(tokA), "Linking made his player profile from the entry (name, E.164 phone) and it speaks for his account", madeProfile && { name: madeProfile.public_name, mobile: madeProfile.mobile_normalized, linked: madeProfile.auth_user_id === subOf(tokA) });
  const { data: adam2Now } = await db().from("players").select("player_profile_id").eq("id", adam2.id).single();
  check(adam2Now?.player_profile_id === madeProfile?.id, "His row in the other tournament joined the same profile");
  const { data: rel } = await db().from("organization_players").select("source").eq("player_profile_id", madeProfile?.id ?? randomUUID());
  check((rel ?? []).length === 1 && rel![0]!.source === "tournament", "The organisation of his entries has the new profile as its own player", rel);
  const prof = await call("GET", "/api/mobile/v1/me/profile", { headers: asA });
  const pr = prof.json?.profile;
  check(
    prof.status === 200 && pr?.linked === true && pr.name === "Adam Hassan" && pr.tournaments?.length === 2 && JSON.stringify(pr.comingSoon) === JSON.stringify(["leagues", "points", "ranks"]),
    "GET /me/profile: his tournaments, and leagues/points/ranks still to come (no sample data)",
    pr && { tournaments: pr.tournaments?.length, comingSoon: pr.comingSoon },
  );
  check(pr?.tournaments?.every((t: { organization: { slug: string } | null }) => t.organization?.slug === "move-beyond") && /no-store/.test(prof.cache), "…each with its organisation, never cached", pr?.tournaments?.map((t: { organization: unknown }) => t.organization));
  check((await call("GET", "/api/mobile/v1/me/profile", { headers: ctx.inst })).status === 401, "GET /me/profile needs a signed-in account");

  // Profile, phone, photo.
  const me = await call("GET", "/api/mobile/v1/me/player", { headers: asA });
  check(me.status === 200 && me.json.player.playerId === ctx.pA.id, "GET /me/player returns the linked player");
  const noUser = await call("GET", "/api/mobile/v1/me/player", { headers: ctx.inst });
  check(noUser.status === 401, "GET /me/player needs a signed-in account");
  const phone = await call("PATCH", "/api/mobile/v1/me/player", { headers: asA, body: { phone: "0100 765 4321" } });
  check(phone.status === 200 && phone.json.player.phone === "+201007654321", "His phone is saved in E.164", phone.json?.player?.phone);
  const { data: both } = await db().from("players").select("phone, self_reported_phone").in("id", [ctx.pA.id, adam2.id]);
  check((both ?? []).length === 2 && (both ?? []).every((r) => r.self_reported_phone === "+201007654321" && r.phone === "+201001234567"), "…as his own number on every linked row; the organiser's record (which phone codes look up) is untouched", both);
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
  check(admin.status === 200 && html.includes(formatAccessCode(code)) && html.includes("wa.me/201001234567") && html.includes("Linked"), "The admin Player codes page lists the code, a WhatsApp link to his number and that he is linked", admin.status);
  check(/data-testid="self-reported-phone"[^>]*>[^<]*\+20 100 765 4321/.test(html), "…and the number he gave in the app, marked as not checked");

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

  await playerCodeSignIn({ ...ctx, code: fresh, omarCode: omar.access_code as string, omarId: omar.id as string, adam2Id: adam2.id as string });

  // Sign-in no longer asks for an age.
  const signin = await call("POST", "/api/mobile/v1/auth/session", { body: { provider: "google", idToken: "x.y.z" } });
  check(signin.status !== 400 || !/16/.test(signin.json?.error ?? ""), "Sign-in no longer refuses for want of an age confirmation", signin.json?.error);
}

/**
 * Signing in with a player code (no sign-up): the code makes a player-code account
 * linked to the player; it moves to a new phone until the player registers; the
 * player completes registration with an email + password (confirmation email,
 * confirm page) and keeps the same account; afterwards the code no longer signs
 * in; a code linked to a registered account is refused; a wrong code is generic.
 */
async function playerCodeSignIn(ctx: { inst: Record<string, string>; pA: { id: string }; code: string; omarCode: string; omarId: string; adam2Id: string }) {
  const made: string[] = [];
  const auth = `${process.env.SUPABASE_URL}/auth/v1`;
  const mailTo = async (to: string) => {
    const r = await fetch(`${auth}/_localdb/mail?to=${encodeURIComponent(to)}`);
    return r.ok ? ((await r.json()) as { kind: string; link: string; otp: string }[]).at(-1) ?? null : null;
  };
  try {
    const started = Date.now();
    const wrong = await call("POST", "/api/mobile/v1/auth/player-code", { headers: ctx.inst, body: { code: "ZZZZ-2222" } });
    check(wrong.status === 400 && /didn't work/.test(wrong.json?.error ?? "") && Date.now() - started >= 340, "Code sign-in: a wrong code gets the generic answer, in the fixed minimum time", wrong.json?.error);

    const a = await call("POST", "/api/mobile/v1/auth/player-code", { headers: ctx.inst, body: { code: ctx.code.toLowerCase() } });
    if (a.json?.userId) made.push(a.json.userId);
    check(
      a.status === 200 && a.json?.provider === "player_code" && a.json?.registrationComplete === false && a.json?.displayName === "Adam Hassan" && !!a.json?.refreshToken,
      "The player code alone signs Adam in, with his name, and registration still to complete",
      { status: a.status, provider: a.json?.provider, name: a.json?.displayName, error: a.json?.error },
    );
    check(a.json?.player?.playerId === ctx.pA.id && a.json?.linked === 2, "…and links his player (and his row in the other tournament) like a claim", a.json?.linked);
    const asA = { Authorization: `Bearer ${a.json?.accessToken}` };
    const { data: anonProfile } = await db().from("player_profiles").select("public_name, auth_user_id").eq("auth_user_id", a.json?.userId ?? randomUUID()).maybeSingle();
    check(anonProfile?.public_name === "Adam Hassan", "The code-only account speaks for his player profile too", anonProfile);
    const anonSugg = await call("GET", "/api/mobile/v1/me/player/suggestions", { headers: asA });
    check(anonSugg.status === 200 && anonSugg.json?.suggestions?.length === 0, "A code-only account (no confirmed email) gets no email suggestions", anonSugg.json);
    const meA = await call("GET", "/api/mobile/v1/me", { headers: asA });
    check(meA.status === 200 && meA.json?.user?.registrationComplete === false && meA.json?.user?.provider === "player_code", "GET /me: registration not complete", meA.json?.user);
    const playerA = await call("GET", "/api/mobile/v1/me/player", { headers: asA });
    check(playerA.json?.player?.name === "Adam Hassan" && !!playerA.json?.player?.phone, "His player profile (name, phone) is there without signing up", playerA.json?.player?.phone);

    // Another phone, before he registered: the link moves to a new account there.
    const b = await call("POST", "/api/mobile/v1/auth/player-code", { body: { code: ctx.code } });
    if (b.json?.userId) made.push(b.json.userId);
    const leftA = await call("GET", "/api/mobile/v1/me/player", { headers: asA });
    check(b.status === 200 && b.json?.userId !== a.json?.userId && leftA.json?.player === null, "On a second phone before registering, the code signs in again and the player moves to that account", { status: b.status, firstStill: leftA.json?.player?.name ?? null });
    const { data: movedProfile } = await db().from("player_profiles").select("auth_user_id").eq("public_name", "Adam Hassan").eq("auth_user_id", b.json?.userId ?? randomUUID()).maybeSingle();
    check(Boolean(movedProfile), "…and so does his player profile");
    const asB = { Authorization: `Bearer ${b.json?.accessToken}` };

    // Complete the registration.
    const email = `e2e.adam.${randomUUID().slice(0, 6)}@example.com`;
    const weak = await call("POST", "/api/mobile/v1/auth/complete", { headers: asB, body: { email, password: "adam" } });
    check(weak.status === 400 && weak.json?.code === "weak_password", "Completing registration enforces the password rules", weak.json?.error);
    const noSession = await call("POST", "/api/mobile/v1/auth/complete", { body: { email, password: "Adam2026x" } });
    check(noSession.status === 401, "Completing registration needs the player-code session", noSession.status);
    const done = await call("POST", "/api/mobile/v1/auth/complete", { headers: asB, body: { email, password: "Adam2026x" } });
    check(done.status === 200 && done.json?.status === "confirm" && /Check your inbox to confirm/.test(done.json?.message ?? ""), "Complete your registration → 'Check your inbox to confirm <email>'", done.json);
    const mail = await mailTo(email);
    const link = new URL(mail?.link ?? "http://x");
    check(mail?.kind === "email_change" && link.pathname === "/movescore/auth/confirm" && link.searchParams.get("type") === "email_change", "Supabase emails the confirmation to the new address, linking to the confirm page", mail?.link);
    const { data: held } = await db().from("app_users").select("pending_email, pending_password_enc, registration_complete").eq("auth_user_id", b.json?.userId).maybeSingle();
    check(held?.pending_email === email && !!held?.pending_password_enc && !held.pending_password_enc.includes("Adam2026x") && held.registration_complete === false, "The chosen password waits sealed (never in plain text) until the email is confirmed", { pending: held?.pending_email });
    const meWaiting = await call("GET", "/api/mobile/v1/me", { headers: asB });
    check(meWaiting.json?.user?.pendingEmail === email && meWaiting.json?.user?.registrationComplete === false, "GET /me shows the email waiting for confirmation", meWaiting.json?.user);
    const third = await call("POST", "/api/mobile/v1/auth/player-code", { body: { code: ctx.code } });
    check(third.status === 409 && third.json?.code === "code_pending_email", "While the email waits for confirmation, the code no longer signs in another phone", third.json?.error);
    const early = await call("POST", "/api/mobile/v1/auth/email/signin", { body: { email, password: "Adam2026x" } });
    check(early.status === 401, "Before confirming, the email cannot sign in yet", early.status);

    const pageRes = await fetch(mail!.link);
    const html = await pageRes.text();
    check(pageRes.status === 200 && html.includes("Email confirmed") && html.includes("registration is complete"), "The confirm page completes the registration", pageRes.status);
    const meDone = await call("GET", "/api/mobile/v1/me", { headers: asB });
    check(meDone.json?.user?.registrationComplete === true && meDone.json?.user?.email === email && meDone.json?.user?.provider === "email", "GET /me: registration complete, email confirmed", meDone.json?.user);
    const signin = await call("POST", "/api/mobile/v1/auth/email/signin", { body: { email, password: "Adam2026x" } });
    check(signin.status === 200 && signin.json?.userId === b.json?.userId, "He now signs in with his email and the password he chose: the same account", signin.status);
    const stillPlayer = await call("GET", "/api/mobile/v1/me/player", { headers: { Authorization: `Bearer ${signin.json?.accessToken}` } });
    check(stillPlayer.json?.player?.playerId === ctx.pA.id, "…still linked to his player", stillPlayer.json?.player?.name);
    const refreshB = await call("POST", "/api/mobile/v1/auth/refresh", { body: { refreshToken: b.json?.refreshToken } });
    check(refreshB.status === 200, "The phone that registered stays signed in", refreshB.status);

    const taken = await call("POST", "/api/mobile/v1/auth/player-code", { body: { code: ctx.code } });
    check(taken.status === 409 && taken.json?.error === "This player code is already registered. Sign in with your email.", "Once registered, the code cannot sign in (or take over the account)", taken.json?.error);

    // A code already linked to a Google account is refused too.
    const tokC = await userToken(`e2e.omar.${randomUUID().slice(0, 6)}@example.com`);
    const claimC = await call("POST", "/api/mobile/v1/me/player/claim", { headers: { authorization: `Bearer ${tokC}` }, body: { code: ctx.omarCode } });
    const omarCode = await call("POST", "/api/mobile/v1/auth/player-code", { body: { code: ctx.omarCode } });
    check(claimC.status === 200 && omarCode.status === 409 && omarCode.json?.code === "code_registered", "A code linked to a Google/Apple account cannot sign in", omarCode.json?.error);
    if (tokC) await call("DELETE", "/api/mobile/v1/me/player", { headers: { authorization: `Bearer ${tokC}` } });

    // Deleting a player-code account works without the secret key.
    const c = await call("POST", "/api/mobile/v1/auth/player-code", { body: { code: ctx.omarCode } });
    if (c.json?.userId) made.push(c.json.userId);
    const delC = await call("DELETE", "/api/mobile/v1/me/account", { headers: { Authorization: `Bearer ${c.json?.accessToken}` } });
    const { data: freed } = await db().from("player_claims").select("user_id").eq("player_id", ctx.omarId).maybeSingle();
    const deadC = await call("POST", "/api/mobile/v1/auth/refresh", { body: { refreshToken: c.json?.refreshToken } });
    check(c.status === 200 && delC.status === 200 && delC.json?.deleted === true && !freed && deadC.json?.code === "session_revoked", "A player-code account can be deleted: player released, sessions revoked", { c: c.status, del: delC.json });

    // Completing with the six-digit code from the email instead of the link.
    const d = await call("POST", "/api/mobile/v1/auth/player-code", { body: { code: ctx.omarCode } });
    if (d.json?.userId) made.push(d.json.userId);
    const emailD = `e2e.omar.${randomUUID().slice(0, 6)}@example.com`;
    await call("POST", "/api/mobile/v1/auth/complete", { headers: { Authorization: `Bearer ${d.json?.accessToken}` }, body: { email: emailD, password: "Omar2026x" } });
    const otp = (await mailTo(emailD))?.otp ?? "";
    const viaCode = await call("POST", "/api/mobile/v1/auth/email/verify", { body: { email: emailD, code: otp, purpose: "complete" } });
    const pwD = await call("POST", "/api/mobile/v1/auth/email/signin", { body: { email: emailD, password: "Omar2026x" } });
    check(
      viaCode.status === 200 && viaCode.json?.userId === d.json?.userId && viaCode.json?.registrationComplete === true && pwD.status === 200,
      "The six-digit code completes the registration too (same account, password set)",
      { verify: viaCode.status, signin: pwD.status },
    );
  } finally {
    for (const id of made) {
      await db().from("player_claims").delete().eq("user_id", id);
      await db().from("app_users").delete().eq("auth_user_id", id);
      await db().from("app_user_deletions").delete().eq("auth_user_id", id);
    }
  }
}

/**
 * Phase 1, player identity: a phone one-time code (WhatsApp, dry run) links what
 * organisers recorded with the phone and lets the player pick who they are when a
 * parent's phone carries two children; WhatsApp failing → the app asks → the code
 * by email; the email-match suggestion; an organiser's offer the player confirms;
 * another organisation cannot offer a link for this one's player; sharing details
 * with an organisation that only matched the player unmasks it; merging refuses two
 * accounts and moves the account, contact, consents and organisations otherwise.
 * One-time codes are read back from their keyed hashes (the script has the pepper),
 * never from a message: the delivery rows hold no code.
 */
async function playerIdentity(ctx: { tid: string; tag: string; egyId: string; jpnId: string; inst: Record<string, string> }) {
  const { hashOneTimeCode, contactHash } = await import("../../src/lib/players/codeVault");
  const { visiblePersonFields } = await import("../../src/lib/orgs/personFields");
  const { staffToken, sessionToken, COOKIE_NAME } = await import("./lib/session");
  const { callAction, form, actionOk } = await import("./lib/actions");
  const tag = ctx.tag;
  const n8 = String(parseInt(tag, 16) % 1e8).padStart(8, "0");
  const lailaPhone = `+2011${n8}`;
  const karimPhone = `+2010${n8.slice(0, 4)}9999`; // the dry-run "Meta" rejects numbers ending 9999
  const lailaEmail = `laila.${tag}@example.com`;
  const emmaEmail = `emma.${tag}@example.com`;
  const offerEmail = `omar.offer.${tag}@example.com`;
  const otpOf = async (vid: string): Promise<string> => {
    const { data } = await db().from("phone_verifications").select("code_hash").eq("id", vid).single();
    for (let i = 0; i < 1_000_000; i++) {
      const c = String(i).padStart(6, "0");
      if (hashOneTimeCode(vid, c) === data!.code_hash) return c;
    }
    return "";
  };
  const made: string[] = [];
  const signIn = async (email: string) => {
    const tok = await userToken(email);
    if (tok) made.push(subOf(tok)!);
    return tok ? { authorization: `Bearer ${tok}`, id: subOf(tok)! } : null;
  };

  const { data: mbOrg } = await db().from("organizations").select("id").eq("slug", "move-beyond").single();
  const MB = mbOrg!.id as string;
  const { data: orgB } = await db().from("organizations").insert({ slug: `e2e-ident-b-${tag}`, name: `E2E Club B ${tag}`, status: "approved" }).select("id").single();
  const B = orgB!.id as string;
  const { data: tB } = await db().from("tournaments").insert({ name: `E2E Ident B ${tag}`, slug: `e2e-ident-b-${tag}`, kind: "tournament", status: "active", organization_id: B }).select("id").single();
  const { data: teamB } = await db().from("teams").insert({ tournament_id: tB!.id, team_name: `B Team ${tag}` }).select("id").single();
  // Laila: Move Beyond added her (her profile has her mobile); Club B's form only matched that profile.
  const { data: pLaila } = await db().from("player_profiles").insert({ public_name: `Laila E2E ${tag}`, mobile_normalized: lailaPhone, email: lailaEmail, approval_status: "approved", birth_year: 2001 }).select("id").single();
  const P = pLaila!.id as string;
  await db().from("organization_players").insert([
    { organization_id: MB, player_profile_id: P, source: "admin", approval_status: "approved" },
    { organization_id: B, player_profile_id: P, source: "matched", approval_status: "approved", typed_name: "Laila (B form)" },
  ]);
  const { data: rows } = await db()
    .from("players")
    .insert([
      { tournament_id: ctx.tid, team_id: ctx.egyId, full_name: `Laila E2E ${tag}`, player_order: 5, player_profile_id: P, phone: lailaPhone },
      { tournament_id: ctx.tid, team_id: ctx.egyId, full_name: `Nour E2E ${tag}`, player_order: 6, phone: lailaPhone },
      { tournament_id: tB!.id, team_id: teamB!.id, full_name: `Laila E2E ${tag}`, player_order: 1, player_profile_id: P, phone: lailaPhone },
      { tournament_id: ctx.tid, team_id: ctx.jpnId, full_name: `Karim E2E ${tag}`, player_order: 5, phone: karimPhone, email: `karim.${tag}@example.com` },
      { tournament_id: ctx.tid, team_id: ctx.jpnId, full_name: `Emma E2E ${tag}`, player_order: 6, email: emmaEmail },
    ])
    .select("id, full_name, tournament_id");
  const rowOf = (name: string, t = ctx.tid) => (rows ?? []).find((r) => r.full_name === `${name} E2E ${tag}` && r.tournament_id === t)!.id as string;
  try {
    // ---- phone code, a parent's phone with two children
    const laila = await signIn(`laila.app.${tag}@example.com`);
    if (!laila) return console.log("⚠️  Skipping player identity: no test sign-ins here (run against npm run localdb).");
    const bAdminUser = await signIn(`b.admin.${tag}@example.com`);
    await db().from("organization_members").insert({ organization_id: B, auth_user_id: bAdminUser!.id, invited_email: `b.admin.${tag}@example.com`, role: "admin", status: "active" });
    const asBAdmin = { Cookie: `${COOKIE_NAME}=${staffToken({ kind: "member", userId: bAdminUser!.id, orgId: B, role: "admin" })}` };
    const asMbAdmin = { Cookie: `${COOKIE_NAME}=${sessionToken("admin")}` };
    const file = "src/app/admin/players/actions.ts";
    // Club B only matched Laila's profile (a mobile typed on its form): it cannot vouch for her account either.
    const matchedOffer = await callAction(file, "offerAppLinkAction", [form({ profile_id: P, account_email: `attacker.${tag}@example.com` })], asBAdmin);
    const { count: matchedOffers } = await db().from("player_link_offers").select("id", { count: "exact", head: true }).eq("player_profile_id", P);
    check(!actionOk(matchedOffer) && matchedOffers === 0, "Cross-org: an organisation that only matched a player cannot offer a link for them", { status: matchedOffer.status, offers: matchedOffers });
    const asL = { authorization: laila.authorization };
    const badPhone = await call("POST", "/api/mobile/v1/me/player/phone/start", { headers: asL, body: { phone: "not a phone" } });
    check(badPhone.status === 400, "Phone code: a number that is not a mobile is refused", badPhone.json?.error);
    const extra = await call("POST", "/api/mobile/v1/me/player/phone/start", { headers: asL, body: { phone: lailaPhone, admin: true } });
    check(extra.status === 400, "Phone code: unknown fields are refused", extra.status);
    check((await call("POST", "/api/mobile/v1/me/player/phone/start", { headers: ctx.inst, body: { phone: lailaPhone } })).status === 401, "Phone code: a signed-in account is required");
    const start = await call("POST", "/api/mobile/v1/me/player/phone/start", { headers: asL, body: { phone: "011 " + lailaPhone.slice(5) } });
    check(start.status === 200 && start.json?.sent === true && start.json?.phone === lailaPhone && /no-store/.test(start.cache), "Phone code: sent on WhatsApp (dry run) to the number in E.164", start.json);
    const vid = start.json?.verificationId as string;
    const { data: otpRows } = await db().from("message_deliveries").select("purpose, channel, vars, payload, address").eq("purpose", "one_time_code").eq("address", lailaPhone);
    const code = await otpOf(vid);
    const otpRow = (otpRows ?? [])[0];
    check(
      code.length === 6 && otpRow?.channel === "whatsapp" && JSON.stringify(otpRow?.vars) === "{}" && !JSON.stringify(otpRow).includes(code) && JSON.stringify(otpRow?.payload).includes("[removed]") && otpRow?.payload?.template?.name === "mb_login_code" && otpRow?.payload?.template?.buttonParams?.length === 1,
      "The delivery row holds no code (authentication template with its copy-code button, code removed)",
      otpRow && { name: otpRow.payload?.template?.name, vars: otpRow.vars },
    );
    const { data: vRow } = await db().from("phone_verifications").select("code_hash, attempts, expires_at").eq("id", vid).single();
    check(/^[0-9a-f]{64}$/.test(vRow?.code_hash ?? "") && Date.parse(vRow!.expires_at) - Date.now() <= 10 * 60_000 + 5000, "The verification keeps only a keyed hash, for 10 minutes", vRow && { hashed: true, expires: vRow.expires_at });
    const wrongOtp = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    const wrong = await call("POST", "/api/mobile/v1/me/player/phone/verify", { headers: asL, body: { verificationId: vid, code: wrongOtp } });
    check(wrong.status === 400 && wrong.json?.attemptsLeft === 4, "A wrong code costs one of five attempts", wrong.json);
    const otherUser = await signIn(`intruder.${tag}@example.com`);
    const stolen = await call("POST", "/api/mobile/v1/me/player/phone/verify", { headers: { authorization: otherUser!.authorization }, body: { verificationId: vid, code } });
    check(stolen.status === 400 && stolen.json?.error === wrong.json?.error, "Another account's attempt at this verification gets the same answer as a wrong code", stolen.json);
    const ok = await call("POST", "/api/mobile/v1/me/player/phone/verify", { headers: asL, body: { verificationId: vid, code: `Your code is ${code.slice(0, 3)} ${code.slice(3)}` } });
    const choices = (ok.json?.choose ?? []) as { choiceId: string; name: string; entries: string[] }[];
    check(ok.status === 200 && ok.json?.linked === null && choices.length === 2 && choices.some((c) => c.name === `Nour E2E ${tag}`), "Right code: two people share the phone, so the player picks who they are", choices.map((c) => c.name));
    const again = await call("POST", "/api/mobile/v1/me/player/phone/verify", { headers: asL, body: { verificationId: vid, code } });
    check(again.status === 409, "A used code cannot be used again", again.status);
    const lailaChoice = choices.find((c) => c.name === `Laila E2E ${tag}`)!;
    check(lailaChoice?.entries.length === 2, "Laila's choice lists her entries at both organisations", lailaChoice?.entries);
    const chose = await call("POST", "/api/mobile/v1/me/player/phone/choose", { headers: asL, body: { verificationId: vid, choiceId: lailaChoice.choiceId } });
    check(chose.status === 200 && chose.json?.linked?.linked === 2 && chose.json.linked.player.entries.length === 2, "She picks herself: both her entries link; her sister's does not", chose.json?.linked?.player?.entries?.map((e: { tournamentName: string }) => e.tournamentName));
    const { data: pAfter } = await db().from("player_profiles").select("auth_user_id, phone_verified_at").eq("id", P).single();
    check(pAfter?.auth_user_id === laila.id && Boolean(pAfter?.phone_verified_at), "Her profile (whose mobile it is) speaks for her account, phone confirmed", pAfter);
    const { data: nourClaim } = await db().from("player_claims").select("user_id").eq("player_id", rowOf("Nour")).maybeSingle();
    check(!nourClaim, "Her sister's entry stays unlinked");

    // Club B only matched her profile: masked until she shares.
    check(!(await visiblePersonFields(B, [P])).has(P), "Club B (matched by a typed mobile) cannot see her details");
    const lp = (await call("GET", "/api/mobile/v1/me/profile", { headers: asL })).json?.profile;
    const bShare = (lp?.organizations ?? []).find((o: { id: string }) => o.id === B);
    check(lp?.phoneVerified === true && lp?.phone === lailaPhone && bShare?.sharing === false && bShare?.canShare === true && lp.organizations.find((o: { id: string }) => o.id === MB)?.sharing === true, "My profile: phone confirmed; Move Beyond sees her details, Club B can be shared with", lp?.organizations);
    check((await call("POST", "/api/mobile/v1/me/profile/share", { headers: asL, body: { organizationId: randomUUID() } })).status === 404, "Sharing with an organisation that is not hers: not found");
    const share = await call("POST", "/api/mobile/v1/me/profile/share", { headers: asL, body: { organizationId: B } });
    const { data: bRel } = await db().from("organization_players").select("source").eq("organization_id", B).eq("player_profile_id", P).single();
    check(share.status === 200 && bRel?.source === "link" && (await visiblePersonFields(B, [P])).has(P), "She shares her details with Club B: its link is confirmed ('link') and it sees them", bRel);

    // Limits: three codes a phone per 15 minutes.
    let lastStart = 0;
    for (let i = 0; i < 3; i++) lastStart = (await call("POST", "/api/mobile/v1/me/player/phone/start", { headers: { authorization: otherUser!.authorization }, body: { phone: lailaPhone } })).status;
    check(lastStart === 429, "A fourth code to the same phone within 15 minutes is refused (per-phone limit)", lastStart);

    // ---- WhatsApp fails → the app asks → email (to his account's own address, which the organiser recorded with that phone)
    const karim = await signIn(`karim.${tag}@example.com`);
    const asK = { authorization: karim!.authorization };
    const ks = await call("POST", "/api/mobile/v1/me/player/phone/start", { headers: asK, body: { phone: karimPhone } });
    check(ks.status === 200 && ks.json?.sent === false, "WhatsApp did not take the code: the answer says so, and nothing is emailed yet", ks.json);
    const { data: noMailYet } = await db().from("message_deliveries").select("id").eq("purpose", "one_time_code").eq("address", `karim.${tag}@example.com`);
    check((noMailYet ?? []).length === 0, "No email before the player says yes");
    const noConsent = await call("POST", "/api/mobile/v1/me/player/phone/email", { headers: asK, body: { verificationId: ks.json?.verificationId } });
    check(noConsent.status === 400, "Email needs the player's yes (consent: true)", noConsent.status);
    const mailed = await call("POST", "/api/mobile/v1/me/player/phone/email", { headers: asK, body: { verificationId: ks.json?.verificationId, consent: true } });
    await sleep(800); // sent after the answer
    const { data: mailRows } = await db().from("message_deliveries").select("channel, status, vars, payload").eq("purpose", "one_time_code").eq("address", `karim.${tag}@example.com`);
    const kcode = await otpOf(ks.json?.verificationId);
    check(mailed.status === 200 && (mailRows ?? []).length === 1 && mailRows![0]!.status === "sent" && !JSON.stringify(mailRows).includes(kcode), "After yes, a new code goes to his account's email, which the organiser recorded with that phone (row holds no code)", { status: mailed.status, rows: mailRows?.length });
    const twice = await call("POST", "/api/mobile/v1/me/player/phone/email", { headers: asK, body: { verificationId: ks.json?.verificationId, consent: true } });
    check(twice.status === 409, "One email per code", twice.status);
    const stranger = await call("POST", "/api/mobile/v1/me/player/phone/start", { headers: asK, body: { phone: `+2012${n8.slice(0, 4)}0000` } });
    const strangerMail = await call("POST", "/api/mobile/v1/me/player/phone/email", { headers: asK, body: { verificationId: stranger.json?.verificationId, consent: true } });
    check(stranger.status === 200 && strangerMail.status === 200 && strangerMail.json?.message === mailed.json?.message, "A number nobody recorded gets the same answers (no hint whether an email is on file)", strangerMail.json?.message);
    const kv = await call("POST", "/api/mobile/v1/me/player/phone/verify", { headers: asK, body: { verificationId: ks.json?.verificationId, code: kcode } });
    check(kv.status === 200 && kv.json?.linked?.player?.name === `Karim E2E ${tag}` && kv.json?.confirmed === "email", "The emailed code links Karim's entry (recorded with both the phone and his email); it confirmed the email, not the number", kv.json?.linked?.player?.name ?? kv.json);

    // ---- email match
    const emma = await signIn(emmaEmail);
    const asE = { authorization: emma!.authorization };
    const sugg = await call("GET", "/api/mobile/v1/me/player/suggestions", { headers: asE });
    const s0 = (sugg.json?.suggestions ?? [])[0];
    check(sugg.status === 200 && sugg.json.suggestions.length === 1 && s0.kind === "email" && s0.name === `Emma E2E ${tag}` && s0.entries.length === 1, "Email match: after signing in, the entry recorded with her email is suggested", sugg.json?.suggestions);
    const tampered = await call("POST", "/api/mobile/v1/me/player/suggestions", { headers: asE, body: { id: `${s0.id}x`, accept: true } });
    const replay = await call("POST", "/api/mobile/v1/me/player/suggestions", { headers: asK, body: { id: s0.id, accept: true } });
    check(tampered.status === 410 && replay.status === 410, "A changed suggestion, or another account replaying it, is refused", { tampered: tampered.status, replay: replay.status });
    const yes = await call("POST", "/api/mobile/v1/me/player/suggestions", { headers: asE, body: { id: s0.id, accept: true } });
    check(yes.status === 200 && yes.json?.player?.name === `Emma E2E ${tag}`, "She confirms: her entry links", yes.json);
    const none = await call("GET", "/api/mobile/v1/me/player/suggestions", { headers: asE });
    check(none.json?.suggestions?.length === 0, "…and the suggestion is gone");

    // ---- organiser offer, and the other organisation cannot make one for this one's player
    const { data: pOffer } = await db().from("player_profiles").insert({ public_name: `Omar Offer E2E ${tag}`, approval_status: "approved", email: `omar.old.${tag}@example.com` }).select("id").single();
    const PO = pOffer!.id as string;
    await db().from("organization_players").insert({ organization_id: MB, player_profile_id: PO, source: "admin", approval_status: "approved" });
    await db().from("players").insert({ tournament_id: ctx.tid, team_id: ctx.jpnId, full_name: `Omar Offer E2E ${tag}`, player_order: 7, player_profile_id: PO });
    await db().from("player_consents").insert({ player_profile_id: PO, channel: "whatsapp", granted: true, granted_at: new Date().toISOString(), source: "admin" });
    const attack = await callAction(file, "offerAppLinkAction", [form({ profile_id: PO, account_email: `attacker.${tag}@example.com` })], asBAdmin);
    const { count: afterAttack } = await db().from("player_link_offers").select("id", { count: "exact", head: true }).eq("player_profile_id", PO);
    check(!actionOk(attack) && afterAttack === 0, "Cross-org: Club B cannot offer a link for Move Beyond's player", { attack: attack.status, offers: afterAttack });
    const offer = await callAction(file, "offerAppLinkAction", [form({ profile_id: PO, account_email: offerEmail })], asMbAdmin);
    const { data: offers } = await db().from("player_link_offers").select("*").eq("player_profile_id", PO);
    check(actionOk(offer) && (offers ?? []).length === 1 && offers![0]!.email_hash === contactHash("email", offerEmail) && !JSON.stringify(offers).includes(offerEmail), "Move Beyond offers the link: stored as a keyed hash of the email, never the address", { status: offer.status, rows: offers?.length });
    const page = await fetch(`${BASE_URL}/admin/players?q=${encodeURIComponent("Omar Offer")}`, { headers: asMbAdmin }).then((r) => r.text());
    check(page.includes("Waiting for the player to confirm"), "The players page shows the offer waiting for the player");
    const wrongEmail = await call("GET", "/api/mobile/v1/me/player/suggestions", { headers: asK });
    check(!(wrongEmail.json?.suggestions ?? []).some((x: { kind: string }) => x.kind === "offer"), "Another account (another email) does not see the offer");
    const omar = await signIn(offerEmail);
    const asO = { authorization: omar!.authorization };
    const os = await call("GET", "/api/mobile/v1/me/player/suggestions", { headers: asO });
    const o0 = (os.json?.suggestions ?? []).find((x: { kind: string }) => x.kind === "offer");
    check(o0?.organization === "Move Beyond" && o0?.name === `Omar Offer E2E ${tag}`, "The account with that email sees Move Beyond's offer", os.json?.suggestions);
    const oy = await call("POST", "/api/mobile/v1/me/player/suggestions", { headers: asO, body: { id: o0?.id, accept: true } });
    const { data: poAfter } = await db().from("player_profiles").select("auth_user_id").eq("id", PO).single();
    const { data: offerAfter } = await db().from("player_link_offers").select("consumed_by").eq("player_profile_id", PO).single();
    check(oy.status === 200 && oy.json?.player?.name === `Omar Offer E2E ${tag}` && poAfter?.auth_user_id === omar!.id && offerAfter?.consumed_by === omar!.id, "He confirms: Move Beyond's entries link and his profile speaks for his account", { status: oy.status, linked: poAfter?.auth_user_id === omar!.id });

    // ---- merging: platform admins only; never two accounts; otherwise the account and more move
    const pa = await signIn(`platform.${tag}@example.com`);
    await db().from("platform_admins").insert({ auth_user_id: pa!.id, email: `platform.${tag}@example.com`, note: "e2e" });
    await db().from("organization_members").insert({ organization_id: MB, auth_user_id: pa!.id, invited_email: `platform.${tag}@example.com`, role: "owner", status: "active" });
    const asPlatform = { Cookie: `${COOKIE_NAME}=${staffToken({ kind: "member", userId: pa!.id, orgId: MB, role: "owner" })}` };
    const notPlatform = await callAction(file, "mergePlayersAction", [form({ survivor_id: P, absorbed_id: PO })], asMbAdmin);
    const twoAccounts = await callAction(file, "mergePlayersAction", [form({ survivor_id: P, absorbed_id: PO })], asPlatform);
    const { data: still } = await db().from("player_profiles").select("id, approval_status, auth_user_id").in("id", [P, PO]);
    check(!actionOk(notPlatform) && !actionOk(twoAccounts) && (still ?? []).every((x) => x.approval_status !== "merged"), "Merging two profiles linked to different accounts is refused (and only platform admins merge at all)", { notPlatform: notPlatform.status, twoAccounts: twoAccounts.status });
    const { data: pBlank } = await db().from("player_profiles").insert({ public_name: `Omar Blank E2E ${tag}`, approval_status: "approved" }).select("id").single();
    await db().from("organization_players").insert({ organization_id: MB, player_profile_id: pBlank!.id, source: "admin", approval_status: "approved" });
    const merged = await callAction(file, "mergePlayersAction", [form({ survivor_id: pBlank!.id, absorbed_id: PO })], asPlatform);
    const { data: surv } = await db().from("player_profiles").select("auth_user_id, email").eq("id", pBlank!.id).single();
    const { data: gone } = await db().from("player_profiles").select("auth_user_id, approval_status").eq("id", PO).single();
    const { data: survConsent } = await db().from("player_consents").select("channel, granted").eq("player_profile_id", pBlank!.id);
    check(
      actionOk(merged) && surv?.auth_user_id === omar!.id && surv?.email === `omar.old.${tag}@example.com` && gone?.approval_status === "merged" && gone?.auth_user_id === null && (survConsent ?? []).some((c) => c.channel === "whatsapp" && c.granted),
      "Merging into an unlinked profile moves the account, email and consents to the survivor",
      { status: merged.status, survivor: surv, consents: survConsent },
    );
    await db().from("platform_admins").delete().eq("auth_user_id", pa!.id);
  } finally {
    for (const id of made) {
      await db().from("player_claims").delete().eq("user_id", id);
      await db().from("phone_verifications").delete().eq("auth_user_id", id);
      await db().from("organization_members").delete().eq("auth_user_id", id);
      await db().from("platform_admins").delete().eq("auth_user_id", id);
      await db().from("player_profiles").update({ auth_user_id: null }).eq("auth_user_id", id);
    }
    await db().from("message_deliveries").delete().eq("purpose", "one_time_code");
    await db().from("tournaments").delete().eq("id", tB!.id);
    await db().from("organizations").delete().eq("id", B);
  }
}


/**
 * Phase 1 security review (50b69d1 → 0026): each finding as an exploit that must be
 * refused. H1 the email fallback as a phone takeover (own row + PATCH phone + unlink
 * + email fallback), and its staff variant (a rogue organisation types a victim's
 * number and the attacker's email on its own row); M1 a rogue organisation's email
 * on a row matched to another organisation's profile; M2 parallel start bursts and
 * the per-phone wrong-guess budget across accounts; L2 an offer's reach, a
 * matched-only organisation's offer; L3 "Send code" to a team contact; L6 merging
 * profiles whose entries different accounts hold; unknown fields on PATCH /me/player
 * and POST /me/player/claim; L4 the hashing script and a wrong pepper; M3 codes left
 * in the message log. One-time codes are read from their hashes and handed to the
 * attacker anyway: even with the code, nothing of the victim's may link.
 */
async function identityHardening(ctx: { tid: string; tag: string; egyId: string; jpnId: string; inst: Record<string, string> }) {
  const { hashOneTimeCode, contactHash } = await import("../../src/lib/players/codeVault");
  const { formatAccessCode } = await import("../../src/lib/players/accessCode");
  const { staffToken, sessionToken, COOKIE_NAME } = await import("./lib/session");
  const { callAction, form, actionOk } = await import("./lib/actions");
  const { spawnSync } = await import("child_process");
  const tag = ctx.tag;
  const base = parseInt(tag, 16);
  // Numbers of their own (+2015…), away from the other sections' and never ending 9999.
  const phone = (i: number) => `+2015${String((base * 7 + i * 7919) % 1e8).padStart(8, "0").replace(/9999$/, "9998")}`;
  const net = (i: number) => ({ "X-Forwarded-For": `198.18.${(base + i * 13) % 250}.${(i % 250) + 1}` });
  const otpOf = async (vid: string): Promise<string> => {
    const { data } = await db().from("phone_verifications").select("code_hash").eq("id", vid).maybeSingle();
    if (!data) return "";
    for (let i = 0; i < 1_000_000; i++) {
      const c = String(i).padStart(6, "0");
      if (hashOneTimeCode(vid, c) === data.code_hash) return c;
    }
    return "";
  };
  const made: string[] = [];
  const signIn = async (email: string) => {
    const tok = await userToken(email);
    if (tok) made.push(subOf(tok)!);
    return tok ? { authorization: `Bearer ${tok}`, id: subOf(tok)! } : null;
  };
  const holder = async (playerId: string) => ((await db().from("player_claims").select("user_id").eq("player_id", playerId).maybeSingle()).data as { user_id: string } | null)?.user_id ?? null;
  const profileOf = async (id: string) =>
    (await db().from("player_profiles").select("auth_user_id, phone_verified_at, approval_status").eq("id", id).maybeSingle()).data as { auth_user_id: string | null; phone_verified_at: string | null; approval_status: string } | null;
  const codeOf = async (playerId: string) => ((await db().from("players").select("access_code").eq("id", playerId).single()).data as { access_code: string | null } | null)?.access_code ?? "";
  /** start → email (consent) → verify with the code (read from its hash) → pick the named person if asked. */
  const emailChain = async (who: Record<string, string>, number: string, pick: string) => {
    const st = await call("POST", "/api/mobile/v1/me/player/phone/start", { headers: who, body: { phone: number } });
    const vid = st.json?.verificationId as string;
    const em = await call("POST", "/api/mobile/v1/me/player/phone/email", { headers: who, body: { verificationId: vid, consent: true } });
    await sleep(800);
    const code = await otpOf(vid);
    const ver = await call("POST", "/api/mobile/v1/me/player/phone/verify", { headers: who, body: { verificationId: vid, code } });
    let chose: Awaited<ReturnType<typeof call>> | null = null;
    const choice = ((ver.json?.choose ?? []) as { choiceId: string; name: string }[]).find((c) => c.name === pick);
    if (choice) chose = await call("POST", "/api/mobile/v1/me/player/phone/choose", { headers: who, body: { verificationId: vid, choiceId: choice.choiceId } });
    return { st, em, ver, chose, vid };
  };
  const mailsTo = async (address: string) => ((await db().from("message_deliveries").select("id").eq("purpose", "one_time_code").eq("address", address)).data ?? []).length;

  const { data: mbOrg } = await db().from("organizations").select("id").eq("slug", "move-beyond").single();
  const MB = mbOrg!.id as string;
  const { data: orgR } = await db().from("organizations").insert({ slug: `e2e-ident-r-${tag}`, name: `E2E Rogue ${tag}`, status: "approved" }).select("id").single();
  const R = orgR!.id as string;
  const { data: tR } = await db().from("tournaments").insert({ name: `E2E Ident R ${tag}`, slug: `e2e-ident-r-${tag}`, kind: "tournament", status: "active", organization_id: R }).select("id").single();
  const TR = tR!.id as string;
  const { data: teamR } = await db().from("teams").insert({ tournament_id: TR, team_name: `R Team ${tag}` }).select("id").single();
  const tfile = "src/app/admin/tournaments/[id]/players/actions.ts";
  const pfile = "src/app/admin/players/actions.ts";
  const profile = async (name: string, extra: Record<string, unknown>, orgs: [string, string][]) => {
    const { data } = await db().from("player_profiles").insert({ public_name: `${name} E2E ${tag}`, approval_status: "approved", ...extra }).select("id").single();
    const id = data!.id as string;
    for (const [org, source] of orgs) await db().from("organization_players").insert({ organization_id: org, player_profile_id: id, source, approval_status: "approved", typed_name: source === "matched" ? `${name} (typed)` : null });
    return id;
  };
  const row = async (r: Record<string, unknown>) => (await db().from("players").insert(r).select("id").single()).data!.id as string;
  let order = 20;
  const mbRow = (name: string, extra: Record<string, unknown> = {}) => row({ tournament_id: ctx.tid, team_id: ctx.egyId, full_name: `${name} E2E ${tag}`, player_order: order++, ...extra });
  const rRow = (name: string, extra: Record<string, unknown> = {}) => row({ tournament_id: TR, team_id: teamR!.id, full_name: `${name} E2E ${tag}`, player_order: order++, ...extra });

  try {
    const rAdminUser = await signIn(`r.admin.${tag}@example.com`);
    if (!rAdminUser) return console.log("⚠️  Skipping the identity hardening checks: no test sign-ins here (run against npm run localdb).");
    await db().from("organization_members").insert({ organization_id: R, auth_user_id: rAdminUser.id, invited_email: `r.admin.${tag}@example.com`, role: "admin", status: "active" });
    const asRAdmin = { Cookie: `${COOKIE_NAME}=${staffToken({ kind: "member", userId: rAdminUser.id, orgId: R, role: "admin" })}` };
    const asMbAdmin = { Cookie: `${COOKIE_NAME}=${sessionToken("admin")}` };

    // ---- H1: own row + PATCH the victim's number + unlink + email fallback = the victim's history
    {
      const vPhone = phone(1);
      const PV = await profile("Victor", { mobile_normalized: vPhone, email: `victor.${tag}@example.com` }, [[MB, "admin"]]);
      const victimRow = await mbRow("Victor", { player_profile_id: PV, phone: vPhone, email: `victor.${tag}@example.com` });
      const malloryEmail = `mallory.${tag}@example.com`;
      const malloryRow = await mbRow("Mallory", { email: malloryEmail });
      const mallory = (await signIn(malloryEmail))!;
      const asM = { authorization: mallory.authorization, ...net(1) };
      const claimed = await call("POST", "/api/mobile/v1/me/player/claim", { headers: asM, body: { code: await codeOf(malloryRow) } });
      const patched = await call("PATCH", "/api/mobile/v1/me/player", { headers: asM, body: { phone: vPhone } });
      const { data: mRow } = await db().from("players").select("phone, self_reported_phone").eq("id", malloryRow).maybeSingle();
      check(claimed.status === 200 && patched.status === 200 && mRow?.phone == null && mRow?.self_reported_phone === vPhone, "H1: a number typed in the app is kept as the player's own, never as the organiser's record", mRow);
      await call("DELETE", "/api/mobile/v1/me/player", { headers: asM });
      const chain = await emailChain(asM, vPhone, `Victor E2E ${tag}`);
      check(chain.em.status === 200 && (await mailsTo(malloryEmail)) === 0, "H1: the emailed code does not go to the attacker's address (it is not on file with that phone)", { email: chain.em.status, mails: await mailsTo(malloryEmail) });
      const pv = await profileOf(PV);
      check(
        (await holder(victimRow)) !== mallory.id && pv?.auth_user_id !== mallory.id && !pv?.phone_verified_at,
        "H1: even holding the code, the attacker gets none of the victim's entries, not their profile, and the number is not marked confirmed",
        { verify: chain.ver.json?.confirmed ?? chain.ver.status, linked: chain.chose?.json?.linked?.linked ?? chain.ver.json?.linked?.linked ?? 0 },
      );
    }

    // ---- H1, staff variant: a rogue organisation types a victim's number and the attacker's email on its own row
    {
      const sPhone = phone(2);
      const PS = await profile("Sara", { mobile_normalized: sPhone, email: `sara.${tag}@example.com` }, [[MB, "admin"]]);
      const saraRow = await mbRow("Sara", { player_profile_id: PS, phone: sPhone });
      const planted = await rRow("Sara");
      const trudyEmail = `trudy.${tag}@example.com`;
      const typed = await callAction(tfile, "savePlayerContact", [form({ tournament_id: TR, player_id: planted, phone: sPhone, email: trudyEmail })], asRAdmin, { id: TR });
      check(actionOk(typed), "Staff variant: the rogue organisation writes the victim's number and the attacker's email on its own row", typed.status);
      const trudy = (await signIn(trudyEmail))!;
      const asT = { authorization: trudy.authorization, ...net(2) };
      const chain = await emailChain(asT, sPhone, `Sara E2E ${tag}`);
      const linked = chain.chose?.json?.linked ?? chain.ver.json?.linked;
      const ps = await profileOf(PS);
      check(
        (await holder(saraRow)) !== trudy.id && ps?.auth_user_id !== trudy.id && !ps?.phone_verified_at,
        "Staff variant: the emailed code links nothing of the victim's other organisation, nor her profile, and confirms no number",
        { saraHeld: (await holder(saraRow)) === trudy.id, profile: ps?.auth_user_id === trudy.id, verified: Boolean(ps?.phone_verified_at) },
      );
      check(linked?.linked === 1 && (await holder(planted)) === trudy.id && chain.ver.json?.confirmed === "email", "Staff variant: only the rogue organisation's own row (recorded with both) links, as an email proof", { linked: linked?.linked, confirmed: chain.ver.json?.confirmed });
      check((await mailsTo(`sara.${tag}@example.com`)) === 0, "Staff variant: the victim's own address is never sent a code she did not ask for");
    }

    // ---- M1: a rogue organisation's email on a row matched to another organisation's profile
    {
      const mPhone = phone(3);
      const PM = await profile("Mona", { mobile_normalized: mPhone, email: `mona.${tag}@example.com` }, [[MB, "admin"], [R, "matched"]]);
      const monaRow = await mbRow("Mona", { player_profile_id: PM, phone: mPhone });
      const matchedRow = await rRow("Mona", { player_profile_id: PM });
      const eveEmail = `eve.${tag}@example.com`;
      await callAction(tfile, "savePlayerContact", [form({ tournament_id: TR, player_id: matchedRow, phone: "", email: eveEmail })], asRAdmin, { id: TR });
      const eve = (await signIn(eveEmail))!;
      const asE = { authorization: eve.authorization, ...net(3) };
      const sugg = await call("GET", "/api/mobile/v1/me/player/suggestions", { headers: asE });
      const sm = ((sugg.json?.suggestions ?? []) as { id: string; kind: string; name: string }[]).find((x) => x.name === `Mona E2E ${tag}`);
      const yes = sm ? await call("POST", "/api/mobile/v1/me/player/suggestions", { headers: asE, body: { id: sm.id, accept: true } }) : null;
      const prof = (await call("GET", "/api/mobile/v1/me/profile", { headers: asE })).json?.profile;
      const pm = await profileOf(PM);
      check(
        pm?.auth_user_id !== eve.id && (await holder(monaRow)) !== eve.id && prof?.phone !== mPhone,
        "M1: the attacker's email on a matched row gets that row only: not the profile, not the other organisation's entry, not the profile's mobile",
        { accepted: yes?.status ?? "no suggestion", profile: pm?.auth_user_id === eve.id, monaHeld: (await holder(monaRow)) === eve.id, phoneShown: prof?.phone === mPhone },
      );
    }

    // ---- L2: an offer reaches only its organisation; a matched-only organisation cannot offer at all
    {
      const PO = await profile("Olga", { email: `olga.${tag}@example.com` }, [[MB, "admin"], [R, "admin"]]);
      const olgaMb = await mbRow("Olga", { player_profile_id: PO });
      const olgaR = await rRow("Olga", { player_profile_id: PO });
      const fake = `olga.fake.${tag}@example.com`;
      const offered = await callAction(pfile, "offerAppLinkAction", [form({ profile_id: PO, account_email: fake })], asRAdmin);
      const thief = (await signIn(fake))!;
      const asX = { authorization: thief.authorization, ...net(4) };
      const os = await call("GET", "/api/mobile/v1/me/player/suggestions", { headers: asX });
      const o0 = ((os.json?.suggestions ?? []) as { id: string; kind: string }[]).find((x) => x.kind === "offer");
      const yes = o0 ? await call("POST", "/api/mobile/v1/me/player/suggestions", { headers: asX, body: { id: o0.id, accept: true } }) : null;
      await call("GET", "/api/mobile/v1/me/player", { headers: asX }); // the profile sync runs here
      const prof = (await call("GET", "/api/mobile/v1/me/profile", { headers: asX })).json?.profile;
      check(actionOk(offered) && yes?.status === 200 && (await holder(olgaR)) === thief.id, "L2: the rogue organisation's offer, once accepted, links its own entry", { offered: offered.status, accepted: yes?.status });
      check(
        (await holder(olgaMb)) !== thief.id && !(prof?.tournaments ?? []).some((t: { organization: { slug: string } | null }) => t.organization?.slug === "move-beyond"),
        "L2: …and nothing of another organisation's (Move Beyond's entry stays unlinked, its tournaments unseen)",
        { mbHeld: (await holder(olgaMb)) === thief.id },
      );
      const { data: scope } = await db().from("player_profiles").select("owner_scope_org").eq("id", PO).maybeSingle();
      check((scope as { owner_scope_org?: string } | null)?.owner_scope_org === R, "L2: the profile records that the account has only that organisation's word for it");
      // Matched only, and no other organisation has the player yet: still no offer.
      const PX = await profile("Xena", { email: `xena.${tag}@example.com` }, [[R, "matched"]]);
      const matchedOffer = await callAction(pfile, "offerAppLinkAction", [form({ profile_id: PX, account_email: `xena.fake.${tag}@example.com` })], asRAdmin);
      const { count: xOffers } = await db().from("player_link_offers").select("id", { count: "exact", head: true }).eq("player_profile_id", PX);
      check(!actionOk(matchedOffer) && xOffers === 0, "L2: an organisation that only matched a player (even one nobody else has) cannot offer a link", { status: matchedOffer.status, offers: xOffers });
      // An offer row such an organisation has anyway (made before this rule) is neither shown nor accepted.
      const PY = await profile("Yara", {}, [[MB, "admin"], [R, "matched"]]);
      await mbRow("Yara", { player_profile_id: PY });
      const yaraFake = `yara.fake.${tag}@example.com`;
      await db().from("player_link_offers").insert({ organization_id: R, player_profile_id: PY, email_hash: contactHash("email", yaraFake), created_by: "e2e" });
      const yThief = (await signIn(yaraFake))!;
      const ys = await call("GET", "/api/mobile/v1/me/player/suggestions", { headers: { authorization: yThief.authorization, ...net(5) } });
      const y0 = ((ys.json?.suggestions ?? []) as { id: string; kind: string }[]).find((x) => x.kind === "offer");
      if (y0) await call("POST", "/api/mobile/v1/me/player/suggestions", { headers: { authorization: yThief.authorization, ...net(5) }, body: { id: y0.id, accept: true } });
      check(!y0 && (await profileOf(PY))?.auth_user_id !== yThief.id, "L2: an old offer from an organisation that only matched the player is not shown, and links nothing");
    }

    // ---- M2: parallel starts, and the wrong-guess budget of one phone across accounts
    {
      const burstPhone = phone(5);
      const crowd = (await Promise.all(Array.from({ length: 6 }, (_, i) => signIn(`burst${i}.${tag}@example.com`)))).filter((x): x is NonNullable<typeof x> => Boolean(x));
      const statuses = await Promise.all(
        crowd.flatMap((u, i) => [0, 1].map((k) => call("POST", "/api/mobile/v1/me/player/phone/start", { headers: { authorization: u.authorization, ...net(40 + i * 2 + k) }, body: { phone: burstPhone } }).then((r) => r.status))),
      );
      const { count: open } = await db().from("phone_verifications").select("id", { count: "exact", head: true }).eq("phone", burstPhone).is("consumed_at", null).gt("expires_at", new Date().toISOString());
      const sent = statuses.filter((x) => x === 200).length;
      check(sent <= 3 && (open ?? 0) <= 2, "M2: twelve simultaneous starts for one phone from six accounts: at most three codes, at most two open at once", { sent, open, statuses });

      const gPhone = phone(6);
      const guessers = (await Promise.all([0, 1, 2].map((i) => signIn(`guess${i}.${tag}@example.com`)))).filter((x): x is NonNullable<typeof x> => Boolean(x));
      const wrongAnswers: number[] = [];
      let lockedOut = false;
      for (const [i, g] of guessers.entries()) {
        const who = { authorization: g.authorization, ...net(60 + i) };
        const st = await call("POST", "/api/mobile/v1/me/player/phone/start", { headers: who, body: { phone: gPhone } });
        const vid = st.json?.verificationId as string | undefined;
        if (!vid) continue;
        const right = await otpOf(vid);
        for (let k = 0; k < 5; k++) {
          const guess = String((Number(right) + 1 + k * 97) % 1_000_000).padStart(6, "0");
          const r = await call("POST", "/api/mobile/v1/me/player/phone/verify", { headers: who, body: { verificationId: vid, code: guess } });
          if (r.status === 400) wrongAnswers.push(r.status);
          if (r.status === 429 && r.json?.code === "phone_locked") lockedOut = true;
        }
      }
      check(wrongAnswers.length <= 10 && lockedOut, "M2: three accounts get no more than ten wrong guesses at one phone a day between them", { tried: wrongAnswers.length, lockedOut });

      // Parallel guesses at one verification each cost one attempt: never more than five are compared.
      const pPhone = phone(7);
      const solo = (await signIn(`solo.${tag}@example.com`))!;
      const who = { authorization: solo.authorization, ...net(70) };
      const st = await call("POST", "/api/mobile/v1/me/player/phone/start", { headers: who, body: { phone: pPhone } });
      const vid = st.json?.verificationId as string;
      const right = await otpOf(vid);
      const burst = await Promise.all(Array.from({ length: 12 }, (_, k) => call("POST", "/api/mobile/v1/me/player/phone/verify", { headers: who, body: { verificationId: vid, code: String((Number(right) + 1 + k) % 1_000_000).padStart(6, "0") } }).then((r) => r.status)));
      check(burst.filter((x) => x === 400).length <= 5, "M2: twelve simultaneous wrong codes at one verification: at most five are compared", burst);
    }

    // ---- L3: "Send code" never to the team's contact number
    {
      const teamPhone = phone(8);
      const { data: team } = await db().from("teams").insert({ tournament_id: ctx.tid, team_name: `Contact Team ${tag}`, phone: teamPhone }).select("id").single();
      const partnerless = await row({ tournament_id: ctx.tid, team_id: team!.id, full_name: `Tariq E2E ${tag}`, player_order: 1 });
      const sent = await callAction(tfile, "sendCode", [null, form({ tournament_id: ctx.tid, player_id: partnerless, channel: "whatsapp" })], asMbAdmin, { id: ctx.tid });
      const { data: rows } = await db().from("message_deliveries").select("id").eq("purpose", "access_code").eq("address", teamPhone);
      check((rows ?? []).length === 0 && /team/.test(sent.text), "L3: a player's code is not sent to the team's contact number", { status: sent.status, rows: rows?.length });
    }

    // ---- L6: two profiles whose entries different accounts hold are not merged
    {
      const pa = (await signIn(`platform2.${tag}@example.com`))!;
      await db().from("platform_admins").insert({ auth_user_id: pa.id, email: `platform2.${tag}@example.com`, note: "e2e" });
      await db().from("organization_members").insert({ organization_id: MB, auth_user_id: pa.id, invited_email: `platform2.${tag}@example.com`, role: "owner", status: "active" });
      const asPlatform = { Cookie: `${COOKIE_NAME}=${staffToken({ kind: "member", userId: pa.id, orgId: MB, role: "owner" })}` };
      const P1 = await profile("Hana One", {}, [[MB, "admin"]]);
      const P2 = await profile("Hana Two", {}, [[MB, "admin"]]);
      const r1 = await mbRow("Hana One", { player_profile_id: P1 });
      const r2 = await mbRow("Hana Two", { player_profile_id: P2 });
      const u1 = (await signIn(`hana1.${tag}@example.com`))!;
      const u2 = (await signIn(`hana2.${tag}@example.com`))!;
      await db().from("player_claims").insert([
        { user_id: u1.id, player_id: r1, via_player_id: r1, proof: "code" },
        { user_id: u2.id, player_id: r2, via_player_id: r2, proof: "code" },
      ]);
      const merged = await callAction(pfile, "mergePlayersAction", [form({ survivor_id: P1, absorbed_id: P2 })], asPlatform);
      check(!actionOk(merged) && (await profileOf(P2))?.approval_status !== "merged", "L6: profiles whose entries are held by two different accounts are not merged", merged.status);
      await db().from("platform_admins").delete().eq("auth_user_id", pa.id);
    }

    // ---- strictBody: PATCH /me/player and POST /me/player/claim take known fields only
    {
      const zRow = await mbRow("Zaid");
      const zaid = (await signIn(`zaid.${tag}@example.com`))!;
      const asZ = { authorization: zaid.authorization, ...net(80) };
      const extraClaim = await call("POST", "/api/mobile/v1/me/player/claim", { headers: asZ, body: { code: await codeOf(zRow), proof: "phone" } });
      check(extraClaim.status === 400 && (await holder(zRow)) === null, "A claim with an unknown field is refused (and links nothing)", extraClaim.status);
      await call("POST", "/api/mobile/v1/me/player/claim", { headers: asZ, body: { code: await codeOf(zRow) } });
      const extraPatch = await call("PATCH", "/api/mobile/v1/me/player", { headers: asZ, body: { phone: "0100 765 4321", verified: true } });
      check(extraPatch.status === 400, "PATCH /me/player with an unknown field is refused", extraPatch.status);
    }

    // ---- L4: the hashing script checks the pepper against a sealed row before writing
    {
      const run = (pepper: string) => spawnSync("npx", ["tsx", "scripts/ops/hash-player-codes.ts", "--dry-run"], { env: { ...process.env, PLAYER_CODE_PEPPER: pepper }, encoding: "utf8", timeout: 120_000 });
      const wrong = run("w".repeat(40));
      const right = run(process.env.PLAYER_CODE_PEPPER ?? "");
      check(wrong.status !== 0 && /not the deployed server's pepper/.test(wrong.stderr), "L4: the hashing script refuses a pepper that does not open the codes already sealed", { status: wrong.status, err: wrong.stderr.trim().slice(0, 120) });
      check(right.status === 0 && /Pepper checked/.test(right.stdout), "L4: …and runs with the right one", { status: right.status, out: right.stdout.trim().slice(0, 160) });
    }

    // ---- M3: codes older code left in the message log are scrubbed
    {
      const legacy = "QRST6789";
      const shown = formatAccessCode(legacy);
      const addr = `legacy.${tag}@example.com`;
      await db().from("message_deliveries").insert([
        { channel: "email", purpose: "access_code", recipient_kind: "player", recipient_name: "Legacy", address: addr, status: "sent", vars: { name: "Legacy", code: shown }, payload: { kind: "email", subject: "Your code", html: `<b>${shown}</b>`, text: `Code ${shown}` }, idempotency_key: `player-code:${randomUUID()}:email:${legacy}:2026-01-01T00:00` },
        { channel: "email", purpose: "access_codes", recipient_kind: "player_profile", recipient_name: "Legacy", address: addr, status: "sent", vars: { name: "Legacy", code: shown } },
      ]);
      const dry = spawnSync("npx", ["tsx", "scripts/ops/scrub-delivery-codes.ts"], { env: process.env, encoding: "utf8", timeout: 120_000 });
      const { data: still } = await db().from("message_deliveries").select("vars, payload, idempotency_key").eq("address", addr);
      check(dry.status === 0 && JSON.stringify(still).includes(legacy), "M3: the scrub is a dry run by default (counts only, nothing written)", { status: dry.status, out: dry.stdout.trim().slice(0, 160) });
      const apply = spawnSync("npx", ["tsx", "scripts/ops/scrub-delivery-codes.ts", "--apply"], { env: process.env, encoding: "utf8", timeout: 120_000 });
      const { data: after } = await db().from("message_deliveries").select("vars, payload, idempotency_key").eq("address", addr);
      const text = JSON.stringify(after);
      check(apply.status === 0 && (after ?? []).length === 2 && !text.includes(legacy) && !text.includes(shown) && !text.includes(legacy.toLowerCase()), "M3: --apply removes the code from vars, the stored message and the idempotency key", { status: apply.status, err: apply.stderr.trim().slice(0, 120) });
      await db().from("message_deliveries").delete().eq("address", addr);
    }
  } finally {
    for (const id of made) {
      await db().from("player_claims").delete().eq("user_id", id);
      await db().from("phone_verifications").delete().eq("auth_user_id", id);
      await db().from("organization_members").delete().eq("auth_user_id", id);
      await db().from("platform_admins").delete().eq("auth_user_id", id);
      await db().from("player_profiles").update({ auth_user_id: null }).eq("auth_user_id", id);
    }
    await db().from("message_deliveries").delete().eq("purpose", "one_time_code");
    await db().from("message_deliveries").delete().like("address", "+2015%");
    await db().from("tournaments").delete().eq("id", TR);
    await db().from("organizations").delete().eq("id", R);
  }
}

void main();

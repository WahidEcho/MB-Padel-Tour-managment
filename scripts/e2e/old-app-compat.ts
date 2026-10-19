/**
 * Move Score 1.0.1 (built from commit 0159033) against this server.
 *
 * The phones that already have 1.0.1 (and the build in App Review) keep talking to
 * the production server after every deploy. This script replays the calls 1.0.1
 * makes, built the way 1.0.1 builds them: the same paths, the same headers
 * (`credentialHeaders` below is a verbatim copy of 0159033:move-score-app/src/api/headers.ts,
 * and `OldPhone.api` follows its api/client.ts: method from the body, JSON content
 * type only with a body, `undefined` fields dropped by JSON.stringify), the same
 * bodies (push/register.ts, state/follows.ts, push/prefs.ts, pass/*, player/me.ts,
 * auth/*, live/lockScreen.ts, referee/useLease.ts, referee/sync.ts with its batch of
 * 50 and its event field list), and the same referee console events (the shared
 * src/lib/scoring/console.ts, which the script checks is byte-identical to 0159033's).
 * Each call must succeed and carry the fields 1.0.1 reads.
 *
 * Stand-in only. Creates and deletes its own rows.
 *
 *   npm run localdb                                      # terminal 1
 *   npm run build && (set -a; . ./.env.localdb; set +a; PUBLIC_SITE_URL=http://localhost:3077 \
 *     PUSH_DRY_RUN=1 MESSAGING_DRY_RUN=1 npx next start -p 3077)   # terminal 2
 *   npm run e2e:old-app                                  # terminal 3
 */
import { spawnSync } from "child_process";
import { createHash, randomBytes, randomUUID } from "crypto";
import sharp from "sharp";
import { db } from "../../src/lib/supabase";
import * as Console from "../../src/lib/scoring/console";
import { stateFromFinalScore } from "../../src/lib/scoring/finalScore";
import type { ScoreState, TeamKey } from "../../src/lib/scoring/engine";
import type { ScoringConfig } from "../../src/lib/types";
import { generateEventCode, hashEventCode } from "../../src/lib/orgs/codes";
import { hashRefereePin } from "../../src/lib/referees/pin";
import { MOVE_BEYOND_SLUG } from "../../src/lib/orgs/roles";
import { newTournamentMatchDayRules } from "../../src/lib/matchday/rules";
import { matchScreenCode, rotatingCode } from "../../src/lib/pass/venueCode";
import { readAuthRedirect } from "../../src/lib/mobile/oauth";
import { BASE_URL, assertStandIn, check, finish, section } from "./lib/fixtures";
import { sessionToken } from "./lib/session";

const OLD = "0159033";
const SUPA = process.env.SUPABASE_URL ?? "";

/* ---------------- 1.0.1's response types (0159033:src/lib/mobile/contract.ts) ---------------- */

const OLD_CONTRACT = spawnSync("git", ["show", `${OLD}:src/lib/mobile/contract.ts`], { encoding: "utf8" }).stdout ?? "";

/** The required (non-optional) fields of one of 1.0.1's response interfaces, its parents' included. */
function oldFields(name: string): string[] {
  const start = OLD_CONTRACT.search(new RegExp(`export interface ${name}\\b`));
  if (start < 0) throw new Error(`${name} is not in ${OLD}'s contract`);
  const head = OLD_CONTRACT.slice(start, OLD_CONTRACT.indexOf("{", start));
  const parent = /extends (\w+)/.exec(head)?.[1];
  const keys: string[] = parent ? oldFields(parent) : [];
  let depth = 0;
  let lineDepth = 0;
  let line = "";
  for (let i = OLD_CONTRACT.indexOf("{", start); i < OLD_CONTRACT.length; i++) {
    const ch = OLD_CONTRACT[i]!;
    if (ch === "\n") {
      // A field of this interface: at depth 1 when its line starts, and not optional.
      const m = /^\s*(\w+)(\??):/.exec(line);
      if (m && lineDepth === 1 && !m[2]) keys.push(m[1]!);
      line = "";
      lineDepth = depth;
      continue;
    }
    line += ch;
    if (ch === "{") depth++;
    if (ch === "}" && --depth === 0) break;
  }
  return [...new Set(keys)];
}

/** Checks that `value` carries every field 1.0.1's `type` requires. */
function shape(type: string, value: unknown, where: string) {
  const want = oldFields(type);
  const have = value && typeof value === "object" ? Object.keys(value) : [];
  if (!want.length) throw new Error(`no fields read for ${type}`);
  const missing = want.filter((k) => !have.includes(k));
  check(value !== null && value !== undefined && missing.length === 0, `${where} carries every field of 1.0.1's ${type}`, missing.length ? { missing } : undefined);
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 1.0.1's request building ---------------- */

type Who = "public" | "me" | "staff";

// Verbatim from 0159033:move-score-app/src/api/headers.ts.
const MATCH_STATE = /^\/api\/matches\/[^/?]+\/state(\?|$)/;
function credentialHeaders(who: Who, path: string, c: { installToken: string | null; userToken: string | null; staffToken: string | null }): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (who === "me") {
    if (c.installToken) h["X-Install-Token"] = c.installToken;
    if (c.userToken) h.Authorization = `Bearer ${c.userToken}`;
  }
  if (who === "staff" && c.staffToken) h.Authorization = `Bearer ${c.staffToken}`;
  if ((who === "staff" || MATCH_STATE.test(path)) && c.installToken) h["X-Install-Token"] = c.installToken;
  return h;
}

interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  headers: Headers;
}

/** One phone running 1.0.1: its install id and token, its user session and its staff token. */
class OldPhone {
  installationId = `ios-${randomUUID()}`; // state/session.ts: `${Platform.OS}-${randomUUID()}`
  installToken: string | null = null;
  user: { id: string; accessToken: string; refreshToken: string; expiresAt: number | null } | null = null;
  staff: { token: string; role: string; expiresAt: string } | null = null;

  /** api/client.ts `api()`, minus the refresh and the retry-on-401 (asserted separately). */
  async api(path: string, opts: { method?: string; body?: unknown; who?: Who; headers?: Record<string, string> } = {}): Promise<Reply> {
    const headers = {
      ...credentialHeaders(opts.who ?? "public", path, { installToken: this.installToken, userToken: (opts.who ?? "public") === "me" && this.user ? this.user.accessToken : null, staffToken: this.staff?.token ?? null }),
      ...(opts.headers ?? {}),
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    };
    const res = await fetch(`${BASE_URL}${path}`, {
      method: opts.method ?? (opts.body ? "POST" : "GET"),
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { unparsable: text.slice(0, 200) };
    }
    return { status: res.status, json, headers: res.headers };
  }

  /** push/register.ts `register()`. */
  register(expoPushToken: string | null, alerts: boolean) {
    return this.api("/api/mobile/v1/devices", {
      who: "me",
      body: { installationId: this.installationId, platform: "ios", expoPushToken, alerts, appVersion: "1.0.1", tz: "Africa/Cairo", locale: "en-US" },
    });
  }

  /** auth/signIn.ts `finish()`: keep the session, sync follows (mergeInstall), register the phone again. */
  async finish(r: { userId: string; accessToken: string; refreshToken: string; expiresAt: number | null }, follows: unknown[] = []) {
    this.user = { id: r.userId, accessToken: r.accessToken, refreshToken: r.refreshToken, expiresAt: r.expiresAt };
    const f = await this.api("/api/mobile/v1/me/follows", { who: "me", body: { add: follows, mergeInstall: true } });
    const d = await this.register(null, false);
    return { follows: f, device: d };
  }
}

/** What the in-app browser sheet does: follow redirects until the app's scheme (adds a login hint so each test person is distinct). */
async function browse(url: string, email: string, redirectTo = "movescore://auth/callback"): Promise<string | null> {
  let at = url;
  for (let i = 0; i < 6; i++) {
    const u = new URL(at);
    if (u.pathname === "/auth/v1/authorize" && !u.searchParams.has("login_hint")) u.searchParams.set("login_hint", email);
    const res = await fetch(u.toString(), { redirect: "manual" });
    const loc = res.headers.get("location");
    if (!loc) return null;
    const next = new URL(loc, u).toString();
    if (next.startsWith(redirectTo)) return next;
    at = next;
  }
  return null;
}

/** auth/signIn.ts `signInWithBrowser("google")` + `exchange()`. */
async function googleSignIn(phone: OldPhone, email: string) {
  const verifier = randomBytes(32).toString("hex");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const start = `${BASE_URL}/api/mobile/v1/auth/oauth/google?redirect_to=${encodeURIComponent("movescore://auth/callback")}&code_challenge=${challenge}`;
  const landed = await browse(start, email);
  const back = readAuthRedirect(landed ?? "");
  return phone.api("/api/mobile/v1/auth/session", { body: { provider: "google", code: back.code, codeVerifier: verifier } });
}

/* ---------------- the referee console (useConsole.ts + queue.ts + sync.ts) ---------------- */

interface QueuedEvent {
  client_event_id: string;
  event_number: number;
  event_type: string;
  team_id: string | null;
  previous_state: ScoreState | null;
  new_state: ScoreState;
  payload: Record<string, unknown> | null;
  created_at_client: string;
  sync_status: "pending" | "synced";
}

/* eslint-disable @typescript-eslint/no-explicit-any */
class OldConsole {
  state: ScoreState | null;
  history: ScoreState[];
  number: number;
  status: string;
  queue: QueuedEvent[] = [];
  opts: Console.ConsoleOptions;
  lastSync: Reply | null = null;

  constructor(
    private phone: OldPhone,
    private deviceId: string,
    private boot: any,
  ) {
    this.state = (boot.snapshot?.snapshot_json as ScoreState | null) ?? null;
    // useConsole.ts takeServer(): a finished match with no history can still undo into its reopen state.
    this.history = (boot.history as ScoreState[]).slice(-200);
    if (["completed", "walkover", "disqualified", "retired", "cancelled"].includes(boot.match.status) && boot.reopenState && !this.history.length) this.history = [boot.reopenState as ScoreState];
    this.number = boot.snapshot?.last_event_number ?? 0;
    this.status = boot.match.status;
    this.opts = {
      config: boot.config as ScoringConfig,
      confirmFirst: boot.config.requireResultConfirmation === true,
      online: true,
      tennis: boot.tennis,
      doubles: boot.tennis && (boot.sideA?.players.length ?? 0) >= 2 && (boot.sideB?.players.length ?? 0) >= 2,
    };
  }

  private sideId = (k: TeamKey) => (k === "A" ? this.boot.match.team_a_id : this.boot.match.team_b_id) as string;
  get finished() {
    return Console.isFinished(this.status, this.state, this.opts.confirmFirst);
  }

  /** useConsole `record()`. */
  record(build: () => Console.ConsoleEvent | null): boolean {
    const prev = this.state;
    const e = build();
    if (!e) return false;
    if (e.eventType !== "UNDO" && Console.isFinished(this.status, prev, this.opts.confirmFirst)) return false;
    const n = this.number + 1;
    const history = Console.nextHistory(this.history, prev, e.eventType);
    const payload = e.winner ? { ...(e.payload ?? {}), winner_team_id: this.sideId(e.winner) } : e.payload;
    this.queue.push({
      client_event_id: randomUUID(),
      event_number: n,
      event_type: e.eventType,
      team_id: e.team ? this.sideId(e.team) : null,
      previous_state: prev,
      new_state: e.next,
      payload,
      created_at_client: new Date().toISOString(),
      sync_status: "pending",
    });
    this.number = n;
    this.state = e.next;
    this.history = history;
    this.status = e.newStatus ?? this.status;
    return true;
  }

  start = (k: TeamKey) => this.record(() => Console.startMatch(k));
  point = (k: TeamKey) => this.record(() => (this.state ? Console.point(this.state, k, this.opts) : null));
  undo = () => this.record(() => Console.undo(this.history, Console.isFinished(this.status, this.state, this.opts.confirmFirst)));
  pause = () => this.record(() => (this.state ? Console.togglePause(this.state, this.status === "paused") : null));
  endWith = (kind: Console.EndKind, w: TeamKey) => this.record(() => (this.state ? Console.endWith(this.state, kind, w, true) : null));

  /** sync.ts `once()` until the queue is empty or the server refuses. Returns the last reply. */
  async sync(): Promise<Reply | null> {
    for (let i = 0; i < 20; i++) {
      const pending = this.queue.filter((e) => e.sync_status === "pending").sort((a, b) => a.event_number - b.event_number);
      if (!pending.length) return this.lastSync;
      const batch = pending.slice(0, 50);
      const r = await this.phone.api(`/api/matches/${this.boot.match.id}/events`, {
        who: "staff",
        body: {
          deviceId: this.deviceId,
          events: batch.map((e) => ({
            client_event_id: e.client_event_id,
            event_number: e.event_number,
            event_type: e.event_type,
            team_id: e.team_id,
            previous_state: e.previous_state,
            new_state: e.new_state,
            payload: e.payload,
            created_at_client: e.created_at_client,
          })),
        },
      });
      this.lastSync = r;
      if (r.status !== 200) return r;
      const ids = new Set(batch.map((e) => e.client_event_id));
      for (const e of this.queue) if (ids.has(e.client_event_id)) e.sync_status = "synced";
    }
    return this.lastSync;
  }
}

/* ---------------- the run ---------------- */

const label = "iPhone 15 · app"; // useLease.ts label()

async function main() {
  assertStandIn("old-app-compat");
  // The console the old app ran is the server's own pure module: it must not have changed since 1.0.1.
  const same = spawnSync("git", ["diff", "--quiet", OLD, "HEAD", "--", "src/lib/scoring/console.ts", "src/lib/scoring/engine.ts", "src/lib/scoring/conduct.ts", "src/lib/scoringLease.ts"]);
  check(same.status === 0, `The scoring console, engine, conduct and lease view are unchanged since ${OLD} (so these events are 1.0.1's)`, same.status);

  // Per-address brakes from earlier runs on this stand-in (one address makes every phone here):
  // staff sign-in, new installs, player-code sign-in and cheers. This run's own calls count again.
  for (const prefix of ["staff-", "devices", "pcsignin", "pcode", "cheer"]) await db().from("request_counters").delete().like("bucket_key", `${prefix}%`);
  const tag = randomUUID().slice(0, 6);
  const made = { tournaments: [] as string[], groups: [] as string[], installs: [] as string[], users: [] as string[], codes: [] as string[], referees: [] as string[] };

  // ---- fixtures: a featured nations event (tennis ties) and a padel event, both Move Beyond's
  const { data: group } = await db().from("event_groups").insert({ slug: `e2e-old-${tag}`, name: `E2E Old App ${tag}`, featured_rank: 1, country_code: null }).select("*").single();
  made.groups.push(group!.id);
  const { data: t } = await db()
    .from("tournaments")
    .insert({
      name: `E2E Old Ties ${tag}`,
      slug: `e2e-old-ties-${tag}`,
      sport: "tennis",
      kind: "tournament",
      status: "active",
      public_access_enabled: true,
      format_config: { type: "group_knockout", ties: { rubbers: ["S2", "S1", "D"] } },
      event_group_id: group!.id,
      timezone: "Africa/Cairo",
    })
    .select("*")
    .single();
  const tid = t!.id as string;
  made.tournaments.push(tid);
  const { data: p } = await db()
    .from("tournaments")
    .insert({ name: `E2E Old Padel ${tag}`, slug: `e2e-old-padel-${tag}`, sport: "padel", kind: "tournament", status: "active", public_access_enabled: true, timezone: "Africa/Cairo", match_day_rules: newTournamentMatchDayRules("padel") })
    .select("*")
    .single();
  const pid = p!.id as string;
  made.tournaments.push(pid);

  try {
    const { data: nations } = await db()
      .from("teams")
      .insert([
        { tournament_id: tid, team_name: "Egypt", nation_code: "EGY", iso2: "eg", seed_number: 1 },
        { tournament_id: tid, team_name: "Japan", nation_code: "JPN", iso2: "jp", seed_number: 2 },
      ])
      .select("*");
    const egy = nations!.find((x) => x.nation_code === "EGY")!;
    const jpn = nations!.find((x) => x.nation_code === "JPN")!;
    const { data: tp } = await db()
      .from("players")
      .insert([
        { tournament_id: tid, team_id: egy.id, full_name: `Adam Old${tag}`, player_order: 1 },
        { tournament_id: tid, team_id: egy.id, full_name: `Karim Old${tag}`, player_order: 2 },
        { tournament_id: tid, team_id: jpn.id, full_name: `Jun Old${tag}`, player_order: 1 },
        { tournament_id: tid, team_id: jpn.id, full_name: `Ken Old${tag}`, player_order: 2 },
      ])
      .select("*");
    const pl = (team: string, order: number) => tp!.find((x) => x.team_id === team && x.player_order === order)!;
    const { data: court } = await db().from("courts").insert({ tournament_id: tid, court_name: "Court 1", court_order: 1 }).select("*").single();
    const { data: tie } = await db()
      .from("ties")
      .insert({ tournament_id: tid, stage: "group", round_no: 1, tie_order: 1, team_a_id: egy.id, team_b_id: jpn.id, court_id: court!.id, status: "live" })
      .select("*")
      .single();
    const rubber = async (no: number, type: string, a: string[], b: string[]) =>
      (
        await db()
          .from("matches")
          .insert({ tournament_id: tid, stage: "group", round_name: `Group A · ${type}`, match_order: no, court_id: court!.id, team_a_id: egy.id, team_b_id: jpn.id, status: "scheduled", tie_id: tie!.id, rubber_no: no, rubber_type: type, team_a_player_ids: a, team_b_player_ids: b })
          .select("*")
          .single()
      ).data!;
    const s2 = await rubber(1, "S2", [pl(egy.id, 2).id], [pl(jpn.id, 2).id]);
    const s1 = await rubber(2, "S1", [pl(egy.id, 1).id], [pl(jpn.id, 1).id]);

    const { data: pTeams } = await db()
      .from("teams")
      .insert([
        { tournament_id: pid, team_name: `Reds ${tag}` },
        { tournament_id: pid, team_name: `Blues ${tag}` },
      ])
      .select("*");
    const [reds, blues] = [pTeams![0]!, pTeams![1]!];
    await db()
      .from("players")
      .insert([
        { tournament_id: pid, team_id: reds.id, full_name: "Red One", player_order: 1 },
        { tournament_id: pid, team_id: reds.id, full_name: "Red Two", player_order: 2 },
        { tournament_id: pid, team_id: blues.id, full_name: "Blue One", player_order: 1 },
        { tournament_id: pid, team_id: blues.id, full_name: "Blue Two", player_order: 2 },
      ]);
    const { data: pCourt } = await db().from("courts").insert({ tournament_id: pid, court_name: "Centre", court_order: 1 }).select("*").single();
    const { data: pMatch } = await db()
      .from("matches")
      .insert({ tournament_id: pid, stage: "group", round_name: "Group A", match_order: 1, court_id: pCourt!.id, team_a_id: reds.id, team_b_id: blues.id, status: "scheduled" })
      .select("*")
      .single();
    const padelMid = pMatch!.id as string;
    const { data: pMatch2 } = await db()
      .from("matches")
      .insert({ tournament_id: pid, stage: "group", round_name: "Group A", match_order: 2, court_id: pCourt!.id, team_a_id: reds.id, team_b_id: blues.id, status: "scheduled" })
      .select("*")
      .single();
    const calledMid = pMatch2!.id as string;

    /* ======== a fan's phone ======== */
    section("A fan's phone: public reads (api/queries.ts)");
    const fan = new OldPhone();
    made.installs.push(fan.installationId);
    const cfg = await fan.api("/api/mobile/v1/config");
    check(cfg.status === 200 && typeof cfg.json?.flags === "object" && cfg.json?.signIn?.playerCode === true && typeof cfg.json?.minAppVersion === "string", "GET /config: flags, signIn.playerCode, minAppVersion", cfg.json?.signIn);
    check(cfg.json?.minAppVersion <= "1.0.1", "minAppVersion does not lock 1.0.1 out", cfg.json?.minAppVersion);
    shape("MConfig", cfg.json, "GET /config");
    // Discover is memoised for 5 s on the server: wait until it lists this run's group.
    let disc = await fan.api("/api/mobile/v1/discover");
    for (let i = 0; i < 12 && !(disc.json?.featured ?? []).some((g: { id: string }) => g.id === group!.id); i++) {
      await pause(500);
      disc = await fan.api("/api/mobile/v1/discover");
    }
    const featured = (disc.json?.featured ?? []).find((g: { id: string }) => g.id === group!.id);
    check(
      disc.status === 200 && Array.isArray(disc.json?.live) && featured?.tournaments?.some((x: { slug: string; name: string; id: string }) => x.slug === t!.slug && x.id === tid && x.name),
      "GET /discover: featured[].tournaments[] {id, slug, name}, live[]",
      featured?.tournaments?.length,
    );
    check(typeof featured?.name === "string" && "venue" in featured && "startsOn" in featured && "endsOn" in featured, "Featured group keeps name, venue, city, startsOn, endsOn (the pass card)", Object.keys(featured ?? {}));
    const bundle = await fan.api(`/api/mobile/v1/t/${t!.slug}/bundle`);
    check(
      bundle.status === 200 && bundle.json?.tournament?.slug === t!.slug && bundle.json?.teams?.length === 2 && bundle.json.teams.every((x: { code: string; name: string }) => typeof x.code === "string" && typeof x.name === "string"),
      "GET /t/:slug/bundle: tournament, teams[] {code, name}",
    );
    shape("MDiscover", disc.json, "GET /discover");
    shape("MEventGroup", featured, "Discover's featured group");
    shape("MTournamentCard", featured?.tournaments?.[0], "Discover's tournament card");
    check(typeof featured?.tournaments?.[0]?.skin === "object", "The card carries its skin (every AppSkin field is optional)");
    shape("MBundle", bundle.json, "GET /t/:slug/bundle");
    check(["isTies", "showPhotos", "rubberPlan", "lowerThird"].every((k) => k in (bundle.json?.tournament ?? {})), "Bundle tournament: isTies, showPhotos, rubberPlan, lowerThird");
    shape("MTeam", bundle.json?.teams?.[0], "A bundle team");
    shape("MPlayer", bundle.json?.teams?.[0]?.players?.[0], "A bundle player");
    const live = await fan.api(`/api/mobile/v1/t/${t!.slug}/live`);
    check(live.status === 200 && Array.isArray(live.json?.matches), "GET /t/:slug/live: matches[]");
    shape("MLive", live.json, "GET /t/:slug/live");
    shape("MMatch", live.json?.matches?.[0], "A live-feed match");
    shape("MTie", live.json?.ties?.[0], "A live-feed tie");
    const stand = await fan.api(`/api/mobile/v1/t/${t!.slug}/standings`);
    shape("MStandings", stand.json, "GET /t/:slug/standings");
    const md = await fan.api(`/api/mobile/v1/matches/${s1.id}`);
    check(md.status === 200 && md.json?.match?.id === s1.id && typeof md.json.match.status === "string", "GET /matches/:id: match {id, status}");
    shape("MMatchDetail", md.json, "GET /matches/:id");
    shape("MSituation", md.json?.situation, "The match's situation");
    const tl = await fan.api(`/api/mobile/v1/matches/${s1.id}/timeline`);
    shape("MTimeline", tl.json, "GET /matches/:id/timeline");
    const where = await fan.api(`/api/mobile/v1/ties/${tie!.id}`);
    check(where.status === 200 && where.json?.tournamentSlug === t!.slug, "GET /ties/:id: tournamentSlug");

    section("A fan's phone: registration, follows, alert types (push/register.ts, state/follows.ts, push/prefs.ts)");
    const reg = await fan.register(`ExponentPushToken[e2eold${tag}abcdefgh]`, true);
    check(reg.status === 200 && typeof reg.json?.installToken === "string" && reg.json?.tokenAccepted === true, "POST /devices: installToken, tokenAccepted", reg.json);
    fan.installToken = reg.json?.installToken ?? null;
    const reReg = await fan.register(`ExponentPushToken[e2eold${tag}abcdefgh]`, true);
    check(reReg.status === 200 && reReg.json?.installToken === fan.installToken, "Registering again (every launch) keeps the same token");
    const followsList = [
      { kind: "nation", key: "EGY", tournamentId: tid },
      { kind: "match", key: s1.id, tournamentId: tid },
      { kind: "tie", key: tie!.id, tournamentId: tid },
      { kind: "player", key: pl(egy.id, 1).id, tournamentId: tid },
      { kind: "tournament", key: t!.slug, tournamentId: tid },
      { kind: "event_group", key: group!.id, tournamentId: null },
    ];
    const sync = await fan.api("/api/mobile/v1/me/follows", { who: "me", body: { add: followsList, mergeInstall: false } });
    shape("MFollow", sync.json?.follows?.[0], "A follow");
    check(sync.status === 200 && sync.json?.follows?.length === 6 && sync.json.follows.every((f: { kind: string; key: string }) => f.kind && f.key), "POST /me/follows (syncFollows): every 1.0.1 kind is kept, follows[] back", sync.json?.follows?.length);
    const off = await fan.api("/api/mobile/v1/me/follows", { who: "me", body: { remove: [{ kind: "player", key: pl(egy.id, 1).id, tournamentId: tid }] } });
    check(off.status === 200 && off.json?.follows?.length === 5, "Unfollow (toggleFollow { remove: [f] })", off.json?.follows?.length);
    const on = await fan.api("/api/mobile/v1/me/follows", { who: "me", body: { add: [{ kind: "player", key: pl(egy.id, 1).id, tournamentId: tid }] } });
    check(on.status === 200 && on.json?.follows?.length === 6, "Follow again (toggleFollow { add: [f] })");
    // The same account on a newer app followed an organisation (a kind 1.0.1 does not know): 1.0.1 keeps it
    // in its list and sends it back on its next sync, which must still be accepted.
    await db().from("follows").insert({ owner_kind: "install", owner_id: fan.installationId, target_kind: "organization", target_key: MOVE_BEYOND_SLUG, tournament_id: null });
    const withOrg = await fan.api("/api/mobile/v1/me/follows", { who: "me", body: { add: on.json?.follows ?? [], mergeInstall: false } });
    check(withOrg.status === 200 && withOrg.json?.follows?.length === 7 && withOrg.json.follows.some((f: { kind: string }) => f.kind === "organization"), "A follow kind newer than 1.0.1 (organization) round-trips through its sync", withOrg.json?.follows?.length);
    const prefsGot = await fan.api("/api/mobile/v1/me/prefs", { who: "me" });
    check(prefsGot.status === 200 && oldFields("MAlertPrefs").every((k) => typeof prefsGot.json?.prefs?.[k] === "boolean"), "GET /me/prefs: every kind 1.0.1 knows, as booleans", prefsGot.json?.prefs);
    // The new app turned `court` off on this phone first; 1.0.1 then saves its whole (six-kind) object.
    await db().from("push_devices").update({ prefs: { court: false } }).eq("installation_id", fan.installationId);
    const oldPrefs = { scheduled: true, starting: false, live: true, finished: true, tie: true, major: false };
    const saved = await fan.api("/api/mobile/v1/me/prefs", { method: "PATCH", who: "me", body: oldPrefs });
    check(saved.status === 200 && saved.json?.prefs?.starting === false && saved.json.prefs.live === true && saved.json.prefs.major === false, "PATCH /me/prefs with 1.0.1's six-kind object is saved", saved.json?.prefs);
    check(saved.json?.prefs?.court === false, "…and leaves the newer `court` kind as it was stored", saved.json?.prefs);

    section("A fan's phone: pass, venue code, check-in, wallet (pass/*)");
    const none = await fan.api(`/api/mobile/v1/me/pass?group=${group!.id}`, { who: "me" });
    check(none.status === 200 && none.json?.pass === null, "GET /me/pass?group=: { pass: null } before opening");
    const opened = await fan.api("/api/mobile/v1/me/pass", { who: "me", body: { group: group!.id, nationCode: "EGY" } });
    const pass = opened.json?.pass;
    check(opened.status === 200 && typeof pass?.id === "string" && pass.eventGroupId === group!.id && pass.nationCode === "EGY" && "holderName" in pass && "attendance" in pass && "onsiteUnlockedAt" in pass, "POST /me/pass { group, nationCode }: pass {id, eventGroupId, nationCode, holderName, attendance, onsiteUnlockedAt}", pass && Object.keys(pass));
    shape("MPass", pass, "The pass");
    const named = await fan.api("/api/mobile/v1/me/pass", { who: "me", body: { group: group!.id, holderName: "Old Fan" } });
    check(named.status === 200 && named.json?.pass?.holderName === "Old Fan" && named.json.pass.nationCode === "EGY", "POST /me/pass { group, holderName } changes only the name");
    const unlock = await fan.api("/api/mobile/v1/passes/unlock", { who: "me", body: { groupSlug: group!.slug, code: rotatingCode(group!.slug) } });
    check(unlock.status === 200 && unlock.json?.pass?.eventGroupId === group!.id && "stampedDay" in unlock.json, "POST /passes/unlock { groupSlug, code }: pass, stampedDay", unlock.json?.stampedDay);
    const head = await fetch(`${BASE_URL}/api/mobile/v1/passes/${pass?.id}/apple`, { method: "HEAD" });
    check([200, 503].includes(head.status), "HEAD /passes/:id/apple answers 200 or 503 (1.0.1 shows 'coming soon' on 503)", head.status);

    section("A fan's phone: cheers (tie/[id].tsx, while the tie is live)");
    const cheer = await fan.api(`/api/mobile/v1/ties/${tie!.id}/cheer`, { who: "me", body: { nation: "EGY", n: 7 } });
    const cheers = await fan.api(`/api/mobile/v1/ties/${tie!.id}/cheers`);
    check(cheer.status === 200 && cheers.json?.cheers?.some((c: { nation: string; count: number }) => c.nation === "EGY" && c.count >= 7), "POST /ties/:id/cheer { nation, n }; GET /cheers", cheers.json);

    /* ======== referees ======== */
    section("Referee sign-in (staff/session { code })");
    const ref = new OldPhone();
    made.installs.push(ref.installationId);
    ref.installToken = (await ref.register(null, false)).json?.installToken ?? null;
    const wrong = await ref.api("/api/mobile/v1/staff/session", { body: { code: "not-the-code" } });
    check(wrong.status === 401 && typeof wrong.json?.error === "string", "A wrong code: 401 with an error message 1.0.1 shows", wrong.json?.error);
    const shared = await ref.api("/api/mobile/v1/staff/session", { body: { code: (process.env.REFEREE_PASSWORD ?? "").trim() } });
    check(shared.status === 200 && typeof shared.json?.token === "string" && shared.json.role === "referee" && Date.parse(shared.json.expiresAt) > Date.now() + 6 * 86400_000, "The shared referee password: { token, role: referee, expiresAt } (a week)", { role: shared.json?.role, expiresAt: shared.json?.expiresAt });
    ref.staff = { token: shared.json?.token, role: shared.json?.role, expiresAt: shared.json?.expiresAt };

    // An event code (Move Beyond's), as typed at the desk with its dashes and in lower case.
    const { data: mb } = await db().from("organizations").select("id").eq("slug", MOVE_BEYOND_SLUG).single();
    const eventCode = generateEventCode();
    const { data: codeRow } = await db().from("organization_codes").insert({ organization_id: mb!.id, role: "referee", code_hash: hashEventCode(eventCode), label: `e2e-old-${tag}` }).select("id").single();
    made.codes.push(codeRow!.id);
    const typed = `${eventCode.slice(0, 4)}-${eventCode.slice(4, 8)}-${eventCode.slice(8)}`.toLowerCase();
    const codeRef = new OldPhone();
    made.installs.push(codeRef.installationId);
    codeRef.installToken = (await codeRef.register(null, false)).json?.installToken ?? null;
    // Every referee code needs the referee's PIN (owner's decision), whole-event codes too.
    const PIN0 = "6274";
    const { data: r0 } = await db().from("referees").insert({ organization_id: mb!.id, name: `E2E Old Event Ref ${tag}`, pin_hash: hashRefereePin(mb!.id, PIN0) }).select("id").single();
    made.referees.push(r0!.id);
    const codeAlone = await codeRef.api("/api/mobile/v1/staff/session", { body: { code: typed } });
    check(codeAlone.status === 401 && /a space, then your PIN/.test(String(codeAlone.json?.error)), "A whole-event referee code alone: 401 with the message 1.0.1 shows (the code, a space, then the PIN)", codeAlone.json);
    const byCode = await codeRef.api("/api/mobile/v1/staff/session", { body: { code: ` ${typed} ${PIN0} `.trim() } });
    check(byCode.status === 200 && typeof byCode.json?.token === "string" && byCode.json.role === "referee" && typeof byCode.json.expiresAt === "string", "An event code with the PIN (\"<code> <PIN>\"): { token, role: referee, expiresAt }", byCode.json?.role);
    codeRef.staff = { token: byCode.json?.token, role: byCode.json?.role, expiresAt: byCode.json?.expiresAt };

    // A token the old server issued before the deploy (same legacy format, a week).
    const kept = new OldPhone();
    kept.staff = { token: sessionToken("referee", 24 * 7), role: "referee", expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString() };
    const keptList = await kept.api("/api/mobile/v1/referee/tournaments", { who: "staff" });
    check(keptList.status === 200 && keptList.json?.tournaments?.some((x: { id: string }) => x.id === tid), "A staff token issued before the deploy still works (no re-entry of the code)", keptList.status);

    section("Referee lists (referee/index.tsx, referee/[tournamentId].tsx)");
    const list = await ref.api("/api/mobile/v1/referee/tournaments", { who: "staff" });
    const row = list.json?.tournaments?.find((x: { id: string }) => x.id === tid);
    check(list.status === 200 && row && ["id", "name", "sport", "status", "is_demo"].every((k) => k in row), "GET /referee/tournaments: tournaments[] {id, name, sport, status, is_demo}", row);
    const codeList = await codeRef.api("/api/mobile/v1/referee/tournaments", { who: "staff" });
    check(codeList.status === 200 && codeList.json?.tournaments?.some((x: { id: string }) => x.id === pid), "…and with the event code", codeList.status);
    const picker = await ref.api(`/api/mobile/v1/referee/tournaments/${tid}/matches`, { who: "staff", headers: { "X-Device-Id": ref.installationId } });
    const prow = picker.json?.matches?.find((x: { id: string }) => x.id === s1.id);
    check(
      picker.status === 200 && typeof picker.json?.tournament?.name === "string" && prow && ["id", "order", "round", "court", "scheduledTime", "status", "tieId", "rubberType", "a", "b", "lineupsMissing", "heldBy"].every((k) => k in prow) && typeof prow.a?.checkedIn === "boolean",
      "GET /referee/tournaments/:id/matches: tournament, matches[] with every field the picker reads",
      prow && Object.keys(prow),
    );
    const signedOut = await new OldPhone().api(`/api/mobile/v1/referee/tournaments/${tid}/matches`, { who: "staff" });
    check([401, 403].includes(signedOut.status) && typeof signedOut.json?.error === "string", "Without a token: 401 (1.0.1 handles 401 and 403 alike) with a message", signedOut.status);

    section("A court referee code (migration 0034) typed by hand into 1.0.1, with the referee's PIN (migration 0035)");
    {
      const { data: c2 } = await db().from("courts").insert({ tournament_id: tid, court_name: "Court 2", court_order: 2 }).select("*").single();
      const { data: other } = await db()
        .from("matches")
        .insert({ tournament_id: tid, stage: "group", round_name: "Group B", match_order: 9, court_id: c2!.id, team_a_id: egy.id, team_b_id: jpn.id, status: "scheduled" })
        .select("id")
        .single();
      const courtCode = generateEventCode();
      const { data: cc } = await db()
        .from("organization_codes")
        .insert({ organization_id: mb!.id, role: "referee", tournament_id: tid, court_name: "Court 1", code_hash: hashEventCode(courtCode), label: `e2e-old-court-${tag}` })
        .select("id")
        .single();
      made.codes.push(cc!.id);
      const courtRef = new OldPhone();
      made.installs.push(courtRef.installationId);
      courtRef.installToken = (await courtRef.register(null, false)).json?.installToken ?? null;
      const PIN = "5839";
      const { data: rr } = await db().from("referees").insert({ organization_id: mb!.id, name: `E2E Old Ref ${tag}`, pin_hash: hashRefereePin(mb!.id, PIN) }).select("id").single();
      made.referees.push(rr!.id);
      const typedCourt = `${courtCode.slice(0, 4)}-${courtCode.slice(4, 8)}-${courtCode.slice(8)}`;
      const bare = await courtRef.api("/api/mobile/v1/staff/session", { body: { code: typedCourt } });
      check(bare.status === 401 && typeof bare.json?.error === "string" && /a space, then your PIN/.test(bare.json.error), "The court code alone: 401 with the message 1.0.1 shows (type the code, a space, then your PIN)", bare.json);
      const dashed = await courtRef.api("/api/mobile/v1/staff/session", { body: { code: `${typedCourt}-${PIN}` } });
      check(dashed.status === 200 && typeof dashed.json?.token === "string", "<COURT-CODE>-<PIN> in the one field signs in", dashed.status);
      const wrongPin = await courtRef.api("/api/mobile/v1/staff/session", { body: { code: `${typedCourt} 0007` } });
      check(wrongPin.status === 401 && typeof wrongPin.json?.error === "string", "A wrong PIN: 401 with a message", wrongPin.status);
      const signed = await courtRef.api("/api/mobile/v1/staff/session", { body: { code: `${typedCourt} ${PIN}` } });
      check(signed.status === 200 && typeof signed.json?.token === "string" && signed.json.role === "referee" && typeof signed.json.expiresAt === "string", "<COURT-CODE> <PIN>: { token, role: referee, expiresAt } as 1.0.1 reads it", signed.json && Object.keys(signed.json));
      courtRef.staff = { token: signed.json?.token, role: signed.json?.role, expiresAt: signed.json?.expiresAt };
      const cl = await courtRef.api("/api/mobile/v1/referee/tournaments", { who: "staff" });
      const crow = cl.json?.tournaments?.[0];
      check(cl.status === 200 && cl.json?.tournaments?.length === 1 && crow?.id === tid && ["id", "name", "sport", "status", "is_demo"].every((k) => k in crow), "Its referee list: only its court's tournament, with 1.0.1's fields", cl.json?.tournaments?.map((x: { id: string }) => x.id));
      const cp = await courtRef.api(`/api/mobile/v1/referee/tournaments/${tid}/matches`, { who: "staff", headers: { "X-Device-Id": courtRef.installationId } });
      const cms = (cp.json?.matches ?? []) as Record<string, unknown>[];
      check(
        cp.status === 200 && typeof cp.json?.tournament?.name === "string" && cms.length >= 2 && cms.every((x) => x.court === "Court 1") && !cms.some((x) => x.id === other!.id) && cms.every((x) => ["id", "order", "round", "court", "scheduledTime", "status", "tieId", "rubberType", "a", "b", "lineupsMissing", "heldBy"].every((k) => k in x)),
        "Its picker: Court 1's matches only (the rubbers), every field the picker reads",
        cms.map((x) => [x.court, x.rubberType]),
      );
      const theirs = await courtRef.api(`/api/mobile/v1/referee/matches/${other!.id}/bootstrap`, { who: "staff" });
      check(theirs.status === 404 && typeof theirs.json?.error === "string", "Court 2's match: 404 with an error message 1.0.1 shows", theirs.status);
      const padelList = await courtRef.api(`/api/mobile/v1/referee/tournaments/${pid}/matches`, { who: "staff" });
      check(padelList.status === 404, "Another event's picker: 404", padelList.status);
      // Out of the way of the sections after this one.
      await db().from("matches").delete().eq("id", other!.id);
      await db().from("courts").delete().eq("id", c2!.id);
    }

    section("Scoring S1 with the shared password: claim, state poll, points, undo, finish, reopen, finish (useLease.ts, useConsole.ts, sync.ts)");
    const dev = ref.installationId;
    const boot = await ref.api(`/api/mobile/v1/referee/matches/${s1.id}/bootstrap`, { who: "staff" });
    const bootKeys = ["match", "tournament", "courtName", "config", "tennis", "chess", "waitingForLineups", "sideA", "sideB", "snapshot", "reopenState", "history", "redBlueTeams", "lease"];
    check(boot.status === 200 && bootKeys.every((k) => k in (boot.json ?? {})) && boot.json.tennis === true && boot.json.waitingForLineups === null && boot.json.sideA?.players?.length === 1, "GET /referee/matches/:id/bootstrap: every field 1.0.1 reads", bootKeys.filter((k) => !(k in (boot.json ?? {}))));
    const claim = await ref.api(`/api/matches/${s1.id}/claim`, { who: "staff", body: { deviceId: dev, deviceLabel: label } });
    check(claim.status === 200 && claim.json?.controller === true && claim.json?.locked === false, "POST /claim { deviceId, deviceLabel }: controller (holder only when locked, as before)", claim.json?.controller);
    const poll = await ref.api(`/api/matches/${s1.id}/state`, { headers: { "X-Device-Id": dev } });
    check(poll.status === 200 && poll.json?.match?.id === s1.id && "snapshot" in poll.json && poll.json?.lease?.heldByYou === true, "GET /state (X-Device-Id, X-Install-Token, no staff token): match, snapshot, lease.heldByYou", poll.json?.lease);
    const c1 = new OldConsole(ref, dev, boot.json);
    c1.start("A");
    for (let i = 0; i < 6; i++) c1.point(i % 3 === 2 ? "B" : "A");
    c1.undo();
    c1.pause();
    c1.pause();
    const r1 = await c1.sync();
    check(r1?.status === 200 && Array.isArray(r1.json?.applied) && r1.json.applied.length === 10 && r1.json.last_event_number === 10, "POST /events: start, 6 points, UNDO, pause, resume → { applied, last_event_number }", r1?.json);
    check(r1?.json && "red_blue_teams" in r1.json && typeof r1.json.red_blue_teams === "boolean", "…with red_blue_teams (the console's red/blue switch)", r1?.json?.red_blue_teams);
    const replay = await ref.api(`/api/matches/${s1.id}/events`, { who: "staff", body: { deviceId: dev, events: c1.queue.slice(0, 3).map(({ sync_status: _s, ...e }) => (void _s, e)) } });
    check(replay.status === 200 && replay.json?.applied?.length === 0, "A lost reply re-sent: 200, nothing applied twice", replay.json);
    const renew = await ref.api(`/api/matches/${s1.id}/renew-lease`, { who: "staff", body: { deviceId: dev } });
    check(renew.status === 200 && renew.json?.renewed === true, "POST /renew-lease { deviceId }: renewed", renew.json);
    let guard = 0;
    while (!c1.finished && guard++ < 200) c1.point("A");
    const r2 = await c1.sync();
    const s1Row = (await db().from("matches").select("status, winner_team_id").eq("id", s1.id).single()).data;
    check(r2?.status === 200 && s1Row?.status === "completed" && s1Row.winner_team_id === egy.id, "Points to the end of the match (batches of 50): completed, Egypt won", { status: r2?.status, row: s1Row, err: r2?.json?.error });
    const s1Number = c1.number;
    c1.undo();
    c1.point("A");
    const r3 = await c1.sync();
    const s1Again = (await db().from("matches").select("status").eq("id", s1.id).single()).data;
    check(r3?.status === 200 && r3.json?.last_event_number === s1Number + 2 && s1Again?.status === "completed", "UNDO after the final point reopens; the point again finishes it", { status: r3?.status, err: r3?.json?.error, row: s1Again });
    const late = new OldConsole(ref, dev, (await ref.api(`/api/mobile/v1/referee/matches/${s1.id}/bootstrap`, { who: "staff" })).json);
    // A phone that missed the end and taps on from the score before it.
    late.state = { ...late.state!, matchOver: false, winner: null } as ScoreState;
    late.status = "live";
    late.point("B");
    const r4 = await late.sync();
    check(r4?.status === 409 && typeof r4.json?.error === "string" && Array.isArray(r4.json?.applied), "A point after the end: 409 with error and applied[] (1.0.1 shows it and stops)", r4?.json?.conflict);

    section("Handover between two phones (request-control / respond-control / release-lease)");
    const other = new OldPhone();
    other.staff = ref.staff;
    other.installToken = (await other.register(null, false)).json?.installToken ?? null;
    made.installs.push(other.installationId);
    const s2claim = await ref.api(`/api/matches/${s2.id}/claim`, { who: "staff", body: { deviceId: dev, deviceLabel: label } });
    const ask = await other.api(`/api/matches/${s2.id}/request-control`, { who: "staff", body: { deviceId: other.installationId, deviceLabel: "Pixel · app" } });
    const asked = await ref.api(`/api/matches/${s2.id}/state`, { headers: { "X-Device-Id": dev } });
    check(s2claim.json?.controller === true && ask.status === 200 && asked.json?.lease?.heldByYou === true, "POST /request-control { deviceId, deviceLabel } is accepted; the holder still holds", { ask: ask.status, lease: asked.json?.lease });
    const no = await ref.api(`/api/matches/${s2.id}/respond-control`, { who: "staff", body: { deviceId: dev, accept: false } });
    check(no.status === 200, "POST /respond-control { deviceId, accept: false }", no.status);
    const rel = await ref.api(`/api/matches/${s2.id}/release-lease`, { who: "staff", body: { deviceId: dev } });
    check(rel.status === 200, "POST /release-lease { deviceId }", rel.status);

    section("Scoring S2 with the event code, ended by retirement");
    const codeDev = codeRef.installationId;
    const boot2 = await codeRef.api(`/api/mobile/v1/referee/matches/${s2.id}/bootstrap`, { who: "staff" });
    check(boot2.status === 200 && boot2.json?.match?.id === s2.id, "Bootstrap with the event code", boot2.status);
    await codeRef.api(`/api/matches/${s2.id}/claim`, { who: "staff", body: { deviceId: codeDev, deviceLabel: label } });
    const c2 = new OldConsole(codeRef, codeDev, boot2.json);
    c2.start("B");
    for (let i = 0; i < 9; i++) c2.point("A");
    c2.endWith("RETIREMENT", "A");
    const r5 = await c2.sync();
    const s2Row = (await db().from("matches").select("status, winner_team_id").eq("id", s2.id).single()).data;
    check(r5?.status === 200 && s2Row?.status === "retired" && s2Row.winner_team_id === egy.id, "Retirement (payload.winner_team_id): retired, Egypt won", { status: r5?.status, err: r5?.json?.error, row: s2Row });

    section("Padel match with the event code: walkover");
    const pboot = await codeRef.api(`/api/mobile/v1/referee/matches/${padelMid}/bootstrap`, { who: "staff" });
    await codeRef.api(`/api/matches/${padelMid}/claim`, { who: "staff", body: { deviceId: codeDev, deviceLabel: label } });
    const c3 = new OldConsole(codeRef, codeDev, pboot.json);
    c3.start("A");
    c3.point("A");
    c3.endWith("WALKOVER", "B");
    const r6 = await c3.sync();
    const pRow = (await db().from("matches").select("status, winner_team_id").eq("id", padelMid).single()).data;
    check(pboot.status === 200 && r6?.status === 200 && pRow?.status === "walkover" && pRow.winner_team_id === blues.id, "Padel: start, point, WALKOVER → walkover, winner Blues", { status: r6?.status, err: r6?.json?.error, row: pRow });

    section("A match the organiser called to court (status ready, match day) scored from 1.0.1");
    const called = await fetch(`${BASE_URL}/api/matches/${calledMid}/call`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: `mb_session=${sessionToken("admin")}` }, body: JSON.stringify({ action: "call" }) });
    const cboot = await codeRef.api(`/api/mobile/v1/referee/matches/${calledMid}/bootstrap`, { who: "staff" });
    check([200, 201].includes(called.status) && cboot.json?.match?.status === "ready", "The organiser calls it; 1.0.1's bootstrap sees status ready", { call: called.status, status: cboot.json?.match?.status });
    await codeRef.api(`/api/matches/${calledMid}/claim`, { who: "staff", body: { deviceId: codeDev, deviceLabel: label } });
    const c4 = new OldConsole(codeRef, codeDev, cboot.json);
    c4.start("A");
    c4.point("A");
    c4.point("B");
    const r7 = await c4.sync();
    const callRow = (await db().from("match_calls").select("status").eq("match_id", calledMid).maybeSingle()).data;
    const cRow = (await db().from("matches").select("status").eq("id", calledMid).single()).data;
    check(r7?.status === 200 && cRow?.status === "live" && callRow?.status === "started", "Start + points from 1.0.1: the match goes live and the call is marked started", { sync: r7?.status, err: r7?.json?.error, match: cRow?.status, call: callRow?.status });

    section("The organiser enters the final result over 1.0.1's points (Phase 2): what the old phone sees");
    await codeRef.api(`/api/matches/${calledMid}/release-lease`, { who: "staff", body: { deviceId: codeDev } });
    // Final results are allowed per match ("either": points or a final score).
    await db().from("matches").update({ scoring_mode_override: "either" }).eq("id", calledMid);
    const entered = stateFromFinalScore(cboot.json.config, [{ a: 6, b: 4 }]);
    const snapNow = (await db().from("match_score_snapshots").select("last_event_number, snapshot_json").eq("match_id", calledMid).single()).data;
    const res = await fetch(`${BASE_URL}/api/matches/${calledMid}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken("admin")}` },
      body: JSON.stringify({
        deviceId: `organiser-${tag}`,
        events: [{ client_event_id: randomUUID(), event_number: (snapNow?.last_event_number ?? 0) + 1, event_type: "RESULT_ENTERED", team_id: reds.id, previous_state: snapNow?.snapshot_json ?? null, new_state: entered.ok ? entered.state : null, payload: { sets: [{ a: 6, b: 4 }] }, created_at_client: new Date().toISOString() }],
      }),
    });
    check(res.status === 200, "The organiser's result over the scored points is accepted (a correction)", res.status === 200 ? undefined : await res.text());
    c4.point("A");
    const stale = await c4.sync();
    check(stale?.status === 409 && typeof stale.json?.error === "string" && Array.isArray(stale.json?.applied), "1.0.1's next queued point: 409 with a message and applied[] (its sync shows a conflict, no crash)", stale?.json?.conflict);
    const reload = await codeRef.api(`/api/mobile/v1/referee/matches/${calledMid}/bootstrap`, { who: "staff" });
    check(reload.json?.match?.status === "completed" && Array.isArray(reload.json?.history) && reload.json.history.length === 0 && reload.json.reopenState === null, "'Load the server's score': completed, no history and no reopen state", { status: reload.json?.match?.status, history: reload.json?.history?.length, reopen: Boolean(reload.json?.reopenState) });
    const c5 = new OldConsole(codeRef, codeDev, reload.json);
    check(!c5.undo(), "…so 1.0.1's Undo button has nothing to send (no UNDO over an entered result)");

    section("The fan sees it (live feed, timeline, check-in, cheers, Live Activity)");
    await pause(4_500); // the live feed (1.5 s) and the timeline (4 s) are memoised on the server
    const liveAfter = await fan.api(`/api/mobile/v1/t/${t!.slug}/live`);
    const s1Live = liveAfter.json?.matches?.find((x: { id: string }) => x.id === s1.id);
    check(liveAfter.status === 200 && s1Live?.status === "completed" && Boolean(s1Live.score), "Live feed: S1 completed with its score", s1Live?.status);
    shape("MScore", s1Live?.score, "S1's score");
    const tl2 = await fan.api(`/api/mobile/v1/matches/${s1.id}/timeline`);
    check(tl2.status === 200 && tl2.json?.points?.length > 20, "Timeline has S1's points", tl2.json?.points?.length);
    // A third rubber, live, for the court check-in.
    const dbl = await rubber(3, "D", [pl(egy.id, 1).id, pl(egy.id, 2).id], [pl(jpn.id, 1).id, pl(jpn.id, 2).id]);
    await db().from("matches").update({ status: "live", started_at: new Date().toISOString() }).eq("id", dbl.id);
    const checkin = await fan.api(`/api/mobile/v1/matches/${dbl.id}/checkin`, { who: "me", body: { c: matchScreenCode(dbl.id) } });
    shape("MCheckInReply", checkin.json, "The check-in reply");
    check(checkin.status === 200 && ["checked_in", "already_checked_in"].includes(checkin.json?.status) && typeof checkin.json?.points === "number" && checkin.json?.pass?.eventGroupId === group!.id, "POST /matches/:id/checkin { c }: status, points, pass", checkin.json?.status ?? checkin.json);
    const tooOld = await fan.api(`/api/mobile/v1/matches/${dbl.id}/checkin`, { who: "me", body: { c: "AAAAAAAA" } });
    check(tooOld.status >= 400 && tooOld.status < 500 && typeof tooOld.json?.code === "string", "A bad check-in code: 4xx with { code } (checkInFeedback)", tooOld.json);
    const apns = randomBytes(32).toString("hex");
    const la = await fan.api("/api/mobile/v1/live-activities", { who: "me", body: { matchId: dbl.id, pushToken: apns } });
    const laRow = (await db().from("live_activity_tokens").select("push_token, installation_id").eq("push_token", apns).maybeSingle()).data;
    check(la.status === 200 && laRow?.installation_id === fan.installationId, "POST /live-activities { matchId, pushToken } (lockScreen.ts)", la.json);
    const laUpper = await fan.api("/api/mobile/v1/live-activities", { who: "me", body: { matchId: dbl.id, pushToken: apns.toUpperCase() } });
    check(laUpper.status === 200, "…the same token in upper case is the same row", laUpper.status);
    const laEnd = await fan.api("/api/mobile/v1/live-activities", { method: "DELETE", who: "me", body: { pushToken: apns.toUpperCase() } });
    const laEnded = (await db().from("live_activity_tokens").select("ended_at").eq("push_token", apns).maybeSingle()).data;
    check(laEnd.status === 200 && Boolean(laEnded?.ended_at), "DELETE /live-activities { pushToken } ends it (not called by 1.0.1; checked anyway)", laEnd.status);

    /* ======== players ======== */
    section("A player signs in with their code (auth/email.ts signInWithPlayerCode)");
    const codes = (await db().from("players").select("id, access_code, access_code_hash").in("id", [pl(egy.id, 1).id, pl(jpn.id, 1).id, pl(egy.id, 2).id])).data ?? [];
    const plainK = codes.find((x) => x.id === pl(egy.id, 2).id);
    const plainA = codes.find((x) => x.id === pl(egy.id, 1).id);
    const plainB = codes.find((x) => x.id === pl(jpn.id, 1).id);
    check(Boolean(plainA?.access_code) && !plainA?.access_code_hash && Boolean(plainB?.access_code), "Fresh players have plain codes not yet hashed (the transition before hash-player-codes runs)", { plain: Boolean(plainA?.access_code), hashed: Boolean(plainA?.access_code_hash) });
    const adamPhone = new OldPhone();
    made.installs.push(adamPhone.installationId);
    adamPhone.installToken = (await adamPhone.register(null, false)).json?.installToken ?? null;
    const pc = await adamPhone.api("/api/mobile/v1/auth/player-code", { who: "me", body: { code: plainA?.access_code } });
    check(
      pc.status === 200 && typeof pc.json?.userId === "string" && typeof pc.json?.accessToken === "string" && typeof pc.json?.refreshToken === "string" && "expiresAt" in pc.json && "displayName" in pc.json && pc.json?.player?.playerId === pl(egy.id, 1).id && typeof pc.json?.linked === "number",
      "POST /auth/player-code { code } with an unhashed code: session + player + linked",
      pc.json?.error ?? { linked: pc.json?.linked },
    );
    if (pc.json?.userId) made.users.push(pc.json.userId);
    const nowHashed = (await db().from("players").select("access_code, access_code_hash").eq("id", pl(egy.id, 1).id).single()).data;
    check(nowHashed?.access_code === null && Boolean(nowHashed?.access_code_hash), "…and the code is hashed on first use");
    const fin = await adamPhone.finish(pc.json, []);
    check(fin.follows.status === 200 && fin.device.status === 200, "After sign-in: follows sync (mergeInstall) and the phone registers with the session", { f: fin.follows.status, d: fin.device.status });
    const me = await adamPhone.api("/api/mobile/v1/me", { who: "me" });
    check(me.status === 200 && me.json?.user?.id === pc.json?.userId && me.json.user.registrationComplete === false && "pendingEmail" in me.json.user && "email" in me.json.user && "provider" in me.json.user, "GET /me: user {id, registrationComplete: false, pendingEmail, email, provider}", me.json?.user);
    const mine = await adamPhone.api("/api/mobile/v1/me/player", { who: "me" });
    const mp = mine.json?.player;
    shape("MMyPlayer", mp, "GET /me/player");
    shape("MMyPlayerEntry", mp?.entries?.[0], "A player entry");
    shape("MMyMatch", mp?.matches?.[0], "A player match");
    const phone = await adamPhone.api("/api/mobile/v1/me/player", { method: "PATCH", who: "me", body: { phone: "010 0123 4567" } });
    check(phone.status === 200 && phone.json?.player?.phone === "+201001234567", "PATCH /me/player { phone }: saved and shown back as E.164", phone.json?.player?.phone ?? phone.json);
    const jpeg = (await sharp({ create: { width: 512, height: 512, channels: 3, background: { r: 200, g: 30, b: 30 } } }).jpeg({ quality: 82 }).toBuffer()).toString("base64");
    const photo = await adamPhone.api("/api/mobile/v1/me/player/photo", { who: "me", body: { image: jpeg } });
    check(photo.status === 200 && typeof photo.json?.player?.photoUrl === "string", "POST /me/player/photo { image } (base64 JPEG): player.photoUrl", photo.json?.error ?? "ok");
    const reg2 = await adamPhone.api("/api/mobile/v1/auth/complete", { who: "me", body: { email: `e2e.old.adam.${tag}@example.com`, password: "Rally2026x" } });
    check(reg2.status === 200 && reg2.json?.status === "confirm" && typeof reg2.json?.email === "string" && typeof reg2.json?.message === "string", "POST /auth/complete { email, password }: { status: confirm, email, message }", reg2.json);
    const refresh = await fetch(`${BASE_URL}/api/mobile/v1/auth/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: adamPhone.user?.refreshToken }) });
    const rj = (await refresh.json().catch(() => null)) as { accessToken?: string; refreshToken?: string; expiresAt?: number | null } | null;
    check(refresh.status === 200 && Boolean(rj?.accessToken && rj?.refreshToken) && rj !== null && "expiresAt" in rj, "POST /auth/refresh { refreshToken }: accessToken, refreshToken, expiresAt", refresh.status);
    if (rj?.accessToken && adamPhone.user) adamPhone.user = { ...adamPhone.user, accessToken: rj.accessToken, refreshToken: rj.refreshToken!, expiresAt: rj.expiresAt ?? null };

    section("A code hashed by the deploy step (hash-player-codes.ts / the cron) still signs in");
    const { securePlayerCodes } = await import("../../src/lib/players/codeVault");
    await securePlayerCodes({ ids: [pl(egy.id, 2).id] });
    const karimRow = (await db().from("players").select("access_code, access_code_hash").eq("id", pl(egy.id, 2).id).single()).data;
    const karimPhone = new OldPhone();
    made.installs.push(karimPhone.installationId);
    karimPhone.installToken = (await karimPhone.register(null, false)).json?.installToken ?? null;
    const kc = await karimPhone.api("/api/mobile/v1/auth/player-code", { who: "me", body: { code: plainK?.access_code } });
    if (kc.json?.userId) made.users.push(kc.json.userId);
    check(karimRow?.access_code === null && Boolean(karimRow?.access_code_hash) && kc.status === 200 && kc.json?.player?.playerId === pl(egy.id, 2).id, "The code the player was sent, after the rows were hashed: signs in", kc.json?.error ?? "ok");

    section("A Google account claims a code; unlink; delete (player/me.ts, signIn.ts)");
    const junPhone = new OldPhone();
    made.installs.push(junPhone.installationId);
    junPhone.installToken = (await junPhone.register(null, false)).json?.installToken ?? null;
    await junPhone.api("/api/mobile/v1/me/follows", { who: "me", body: { add: [{ kind: "nation", key: "JPN", tournamentId: tid }], mergeInstall: false } });
    const g = await googleSignIn(junPhone, `e2e.old.jun.${tag}@example.com`);
    check(g.status === 200 && typeof g.json?.accessToken === "string" && g.json?.provider === "google", "Google: /auth/oauth/google → /auth/session { provider, code, codeVerifier }", g.json?.error ?? g.json?.provider);
    if (g.json?.userId) made.users.push(g.json.userId);
    const gf = await junPhone.finish(g.json, [{ kind: "nation", key: "JPN", tournamentId: tid }]);
    check(gf.follows.status === 200 && gf.follows.json?.follows?.some((f: { kind: string; key: string }) => f.kind === "nation" && f.key === "JPN"), "Signing in carries the guest's follows over (mergeInstall)", gf.follows.json?.follows?.length);
    const noPlayer = await junPhone.api("/api/mobile/v1/me/player", { who: "me" });
    check(noPlayer.status === 200 && noPlayer.json?.player === null, "GET /me/player before a code: { player: null }");
    const claimJ = await junPhone.api("/api/mobile/v1/me/player/claim", { who: "me", body: { code: plainB?.access_code } });
    check(claimJ.status === 200 && claimJ.json?.player?.playerId === pl(jpn.id, 1).id && typeof claimJ.json?.linked === "number", "POST /me/player/claim { code } (unhashed code): player + linked", claimJ.json?.error ?? claimJ.json?.linked);
    const badClaim = await junPhone.api("/api/mobile/v1/me/player/claim", { who: "me", body: { code: "ZZZZ2222" } });
    check(badClaim.status === 400 && typeof badClaim.json?.error === "string", "A wrong code: 400 with a message 1.0.1 shows", badClaim.json?.error);
    const unlink = await junPhone.api("/api/mobile/v1/me/player", { method: "DELETE", who: "me" });
    const after = await junPhone.api("/api/mobile/v1/me/player", { who: "me" });
    check(unlink.status === 200 && after.json?.player === null, "DELETE /me/player (this isn't me) unlinks", after.json);
    const again = new OldPhone();
    made.installs.push(again.installationId);
    again.installToken = (await again.register(null, false)).json?.installToken ?? null;
    const reSign = await again.api("/api/mobile/v1/auth/player-code", { who: "me", body: { code: plainB?.access_code } });
    if (reSign.json?.userId) made.users.push(reSign.json.userId);
    check(reSign.status === 200 && reSign.json?.player?.playerId === pl(jpn.id, 1).id, "Once unlinked, the same (now hashed) code signs in on another phone", reSign.json?.error ?? "ok");
    const juPass = await junPhone.api(`/api/mobile/v1/me/pass?group=${group!.id}`, { who: "me" });
    check(juPass.status === 200 && "pass" in (juPass.json ?? {}), "GET /me/pass as a signed-in account", juPass.status);
    const del = await junPhone.api("/api/mobile/v1/me/account", { method: "DELETE", who: "me" });
    check(del.status === 200, "DELETE /me/account (deleteAccount)", del.json);
    junPhone.user = null;
    const afterDel = await junPhone.register(null, false);
    check(afterDel.status === 200 && afterDel.json?.installToken === junPhone.installToken, "…then the phone registers again as a guest (signOut)", afterDel.status);
    const delAdam = await adamPhone.api("/api/mobile/v1/me/account", { method: "DELETE", who: "me" });
    check(delAdam.status === 200, "A player-code account deletes itself too", delAdam.json);

    section("Email accounts (auth/email.ts)");
    const mailPhone = new OldPhone();
    const email = `e2e.old.mail.${tag}@example.com`;
    const up = await mailPhone.api("/api/mobile/v1/auth/email/signup", { body: { email, password: "Rally2026x", name: "Old Mail" } });
    check(up.status === 200 && up.json?.status === "confirm" && up.json?.email === email && typeof up.json?.message === "string", "POST /auth/email/signup { email, password, name }: { status: confirm, email, message }", up.json);
    const mail = await fetch(`${SUPA}/auth/v1/_localdb/mail?to=${encodeURIComponent(email)}`).then((r) => r.json() as Promise<{ otp: string }[]>);
    const ver = await mailPhone.api("/api/mobile/v1/auth/email/verify", { body: { email, code: mail.at(-1)?.otp, purpose: "signup" } });
    check(ver.status === 200 && typeof ver.json?.accessToken === "string" && typeof ver.json?.userId === "string", "POST /auth/email/verify { email, code, purpose: signup }: a session", ver.json?.error ?? "ok");
    if (ver.json?.userId) made.users.push(ver.json.userId);
    const si = await mailPhone.api("/api/mobile/v1/auth/email/signin", { body: { email, password: "Rally2026x" } });
    check(si.status === 200 && typeof si.json?.accessToken === "string" && si.json?.registrationComplete === true, "POST /auth/email/signin { email, password }", si.json?.error ?? "ok");
    const fg = await mailPhone.api("/api/mobile/v1/auth/email/forgot", { body: { email } });
    const rs = await mailPhone.api("/api/mobile/v1/auth/email/resend", { body: { email } });
    check(fg.status === 200 && typeof fg.json?.message === "string" && rs.status === 200 && typeof rs.json?.message === "string", "POST /auth/email/forgot and /resend { email }: { message }", [fg.status, rs.status]);
  } finally {
    section("Cleanup");
    await db().from("live_activity_tokens").delete().in("installation_id", made.installs);
    await db().from("follows").delete().in("owner_id", [...made.installs, ...made.users]);
    await db().from("event_passes").delete().in("event_group_id", made.groups);
    for (const id of made.users) {
      await db().from("player_claims").delete().eq("user_id", id);
      await db().from("player_profiles").update({ auth_user_id: null }).eq("auth_user_id", id);
      await db().from("app_users").delete().eq("auth_user_id", id);
      await db().from("app_user_deletions").delete().eq("auth_user_id", id);
    }
    await db().from("push_devices").delete().in("installation_id", made.installs);
    await db().from("referee_sessions").delete().in("referee_id", made.referees);
    await db().from("audit_logs").delete().in("actor_referee_id", made.referees);
    await db().from("organization_codes").delete().in("id", made.codes);
    await db().from("referees").delete().in("id", made.referees);
    await db().from("audit_logs").delete().in("tournament_id", made.tournaments);
    await db().from("notification_events").delete().in("tournament_id", made.tournaments);
    await db().from("tournaments").delete().in("id", made.tournaments);
    await db().from("event_groups").delete().in("id", made.groups);
    await db().from("request_counters").delete().like("bucket_key", "staff-%");
    const { count } = await db().from("tournaments").select("id", { count: "exact", head: true }).in("id", made.tournaments);
    check((count ?? 0) === 0, "Everything made here is removed", count);
  }
  finish("Move Score 1.0.1 against this server");
}

void main();

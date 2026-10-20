import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Referee PIN brakes (audit H1) against an in-memory stand-in for the PostgREST calls
 * checkRefereePin makes (referees, referee_sessions, request_counters, audit_logs,
 * organization_members). takeRateLimit's compare-and-set runs on it as it would on the
 * database.
 */
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
const sent: { to: string; template: string }[] = [];

class Query implements PromiseLike<{ data: unknown; error: null }> {
  private op: "select" | "update" | "insert" | "upsert" = "select";
  private patch: Row | Row[] = {};
  private ignoreDup = false;
  private single = false;
  private lim = Infinity;
  private filters: ((r: Row) => boolean)[] = [];
  constructor(private table: string) {}
  select() {
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.patch = patch;
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = "insert";
    this.patch = rows;
    return this;
  }
  upsert(row: Row, o?: { ignoreDuplicates?: boolean }) {
    this.op = "upsert";
    this.patch = row;
    this.ignoreDup = Boolean(o?.ignoreDuplicates);
    return this;
  }
  eq(k: string, v: unknown) {
    this.filters.push((r) => r[k] === v);
    return this;
  }
  in(k: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[k]));
    return this;
  }
  gte(k: string, v: string) {
    this.filters.push((r) => String(r[k]) >= v);
    return this;
  }
  lt(k: string, v: string) {
    this.filters.push((r) => String(r[k]) < v);
    return this;
  }
  is(k: string, v: unknown) {
    this.filters.push((r) => (r[k] ?? null) === v);
    return this;
  }
  order() {
    return this;
  }
  limit(n: number) {
    this.lim = n;
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  single_() {
    return this;
  }
  private run(): unknown {
    const t = (tables[this.table] ??= []);
    if (this.op === "insert") {
      for (const r of [this.patch].flat() as Row[]) t.push({ id: crypto.randomUUID(), ...r });
      return null;
    }
    if (this.op === "upsert") {
      const row = this.patch as Row;
      if (t.some((r) => r.bucket_key === row.bucket_key)) return this.ignoreDup ? [] : [row];
      t.push({ ...row });
      return [{ bucket_key: row.bucket_key }];
    }
    const hits = t.filter((r) => this.filters.every((f) => f(r))).slice(0, this.lim);
    if (this.op === "update") {
      for (const r of hits) Object.assign(r, this.patch);
      return hits.map((r) => ({ ...r }));
    }
    const out = hits.map((r) => ({ ...r }));
    return this.single ? (out[0] ?? null) : out;
  }
  then<A, B>(ok?: ((v: { data: unknown; error: null }) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve({ data: this.run(), error: null as null }).then(ok, bad);
  }
}

vi.mock("../supabase", () => ({ db: () => ({ from: (t: string) => new Query(t) }) }));
vi.mock("../messaging/queue", () => ({ sendTransactional: async (m: { to: string; template: string }) => (sent.push(m), { ok: true }) }));
vi.mock("../messaging/links", () => ({ siteUrl: () => "https://tour.example" }));

process.env.EVENT_CODE_PEPPER ??= "test-event-code-pepper-0123456789abcdef";

const { checkRefereePin, refereeChoices } = await import("./server");
const { hashRefereeDevice, hashRefereePin } = await import("./pin");
const { PIN_ORG_TIERS } = await import("./rules");

const ORG = "11111111-1111-4111-8111-111111111111";
const GROUP = "22222222-2222-4222-8222-222222222222";
const SARA = "a1111111-1111-4111-8111-111111111111";
const LINA = "a2222222-2222-4222-8222-222222222222";
const OMAR = "a3333333-3333-4333-8333-333333333333";
const ELSEWHERE = "a4444444-4444-4444-8444-444444444444";
const PIN: Record<string, string> = { [SARA]: "4821", [LINA]: "7305", [OMAR]: "6194", [ELSEWHERE]: "2958" };
const court = { id: "c1111111-1111-4111-8111-111111111111", organization_id: ORG, role: "referee" as const, tournament_id: null, event_group_id: GROUP, court_name: "Court 3", referee_id: null };
const masterCode = { ...court, id: "c2222222-2222-4222-8222-222222222222", role: "master_referee" as const, court_name: null, referee_id: OMAR };
const ip = (n: number) => `198.51.100.${n}`;

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  sent.length = 0;
  const ref = (id: string, name: string, role = "referee", group: string | null = null, phone = "+201000000000") => ({
    id, organization_id: ORG, event_group_id: group, name, phone, photo_url: null, role, pin_hash: hashRefereePin(ORG, PIN[id]), pin_set_at: "2026-10-01T00:00:00Z", status: "active", created_at: "2026-10-01T00:00:00Z",
  });
  tables.referees = [ref(SARA, "Sara"), ref(LINA, "Lina", "referee", GROUP), ref(OMAR, "Omar", "master_referee"), ref(ELSEWHERE, "Nour", "referee", "99999999-9999-4999-8999-999999999999")];
  tables.organization_members = [{ id: "m1", organization_id: ORG, status: "active", role: "owner", invited_email: "owner@club.example" }];
});

const wrong = (id: string) => (PIN[id] === "1357" ? "1358" : "1357");

describe("the PIN step's names (audit H1)", () => {
  it("lists the code's referees by name only, never a phone or a PIN hash", async () => {
    const list = await refereeChoices(court);
    expect(list.map((r) => r.name).sort()).toEqual(["Lina", "Omar", "Sara"]);
    expect(JSON.stringify(list)).not.toMatch(/phone|pin|\+20/);
  });
  it("a master code lists its own master referee only", async () => {
    expect((await refereeChoices(masterCode)).map((r) => r.name)).toEqual(["Omar"]);
  });
  it("a name not on the code's list is refused before any PIN is tried", async () => {
    expect(await checkRefereePin(court, PIN[ELSEWHERE], { refereeId: ELSEWHERE, ip: ip(1) })).toMatchObject({ ok: false, reason: "unknown_referee" });
    expect(await checkRefereePin(masterCode, PIN[SARA], { refereeId: SARA, ip: ip(1) })).toMatchObject({ ok: false, reason: "unknown_referee" });
  });
});

describe("a PIN is checked against the picked referee only", () => {
  it("the right PIN for the name signs in; another referee's PIN is wrong", async () => {
    expect(await checkRefereePin(court, PIN[SARA], { refereeId: SARA, ip: ip(1) })).toMatchObject({ ok: true, referee: { id: SARA } });
    expect(await checkRefereePin(court, PIN[LINA], { refereeId: SARA, ip: ip(1) })).toMatchObject({ ok: false, reason: "wrong_pin", refereeName: "Sara" });
  });
  it("a master referee may pick themselves on a court code", async () => {
    expect(await checkRefereePin(court, PIN[OMAR], { refereeId: OMAR, ip: ip(1) })).toMatchObject({ ok: true, referee: { id: OMAR } });
  });
});

describe("brakes: per referee, never per court code", () => {
  it("5 wrong PINs lock that referee only; the court and the others are unaffected", async () => {
    const left: (number | undefined)[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await checkRefereePin(court, wrong(SARA), { refereeId: SARA, ip: ip(10 + i) });
      left.push(r.ok ? -1 : r.triesLeft);
    }
    expect(left).toEqual([4, 3, 2, 1, 0]);
    expect(await checkRefereePin(court, PIN[SARA], { refereeId: SARA, ip: ip(20) })).toMatchObject({ ok: false, reason: "pin_locked", refereeName: "Sara" });
    // Same court code, another referee: still signs in (the old per-code lock is gone).
    expect(await checkRefereePin(court, PIN[LINA], { refereeId: LINA, ip: ip(20) })).toMatchObject({ ok: true });
    expect((tables.request_counters ?? []).some((r) => String(r.bucket_key).includes(court.id))).toBe(false);
  });
  it("a right PIN is refunded: it never counts", async () => {
    for (let i = 0; i < 8; i++) expect((await checkRefereePin(court, PIN[SARA], { refereeId: SARA, ip: ip(1) })).ok).toBe(true);
    const counts = (tables.request_counters ?? []).map((r) => r.count);
    expect(counts.every((c) => c === 0)).toBe(true);
  });
  it("a device that signed in as that referee today gets back in while they are locked; a stranger's does not", async () => {
    const mine = "app:install-sara-0000000000";
    tables.referee_sessions = [{ id: "s1", referee_id: SARA, organization_id: ORG, device_hash: hashRefereeDevice(mine), signed_in_at: new Date(Date.now() - 3600_000).toISOString() }];
    for (let i = 0; i < 5; i++) await checkRefereePin(court, wrong(SARA), { refereeId: SARA, ip: ip(30 + i), deviceKey: "web:attacker-browser-00000000" });
    expect(await checkRefereePin(court, PIN[SARA], { refereeId: SARA, ip: ip(40), deviceKey: "web:another-browser-0000000" })).toMatchObject({ ok: false, reason: "pin_locked" });
    expect(await checkRefereePin(court, PIN[SARA], { refereeId: SARA, ip: ip(40), deviceKey: mine })).toMatchObject({ ok: true });
  });
  it("a device from more than 24 h ago is not known any more", async () => {
    const old = "app:install-sara-0000000000";
    tables.referee_sessions = [{ id: "s1", referee_id: SARA, organization_id: ORG, device_hash: hashRefereeDevice(old), signed_in_at: new Date(Date.now() - 25 * 3600_000).toISOString() }];
    for (let i = 0; i < 5; i++) await checkRefereePin(court, wrong(SARA), { refereeId: SARA, ip: ip(50 + i) });
    expect(await checkRefereePin(court, PIN[SARA], { refereeId: SARA, ip: ip(60), deviceKey: old })).toMatchObject({ ok: false, reason: "pin_locked" });
  });
});

describe("the organisation-wide budget", () => {
  it("wrong PINs across referees fill it, pause new devices, alert the owners once; known devices still get in", async () => {
    const tier = PIN_ORG_TIERS[0].limit;
    const ids = [SARA, LINA, OMAR];
    for (let i = 0; i < tier; i++) {
      const who = ids[i % 3];
      await checkRefereePin(court, wrong(who), { refereeId: who, ip: ip(i % 200) });
      // Keep each referee under their own lock: this is many referees' worth of guesses.
      for (const r of tables.request_counters ?? []) if (String(r.bucket_key).startsWith("staff-pin-ref:")) r.count = 0;
    }
    const alerts = (tables.audit_logs ?? []).filter((a) => a.action === "REFEREE_PIN_BRAKE");
    expect(alerts).toHaveLength(1);
    expect(sent).toEqual([expect.objectContaining({ to: "owner@club.example", template: "staff_alert" })]);
    expect(await checkRefereePin(court, PIN[LINA], { refereeId: LINA, ip: ip(250) })).toMatchObject({ ok: false, reason: "pin_paused" });
    const mine = "web:lina-browser-0000000000";
    tables.referee_sessions = [{ id: "s2", referee_id: LINA, organization_id: ORG, device_hash: hashRefereeDevice(mine), signed_in_at: new Date().toISOString() }];
    expect(await checkRefereePin(court, PIN[LINA], { refereeId: LINA, ip: ip(250), deviceKey: mine })).toMatchObject({ ok: true });
  });
});

describe("Move Score 1.0.1 (no name): matched across the code's referees, org budget only", () => {
  it("signs in whoever has the PIN; a wrong one counts for the organisation, never a referee", async () => {
    expect(await checkRefereePin(court, PIN[LINA], { ip: ip(1) })).toMatchObject({ ok: true, referee: { id: LINA } });
    expect(await checkRefereePin(court, PIN[ELSEWHERE], { ip: ip(1) })).toMatchObject({ ok: false, reason: "wrong_pin" });
    expect(await checkRefereePin(masterCode, PIN[SARA], { ip: ip(1) })).toMatchObject({ ok: false, reason: "wrong_pin" });
    expect(await checkRefereePin(masterCode, PIN[OMAR], { ip: ip(1) })).toMatchObject({ ok: true });
    const keys = (tables.request_counters ?? []).filter((r) => Number(r.count) > 0).map((r) => String(r.bucket_key));
    expect(keys.some((k) => k.startsWith("staff-pin-org1:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("staff-pin-ref:"))).toBe(false);
  });
});

describe("Move Score 1.0.1's own tighter budget", () => {
  it("10 nameless wrong PINs pause the nameless path (and alert); a named sign-in still works", async () => {
    for (let i = 0; i < 10; i++) await checkRefereePin(court, "1111", { ip: ip(i) });
    expect(await checkRefereePin(court, PIN[SARA], { ip: ip(70) })).toMatchObject({ ok: false, reason: "pin_paused" });
    expect((tables.audit_logs ?? []).some((a) => a.action === "REFEREE_PIN_BRAKE")).toBe(true);
    expect(await checkRefereePin(court, PIN[SARA], { refereeId: SARA, ip: ip(70) })).toMatchObject({ ok: true });
  });
});

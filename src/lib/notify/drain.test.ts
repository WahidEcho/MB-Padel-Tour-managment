import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* A tiny in-memory stand-in for the PostgREST calls the drain makes. */
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
const DEFAULTS: Record<string, Row> = {
  notification_deliveries: { status: "queued", ticket_id: null, error: null, sent_at: null, receipt_checked_at: null },
};

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

class Query implements PromiseLike<{ data: unknown; error: null }> {
  private op: "select" | "update" | "upsert" = "select";
  private patch: Row = {};
  private rows: Row[] = [];
  private conflict: string[] = [];
  private ignore = false;
  private returning = false;
  private single = false;
  private max = Infinity;
  private sortBy: string | null = null;
  private filters: ((r: Row) => boolean)[] = [];
  constructor(private table: string) {}
  select() {
    if (this.op !== "select") this.returning = true;
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.patch = patch;
    return this;
  }
  upsert(rows: Row | Row[], opts: { onConflict: string; ignoreDuplicates?: boolean }) {
    this.op = "upsert";
    this.rows = Array.isArray(rows) ? rows : [rows];
    this.conflict = opts.onConflict.split(",");
    this.ignore = Boolean(opts.ignoreDuplicates);
    return this;
  }
  eq(k: string, v: unknown) {
    this.filters.push((r) => r[k] === v);
    return this;
  }
  lt(k: string, v: unknown) {
    this.filters.push((r) => r[k] != null && cmp(r[k], v) < 0);
    return this;
  }
  lte(k: string, v: unknown) {
    this.filters.push((r) => r[k] != null && cmp(r[k], v) <= 0);
    return this;
  }
  gte(k: string, v: unknown) {
    this.filters.push((r) => r[k] != null && cmp(r[k], v) >= 0);
    return this;
  }
  in(k: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[k]));
    return this;
  }
  is(k: string, v: null) {
    this.filters.push((r) => r[k] == v);
    return this;
  }
  not(k: string, _op: "is", v: null) {
    this.filters.push((r) => r[k] != v);
    return this;
  }
  order(k: string) {
    this.sortBy = k;
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  private run(): unknown {
    const t = (tables[this.table] ??= []);
    if (this.op === "upsert") {
      for (const row of this.rows) {
        const hit = t.find((r) => this.conflict.every((c) => r[c] === row[c]));
        if (hit && !this.ignore) Object.assign(hit, row);
        else if (!hit) t.push({ ...DEFAULTS[this.table], ...row });
      }
      return null;
    }
    let hits = t.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") {
      for (const r of hits) Object.assign(r, this.patch);
      if (!this.returning) return null;
    }
    if (this.sortBy) hits = [...hits].sort((a, b) => cmp(a[this.sortBy!], b[this.sortBy!]));
    hits = hits.slice(0, this.max).map((r) => ({ ...r }));
    return this.single ? (hits[0] ?? null) : hits;
  }
  then<A, B>(ok?: ((v: { data: unknown; error: null }) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve({ data: this.run(), error: null as null }).then(ok, bad);
  }
}

vi.mock("../supabase", () => ({ db: () => ({ from: (t: string) => new Query(t) }) }));

const { drainNotifications, checkReceipts, MAX_ATTEMPTS } = await import("./drain");

/* ---------------- fixtures ---------------- */

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;

function seed(event: Partial<Row> = {}) {
  for (const k of Object.keys(tables)) delete tables[k];
  tables.follows = [
    { owner_kind: "install", owner_id: "inst-1", target_kind: "match", target_key: "m1" },
    { owner_kind: "install", owner_id: "inst-2", target_kind: "match", target_key: "m1" },
  ];
  tables.push_devices = [
    { id: "d1", installation_id: "inst-1", user_id: null, expo_push_token: "ExponentPushToken[1]", prefs: {}, disabled_at: null },
    { id: "d2", installation_id: "inst-2", user_id: null, expo_push_token: "ExponentPushToken[2]", prefs: {}, disabled_at: null },
  ];
  tables.notification_events = [
    {
      id: "e1",
      kind: "match_finished",
      status: "pending",
      attempts: 0,
      fire_at: ago(MIN),
      claimed_at: null,
      error: null,
      sent_at: null,
      payload: { title: "T", body: "B", url: "movescore://match/m1", category: "finished", targets: [{ kind: "match", key: "m1" }] },
      ...event,
    },
  ];
  tables.notification_deliveries = [];
}

const event = () => tables.notification_events![0]!;
const delivery = (device: string) => tables.notification_deliveries!.find((d) => d.device_id === device);

type Reply = { status?: number; tickets?: Row[]; receipts?: Record<string, Row> };
const fetchMock = vi.fn();
function replies(...rs: Reply[]) {
  for (const r of rs) {
    fetchMock.mockResolvedValueOnce({
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => ({ data: r.receipts ?? r.tickets ?? [] }),
    });
  }
}
/** The tokens each push request was addressed to. */
const sentTo = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/push/send")).map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { to: string }[]).map((m) => m.to));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ---------------- tests ---------------- */

describe("drain retries", () => {
  it("sends on the next drain when Expo failed the first time (rows already inserted)", async () => {
    seed();
    replies({ status: 503 });
    expect(await drainNotifications()).toEqual({ events: 1, sent: 0 });
    expect(event()).toMatchObject({ status: "pending", attempts: 1, error: "Expo push 503" });
    expect(delivery("d1")?.status).toBe("queued");

    replies({ tickets: [{ status: "ok", id: "t1" }, { status: "ok", id: "t2" }] });
    expect(await drainNotifications()).toEqual({ events: 1, sent: 2 });
    expect(sentTo()[1]).toEqual(["ExponentPushToken[1]", "ExponentPushToken[2]"]);
    expect(event()).toMatchObject({ status: "sent", attempts: 2, error: null });
    expect(delivery("d1")).toMatchObject({ status: "sent", ticket_id: "t1" });
    expect(delivery("d2")).toMatchObject({ status: "sent", ticket_id: "t2" });
  });

  it("re-sends only to phones not yet alerted, and only marks the event sent when all are", async () => {
    seed();
    replies({ tickets: [{ status: "ok", id: "t1" }, { status: "error", details: { error: "MessageRateExceeded" } }] });
    await drainNotifications();
    expect(event().status).toBe("pending");
    expect(delivery("d2")).toMatchObject({ status: "error", error: "MessageRateExceeded" });

    replies({ tickets: [{ status: "ok", id: "t2" }] });
    await drainNotifications();
    expect(sentTo()[1]).toEqual(["ExponentPushToken[2]"]);
    expect(event().status).toBe("sent");
  });

  it("treats an uninstalled app as settled and switches the phone off", async () => {
    seed();
    replies({ tickets: [{ status: "ok", id: "t1" }, { status: "error", details: { error: "DeviceNotRegistered" } }] });
    await drainNotifications();
    expect(event().status).toBe("sent");
    expect(delivery("d2")?.status).toBe("failed");
    expect(tables.push_devices!.find((d) => d.id === "d2")).toMatchObject({ expo_push_token: null });
    expect(tables.push_devices!.find((d) => d.id === "d2")?.disabled_at).not.toBeNull();
  });

  it("gives up after the last attempt", async () => {
    seed({ attempts: MAX_ATTEMPTS - 1 });
    replies({ status: 500 });
    await drainNotifications();
    expect(event().status).toBe("failed");
  });
});

describe("stuck events", () => {
  it("returns an event stuck in 'sending' for over five minutes and sends it", async () => {
    seed({ status: "sending", attempts: 1, claimed_at: ago(10 * MIN) });
    replies({ tickets: [{ status: "ok", id: "t1" }, { status: "ok", id: "t2" }] });
    expect(await drainNotifications()).toEqual({ events: 1, sent: 2 });
    expect(event()).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("leaves an event another drain is sending right now", async () => {
    seed({ status: "sending", attempts: 1, claimed_at: ago(MIN) });
    expect(await drainNotifications()).toEqual({ events: 0, sent: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(event().status).toBe("sending");
  });

  it("fails a stuck event that has used all its attempts", async () => {
    seed({ status: "sending", attempts: MAX_ATTEMPTS, claimed_at: ago(10 * MIN) });
    await drainNotifications();
    expect(event().status).toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("receipts", () => {
  it("checks tickets sent 15+ minutes ago, records the outcome and switches off gone phones", async () => {
    seed({ status: "sent" });
    tables.notification_deliveries = [
      { event_id: "e1", device_id: "d1", status: "sent", ticket_id: "t1", sent_at: ago(20 * MIN), receipt_checked_at: null, error: null },
      { event_id: "e1", device_id: "d2", status: "sent", ticket_id: "t2", sent_at: ago(20 * MIN), receipt_checked_at: null, error: null },
      { event_id: "e1", device_id: "d3", status: "sent", ticket_id: "t3", sent_at: ago(2 * MIN), receipt_checked_at: null, error: null },
    ];
    replies({ receipts: { t1: { status: "ok" }, t2: { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } } } });
    expect(await checkReceipts()).toEqual({ checked: 2, failed: 1 });
    const asked = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)) as { ids: string[] };
    expect(asked.ids).toEqual(["t1", "t2"]);
    expect(delivery("d1")).toMatchObject({ status: "sent" });
    expect(delivery("d1")?.receipt_checked_at).not.toBeNull();
    expect(delivery("d2")).toMatchObject({ status: "failed", error: "DeviceNotRegistered" });
    expect(delivery("d3")?.receipt_checked_at).toBeNull();
    expect(tables.push_devices!.find((d) => d.id === "d2")?.expo_push_token).toBeNull();
  });

  it("logs setup errors loudly", async () => {
    seed({ status: "sent" });
    tables.notification_deliveries = [
      { event_id: "e1", device_id: "d1", status: "sent", ticket_id: "t1", sent_at: ago(20 * MIN), receipt_checked_at: null, error: null },
    ];
    replies({ receipts: { t1: { status: "error", message: "bad key", details: { error: "InvalidCredentials" } } } });
    await checkReceipts();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("[push:receipts] InvalidCredentials"));
  });
});

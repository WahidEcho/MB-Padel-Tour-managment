/**
 * The referee's score queue on the phone. Every tap is written here (event and
 * resulting state in one transaction) before the screen treats it as recorded,
 * so a dead battery or a killed app loses nothing. Same shape as the web
 * console's queue and the server's events route.
 *
 * Every call runs through one promise chain on one connection, one at a time.
 * expo-sqlite's exclusive transaction opens a second connection, and a sync's
 * `mark` landing on the first while a tap's write held the second failed with
 * "database is locked": the point was lost and its number left a hole that
 * every later sync was refused over.
 */
import { Platform } from "react-native";
import type { ScoreState } from "@core";
import { config } from "../config";

export interface QueuedEvent {
  client_event_id: string;
  match_id: string;
  event_number: number;
  event_type: string;
  team_id: string | null;
  previous_state: ScoreState | null;
  new_state: ScoreState;
  payload: Record<string, unknown> | null;
  created_at_client: string;
  sync_status: "pending" | "synced" | "abandoned";
}

export interface LocalMatch {
  match_id: string;
  state: ScoreState | null;
  history: ScoreState[];
  last_event_number: number;
  match_status: string;
}

interface Backend {
  record(e: QueuedEvent, m: LocalMatch): Promise<void>;
  pending(matchId: string): Promise<QueuedEvent[]>;
  /** Every event of the match still in play (waiting or sent), not the given-up ones. */
  events(matchId: string): Promise<QueuedEvent[]>;
  mark(ids: string[], status: "synced"): Promise<void>;
  /** Gives up the match's unsent events: kept apart on the phone, never sent. Returns how many. */
  abandon(matchId: string): Promise<number>;
  match(matchId: string): Promise<LocalMatch | null>;
  saveMatch(m: LocalMatch): Promise<void>;
  /** Drops the phone's copy of the match, so the phone no longer counts as scoring it. */
  forget(matchId: string): Promise<void>;
  matchesWithPending(): Promise<string[]>;
}

/** Runs each call after the one before has finished, whatever its outcome. */
function serialize(b: Backend): Backend {
  let tail: Promise<unknown> = Promise.resolve();
  const one =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    (...a: A): Promise<R> => {
      const run = tail.then(
        () => fn(...a),
        () => fn(...a),
      );
      tail = run.catch(() => undefined);
      return run;
    };
  return {
    record: one(b.record),
    pending: one(b.pending),
    events: one(b.events),
    mark: one(b.mark),
    abandon: one(b.abandon),
    match: one(b.match),
    saveMatch: one(b.saveMatch),
    forget: one(b.forget),
    matchesWithPending: one(b.matchesWithPending),
  };
}

/* ---------- native: SQLite ---------- */
function sqliteBackend(): Backend {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const SQLite = require("expo-sqlite") as typeof import("expo-sqlite");
  const db = SQLite.openDatabaseSync(`scoring-${config.appEnv}.db`);
  db.execSync(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS score_event_queue (
      client_event_id TEXT PRIMARY KEY NOT NULL,
      match_id TEXT NOT NULL,
      event_number INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      team_id TEXT,
      previous_state TEXT,
      new_state TEXT NOT NULL,
      payload TEXT,
      created_at_client TEXT NOT NULL,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      UNIQUE (match_id, event_number)
    );
    CREATE INDEX IF NOT EXISTS q_match_status ON score_event_queue (match_id, sync_status, event_number);
    CREATE TABLE IF NOT EXISTS match_state (
      match_id TEXT PRIMARY KEY NOT NULL,
      state TEXT,
      history TEXT NOT NULL,
      last_event_number INTEGER NOT NULL,
      match_status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS score_event_abandoned (
      client_event_id TEXT NOT NULL,
      match_id TEXT NOT NULL,
      event_number INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      team_id TEXT,
      previous_state TEXT,
      new_state TEXT NOT NULL,
      payload TEXT,
      created_at_client TEXT NOT NULL,
      abandoned_at TEXT NOT NULL
    );
  `);
  // Given-up events are moved out of the queue. Left in it they held their
  // (match, number) slot, so the next point scored from the server's score
  // could not be saved.
  const moveOut = (where: string) =>
    `INSERT INTO score_event_abandoned (client_event_id, match_id, event_number, event_type, team_id, previous_state, new_state, payload, created_at_client, abandoned_at)
     SELECT client_event_id, match_id, event_number, event_type, team_id, previous_state, new_state, payload, created_at_client, ? FROM score_event_queue WHERE ${where}`;
  db.withTransactionSync(() => {
    db.runSync(moveOut("sync_status = 'abandoned'"), new Date().toISOString());
    db.runSync(`DELETE FROM score_event_queue WHERE sync_status = 'abandoned'`);
  });
  type Row = Omit<QueuedEvent, "previous_state" | "new_state" | "payload"> & { previous_state: string | null; new_state: string; payload: string | null };
  const parse = (r: Row): QueuedEvent => ({
    ...r,
    previous_state: r.previous_state ? JSON.parse(r.previous_state) : null,
    new_state: JSON.parse(r.new_state),
    payload: r.payload ? JSON.parse(r.payload) : null,
  });
  const writeMatch = (m: LocalMatch) =>
    db.runAsync(
      `INSERT INTO match_state (match_id, state, history, last_event_number, match_status, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(match_id) DO UPDATE SET state = excluded.state, history = excluded.history, last_event_number = excluded.last_event_number, match_status = excluded.match_status, updated_at = excluded.updated_at`,
      m.match_id,
      m.state ? JSON.stringify(m.state) : null,
      JSON.stringify(m.history),
      m.last_event_number,
      m.match_status,
      new Date().toISOString(),
    );
  return {
    async record(e, m) {
      // The same connection as every other call; serialize() keeps anything
      // else from running while this transaction is open.
      await db.withTransactionAsync(async () => {
        await db.runAsync(
          `INSERT INTO score_event_queue (client_event_id, match_id, event_number, event_type, team_id, previous_state, new_state, payload, created_at_client, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
          e.client_event_id,
          e.match_id,
          e.event_number,
          e.event_type,
          e.team_id,
          e.previous_state ? JSON.stringify(e.previous_state) : null,
          JSON.stringify(e.new_state),
          e.payload ? JSON.stringify(e.payload) : null,
          e.created_at_client,
        );
        await writeMatch(m);
      });
    },
    async pending(matchId) {
      const rows = await db.getAllAsync<Row>(`SELECT * FROM score_event_queue WHERE match_id = ? AND sync_status = 'pending' ORDER BY event_number`, matchId);
      return rows.map(parse);
    },
    async events(matchId) {
      const rows = await db.getAllAsync<Row>(`SELECT * FROM score_event_queue WHERE match_id = ? AND sync_status != 'abandoned' ORDER BY event_number`, matchId);
      return rows.map(parse);
    },
    async mark(ids, status) {
      if (!ids.length) return;
      await db.runAsync(`UPDATE score_event_queue SET sync_status = ? WHERE client_event_id IN (${ids.map(() => "?").join(",")})`, status, ...ids);
    },
    async abandon(matchId) {
      let n = 0;
      await db.withTransactionAsync(async () => {
        const r = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM score_event_queue WHERE match_id = ? AND sync_status = 'pending'`, matchId);
        n = r?.n ?? 0;
        await db.runAsync(moveOut("match_id = ? AND sync_status = 'pending'"), new Date().toISOString(), matchId);
        await db.runAsync(`DELETE FROM score_event_queue WHERE match_id = ? AND sync_status = 'pending'`, matchId);
      });
      return n;
    },
    async match(matchId) {
      const r = await db.getFirstAsync<{ match_id: string; state: string | null; history: string; last_event_number: number; match_status: string }>(`SELECT * FROM match_state WHERE match_id = ?`, matchId);
      return r ? { match_id: r.match_id, state: r.state ? JSON.parse(r.state) : null, history: JSON.parse(r.history), last_event_number: r.last_event_number, match_status: r.match_status } : null;
    },
    async saveMatch(m) {
      await writeMatch(m);
    },
    async forget(matchId) {
      await db.runAsync(`DELETE FROM match_state WHERE match_id = ?`, matchId);
    },
    async matchesWithPending() {
      const rows = await db.getAllAsync<{ match_id: string }>(`SELECT DISTINCT match_id FROM score_event_queue WHERE sync_status = 'pending'`);
      return rows.map((r) => r.match_id);
    },
  };
}

/* ---------- web preview: localStorage ---------- */
function webBackend(): Backend {
  const read = <T,>(k: string, d: T): T => {
    try {
      return JSON.parse(globalThis.localStorage.getItem(k) ?? "") as T;
    } catch {
      return d;
    }
  };
  const write = (k: string, v: unknown) => globalThis.localStorage.setItem(k, JSON.stringify(v));
  const all = () => read<QueuedEvent[]>("ms.q", []);
  return {
    async record(e, m) {
      write("ms.q", [...all(), e]);
      write(`ms.m:${m.match_id}`, m);
    },
    async pending(id) {
      return all().filter((e) => e.match_id === id && e.sync_status === "pending").sort((a, b) => a.event_number - b.event_number);
    },
    async events(id) {
      return all().filter((e) => e.match_id === id && e.sync_status !== "abandoned").sort((a, b) => a.event_number - b.event_number);
    },
    async mark(ids, status) {
      write("ms.q", all().map((e) => (ids.includes(e.client_event_id) ? { ...e, sync_status: status } : e)));
    },
    async abandon(id) {
      const q = all();
      const mine = (e: QueuedEvent) => e.match_id === id && e.sync_status === "pending";
      write("ms.q", q.map((e) => (mine(e) ? { ...e, sync_status: "abandoned" as const } : e)));
      return q.filter(mine).length;
    },
    async match(id) {
      return read<LocalMatch | null>(`ms.m:${id}`, null);
    },
    async saveMatch(m) {
      write(`ms.m:${m.match_id}`, m);
    },
    async forget(id) {
      globalThis.localStorage.removeItem(`ms.m:${id}`);
    },
    async matchesWithPending() {
      return [...new Set(all().filter((e) => e.sync_status === "pending").map((e) => e.match_id))];
    },
  };
}

let backend: Backend | null = null;
export function queue(): Backend {
  if (!backend) backend = serialize(Platform.OS === "web" ? webBackend() : sqliteBackend());
  return backend;
}

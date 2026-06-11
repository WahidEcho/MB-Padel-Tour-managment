"use client";

import Dexie, { type EntityTable } from "dexie";
import type { ScoreState } from "../scoring/engine";

/** A scoring action queued locally; synced to the server in order (spec §18.7). */
export interface LocalScoreEvent {
  client_event_id: string;
  match_id: string;
  event_number: number;
  event_type: string;
  team_id: string | null;
  previous_state: ScoreState | null;
  new_state: ScoreState;
  payload: Record<string, unknown> | null;
  created_at_client: string;
  sync_status: "pending" | "synced";
}

/** Persisted local match state so an offline page refresh keeps the score. */
export interface LocalMatchState {
  match_id: string;
  state: ScoreState;
  history: ScoreState[];
  last_event_number: number;
  match_status: string;
  updated_at: string;
}

const dexie = new Dexie("mb-tournament-offline") as Dexie & {
  events: EntityTable<LocalScoreEvent, "client_event_id">;
  matchState: EntityTable<LocalMatchState, "match_id">;
};

dexie.version(1).stores({
  events: "client_event_id, match_id, [match_id+event_number], sync_status",
  matchState: "match_id",
});

export const offlineDb = dexie;

export function getDeviceId(): string {
  const KEY = "mb_device_id";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

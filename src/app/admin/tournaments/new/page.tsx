"use client";

import { useState } from "react";
import { createTournament } from "../actions";

export default function NewTournamentPage() {
  const [sport, setSport] = useState<"padel" | "chess" | "tennis">("padel");
  const isChess = sport === "chess";

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-2xl font-bold">New Tournament</h1>
      <form action={createTournament} className="card space-y-4 p-6">
        <div>
          <label className="label" htmlFor="sport">Sport</label>
          <select
            id="sport"
            name="sport"
            value={sport}
            onChange={(e) => setSport(e.target.value as "padel" | "chess" | "tennis")}
            className="input"
          >
            <option value="padel">🎾 Padel</option>
            <option value="tennis">🎾 Tennis</option>
            <option value="chess">♟ Chess</option>
          </select>
        </div>

        <div>
          <label className="label" htmlFor="name">Tournament name</label>
          <input id="name" name="name" required className="input" placeholder={isChess ? "Move Beyond Chess Open" : sport === "tennis" ? "Junior Team Finals" : "Move Beyond Cup"} />
        </div>

        <div>
          <label className="label" htmlFor="courts">
            {isChess ? "Number of boards (1–20)" : "Number of courts (1–20)"}
          </label>
          <input id="courts" name="courts" type="number" min={1} max={20} defaultValue={isChess ? 8 : 2} className="input" />
        </div>

        {isChess && (
          <>
            <div>
              <label className="label" htmlFor="legs">Games per match</label>
              <select id="legs" name="legs" defaultValue="1" className="input">
                <option value="1">1 game (single knockout)</option>
                <option value="2">2 games (colours reversed, aggregate)</option>
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="third_place" className="h-4 w-4" />
              Include a third-place match
            </label>
          </>
        )}

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="is_demo" className="h-4 w-4" />
          Demo / training tournament (for referee training and screen testing)
        </label>

        <p className="text-xs text-muted">
          {isChess
            ? "Chess runs as a knockout (no group stage). Add players under Teams, then seed the bracket from the player list."
            : sport === "tennis"
              ? "Standard tennis rules are applied: best of 3 tie-break sets with advantage scoring. Doubles plays no-ad with a 10-point match tie-break at one set all. A team with one player plays singles. You can change everything in Settings afterwards."
              : "Default padel rules are applied: 1 set to 6 games, advantage scoring, tie-break at 6-6. You can change everything in Settings afterwards."}
        </p>
        <button type="submit" className="btn-primary w-full">Create Tournament</button>
      </form>
    </div>
  );
}

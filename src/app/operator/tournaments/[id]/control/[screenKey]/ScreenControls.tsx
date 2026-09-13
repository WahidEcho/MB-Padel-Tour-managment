"use client";

import { useActionState } from "react";
import type { Court, ScreenSettings } from "@/lib/types";
import ScreenModePicker from "@/components/ScreenModePicker";
import ScreenCommandBar from "@/components/ScreenCommandBar";
import { renameScreenAction, saveScreen, screenCommand, type ScreenFormState } from "../actions";

export interface CeremonyStatus {
  /** "Cup — 2nd place (6 of 8)". */
  description: string;
  index: number;
  last: number;
  /** Tiers that have fewer decided places than their settings ask for. */
  notes: string[];
  /** Whether a Plate podium exists, so the tier choice is worth offering. */
  hasPlate: boolean;
}

function Result({ state }: { state: ScreenFormState }) {
  if (!state) return null;
  return (
    <p
      className={`text-xs font-semibold ${
        state.ok ? "text-success" : "conflict" in state ? "text-warning" : "text-danger"
      }`}
    >
      {state.message}
    </p>
  );
}

/**
 * One screen's own console.
 *
 * Every form carries the revision it was rendered with, so a save that would
 * overwrite somebody else's change is refused and says so in place instead of
 * quietly winning.
 */
export default function ScreenControls({
  tournamentId,
  screen,
  courts,
  liveCourtName,
  canRename,
  liveMatches,
  replayBlockedReason,
  ceremony,
  breakMinutesLeft,
}: {
  tournamentId: string;
  screen: ScreenSettings;
  courts: Court[];
  /** What "follow live" resolves to right now, printed before it goes to air. */
  liveCourtName: string | null;
  canRename: boolean;
  /** Live matches this screen could replay an entrance for. */
  liveMatches: { id: string; label: string }[];
  /** Why no entrance can be replayed on this screen right now, when that is the case. */
  replayBlockedReason: string | null;
  ceremony: CeremonyStatus;
  /** Minutes left in the break when the page rendered; null when not on break. */
  breakMinutesLeft: number | null;
}) {
  const [saveState, save, saving] = useActionState<ScreenFormState, FormData>(saveScreen, null);
  const [renameState, rename, renaming] = useActionState<ScreenFormState, FormData>(renameScreenAction, null);

  const base = { tournament_id: tournamentId, screen_key: screen.screen_key, revision: String(screen.revision) };
  const hiddenInputs = Object.entries(base).map(([name, value]) => (
    <input key={name} type="hidden" name={name} value={value} />
  ));

  const onBreak = breakMinutesLeft !== null;
  const breakLeft = breakMinutesLeft ?? 0;
  const ceremonyOnAir = screen.display_mode === "ceremony";

  return (
    <div className="space-y-4">
      <ScreenModePicker
        action={saveScreen}
        hidden={base}
        current={screen.display_mode}
        label="What this screen shows"
      />

      <div className="grid gap-3 lg:grid-cols-3">
        {/* ---------------- Break and mute ---------------- */}
        <div className="card space-y-3" data-testid="live-controls">
          <div>
            <p className="label">Break</p>
            <p className="text-xs text-muted">
              {onBreak
                ? breakLeft > 0
                  ? `On break — about ${breakLeft} min left, counting down on the wall.`
                  : "On break — the countdown has run out and the wall says Back shortly."
                : "Counts down over whatever is showing. The sponsor band stays on air."}
            </p>
          </div>
          <ScreenCommandBar
            action={screenCommand}
            hidden={base}
            buttons={[
              { command: "break_start", label: "5 min", fields: { break_minutes: "5" } },
              { command: "break_start", label: "10 min", fields: { break_minutes: "10" } },
              { command: "break_start", label: "15 min", fields: { break_minutes: "15" } },
              ...(onBreak ? [{ command: "break_end", label: "End break", tone: "primary" as const }] : []),
            ]}
            testId="break-controls"
          />
          <div>
            <p className="label">Animations</p>
            <p className="text-xs text-muted">
              {screen.mute_animations
                ? "Muted — every scene shows its finished frame and nothing moves."
                : "The emergency brake: stops every animation on this screen at once."}
            </p>
          </div>
          <ScreenCommandBar
            action={screenCommand}
            hidden={base}
            buttons={[
              screen.mute_animations
                ? { command: "mute_off", label: "Unmute animations", tone: "primary" }
                : { command: "mute_on", label: "Mute animations", tone: "danger" },
            ]}
            testId="mute-controls"
          />
        </div>

        {/* ---------------- Replay entrance ---------------- */}
        <div className="card space-y-2">
          <div>
            <p className="label">Replay entrance</p>
            <p className="text-xs text-muted">
              Plays a live match&apos;s 9-second player entrance again on its court card — for when the wall was
              showing something else as it began. A point scored meanwhile ends it.
            </p>
          </div>
          {replayBlockedReason ? (
            <p className="text-xs text-warning">Not available now: {replayBlockedReason}.</p>
          ) : liveMatches.length === 0 ? (
            <p className="text-xs text-muted">Nothing is live on a court this screen shows.</p>
          ) : (
            <ScreenCommandBar
              action={screenCommand}
              hidden={base}
              buttons={liveMatches.map((m) => ({ command: "replay_entrance", label: m.label, fields: { match_id: m.id } }))}
              testId="replay-controls"
            />
          )}
        </div>

        {/* ---------------- Ceremony ---------------- */}
        <div className="card space-y-2" data-testid="ceremony-controls">
          <div>
            <p className="label">Closing ceremony</p>
            <p className="text-sm font-semibold">{ceremony.description}</p>
            {ceremony.notes.map((n) => (
              <p key={n} className="text-xs text-warning">{n}. The ceremony stops at the deepest decided place.</p>
            ))}
          </div>
          {!ceremonyOnAir && (
            // The tier is chosen here, with the mode, so what airs is what was chosen.
            <form action={save} className="flex flex-wrap items-center gap-2">
              {hiddenInputs}
              <input type="hidden" name="display_mode" value="ceremony" />
              {ceremony.hasPlate && (
                <select key="off-air" name="bracket_tier" defaultValue="both" className="input w-auto text-xs">
                  <option value="both">Plate, then Cup</option>
                  <option value="cup">Cup only</option>
                  <option value="plate">Plate only</option>
                </select>
              )}
              <button className="btn-primary text-xs" disabled={saving}>
                Put the ceremony on air
              </button>
            </form>
          )}
          {ceremonyOnAir ? (
            <ScreenCommandBar
              action={screenCommand}
              hidden={base}
              buttons={[
                { command: "ceremony_next", label: "Next place ▶", tone: "primary", disabled: ceremony.index >= ceremony.last },
                { command: "ceremony_back", label: "◀ Back", disabled: ceremony.index <= 0 },
                { command: "ceremony_replay", label: "Replay" },
                { command: "ceremony_restart", label: "Restart", confirm: "Go back to the opening slate?" },
              ]}
            />
          ) : (
            // Moving a ceremony nobody can see would start it part-way through.
            <p className="text-xs text-muted">It starts from the opening slate when it goes on air.</p>
          )}
          {ceremony.hasPlate && ceremonyOnAir && (
            <form
              action={save}
              className="flex items-center gap-2"
              onSubmit={(e) => {
                if (!window.confirm("Changing which podiums are shown restarts the ceremony from its opening slate. Continue?")) {
                  e.preventDefault();
                }
              }}
            >
              {hiddenInputs}
              {/* Keyed by what is stored, so it always shows the tier on air. */}
              <select key={screen.bracket_tier} name="bracket_tier" defaultValue={screen.bracket_tier} className="input w-auto text-xs">
                <option value="both">Plate, then Cup</option>
                <option value="cup">Cup only</option>
                <option value="plate">Plate only</option>
              </select>
              <button className="btn-secondary text-xs" disabled={saving}>
                Set
              </button>
            </form>
          )}
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* ---------------- Coverage ---------------- */}
        <form action={save} className="card space-y-2">
          {hiddenInputs}
          <div>
            <p className="label">Courts on this screen</p>
            <p className="text-xs text-muted">
              Tick none to show every court. This is the one setting the control room never changes
              for you, because pushing it to every screen would undo the split.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
            {courts.map((c) => (
              <label key={c.id} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  name="court_ids"
                  value={c.id}
                  defaultChecked={screen.court_ids?.includes(c.id)}
                  className="h-4 w-4"
                />
                {c.court_name}
              </label>
            ))}
            {courts.length === 0 && <p className="text-xs text-muted">No courts yet.</p>}
          </div>
          <button className="btn-secondary text-xs" disabled={saving}>
            Save coverage
          </button>
        </form>

        {/* ---------------- Pin ---------------- */}
        <form action={save} className="card space-y-2">
          {hiddenInputs}
          <div>
            <p className="label">Follow live, or pin a court</p>
            <p className="text-xs text-muted">
              {screen.focus_court_id
                ? "Pinned. It will stay on this court even when the match there finishes."
                : liveCourtName
                  ? `No pin. Right now that resolves to ${liveCourtName}.`
                  : "No pin. Nothing is live on this screen's courts right now."}
            </p>
          </div>
          <select name="focus_court_id" defaultValue={screen.focus_court_id ?? ""} className="input">
            <option value="">Follow live</option>
            {courts.map((c) => (
              <option key={c.id} value={c.id}>
                Pin to {c.court_name}
              </option>
            ))}
          </select>
          <button className="btn-secondary text-xs" disabled={saving}>
            Apply
          </button>
        </form>

        {/* ---------------- Appearance ---------------- */}
        <form action={save} className="card space-y-2">
          {hiddenInputs}
          <label className="label">Screen theme</label>
          <select name="theme" defaultValue={screen.theme} className="input">
            <option value="dark">Dark (recommended for TV)</option>
            <option value="light">Light</option>
          </select>
          <label className="label">Sponsor rotation (seconds)</label>
          <input
            name="sponsor_rotation_seconds"
            type="number"
            min={3}
            defaultValue={screen.sponsor_rotation_seconds}
            className="input"
          />
          <button className="btn-secondary text-xs" disabled={saving}>
            Apply
          </button>
        </form>

        {/* ---------------- Name ---------------- */}
        {canRename && (
          <form action={rename} className="card space-y-2">
            <input type="hidden" name="tournament_id" value={tournamentId} />
            <input type="hidden" name="screen_key" value={screen.screen_key} />
            <label className="label">Screen name</label>
            <input
              name="screen_name"
              defaultValue={screen.screen_name ?? ""}
              placeholder={screen.screen_key}
              className="input"
            />
            <p className="text-xs text-muted">
              The link stays <code>/screen/{screen.screen_key}</code> — a TV may already be open on
              it, so the key never changes.
            </p>
            <button className="btn-secondary text-xs" disabled={renaming}>
              Rename
            </button>
            <Result state={renameState} />
          </form>
        )}
      </div>

      <Result state={saveState} />
    </div>
  );
}

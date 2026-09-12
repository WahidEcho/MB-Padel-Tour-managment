"use client";

import { useActionState } from "react";
import type { Court, ScreenSettings } from "@/lib/types";
import ScreenModePicker from "@/components/ScreenModePicker";
import { renameScreenAction, saveScreen, type ScreenFormState } from "../actions";

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
}: {
  tournamentId: string;
  screen: ScreenSettings;
  courts: Court[];
  /** What "follow live" resolves to right now, printed before it goes to air. */
  liveCourtName: string | null;
  canRename: boolean;
}) {
  const [saveState, save, saving] = useActionState<ScreenFormState, FormData>(saveScreen, null);
  const [renameState, rename, renaming] = useActionState<ScreenFormState, FormData>(renameScreenAction, null);

  const base = { tournament_id: tournamentId, screen_key: screen.screen_key, revision: String(screen.revision) };
  const hiddenInputs = Object.entries(base).map(([name, value]) => (
    <input key={name} type="hidden" name={name} value={value} />
  ));

  return (
    <div className="space-y-4">
      <ScreenModePicker
        action={saveScreen}
        hidden={base}
        current={screen.display_mode}
        label="What this screen shows"
      />

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

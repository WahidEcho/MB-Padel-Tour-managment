import ConfirmSubmit from "@/components/ConfirmSubmit";
import type { ConsentChannel, PlayerProfile } from "@/lib/types";
import { setPlayerApproval, setPlayerConsent, updatePlayerProfile } from "./actions";

const APPROVAL_BADGE: Record<string, string> = {
  pending: "bg-warning/15 text-warning",
  approved: "bg-success/15 text-success",
  rejected: "bg-danger/15 text-danger",
  merged: "bg-border text-muted",
};

const CHANNELS: { key: ConsentChannel; label: string }[] = [
  { key: "whatsapp", label: "WhatsApp" },
  { key: "web_push", label: "App alerts" },
  { key: "email", label: "Email" },
];

function ageFrom(birthYear: number | null): number | null {
  if (!birthYear) return null;
  return new Date().getUTCFullYear() - birthYear;
}

export default function PlayerCard({
  player,
  granted,
  duplicateOf,
}: {
  player: PlayerProfile;
  granted: Set<string>;
  /** Name of another player sharing this mobile, if any. */
  duplicateOf?: string;
}) {
  const age = ageFrom(player.birth_year);

  // Only show the detail strip when there is something in it.
  const details: string[] = [];
  if (player.skill_level) details.push(`Level ${player.skill_level}`);
  if (age !== null) details.push(`${age} yrs`);
  if (player.gender) details.push(player.gender);
  if (player.email) details.push(player.email);

  return (
    <div className="card flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-bold">
            {player.public_name}
            {player.active_streak >= 2 && (
              <span className="badge ml-1 bg-accent/15 text-accent">🔥 {player.active_streak}</span>
            )}
          </h3>
          <p className="font-mono text-xs text-muted">
            {player.mobile_normalized ?? "no mobile on file"}
          </p>
        </div>
        <span className={`badge shrink-0 ${APPROVAL_BADGE[player.approval_status] ?? "bg-border text-muted"}`}>
          {player.approval_status}
        </span>
      </div>

      {duplicateOf && (
        <p className="rounded-lg bg-warning/10 px-2 py-1 text-xs font-semibold text-warning">
          ⚠ Same mobile as {duplicateOf} — likely the same person. Merge them below the list.
        </p>
      )}

      {details.length > 0 && (
        <p className="truncate text-xs text-muted">{details.join(" · ")}</p>
      )}

      {player.notes && <p className="text-xs text-muted">{player.notes}</p>}

      <div className="flex flex-wrap items-center gap-1">
        <span className="text-xs font-semibold text-muted">Can contact via</span>
        {CHANNELS.map((c) => {
          const on = granted.has(c.key);
          return (
            <form key={c.key} action={setPlayerConsent}>
              <input type="hidden" name="profile_id" value={player.id} />
              <input type="hidden" name="channel" value={c.key} />
              <input type="hidden" name="granted" value={on ? "0" : "1"} />
              <button
                className={`badge cursor-pointer ${on ? "bg-success/15 text-success" : "bg-border text-muted"}`}
                title={
                  on
                    ? `${player.public_name} agreed to ${c.label}. Click to withdraw.`
                    : `No consent recorded for ${c.label}. Click to record it.`
                }
              >
                {on ? "✓" : "✕"} {c.label}
              </button>
            </form>
          );
        })}
      </div>

      <div className="mt-auto flex flex-wrap gap-2 border-t border-border pt-2">
        {player.approval_status !== "approved" && (
          <form action={setPlayerApproval}>
            <input type="hidden" name="profile_id" value={player.id} />
            <input type="hidden" name="approval_status" value="approved" />
            <button className="btn-secondary text-xs">Approve</button>
          </form>
        )}
        {player.approval_status !== "rejected" && player.approval_status !== "merged" && (
          <form action={setPlayerApproval}>
            <input type="hidden" name="profile_id" value={player.id} />
            <input type="hidden" name="approval_status" value="rejected" />
            <ConfirmSubmit
              className="btn-secondary text-xs text-danger"
              message={`Reject ${player.public_name}? They stay in the directory and can be approved again later.`}
            >
              Reject
            </ConfirmSubmit>
          </form>
        )}

        <details className="w-full">
          <summary className="cursor-pointer text-xs font-semibold text-muted">Edit details</summary>
          <form action={updatePlayerProfile} className="mt-2 grid gap-2 sm:grid-cols-2">
            <input type="hidden" name="profile_id" value={player.id} />
            <div className="sm:col-span-2">
              <label className="label">Name</label>
              <input name="public_name" defaultValue={player.public_name} className="input text-sm" required />
            </div>
            <div className="sm:col-span-2">
              <label className="label">Mobile</label>
              <input name="mobile" defaultValue={player.mobile_normalized ?? ""} className="input text-sm" />
            </div>
            <div>
              <label className="label">Level</label>
              <input name="skill_level" defaultValue={player.skill_level ?? ""} className="input text-sm" placeholder="e.g. B, 4.5" />
            </div>
            <div>
              <label className="label">Birth year</label>
              <input name="birth_year" type="number" min={1900} max={2100} defaultValue={player.birth_year ?? ""} className="input text-sm" placeholder="1994" />
            </div>
            <div>
              <label className="label">Gender</label>
              <select name="gender" defaultValue={player.gender ?? ""} className="input text-sm">
                <option value="">not recorded</option>
                <option value="male">male</option>
                <option value="female">female</option>
                <option value="other">other</option>
              </select>
            </div>
            <div>
              <label className="label">Email</label>
              <input name="email" type="email" defaultValue={player.email ?? ""} className="input text-sm" />
            </div>
            <div className="sm:col-span-2">
              <label className="label">Notes</label>
              <input name="notes" defaultValue={player.notes ?? ""} className="input text-sm" placeholder="anything else, admin-only" />
            </div>
            <div className="sm:col-span-2">
              <button className="btn-secondary text-xs">Save changes</button>
            </div>
          </form>
        </details>
      </div>
    </div>
  );
}

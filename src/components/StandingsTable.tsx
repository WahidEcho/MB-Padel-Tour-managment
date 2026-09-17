import Avatar from "./Avatar";
import type { Standing, Team } from "@/lib/types";

const STATUS_BADGE: Record<string, string> = {
  qualified: "bg-success/15 text-success",
  plate: "bg-accent/15 text-accent",
  pending: "bg-border text-muted",
  eliminated: "bg-danger/10 text-muted",
  disqualified: "bg-danger/15 text-danger",
};

/** "plate" is a place in the Plate bracket, which is not a word on its own. */
const STATUS_TEXT: Record<string, string> = {
  qualified: "qualified",
  plate: "plate",
  pending: "pending",
  eliminated: "eliminated",
  disqualified: "disqualified",
};

/**
 * A group's standings.
 *
 * One table serves three places, and each had a different way of being wrong:
 *
 *  - **A phone.** Eleven columns cannot fit 380 pixels, and the old table was
 *    simply cut off inside a horizontal scroller nobody discovers. The four
 *    difference columns fold into a line under the team name below `sm`.
 *  - **A venue screen.** The table set `text-sm` on itself, which beat the 24px
 *    the scene asked for by being the more specific rule — so a wall meant to be
 *    read from six metres showed 14px type. Size now comes in as a number, and
 *    every space inside the table is measured in that size.
 *  - **The admin page**, which also carries the override control.
 */
export default function StandingsTable({
  standings,
  teams,
  compact = false,
  actions,
  fontPx,
  detail = true,
}: {
  standings: Standing[];
  teams: Map<string, Team>;
  /** Overview cards: names only, no photos and no difference columns. */
  compact?: boolean;
  actions?: (s: Standing) => React.ReactNode;
  /** Venue screens: the type size every space in the table is derived from. */
  fontPx?: number;
  /** Whether the set and game columns have room. Ignored when `compact`. */
  detail?: boolean;
}) {
  const wide = !compact && detail;
  // On a wall nothing is hidden by breakpoint: the size was chosen to fit.
  const tv = typeof fontPx === "number";
  const em = (n: number) => (tv ? `${(fontPx! * n).toFixed(1)}px` : undefined);
  const cell = tv ? { padding: `${(fontPx! * 0.3).toFixed(1)}px ${(fontPx! * 0.38).toFixed(1)}px` } : undefined;
  const pad = tv ? "" : "px-1 py-1.5 sm:px-2";
  const headPad = tv ? "" : "px-1 py-1 sm:px-2";
  /**
   * Columns that fold away on a phone, where eleven of them cannot fit 380
   * pixels. What they were carrying is printed under the team's name instead, so
   * nothing is lost — the old table was simply cut off by a scroller nobody
   * finds. Always shown on a wall, where the size was chosen to fit.
   */
  const fold = tv ? "" : "hidden sm:table-cell";

  return (
    <table className={`w-full text-left${tv ? "" : " text-sm"}`} style={tv ? { fontSize: fontPx } : undefined}>
      <thead>
        <tr className={`uppercase text-muted${tv ? "" : " text-xs"}`} style={tv ? { fontSize: em(0.62) } : undefined}>
          <th className={headPad} style={cell}>#</th>
          <th className={headPad} style={cell}>Team</th>
          <th className={`${headPad} ${fold} text-center`} style={cell}>P</th>
          <th className={`${headPad} ${fold} text-center`} style={cell}>W</th>
          <th className={`${headPad} ${fold} text-center`} style={cell}>L</th>
          <th className={`${headPad} text-center`} style={cell}>Pts</th>
          {wide && (
            <>
              <th className={`${headPad} ${fold} text-center`} style={cell} title="Sets won-lost">Sets</th>
              <th className={`${headPad} ${fold} text-center`} style={cell} title="Set difference">SD</th>
              <th className={`${headPad} ${fold} text-center`} style={cell} title="Games won-lost">Games</th>
              <th className={`${headPad} ${fold} text-center`} style={cell} title="Game difference">GD</th>
            </>
          )}
          <th className={headPad} style={cell}>Status</th>
          {actions && <th className={headPad} style={cell} />}
        </tr>
      </thead>
      <tbody>
        {standings.map((s) => {
          const team = teams.get(s.team_id);
          const avatar = tv ? Math.round(fontPx! * 1.7) : 24;
          return (
            <tr
              key={s.team_id}
              className={`border-t border-border ${s.status === "qualified" ? "bg-success/5" : ""}`}
            >
              <td className={`${pad} font-bold`} style={cell}>{s.rank}</td>
              <td className={pad} style={cell}>
                <div className="flex items-center gap-2">
                  {!compact && (
                    <div className="flex -space-x-1.5">
                      {team?.players?.map((p) => (
                        <Avatar key={p.id} name={p.full_name} person={p} size={avatar} />
                      ))}
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="font-semibold leading-tight">{team?.team_name ?? "?"}</p>
                    {!compact && (
                      <p className="leading-tight text-muted" style={tv ? { fontSize: em(0.62) } : undefined}>
                        <span className={tv ? "" : "text-xs"}>
                          {team?.players?.map((p) => p.full_name).join(" & ")}
                        </span>
                      </p>
                    )}
                    {/* What the folded columns were carrying, for a phone. */}
                    {!tv && (
                      <p className="text-[11px] leading-tight text-muted sm:hidden">
                        {s.played}P · {s.won}W · {s.lost}L
                        {wide
                          ? ` · Sets ${s.sets_won}-${s.sets_lost} · Games ${s.games_won}-${s.games_lost}`
                          : ""}
                      </p>
                    )}
                  </div>
                </div>
              </td>
              <td className={`${pad} ${fold} text-center`} style={cell}>{s.played}</td>
              <td className={`${pad} ${fold} text-center`} style={cell}>{s.won}</td>
              <td className={`${pad} ${fold} text-center`} style={cell}>{s.lost}</td>
              <td className={`${pad} text-center font-bold`} style={cell}>{s.points}</td>
              {wide && (
                <>
                  <td className={`${pad} ${fold} text-center`} style={cell}>{s.sets_won}-{s.sets_lost}</td>
                  <td className={`${pad} ${fold} text-center`} style={cell}>{s.set_diff > 0 ? `+${s.set_diff}` : s.set_diff}</td>
                  <td className={`${pad} ${fold} text-center`} style={cell}>{s.games_won}-{s.games_lost}</td>
                  <td className={`${pad} ${fold} text-center`} style={cell}>{s.game_diff > 0 ? `+${s.game_diff}` : s.game_diff}</td>
                </>
              )}
              <td className={pad} style={cell}>
                <span
                  className={`badge ${STATUS_BADGE[s.status] ?? STATUS_BADGE.pending}`}
                  style={tv ? { fontSize: em(0.6), padding: `${(fontPx! * 0.12).toFixed(1)}px ${(fontPx! * 0.4).toFixed(1)}px` } : undefined}
                >
                  {STATUS_TEXT[s.status] ?? s.status}
                  {s.manual_status_override ? " *" : ""}
                </span>
              </td>
              {actions && <td className={pad} style={cell}>{actions(s)}</td>}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

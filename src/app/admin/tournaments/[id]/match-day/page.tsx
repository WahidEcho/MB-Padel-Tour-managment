import { notFound } from "next/navigation";
import { getTournament } from "@/lib/data";
import { requireRole } from "@/lib/guard";
import { matchDayRules, MINUTES_RANGE, EXTENSIONS_RANGE, type MatchDayRules } from "@/lib/matchday/rules";
import { sportOf, type SportSupports } from "@/lib/sports/registry";
import { saveMatchDayRules } from "./actions";

export const dynamic = "force-dynamic";

type Group = keyof Omit<MatchDayRules, "configured">;

interface Field {
  key: string;
  label: string;
  hint?: string;
  kind: "toggle" | "minutes" | "count" | "mode";
}

interface Section {
  group: Group;
  title: string;
  /** The sport feature the whole group needs. */
  needs?: keyof SportSupports;
  fields: Field[];
}

const SECTIONS: Section[] = [
  {
    group: "showcase",
    title: "Live courts on the app",
    needs: "showcase",
    fields: [
      { key: "on", label: "Show this tournament's courts at the top of Discover", kind: "toggle" },
      { key: "eventDaysOnly", label: "Only on the event's days", kind: "toggle" },
    ],
  },
  {
    group: "alerts",
    title: "Player alerts",
    fields: [{ key: "on", label: "Send match-day alerts to the players", hint: "Players can still turn court calls off in the app.", kind: "toggle" }],
  },
  {
    group: "matchSoon",
    title: "Match soon",
    needs: "nearEnd",
    fields: [
      { key: "on", label: "Tell the next players when the match before them is one game from the end", kind: "toggle" },
      { key: "starredFans", label: "Also tell fans who starred them", kind: "toggle" },
    ],
  },
  {
    group: "courtCall",
    title: "Call to court",
    fields: [
      { key: "on", label: "Call players to their court", kind: "toggle" },
      { key: "autoOnRefereeOpen", label: "Call automatically when the referee opens the match", kind: "toggle" },
      { key: "minutes", label: "Minutes to reach the court", kind: "minutes" },
      { key: "reminderMinutes", label: "Reminder, minutes before the deadline", kind: "minutes" },
    ],
  },
  {
    group: "noShow",
    title: "No-show",
    fields: [
      { key: "on", label: "Ask the referee what to do when a side is not at court in time", kind: "toggle" },
      { key: "extensionMinutes", label: "Minutes each extension adds", kind: "minutes" },
      { key: "maxExtensions", label: "Most extensions allowed", kind: "count" },
      { key: "bothAbsentPromptOnly", label: "When both sides are missing, only ask (never a walkover)", kind: "toggle" },
    ],
  },
  {
    group: "lockScreen",
    title: "Lock screen (iPhone)",
    needs: "liveActivity",
    fields: [
      { key: "liveActivities", label: "Live score on the lock screen", kind: "toggle" },
      { key: "startByPush", label: "Start it from the server, without opening the app", kind: "toggle" },
      { key: "countdown", label: "Count down to the court deadline", kind: "toggle" },
      { key: "autoStartMine", label: "Start it for the player's own matches", kind: "toggle" },
      { key: "autoStartStarred", label: "Start it for starred matches", kind: "toggle" },
    ],
  },
  {
    group: "widgets",
    title: "Widgets",
    needs: "liveActivity",
    fields: [{ key: "on", label: "Show this tournament in the home-screen widgets", kind: "toggle" }],
  },
  {
    group: "scoring",
    title: "Recording results",
    fields: [{ key: "mode", label: "How referees record a match", kind: "mode" }],
  },
  {
    group: "extras",
    title: "Extras",
    fields: [
      { key: "imAtCourt", label: "Players can tap \"I'm at court\"", kind: "toggle" },
      { key: "qrCheckInPresent", label: "Scanning the match QR code counts as at court", kind: "toggle" },
      { key: "warmUpTimer", label: "Warm-up timer", kind: "toggle" },
      { key: "warmUpMinutes", label: "Warm-up minutes", kind: "minutes" },
      { key: "callOnTv", label: "Show the call on the court TV", kind: "toggle" },
      { key: "umpireVoiceCall", label: "Umpire voice announces the call", kind: "toggle" },
      { key: "skipSoonIfBusy", label: "Skip \"match soon\" for a player still on another court", kind: "toggle" },
      { key: "quietOutsideEventDays", label: "No match-day alerts outside the event's days", kind: "toggle" },
      { key: "autoCallWithoutReferee", label: "Call automatically when a court frees up, without a referee", kind: "toggle" },
      { key: "notifyBothOnResult", label: "Tell both sides when a result is entered", kind: "toggle" },
    ],
  },
];

const MODE_LABELS: [string, string][] = [
  ["point_by_point", "Point by point"],
  ["final_score", "Final result only"],
  ["either", "Either: the referee picks per match"],
];

export default async function MatchDayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireRole(["admin", "manager"], `/admin/tournaments/${id}/match-day`);
  const tournament = await getTournament(id);
  if (!tournament) notFound();
  const sport = sportOf(tournament);
  const rules = matchDayRules(tournament.match_day_rules, tournament);
  const value = (g: Group, k: string) => (rules[g] as unknown as Record<string, boolean | number | string>)[k];

  return (
    <div className="space-y-4">
      <section className="card space-y-2">
        <h2 className="font-bold">Match day</h2>
        <p className="text-sm text-muted">
          What happens around each match on the day: calling players to court, alerts, the lock screen and how results are recorded.
        </p>
        {!rules.configured && (
          <p className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
            Match day is off for this {tournament.kind === "tournament" ? "tournament" : "session"}: everything below is off until you save.
            Use the recommended settings to switch the usual set on.
          </p>
        )}
      </section>

      <form action={saveMatchDayRules} className="space-y-4">
        <input type="hidden" name="tournament_id" value={id} />
        <div className="grid gap-4 lg:grid-cols-2">
          {SECTIONS.map((s) => {
            const unsupported = s.needs ? !sport.supports[s.needs] : false;
            return (
              <fieldset key={s.group} className="card space-y-2" disabled={unsupported}>
                <legend className="font-bold">{s.title}</legend>
                {unsupported && <p className="text-xs text-muted">Not available for {sport.label.toLowerCase()}.</p>}
                {s.fields.map((f) => {
                  const name = `${s.group}.${f.key}`;
                  const v = value(s.group, f.key);
                  if (f.kind === "toggle") {
                    const voiceOff = f.key === "umpireVoiceCall" && !sport.supports.voice;
                    return (
                      <label key={name} className="flex items-start gap-2 text-sm">
                        <input type="checkbox" name={name} defaultChecked={v === true} disabled={voiceOff} className="mt-1" />
                        <span>
                          {f.label}
                          {voiceOff && <span className="text-muted"> (not available for {sport.label.toLowerCase()})</span>}
                          {f.hint && <span className="block text-xs text-muted">{f.hint}</span>}
                        </span>
                      </label>
                    );
                  }
                  if (f.kind === "mode") {
                    return (
                      <label key={name} className="block text-sm">
                        <span className="label">{f.label}</span>
                        <select name={name} defaultValue={String(v)} className="input">
                          {MODE_LABELS.map(([m, label]) => (
                            <option key={m} value={m}>{label}</option>
                          ))}
                        </select>
                      </label>
                    );
                  }
                  const range = f.kind === "count" ? EXTENSIONS_RANGE : MINUTES_RANGE;
                  return (
                    <label key={name} className="flex items-center justify-between gap-2 text-sm">
                      <span>{f.label}</span>
                      <input type="number" name={name} min={range.min} max={range.max} step={1} defaultValue={Number(v)} className="input w-20" />
                    </label>
                  );
                })}
              </fieldset>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" name="intent" value="save">Save</button>
          <button className="btn-secondary" name="intent" value="defaults">Use recommended settings</button>
          {rules.configured && (
            <button className="btn-secondary" name="intent" value="off">Switch match day off</button>
          )}
        </div>
      </form>
    </div>
  );
}

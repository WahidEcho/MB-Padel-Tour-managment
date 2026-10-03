import { Pressable, View } from "react-native";
import { RUBBER_SHORT, isDoneStatus, isLiveStatus, type MMatch, type MTie } from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Eyebrow, Num } from "./Text";
import { Card, Chip, Flag, LivePill } from "./Bits";
import type { View as Model } from "../api/model";
import { dayIn, isAwaitingResult, matchA11y, timeIn, whenIn } from "../api/model";
import { isNation, openMatch, openTeam, openTie } from "../nav/links";

function ServeMark() {
  const { t } = useTheme();
  return <View accessibilityLabel="serving" style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.ball, borderWidth: t.scheme === "light" ? 1.5 : 0, borderColor: t.ballInk }} />;
}

/** A live (or finished) match in two lines: who, sets, the game in play. */
export function MatchMini({ m, v, width, withDay = false }: { m: MMatch; v: Model; width?: number; withDay?: boolean }) {
  const { t } = useTheme();
  // Over but not confirmed (or not yet synced from the referee's phone): the sets stand, nothing is in play.
  const awaiting = isAwaitingResult(m);
  const live = isLiveStatus(m.status) && !awaiting;
  const done = isDoneStatus(m.status);
  const tz = v.bundle.tournament.timezone;
  const row = (side: "A" | "B") => {
    const team = v.team(side === "A" ? m.a : m.b);
    const sets = m.score?.sets ?? [];
    const won = done && m.winner && m.winner === (side === "A" ? m.a : m.b);
    return (
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
          <Flag iso2={team?.iso2} code={team?.code} />
          <Body numberOfLines={1} weight={won ? "bold" : "semi"} size={14} style={{ flexShrink: 1 }}>
            {v.sideLabel(m, side, true)}
          </Body>
          {live && m.score?.serving === side ? <ServeMark /> : null}
        </View>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          {sets.map((s, i) => (
            <Num key={i} size={17} tone={won || !done ? "ink" : "ink2"}>
              {side === "A" ? s.a : s.b}
            </Num>
          ))}
          {live && m.score?.games ? (
            <Num size={17}>{side === "A" ? m.score.games.a : m.score.games.b}</Num>
          ) : null}
          {live && m.score?.points ? (
            <View style={{ backgroundColor: t.chip, borderRadius: 6, paddingHorizontal: 5, minWidth: 30, alignItems: "center" }}>
              <Num size={17}>{side === "A" ? m.score.points.a : m.score.points.b}</Num>
            </View>
          ) : null}
        </View>
      </View>
    );
  };
  return (
    <Card onPress={() => openMatch(m.id)} style={{ width, gap: 9 }} accessibilityLabel={matchA11y(m, v)}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        {live ? (
          <LivePill label={m.status === "paused" ? "PAUSED" : "LIVE"} />
        ) : done ? (
          <Chip label="Final" />
        ) : awaiting ? (
          <Chip label="Match over" />
        ) : m.status === "cancelled" ? (
          <Chip label="Not played" />
        ) : (
          <Num size={14} tone="ink2">{whenIn(m.scheduledTime, tz, withDay)}</Num>
        )}
        <Eyebrow size={10}>
          {[v.court(m.courtId), m.rubberType ? RUBBER_SHORT[m.rubberType as keyof typeof RUBBER_SHORT] : m.round].filter(Boolean).join(" · ")}
        </Eyebrow>
      </View>
      {row("A")}
      {row("B")}
    </Card>
  );
}

/** A tie in one line: nations either side, rubbers or time in the middle. */
export function TieRow({ tie, v, onPress, withDay = false }: { tie: MTie; v: Model; onPress?: () => void; withDay?: boolean }) {
  const a = v.team(tie.a);
  const b = v.team(tie.b);
  const tz = v.bundle.tournament.timezone;
  const court = v.court(tie.courtId);
  const label = [
    `${a?.name ?? "TBD"} against ${b?.name ?? "TBD"}`,
    tie.status === "scheduled"
      ? tie.scheduledTime
        ? `Starts ${dayIn(tie.scheduledTime, tz)} at ${timeIn(tie.scheduledTime, tz)}`
        : "Time to be confirmed"
      : `${tie.status === "live" ? "Live" : "Final"}, rubbers ${tie.rubbersA}–${tie.rubbersB}`,
    court,
  ]
    .filter(Boolean)
    .join(". ");
  return (
    <Card onPress={onPress ?? (() => openTie(tie.id))} style={{ flexDirection: "row", alignItems: "center", gap: 10 }} accessibilityLabel={label}>
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 }}>
        <Flag iso2={a?.iso2} code={a?.code} />
        <Body weight="bold" size={14} numberOfLines={1}>{a?.code ?? "TBD"}</Body>
      </View>
      <View style={{ alignItems: "center", minWidth: 88 }}>
        {tie.status === "scheduled" ? <Num size={19}>{timeIn(tie.scheduledTime, tz)}</Num> : <Num size={24}>{`${tie.rubbersA}–${tie.rubbersB}`}</Num>}
        <Eyebrow size={9.5} tone="ink3">
          {tie.status === "live"
            ? "LIVE"
            : tie.status === "completed"
              ? "FINAL"
              : [withDay && tie.scheduledTime ? dayIn(tie.scheduledTime, tz) : null, court ?? "Court TBC"].filter(Boolean).join(" · ")}
        </Eyebrow>
      </View>
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, justifyContent: "flex-end", minWidth: 0 }}>
        <Body weight="bold" size={14} numberOfLines={1}>{b?.code ?? "TBD"}</Body>
        <Flag iso2={b?.iso2} code={b?.code} />
      </View>
    </Card>
  );
}

/** A tie with its rubbers: the main card of a nations event. Each nation opens its page; `linkTie` makes the score open the tie. */
export function TieCard({ tie, v, linkTie = false }: { tie: MTie; v: Model; linkTie?: boolean }) {
  const { t } = useTheme();
  const a = v.team(tie.a);
  const b = v.team(tie.b);
  const rubbers = v.rubbers(tie.id);
  const tr = v.bundle.tournament;
  const tz = tr.timezone;
  const pressed = { opacity: 0.7 };
  const side = (team: typeof a, align: "flex-start" | "flex-end") => {
    const body = (
      <>
        <Flag iso2={team?.iso2} code={team?.code} size={34} />
        <Body weight="bold" size={13} numberOfLines={1}>
          {team?.name ?? "TBD"}
          {team ? <Body tone="ink3" weight="bold" size={13}>{" ›"}</Body> : null}
        </Body>
      </>
    );
    if (!team) return <View style={{ flex: 1, gap: 6, alignItems: align }}>{body}</View>;
    return (
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`${team.name}${isNation(team, tr.isTies) ? ", nation page" : ", team page"}`}
        onPress={() => openTeam(team, tr.slug, tr.isTies)}
        hitSlop={6}
        style={({ pressed: p }) => [{ flex: 1, gap: 6, alignItems: align }, p && pressed]}
      >
        {body}
      </Pressable>
    );
  };
  const score = (
    <>
      <Num size={38}>{tie.status === "scheduled" && !tie.rubbersA && !tie.rubbersB ? timeIn(tie.scheduledTime, tz) : `${tie.rubbersA}–${tie.rubbersB}`}</Num>
      <Eyebrow size={10} tone="ink3">
        {tie.status === "live" ? "LIVE" : tie.status === "completed" ? "FINAL" : [v.court(tie.courtId), tie.roundName].filter(Boolean).join(" · ") || "Scheduled"}
        {linkTie ? "  ›" : ""}
      </Eyebrow>
    </>
  );
  return (
    <View style={{ borderRadius: 24, backgroundColor: t.surface, borderWidth: 1, borderColor: t.line, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", alignItems: "center", padding: 14, gap: 10, backgroundColor: t.scheme === "dark" ? "rgba(255,255,255,0.02)" : t.surface2 }}>
        {side(a, "flex-start")}
        {linkTie ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open the tie, ${a?.name ?? "TBD"} against ${b?.name ?? "TBD"}, ${tie.status === "scheduled" ? "not started" : `rubbers ${tie.rubbersA}–${tie.rubbersB}`}`}
            onPress={() => openTie(tie.id)}
            hitSlop={8}
            style={({ pressed: p }) => [{ alignItems: "center", paddingHorizontal: 6, paddingVertical: 4, borderRadius: 12 }, p && { backgroundColor: t.chip }]}
          >
            {score}
          </Pressable>
        ) : (
          <View style={{ alignItems: "center" }}>{score}</View>
        )}
        {side(b, "flex-end")}
      </View>
      {rubbers.map((r) => {
        const awaiting = isAwaitingResult(r);
        const live = isLiveStatus(r.status) && !awaiting;
        const done = isDoneStatus(r.status);
        const sets = (r.score?.sets ?? []).map((s) => `${s.a}–${s.b}`).join(" ");
        return (
          <Card key={r.id} accessibilityLabel={`${RUBBER_SHORT[r.rubberType as keyof typeof RUBBER_SHORT] ?? r.rubberType ?? "Rubber"}. ${matchA11y(r, v)}`} onPress={() => openMatch(r.id)} style={{ borderRadius: 0, borderWidth: 0, borderTopWidth: 1, borderColor: t.line, backgroundColor: "transparent", flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Num size={14} tone="ink3" style={{ width: 28 }}>{RUBBER_SHORT[r.rubberType as keyof typeof RUBBER_SHORT] ?? r.rubberType}</Num>
            <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
              <Body numberOfLines={1} size={13.5} weight={done && r.winner === r.a ? "bold" : "regular"} tone={done && r.winner !== r.a ? "ink2" : "ink"}>
                {v.sideLabel(r, "A")}
              </Body>
              <Body numberOfLines={1} size={13.5} weight={done && r.winner === r.b ? "bold" : "regular"} tone={done && r.winner !== r.b ? "ink2" : "ink"}>
                {v.sideLabel(r, "B")}
              </Body>
            </View>
            <View style={{ alignItems: "flex-end", gap: 3 }}>
              {live ? <LivePill /> : awaiting ? <Chip label="Match over" /> : r.status === "cancelled" ? <Chip label="Not needed" /> : !done ? <Chip label={timeIn(r.scheduledTime, tz)} /> : null}
              <Num size={15} tone={done ? "ink" : "ink2"}>{live && r.score?.games ? `${sets ? `${sets} ` : ""}${r.score.games.a}–${r.score.games.b}` : sets}</Num>
            </View>
          </Card>
        );
      })}
      {rubbers.length === 0 && (
        <View style={{ padding: 14, borderTopWidth: 1, borderColor: t.line }}>
          <Body tone="ink2" size={13}>Line-ups are announced before play.</Body>
        </View>
      )}
    </View>
  );
}

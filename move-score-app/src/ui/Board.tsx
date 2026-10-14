import { View } from "react-native";
import { LEAGUE_VISIBILITY_BADGE, leagueVisibility, type MBoardLine, type MLeagueCard } from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Eyebrow, Num } from "./Text";
import { Card, Chip } from "./Bits";
import { dateRange } from "../api/model";
import { openLeague } from "../nav/links";

/**
 * A board: rank, name, points (wins–losses and played under the name). Public
 * lines carry names and numbers only. `limit` trims long boards.
 */
export function BoardTable({ lines, limit = 50, empty = "No results yet this period." }: { lines: MBoardLine[]; limit?: number; empty?: string }) {
  const { t } = useTheme();
  if (lines.length === 0) {
    return (
      <Card>
        <Body tone="ink3" size={13}>{empty}</Body>
      </Card>
    );
  }
  return (
    <Card style={{ paddingVertical: 4 }}>
      {lines.slice(0, limit).map((l, i) => (
        <View
          key={`${l.rank}-${l.name}-${i}`}
          accessible
          accessibilityLabel={`${l.rank}. ${l.name}, ${l.points} points, ${l.wins} won, ${l.losses} lost`}
          style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, borderTopWidth: i === 0 ? 0 : 1, borderColor: t.line }}
        >
          <Num size={16} tone={l.rank <= 3 ? "ball" : "ink2"} style={{ width: 28, textAlign: "right" }}>{l.rank}</Num>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Body weight="semi" numberOfLines={1}>{l.name}</Body>
            <Body tone="ink3" size={12}>{`${l.wins}–${l.losses} · ${l.played} played`}</Body>
          </View>
          <Num size={18}>{l.points}</Num>
        </View>
      ))}
    </Card>
  );
}

const KIND_LABEL = { nights: "League nights", season: "Season" } as const;

/** A league in a list: what it is, who runs it, members and the next date. */
export function LeagueLine({ l, showOrg = false }: { l: MLeagueCard; showOrg?: boolean }) {
  const badge = LEAGUE_VISIBILITY_BADGE[leagueVisibility(l.visibility)];
  return (
    <Card onPress={() => openLeague(l.slug)} accessibilityLabel={[l.name, badge, KIND_LABEL[l.kind], showOrg ? l.organization?.name : null, `${l.members} members`].filter(Boolean).join(". ")} style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <View style={{ flexDirection: "row", gap: 6 }}>
          <Chip label={l.status === "closed" ? "Closed" : l.nextDate ? `Next ${dateRange(l.nextDate, null)}` : KIND_LABEL[l.kind]} />
          {badge ? <VisibilityBadge label={badge} /> : null}
        </View>
        <Eyebrow size={10}>{l.sport}</Eyebrow>
      </View>
      <Body weight="bold" size={16}>{l.name}</Body>
      <Body tone="ink2" size={12.5}>
        {[showOrg ? l.organization?.name : null, `${l.members} ${l.members === 1 ? "member" : "members"}`, l.divisions > 1 ? `${l.divisions} divisions` : null].filter(Boolean).join(" · ")}
      </Body>
    </Card>
  );
}

/** "Members only" / "Invite only": shown only to people who can see such a league (a public one has none). */
export function VisibilityBadge({ label }: { label: string }) {
  const { t } = useTheme();
  return <Chip label={label} style={{ backgroundColor: "transparent", borderWidth: 1, borderColor: t.line }} />;
}

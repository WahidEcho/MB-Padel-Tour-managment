import { View } from "react-native";
import { leagueVisibility, type MBoardLine, type MLeagueCard } from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Eyebrow, Num } from "./Text";
import { Card, Chip } from "./Bits";
import { dateRange } from "../api/model";
import { openLeague } from "../nav/links";
import { useT } from "../i18n";
import { tr, type Key } from "../i18n/t";

/**
 * A board: rank, name, points (wins–losses and played under the name). Public
 * lines carry names and numbers only. `limit` trims long boards.
 */
export function BoardTable({ lines, limit = 50, empty }: { lines: MBoardLine[]; limit?: number; empty?: string }) {
  const { t } = useTheme();
  const tr = useT();
  if (lines.length === 0) {
    return (
      <Card>
        <Body tone="ink3" size={13}>{empty ?? tr("hero.boardEmpty")}</Body>
      </Card>
    );
  }
  return (
    <Card style={{ paddingVertical: 4 }}>
      {lines.slice(0, limit).map((l, i) => (
        <View
          key={`${l.rank}-${l.name}-${i}`}
          accessible
          accessibilityLabel={tr("hero.boardA11y", { rank: l.rank, name: l.name, points: l.points, wins: l.wins, losses: l.losses })}
          style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, borderTopWidth: i === 0 ? 0 : 1, borderColor: t.line }}
        >
          <Num size={16} tone={l.rank <= 3 ? "ball" : "ink2"} style={{ width: 28, textAlign: "right" }}>{l.rank}</Num>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Body weight="semi" numberOfLines={1}>{l.name}</Body>
            <Body tone="ink3" size={12}>{tr("hero.boardLine", { wins: l.wins, losses: l.losses, count: l.played })}</Body>
          </View>
          <Num size={18}>{l.points}</Num>
        </View>
      ))}
    </Card>
  );
}

const KIND_LABEL: Record<MLeagueCard["kind"], Key> = { nights: "hero.leagueNights", season: "hero.season" };
const BADGE: Record<ReturnType<typeof leagueVisibility>, Key | null> = { everyone: null, org_players: "hero.membersOnly", invite_only: "hero.inviteOnly" };

/** A league in a list: what it is, who runs it, members and the next date. */
export function LeagueLine({ l, showOrg = false }: { l: MLeagueCard; showOrg?: boolean }) {
  const tr = useT();
  const badgeKey = BADGE[leagueVisibility(l.visibility)];
  const badge = badgeKey ? tr(badgeKey) : null;
  const kind = tr(KIND_LABEL[l.kind]);
  return (
    <Card onPress={() => openLeague(l.slug)} accessibilityLabel={[l.name, badge, kind, showOrg ? l.organization?.name : null, tr("hero.members", { count: l.members })].filter(Boolean).join(". ")} style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <View style={{ flexDirection: "row", gap: 6 }}>
          <Chip label={l.status === "closed" ? tr("hero.closed") : l.nextDate ? tr("hero.nextDate", { date: dateRange(l.nextDate, null) }) : kind} />
          {badge ? <VisibilityBadge label={badge} /> : null}
        </View>
        <Eyebrow size={10}>{l.sport}</Eyebrow>
      </View>
      <Body weight="bold" size={16}>{l.name}</Body>
      <Body tone="ink2" size={12.5}>
        {[showOrg ? l.organization?.name : null, tr("hero.members", { count: l.members }), l.divisions > 1 ? tr("hero.divisions", { count: l.divisions }) : null].filter(Boolean).join(" · ")}
      </Body>
    </Card>
  );
}

/** "Members only" / "Invite only": shown only to people who can see such a league (a public one has none). */
export function VisibilityBadge({ label }: { label: string }) {
  const { t } = useTheme();
  const tr = useT();
  // The shared module's English badge words, in the app's language.
  const shown = label === "Members only" ? tr("hero.membersOnly") : label === "Invite only" ? tr("hero.inviteOnly") : label;
  return <Chip label={shown} style={{ backgroundColor: "transparent", borderWidth: 1, borderColor: t.line }} />;
}

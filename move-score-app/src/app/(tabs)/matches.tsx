import { useMemo, useState } from "react";
import type { MMatch } from "@core";
import { Pressable, ScrollView, View } from "react-native";
import { refetchOnScreen, useBundle, useLive } from "../../api/queries";
import { dayIn, finishedMatches, liveMatches, makeView, needsDay, upcomingMatches } from "../../api/model";
import { useFeaturedNeeds, useFeaturedSlugs } from "../../api/featured";
import { LoadState } from "../../ui/LoadState";
import { useTheme } from "../../theme/ThemeProvider";
import { Screen } from "../../ui/Screen";
import { Segments } from "../../ui/Segments";
import { Body, Display } from "../../ui/Text";
import { Empty, SectionHeader } from "../../ui/Bits";
import { MatchMini } from "../../ui/Cards";
import { StaleBanner } from "../../ui/Offline";
import { useFollowsOf } from "../../state/follows";
import { openTournament } from "../../nav/links";

type Filter = "all" | "live" | "starred" | "results";

function TournamentMatches({ slug, filter, day }: { slug: string; filter: Filter; day: string | null }) {
  const b = useBundle(slug);
  const l = useLive(slug);
  const starred = useFollowsOf("match");
  const followedPlayers = useFollowsOf("player");
  const nations = useFollowsOf("nation");
  const v = useMemo(() => (b.data ? makeView(b.data, l.data) : null), [b.data, l.data]);
  if (!v || !b.data) return null;
  const tz = b.data.tournament.timezone;
  const mine = (m: MMatch) =>
    starred.includes(m.id) ||
    [...m.aPlayers, ...m.bPlayers].some((p) => followedPlayers.includes(p)) ||
    [v.team(m.a)?.code, v.team(m.b)?.code].some((c) => c && nations.includes(c));
  let list = filter === "live" ? liveMatches(l.data) : filter === "results" ? finishedMatches(l.data) : [...liveMatches(l.data), ...upcomingMatches(l.data), ...finishedMatches(l.data)];
  if (filter === "starred") list = list.filter(mine);
  if (day) list = list.filter((m) => dayIn(m.scheduledTime ?? m.startedAt, tz) === day);
  list = list.filter((m) => m.a && m.b);
  if (!list.length) return null;
  // A chosen day already says which day; otherwise name the day once the list runs past today.
  const withDay = !day && needsDay(list.filter((m) => m.status === "scheduled" || m.status === "ready").map((m) => m.scheduledTime), tz);
  return (
    <View style={{ gap: 8 }}>
      <SectionHeader title={b.data.tournament.name} onTitlePress={() => openTournament(slug)} />
      {list.slice(0, 80).map((m) => (
        <MatchMini key={m.id} m={m} v={v} withDay={withDay} />
      ))}
    </View>
  );
}

function useDays(slugs: string[]) {
  // Days come from the first tournament's schedule; both finals share the week.
  const b = useBundle(slugs[0]);
  const l = useLive(slugs[0]);
  return useMemo(() => {
    if (!b.data || !l.data) return [];
    const tz = b.data.tournament.timezone;
    return [...new Set(l.data.matches.map((m) => m.scheduledTime).filter(Boolean).sort().map((s) => dayIn(s!, tz)))];
  }, [b.data, l.data]);
}

export default function Matches() {
  const { t } = useTheme();
  const slugs = useFeaturedSlugs().map((s) => s.slug);
  const [filter, setFilter] = useState<Filter>("all");
  const [day, setDay] = useState<string | null>(null);
  const days = useDays(slugs);
  const first = useLive(slugs[0]);
  const { needs, waiting } = useFeaturedNeeds();
  return (
    <Screen onRefresh={refetchOnScreen}>
      <Display size={26} style={{ marginTop: 8 }}>Matches</Display>
      <StaleBanner queries={[first]} live />
      <Segments
        value={filter}
        onChange={setFilter}
        options={[
          { key: "all", label: "All" },
          { key: "live", label: "Live" },
          { key: "starred", label: "Mine" },
          { key: "results", label: "Results" },
        ]}
      />
      {days.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }} style={{ marginBottom: 6 }}>
          {[null, ...days].map((d) => (
            <Pressable key={d ?? "all"} onPress={() => setDay(d)} accessibilityRole="button" accessibilityState={{ selected: day === d }} hitSlop={4} style={({ pressed }) => ({ paddingHorizontal: 12, paddingVertical: 9, borderRadius: 999, backgroundColor: day === d ? t.ball : t.chip, opacity: pressed ? 0.7 : 1 })}>
              <Body weight="bold" size={12.5} style={{ color: day === d ? t.ballInk : t.ink }}>{d ?? "Every day"}</Body>
            </Pressable>
          ))}
        </ScrollView>
      )}
      {slugs.map((s) => (
        <TournamentMatches key={s} slug={s} filter={filter} day={day} />
      ))}
      {waiting ? <LoadState queries={needs} what="the matches" /> : !slugs.length && <Empty title="Nothing on court yet" body="Matches appear here when the featured event starts." />}
      {filter === "starred" && <Body tone="ink3" size={12} style={{ marginTop: 14 }}>Mine shows matches you starred, and every match of the players and nations you follow.</Body>}
    </Screen>
  );
}

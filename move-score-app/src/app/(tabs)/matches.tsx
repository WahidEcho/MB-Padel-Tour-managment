import { useCallback, useEffect, useMemo, useState } from "react";
import type { MMatch } from "@core";
import { Pressable, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { refetchOnScreen, useBundle, useLive } from "../../api/queries";
import { dayIn, finishedMatches, liveMatches, makeView, needsDay, upcomingMatches } from "../../api/model";
import { useFeaturedNeeds, useFeaturedSlugs } from "../../api/featured";
import { LoadState } from "../../ui/LoadState";
import { useTheme } from "../../theme/ThemeProvider";
import { Screen } from "../../ui/Screen";
import { Segments } from "../../ui/Segments";
import { Body, Display } from "../../ui/Text";
import { Button, Empty, SectionHeader } from "../../ui/Bits";
import { MatchMini } from "../../ui/Cards";
import { StaleBanner } from "../../ui/Offline";
import { useFollowsOf } from "../../state/follows";
import { session } from "../../state/session";
import { openTournament } from "../../nav/links";
import { useMyPlayer } from "../../player/me";
import { isMine } from "../../player/mine";

type Filter = "all" | "live" | "mine" | "results";

function TournamentMatches({ slug, filter, day, mine, onShown }: { slug: string; filter: Filter; day: string | null; mine: (m: MMatch) => boolean; onShown: (slug: string, n: number) => void }) {
  const b = useBundle(slug);
  const l = useLive(slug);
  const v = useMemo(() => (b.data ? makeView(b.data, l.data) : null), [b.data, l.data]);
  const tz = b.data?.tournament.timezone ?? "UTC";
  let list: MMatch[] = [];
  if (v) {
    list = filter === "live" ? liveMatches(l.data) : filter === "results" ? finishedMatches(l.data) : [...liveMatches(l.data), ...upcomingMatches(l.data), ...finishedMatches(l.data)];
    if (filter === "mine") list = list.filter(mine);
    if (day) list = list.filter((m) => dayIn(m.scheduledTime ?? m.startedAt, tz) === day);
    list = list.filter((m) => m.a && m.b);
  }
  // The tab says "nothing for you" only when no tournament has a match to show.
  const n = list.length;
  useEffect(() => onShown(slug, n), [slug, n, onShown]);
  if (!v || !b.data || !n) return null;
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
  const signedIn = session.use((s) => Boolean(s.user));
  // Undefined while the first answer is on its way; null when no player is linked.
  const me = useMyPlayer().data;
  const starred = useFollowsOf("match");
  const mine = useCallback((m: MMatch) => isMine(m, me, starred), [me, starred]);
  const [shown, setShown] = useState<Record<string, number>>({});
  const onShown = useCallback((slug: string, n: number) => setShown((s) => (s[slug] === n ? s : { ...s, [slug]: n })), []);
  const nothingMine = filter === "mine" && !waiting && slugs.length > 0 && slugs.every((s) => !shown[s]);
  const noPlayer = !signedIn || me === null;
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
          { key: "mine", label: "Mine" },
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
        <TournamentMatches key={s} slug={s} filter={filter} day={day} mine={mine} onShown={onShown} />
      ))}
      {waiting ? <LoadState queries={needs} what="the matches" /> : !slugs.length && <Empty title="Nothing on court yet" body="Matches appear here when the featured event starts." />}
      {nothingMine &&
        (noPlayer ? (
          <View style={{ gap: 10 }}>
            <Empty title="No player linked yet" body="Playing in this event? Enter the player code the tournament sent you and your matches appear here. Star any match to keep it here too." />
            <Button label="I have a player code" onPress={() => router.push("/player-code")} />
          </View>
        ) : me ? (
          <Empty title="No matches for you yet" body={day ? "None of your matches is on this day. Star any match to keep it here too." : "Your matches appear here once the order of play lists them. Star any match to keep it here too."} />
        ) : null)}
      {filter === "mine" && (
        <Body tone="ink3" size={12} style={{ marginTop: 14 }}>
          {noPlayer ? "Mine shows the matches you play, once your player code is linked, and the matches you starred." : `Mine shows the matches ${me ? `${me.name} plays` : "you play"} and the matches you starred.`} Players and nations you follow are under Following.
        </Body>
      )}
    </Screen>
  );
}

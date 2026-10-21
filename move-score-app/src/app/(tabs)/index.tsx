import { ScrollView, View } from "react-native";
import { router } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import type { MEventGroup, MTournamentCard } from "@core";
import { queryClient, useBundle, useDiscover, useLive, useTopBoard } from "../../api/queries";
import { dateRange, liveMatches, makeView, needsDay, sportName, upcomingMatches } from "../../api/model";
import { useT } from "../../i18n";
import { useTheme } from "../../theme/ThemeProvider";
import { Screen } from "../../ui/Screen";
import { Body, Display, Eyebrow } from "../../ui/Text";
import { Card, Chip, Empty, LivePill, SectionHeader, Wordmark } from "../../ui/Bits";
import { MatchMini, TieRow } from "../../ui/Cards";
import { StaleBanner } from "../../ui/Offline";
import { LoadState } from "../../ui/LoadState";
import { ProfileButton } from "../../ui/Header";
import { openLeagues, openTournament } from "../../nav/links";
import { BoardTable } from "../../ui/Board";
import { RegistrationBanner } from "../../auth/RegistrationBanner";
import { LiveCourtsHero } from "../../ui/LiveCourtsHero";
import { Pressable } from "react-native";

/**
 * The hero is navy in both themes, so its chips keep fixed light-on-navy colours
 * (theme chips are dark ink in light mode, about 2:1 on navy).
 */
function HeroChip({ label, live }: { label: string; live?: boolean }) {
  return (
    <View accessibilityLabel={label} style={{ flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(255,255,255,0.12)", paddingHorizontal: 9, paddingVertical: 5, borderRadius: 999 }}>
      {live ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: "#FF2D55" }} /> : null}
      <Eyebrow size={10} style={{ color: "#E8ECF4", letterSpacing: 0.8 }}>
        {label}
      </Eyebrow>
    </View>
  );
}

function Hero({ g }: { g: MEventGroup }) {
  const { t } = useTheme();
  const tr = useT();
  const count = (n: { liveCount: number; teamCount: number }) => (n.liveCount ? tr("screens.liveN", { n: n.liveCount }) : tr("screens.teams", { count: n.teamCount }));
  return (
    <View style={{ borderRadius: 26, overflow: "hidden", borderWidth: 1, borderColor: "rgba(255,255,255,0.1)" }}>
      <LinearGradient colors={["#0b1a4d", "#01041A"]} start={{ x: 0, y: 0 }} end={{ x: 0.8, y: 1 }} style={{ padding: 18, gap: 4 }}>
        <View style={{ position: "absolute", right: -40, top: -40, width: 120, height: 120, borderRadius: 60, backgroundColor: t.ball, opacity: 0.95, shadowColor: t.ball, shadowOpacity: 0.6, shadowRadius: 30 }} />
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          {g.liveCount > 0 ? <HeroChip live label={tr("screens.liveCount", { n: g.liveCount })} /> : <HeroChip label={dateRange(g.startsOn, g.endsOn) || tr("screens.featured")} />}
          {g.city ? <HeroChip label={g.city} /> : null}
        </View>
        <Display size={26} style={{ color: "#E8ECF4", marginTop: 12, maxWidth: "78%" }}>
          {g.name}
        </Display>
        <Body size={13} style={{ color: "#9AA4B8" }}>
          {[g.subtitle, g.venue, dateRange(g.startsOn, g.endsOn)].filter(Boolean).join(" · ")}
        </Body>
        <View style={{ flexDirection: "row", gap: 8, marginTop: 14 }}>
          {g.tournaments.map((tn, i) => (
            <Pressable
              key={tn.id}
              accessibilityRole="button"
              accessibilityLabel={`${tn.name}, ${count(tn)}`}
              onPress={() => openTournament(tn.slug)}
              style={({ pressed }) => [{ flex: 1, borderRadius: 18, padding: 12, gap: 6, backgroundColor: pressed ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.06)", borderWidth: 1, borderColor: "rgba(255,255,255,0.1)" }, pressed && { transform: [{ scale: 0.98 }] }]}
            >
              <View style={{ height: 3, borderRadius: 3, backgroundColor: tn.skin.seedA ?? (i ? "#8a4fff" : "#d8572a") }} />
              <Eyebrow size={11.5} style={{ color: "#E8ECF4", letterSpacing: 0.4 }} numberOfLines={3}>
                {tn.name}
              </Eyebrow>
              <Body size={11.5} style={{ color: "#9AA4B8" }}>
                {count(tn)}
              </Body>
            </Pressable>
          ))}
        </View>
      </LinearGradient>
    </View>
  );
}

/** Live rubbers and the next ties of one featured tournament. */
function FeaturedFeed({ slug, section }: { slug: string; section: "live" | "next" }) {
  const b = useBundle(slug);
  const l = useLive(slug, 8_000);
  if (!b.data) return null;
  const v = makeView(b.data, l.data);
  if (section === "live") {
    const live = liveMatches(l.data);
    return (
      <>
        {live.map((m) => (
          <MatchMini key={m.id} m={m} v={v} width={250} />
        ))}
      </>
    );
  }
  const tz = b.data.tournament.timezone;
  const ties = (l.data?.ties ?? []).filter((t) => t.status === "scheduled" && t.a && t.b).sort((x, y) => (x.scheduledTime ?? "9").localeCompare(y.scheduledTime ?? "9")).slice(0, 3);
  const matches = upcomingMatches(l.data).slice(0, 3);
  // Times alone mislead once the list runs into another day (or is not today).
  const withDay = needsDay((ties.length ? ties : matches).map((x) => x.scheduledTime), tz);
  const next = ties.length ? ties.map((t) => <TieRow key={t.id} tie={t} v={v} withDay={withDay} />) : matches.map((m) => <MatchMini key={m.id} m={m} v={v} withDay={withDay} />);
  return <>{next}</>;
}

function TournamentLine({ c }: { c: MTournamentCard }) {
  const tr = useT();
  return (
    <Card onPress={() => openTournament(c.slug)} accessibilityLabel={[c.name, c.liveCount ? tr("screens.liveN", { n: c.liveCount }) : null, [c.venue, c.city].filter(Boolean).join(", ")].filter(Boolean).join(". ")} style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        {c.liveCount ? <LivePill label={tr("screens.liveCount", { n: c.liveCount })} /> : <Chip label={c.status === "completed" ? tr("screens.results") : dateRange(c.startsOn, c.endsOn) || tr("screens.upcoming")} />}
        <Eyebrow size={10}>{sportName(c.sport)}</Eyebrow>
      </View>
      <Body weight="bold" size={16}>{c.name}</Body>
      <Body tone="ink2" size={12.5}>{[c.venue, c.city].filter(Boolean).join(", ") || tr("screens.teams", { count: c.teamCount })}</Body>
    </Card>
  );
}

/** The top five of all leagues this month (hidden until someone has league points). */
function TopLeagues() {
  const tr = useT();
  const top = useTopBoard();
  if (!top.data?.lines.length) return null;
  return (
    <>
      <SectionHeader title={tr("screens.topLeagues")} action={tr("screens.leagues")} onAction={openLeagues} />
      <BoardTable lines={top.data.lines} limit={5} />
    </>
  );
}

export default function Discover() {
  const tr = useT();
  const d = useDiscover();
  const data = d.data;
  const featured = data?.featured ?? [];
  const featuredSlugs = featured.flatMap((g) => g.tournaments.map((t) => t.slug)).slice(0, 4);
  return (
    <Screen onRefresh={() => Promise.all([d.refetch(), queryClient.refetchQueries({ queryKey: ["courts-live"], type: "active" })])}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", height: 40, marginBottom: 14 }}>
        <Wordmark />
        <ProfileButton />
      </View>
      <StaleBanner queries={[d]} />
      <RegistrationBanner style={{ marginBottom: 14 }} />
      {/* Live days: every court of the featured event and the live tournaments (hidden otherwise). */}
      <LiveCourtsHero />
      <Display size={34} style={{ marginBottom: 6 }}>
        {tr("screens.tagline")}
      </Display>
      <Body tone="ink2" size={14} style={{ marginBottom: 18 }}>
        {featured[0]?.venue ? tr("screens.liveFrom", { place: [featured[0].venue, featured[0].city].filter(Boolean).join(", ") }) : tr("screens.discoverIntro")}
      </Body>
      {featured.map((g) => (
        <Hero key={g.id} g={g} />
      ))}
      {featuredSlugs.length > 0 && (
        <>
          <SectionHeader title={tr("screens.liveNow")} action={tr("screens.allMatches")} onAction={() => router.push("/matches")} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingRight: 18 }} style={{ marginHorizontal: -18, paddingLeft: 18 }}>
            {featuredSlugs.map((s) => (
              <FeaturedFeed key={s} slug={s} section="live" />
            ))}
          </ScrollView>
          <SectionHeader title={tr("common.upNext")} />
          <View style={{ gap: 8 }}>
            {featuredSlugs.map((s) => (
              <FeaturedFeed key={s} slug={s} section="next" />
            ))}
          </View>
        </>
      )}
      {(data?.live.length ?? 0) > 0 && <SectionHeader title={tr("screens.alsoLive")} />}
      <View style={{ gap: 8 }}>{data?.live.map((c) => <TournamentLine key={c.id} c={c} />)}</View>
      {(data?.upcoming.length ?? 0) > 0 && <SectionHeader title={tr("screens.comingUp")} />}
      <View style={{ gap: 8 }}>{data?.upcoming.map((c) => <TournamentLine key={c.id} c={c} />)}</View>
      <TopLeagues />
      {(data?.past.length ?? 0) > 0 && <SectionHeader title={tr("screens.results")} />}
      <View style={{ gap: 8 }}>{data?.past.slice(0, 12).map((c) => <TournamentLine key={c.id} c={c} />)}</View>
      {!data && <LoadState queries={[d]} what={tr("screens.whatLatestEvents")} />}
      {data && !featured.length && !data.live.length && !data.upcoming.length && !data.past.length && <Empty title={tr("screens.noTournamentsTitle")} body={tr("screens.noTournamentsBody")} />}
    </Screen>
  );
}

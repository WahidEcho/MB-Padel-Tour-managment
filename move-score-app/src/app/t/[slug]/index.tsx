import { useMemo, useState } from "react";
import { Linking, Platform, Pressable, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useBundle, useLive, useRegistrationInfo, useStandings, useVenue } from "../../../api/queries";
import { dateRange, finishedMatches, isAwaitingResult, liveMatches, makeView, sportName } from "../../../api/model";
import { useT } from "../../../i18n";
import { SkinScope, useTheme } from "../../../theme/ThemeProvider";
import { Screen } from "../../../ui/Screen";
import { BackHeader } from "../../../ui/Header";
import { Segments } from "../../../ui/Segments";
import { Body, Display, Eyebrow, Num } from "../../../ui/Text";
import { Card, Empty, Flag, LivePill, SectionHeader, ToggleButton } from "../../../ui/Bits";
import { MatchMini } from "../../../ui/Cards";
import { MatchSchedule, TieSchedule } from "../../../ui/Schedule";
import { NoticeBanners } from "../../../ui/NoticeBanner";
import { SponsorBand } from "../../../ui/Sponsors";
import { StaleBanner } from "../../../ui/Offline";
import { LoadState } from "../../../ui/LoadState";
import { toggleFollow, useFollowsOf } from "../../../state/follows";
import { isNation, openOrg, openRegister, openTeam, openVenueMap } from "../../../nav/links";
import { Brackets } from "../../../ui/Bracket";
import { NightTable } from "../../../ui/NightTable";
import { FollowedPlayers } from "../../../ui/FollowedPlayers";
import { nightTableOf } from "../../../night/table";
import { EventInfoLink } from "../../../ui/EventInfoLink";
import { StoriesRow } from "../../../stories/StoriesRow";

type Tab = "ties" | "matches" | "groups" | "brackets" | "nations";
const TABS: Tab[] = ["ties", "matches", "groups", "brackets", "nations"];

/** The venue in the phone's maps app. */
function openMaps(place: string) {
  const q = encodeURIComponent(place);
  void Linking.openURL(Platform.OS === "ios" ? `https://maps.apple.com/?q=${q}` : `https://www.google.com/maps/search/?api=1&query=${q}`).catch(() => {});
}

function Hub({ slug, initialTab }: { slug: string; initialTab?: Tab }) {
  const { t } = useTheme();
  const tr = useT();
  const b = useBundle(slug);
  const l = useLive(slug);
  // Registration (Phase 9): a "Register" link while the event takes entries in Move Score.
  const reg = useRegistrationInfo(slug);
  const s = useStandings(slug);
  // The 3D venue map, once the organiser has published one (a 404 until then).
  const venue = useVenue(slug);
  const isTies = b.data?.tournament.isTies ?? false;
  const [tab, setTab] = useState<Tab>(initialTab ?? "ties");
  const following = useFollowsOf("nation");
  const v = useMemo(() => (b.data ? makeView(b.data, l.data) : null), [b.data, l.data]);
  // A league night (Phase 8): its order of play per court with "about" times.
  const night = useMemo(() => (b.data ? nightTableOf(b.data, l.data) : null), [b.data, l.data]);
  if (!b.data || !v) {
    return (
      <Screen tabs={false} onRefresh={() => b.refetch()}>
        <BackHeader label={tr("event.discoverBack")} />
        <LoadState queries={[b]} what={tr("event.whatTournament")} notFound={<Empty title={tr("event.tournamentNA")} body={tr("event.tournamentNABody")} />} />
      </Screen>
    );
  }
  const tour = b.data.tournament;
  const ties = l.data?.ties ?? [];
  const liveCount = liveMatches(l.data).filter((m) => !isAwaitingResult(m)).length;
  const current: Tab = !isTies && (tab === "ties" || tab === "brackets") ? "matches" : isTies && tab === "matches" ? "ties" : tab;
  // The "ties" key stays (deep links ?tab=ties); the tab is the order of play by day and court.
  const tabs = isTies
    ? [
        { key: "ties" as Tab, label: tr("event.tabSchedule") },
        { key: "groups" as Tab, label: tr("event.tabGroups") },
        { key: "brackets" as Tab, label: tr("event.tabBrackets") },
        { key: "nations" as Tab, label: tr("event.tabNations") },
      ]
    : [
        { key: "matches" as Tab, label: tr("event.tabMatches") },
        { key: "groups" as Tab, label: tr("event.tabGroups") },
        { key: "nations" as Tab, label: tr("event.tabTeams") },
      ];
  return (
    <Screen tabs={false} onRefresh={() => Promise.all([l.refetch(), b.refetch(), s.refetch()])}>
      <BackHeader label={tr("event.discoverBack")} />
      <StaleBanner queries={[l]} live />
      <NoticeBanners live={l.data} timeZone={tour.timezone} />
      {/* This event's Move Score Stories (hidden while it has none). */}
      <StoriesRow slug={slug} />
      <Eyebrow>{[sportName(tour.sport), tr(isTies ? "screens.nations" : "screens.teams", { count: b.data.teams.length })].join(" · ")}</Eyebrow>
      <Display size={27} style={{ marginTop: 8, lineHeight: 30 }}>{tour.name}</Display>
      <View style={{ flexDirection: "row", columnGap: 16, rowGap: 10, flexWrap: "wrap", marginTop: 12, alignItems: "center" }}>
        {tour.venue ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={tr("event.openInMaps", { venue: tour.venue })}
            onPress={() => openMaps([tour.venue, tour.city].filter(Boolean).join(", "))}
            hitSlop={8}
            style={({ pressed }) => pressed && { opacity: 0.6 }}
          >
            <Body tone="blue" size={13} weight="semi">{`${tour.venue} ›`}</Body>
          </Pressable>
        ) : null}
        <EventInfoLink slug={slug} />
        {tour.startsOn ? <Body tone="ink2" size={13}>{dateRange(tour.startsOn, tour.endsOn)}</Body> : null}
        {tour.organization ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={tr("event.runBy", { name: tour.organization.name })}
            onPress={() => openOrg(tour.organization!.slug)}
            hitSlop={8}
            style={({ pressed }) => pressed && { opacity: 0.6 }}
          >
            <Body tone="blue" size={13} weight="semi">{tr("event.byOrg", { name: tour.organization.name })}</Body>
          </Pressable>
        ) : null}
        {venue.data ? (
          <Pressable accessibilityRole="link" accessibilityLabel={tr("event.venueMapA11y")} onPress={() => openVenueMap(slug)} hitSlop={8} style={({ pressed }) => pressed && { opacity: 0.6 }}>
            <Body tone="blue" size={13} weight="semi">{tr("event.venueMapLink")}</Body>
          </Pressable>
        ) : null}
        {liveCount ? <LivePill label={tr("screens.liveCount", { n: liveCount })} /> : null}
        {reg.data?.open ? (
          <Pressable accessibilityRole="link" accessibilityLabel={tr("event.registerA11y", { name: tour.name })} onPress={() => openRegister(slug)} hitSlop={8} style={({ pressed }) => pressed && { opacity: 0.6 }}>
            <Body tone="blue" size={13} weight="semi">{tr("event.registerLink")}</Body>
          </Pressable>
        ) : null}
      </View>
      <Segments value={current} options={tabs} onChange={setTab} />

      {current === "ties" && <TieSchedule ties={ties} v={v} />}

      {current === "matches" && night && (
        <View style={{ gap: 8 }}>
          {liveMatches(l.data).map((m) => (
            <MatchMini key={m.id} m={m} v={v} />
          ))}
          {night.matches > night.finished ? (
            <>
              <SectionHeader title={b.data.tournament.night?.publishedAt ? tr("event.orderOfPlay") : tr("event.orderOfPlayDraft")} />
              <NightTable table={night} />
            </>
          ) : null}
          {finishedMatches(l.data).length > 0 && <SectionHeader title={tr("screens.results")} />}
          {finishedMatches(l.data).map((m) => (
            <MatchMini key={m.id} m={m} v={v} />
          ))}
        </View>
      )}
      {current === "matches" && !night && <MatchSchedule matches={l.data?.matches ?? []} v={v} />}

      {current === "groups" && (
        <View style={{ gap: 12 }}>
          {(s.data?.groups ?? []).map((g) => (
            <View key={g.id} style={{ borderRadius: 20, overflow: "hidden", backgroundColor: t.surface, borderWidth: 1, borderColor: t.line }}>
              <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12 }}>
                <Eyebrow style={{ flex: 1 }}>{g.name}</Eyebrow>
                <Eyebrow style={{ width: 54, textAlign: "center" }}>{isTies ? tr("event.colTies") : tr("event.colWonLost")}</Eyebrow>
                {isTies && <Eyebrow style={{ width: 84, textAlign: "center" }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{tr("event.colRubbers")}</Eyebrow>}
                <Eyebrow style={{ width: 40, textAlign: "right" }}>{tr("event.colPoints")}</Eyebrow>
              </View>
              {g.rows.map((r) => {
                const team = v.team(r.teamId);
                const q = r.status === "qualified";
                return (
                  <Pressable
                    key={r.teamId}
                    disabled={!team}
                    onPress={() => team && openTeam(team, slug, isTies)}
                    accessibilityRole="link"
                    accessibilityLabel={`${tr("event.standingA11y", { rank: r.rank, team: team?.name ?? tr("common.tbd"), won: r.won, lost: r.lost, points: r.points })}${q ? `, ${tr("event.qualified")}` : ""}`}
                    style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: 1, borderColor: t.line, borderLeftWidth: 3, borderLeftColor: q ? t.skinA : "transparent", backgroundColor: pressed ? t.chip : "transparent" })}
                  >
                    <Num size={14} tone="ink3" style={{ width: 20 }}>{r.rank}</Num>
                    <View style={{ flex: 1, flexDirection: "row", gap: 8, alignItems: "center" }}>
                      <Flag iso2={team?.iso2} code={team?.code} />
                      <Body weight="semi" size={14} numberOfLines={1}>{isTies ? team?.code : team?.name}</Body>
                    </View>
                    <Num size={15} style={{ width: 54, textAlign: "center" }}>{`${r.won}–${r.lost}`}</Num>
                    {isTies && <Num size={15} style={{ width: 84, textAlign: "center" }}>{`${r.rubbersWon ?? 0}–${r.rubbersLost ?? 0}`}</Num>}
                    <Num size={15} style={{ width: 40, textAlign: "right" }}>{r.points}</Num>
                  </Pressable>
                );
              })}
            </View>
          ))}
          {(s.data?.placings.length ?? 0) > 0 && <SectionHeader title={tr("event.finalPlaces")} />}
          {s.data?.placings.map((p) => {
            const team = v.team(p.teamId);
            return (
              <Card key={p.teamId} onPress={team ? () => openTeam(team, slug, isTies) : undefined} accessibilityLabel={tr("event.placeA11y", { place: p.place, team: team?.name ?? tr("common.tbd") })} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <Num size={18} style={{ width: 34 }}>{p.place}</Num>
                <Flag iso2={team?.iso2} code={team?.code} />
                <Body weight="semi" style={{ flex: 1 }}>{team?.name}</Body>
                {team ? <Body tone="ink3" weight="bold">›</Body> : null}
              </Card>
            );
          })}
          {!s.data?.groups.length && <Empty title={tr("event.noGroups")} />}
        </View>
      )}

      {current === "brackets" && <Brackets ties={ties} v={v} />}

      {current === "nations" && <FollowedPlayers bundle={b.data} slug={slug} />}

      {current === "nations" && (
        <View style={{ gap: 12 }}>
          {[...b.data.teams]
            .sort((x, y) => (x.seed ?? 99) - (y.seed ?? 99) || x.name.localeCompare(y.name))
            .map((team) => (
              <Card key={team.id} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 }}>
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel={tr(isNation(team, isTies) ? "screens.pageNation" : "screens.pageTeam", {
                    name: team.seed ? `${team.name}, ${tr("screens.seedLower", { n: team.seed })}` : team.name,
                  })}
                  onPress={() => openTeam(team, slug, isTies)}
                  style={({ pressed }) => [{ flex: 1, flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 }, pressed && { opacity: 0.6 }]}
                >
                  <Flag iso2={team.iso2} code={team.code} size={34} />
                  <View style={{ flex: 1 }}>
                    <Body weight="bold" numberOfLines={1}>
                      {team.name}
                      <Body tone="ink3" weight="bold">{" ›"}</Body>
                    </Body>
                    <Body tone="ink2" size={12} numberOfLines={1}>
                      {[team.seed ? tr("screens.seed", { n: team.seed }) : null, team.players.map((p) => p.name.split(" ").slice(-1)[0]).join(", ")].filter(Boolean).join(" · ")}
                    </Body>
                  </View>
                </Pressable>
                {isNation(team, isTies) ? (
                  <ToggleButton compact on={following.includes(team.code)} onLabel={tr("screens.followingBtn")} offLabel={tr("screens.followBtn")} onPress={() => void toggleFollow("nation", team.code, tour.id)} />
                ) : null}
              </Card>
            ))}
        </View>
      )}
      <SponsorBand sponsors={b.data.sponsors} />
    </Screen>
  );
}

export default function HubScreen() {
  const { slug, tab } = useLocalSearchParams<{ slug: string; tab?: string }>();
  const b = useBundle(slug);
  return (
    <SkinScope skin={b.data?.tournament.skin}>
      <Hub slug={slug} initialTab={TABS.find((x) => x === tab)} />
    </SkinScope>
  );
}

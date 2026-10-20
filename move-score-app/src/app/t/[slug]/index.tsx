import { useMemo, useState } from "react";
import { Linking, Platform, Pressable, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useBundle, useLive, useRegistrationInfo, useStandings, useVenue } from "../../../api/queries";
import { dateRange, finishedMatches, isAwaitingResult, liveMatches, makeView } from "../../../api/model";
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

type Tab = "ties" | "matches" | "groups" | "brackets" | "nations";
const TABS: Tab[] = ["ties", "matches", "groups", "brackets", "nations"];

/** The venue in the phone's maps app. */
function openMaps(place: string) {
  const q = encodeURIComponent(place);
  void Linking.openURL(Platform.OS === "ios" ? `https://maps.apple.com/?q=${q}` : `https://www.google.com/maps/search/?api=1&query=${q}`).catch(() => {});
}

function Hub({ slug, initialTab }: { slug: string; initialTab?: Tab }) {
  const { t } = useTheme();
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
        <BackHeader label="Discover" />
        <LoadState queries={[b]} what="this tournament" notFound={<Empty title="This tournament is not available" body="It may not be public yet." />} />
      </Screen>
    );
  }
  const tr = b.data.tournament;
  const ties = l.data?.ties ?? [];
  const liveCount = liveMatches(l.data).filter((m) => !isAwaitingResult(m)).length;
  const current: Tab = !isTies && (tab === "ties" || tab === "brackets") ? "matches" : isTies && tab === "matches" ? "ties" : tab;
  // The "ties" key stays (deep links ?tab=ties); the tab is the order of play by day and court.
  const tabs = isTies
    ? ([{ key: "ties", label: "Schedule" }, { key: "groups", label: "Groups" }, { key: "brackets", label: "Brackets" }, { key: "nations", label: "Nations" }] as const)
    : ([{ key: "matches", label: "Matches" }, { key: "groups", label: "Groups" }, { key: "nations", label: "Teams" }] as const);
  return (
    <Screen tabs={false} onRefresh={() => Promise.all([l.refetch(), b.refetch(), s.refetch()])}>
      <BackHeader label="Discover" />
      <StaleBanner queries={[l]} live />
      <NoticeBanners live={l.data} timeZone={tr.timezone} />
      <Eyebrow>{[tr.sport, `${b.data.teams.length} ${isTies ? "nations" : "teams"}`].join(" · ")}</Eyebrow>
      <Display size={27} style={{ marginTop: 8, lineHeight: 30 }}>{tr.name}</Display>
      <View style={{ flexDirection: "row", columnGap: 16, rowGap: 10, flexWrap: "wrap", marginTop: 12, alignItems: "center" }}>
        {tr.venue ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`${tr.venue}, open in maps`}
            onPress={() => openMaps([tr.venue, tr.city].filter(Boolean).join(", "))}
            hitSlop={8}
            style={({ pressed }) => pressed && { opacity: 0.6 }}
          >
            <Body tone="blue" size={13} weight="semi">{`${tr.venue} ›`}</Body>
          </Pressable>
        ) : null}
        <EventInfoLink slug={slug} />
        {tr.startsOn ? <Body tone="ink2" size={13}>{dateRange(tr.startsOn, tr.endsOn)}</Body> : null}
        {tr.organization ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`Run by ${tr.organization.name}, open its page`}
            onPress={() => openOrg(tr.organization!.slug)}
            hitSlop={8}
            style={({ pressed }) => pressed && { opacity: 0.6 }}
          >
            <Body tone="blue" size={13} weight="semi">{`by ${tr.organization.name} ›`}</Body>
          </Pressable>
        ) : null}
        {venue.data ? (
          <Pressable accessibilityRole="link" accessibilityLabel="Open the 3D venue map" onPress={() => openVenueMap(slug)} hitSlop={8} style={({ pressed }) => pressed && { opacity: 0.6 }}>
            <Body tone="blue" size={13} weight="semi">{"Venue map ›"}</Body>
          </Pressable>
        ) : null}
        {liveCount ? <LivePill label={`${liveCount} LIVE`} /> : null}
        {reg.data?.open ? (
          <Pressable accessibilityRole="link" accessibilityLabel={`Register for ${tr.name}`} onPress={() => openRegister(slug)} hitSlop={8} style={({ pressed }) => pressed && { opacity: 0.6 }}>
            <Body tone="blue" size={13} weight="semi">{"Register ›"}</Body>
          </Pressable>
        ) : null}
      </View>
      <Segments value={current} options={tabs as unknown as { key: Tab; label: string }[]} onChange={setTab} />

      {current === "ties" && <TieSchedule ties={ties} v={v} />}

      {current === "matches" && night && (
        <View style={{ gap: 8 }}>
          {liveMatches(l.data).map((m) => (
            <MatchMini key={m.id} m={m} v={v} />
          ))}
          {night.matches > night.finished ? (
            <>
              <SectionHeader title={b.data.tournament.night?.publishedAt ? "Order of play" : "Order of play (draft)"} />
              <NightTable table={night} />
            </>
          ) : null}
          {finishedMatches(l.data).length > 0 && <SectionHeader title="Results" />}
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
                <Eyebrow style={{ width: 54, textAlign: "center" }}>{isTies ? "Ties" : "W–L"}</Eyebrow>
                {isTies && <Eyebrow style={{ width: 84, textAlign: "center" }}>Rubbers</Eyebrow>}
                <Eyebrow style={{ width: 40, textAlign: "right" }}>Pts</Eyebrow>
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
                    accessibilityLabel={`${r.rank}. ${team?.name ?? "TBD"}, ${r.won} won, ${r.lost} lost, ${r.points} points${q ? ", qualified" : ""}`}
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
          {(s.data?.placings.length ?? 0) > 0 && <SectionHeader title="Final places" />}
          {s.data?.placings.map((p) => {
            const team = v.team(p.teamId);
            return (
              <Card key={p.teamId} onPress={team ? () => openTeam(team, slug, isTies) : undefined} accessibilityLabel={`Place ${p.place}, ${team?.name ?? "TBD"}`} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <Num size={18} style={{ width: 34 }}>{p.place}</Num>
                <Flag iso2={team?.iso2} code={team?.code} />
                <Body weight="semi" style={{ flex: 1 }}>{team?.name}</Body>
                {team ? <Body tone="ink3" weight="bold">›</Body> : null}
              </Card>
            );
          })}
          {!s.data?.groups.length && <Empty title="No groups yet" />}
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
                  accessibilityLabel={`${team.name}${team.seed ? `, seed ${team.seed}` : ""}, ${isNation(team, isTies) ? "nation" : "team"} page`}
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
                      {[team.seed ? `Seed ${team.seed}` : null, team.players.map((p) => p.name.split(" ").slice(-1)[0]).join(", ")].filter(Boolean).join(" · ")}
                    </Body>
                  </View>
                </Pressable>
                {isNation(team, isTies) ? (
                  <ToggleButton compact on={following.includes(team.code)} onLabel="✓ Following" offLabel="+ Follow" onPress={() => void toggleFollow("nation", team.code, tr.id)} />
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

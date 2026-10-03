import { useMemo, useState } from "react";
import { Linking, Platform, Pressable, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useBundle, useLive, useStandings } from "../../../api/queries";
import { dateRange, dayIn, finishedMatches, isAwaitingResult, liveMatches, makeView, needsDay, upcomingMatches } from "../../../api/model";
import { SkinScope, useTheme } from "../../../theme/ThemeProvider";
import { Screen } from "../../../ui/Screen";
import { BackHeader } from "../../../ui/Header";
import { Segments } from "../../../ui/Segments";
import { Body, Display, Eyebrow, Num } from "../../../ui/Text";
import { Card, Empty, Flag, LivePill, SectionHeader, ToggleButton } from "../../../ui/Bits";
import { MatchMini, TieCard, TieRow } from "../../../ui/Cards";
import { SponsorBand } from "../../../ui/Sponsors";
import { StaleBanner } from "../../../ui/Offline";
import { LoadState } from "../../../ui/LoadState";
import { toggleFollow, useFollowsOf } from "../../../state/follows";
import { isNation, openTeam } from "../../../nav/links";

type Tab = "ties" | "matches" | "groups" | "nations";
const TABS: Tab[] = ["ties", "matches", "groups", "nations"];

/** The venue in the phone's maps app. */
function openMaps(place: string) {
  const q = encodeURIComponent(place);
  void Linking.openURL(Platform.OS === "ios" ? `https://maps.apple.com/?q=${q}` : `https://www.google.com/maps/search/?api=1&query=${q}`).catch(() => {});
}

function Hub({ slug, initialTab }: { slug: string; initialTab?: Tab }) {
  const { t } = useTheme();
  const b = useBundle(slug);
  const l = useLive(slug);
  const s = useStandings(slug);
  const isTies = b.data?.tournament.isTies ?? false;
  const [tab, setTab] = useState<Tab>(initialTab ?? "ties");
  const following = useFollowsOf("nation");
  const v = useMemo(() => (b.data ? makeView(b.data, l.data) : null), [b.data, l.data]);
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
  const liveTies = ties.filter((x) => x.status === "live");
  const nextTies = ties.filter((x) => x.status === "scheduled").sort((x, y) => (x.scheduledTime ?? "9").localeCompare(y.scheduledTime ?? "9"));
  // One heading per day, so "Next · Tue 3 Nov" never sits over Wednesday's ties.
  const nextByDay: { day: string; list: typeof nextTies }[] = [];
  for (const x of nextTies.slice(0, 12)) {
    const day = dayIn(x.scheduledTime, tr.timezone) || "Order of play";
    const last = nextByDay[nextByDay.length - 1];
    if (last && last.day === day) last.list.push(x);
    else nextByDay.push({ day, list: [x] });
  }
  const upcoming = upcomingMatches(l.data);
  const upcomingWithDay = needsDay(upcoming.slice(0, 30).map((m) => m.scheduledTime), tr.timezone);
  const liveCount = liveMatches(l.data).filter((m) => !isAwaitingResult(m)).length;
  const doneTies = ties.filter((x) => x.status === "completed").reverse();
  const current: Tab = !isTies && tab === "ties" ? "matches" : tab;
  const tabs = isTies
    ? ([{ key: "ties", label: "Ties" }, { key: "groups", label: "Groups" }, { key: "nations", label: "Nations" }] as const)
    : ([{ key: "matches", label: "Matches" }, { key: "groups", label: "Groups" }, { key: "nations", label: "Teams" }] as const);
  return (
    <Screen tabs={false} onRefresh={() => Promise.all([l.refetch(), b.refetch(), s.refetch()])}>
      <BackHeader label="Discover" />
      <StaleBanner queries={[l, b]} live />
      <Eyebrow>{[tr.sport, `${b.data.teams.length} ${isTies ? "nations" : "teams"}`].join(" · ")}</Eyebrow>
      <Display size={27} style={{ marginTop: 6 }}>{tr.name}</Display>
      <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
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
        {tr.startsOn ? <Body tone="ink2" size={13}>{dateRange(tr.startsOn, tr.endsOn)}</Body> : null}
        {liveCount ? <LivePill label={`${liveCount} LIVE`} /> : null}
      </View>
      <Segments value={current} options={tabs as unknown as { key: Tab; label: string }[]} onChange={setTab} />

      {current === "ties" && (
        <View style={{ gap: 10 }}>
          {liveTies.map((x) => (
            <TieCard key={x.id} tie={x} v={v} linkTie />
          ))}
          {nextByDay.map((g, i) => (
            <View key={g.day} style={{ gap: 10 }}>
              <SectionHeader title={i === 0 ? `Next · ${g.day}` : g.day} />
              {g.list.map((x) => (
                <TieRow key={x.id} tie={x} v={v} />
              ))}
            </View>
          ))}
          {doneTies.length > 0 && <SectionHeader title="Results" />}
          {doneTies.map((x) => (
            <TieRow key={x.id} tie={x} v={v} />
          ))}
          {!ties.length && <Empty title="The order of play is not out yet" body="Ties appear here as soon as the groups are drawn." />}
        </View>
      )}

      {current === "matches" && (
        <View style={{ gap: 8 }}>
          {liveMatches(l.data).map((m) => (
            <MatchMini key={m.id} m={m} v={v} />
          ))}
          {upcoming.length > 0 && <SectionHeader title="Coming up" />}
          {upcoming.slice(0, 30).map((m) => (
            <MatchMini key={m.id} m={m} v={v} withDay={upcomingWithDay} />
          ))}
          {finishedMatches(l.data).length > 0 && <SectionHeader title="Results" />}
          {finishedMatches(l.data).map((m) => (
            <MatchMini key={m.id} m={m} v={v} />
          ))}
        </View>
      )}

      {current === "groups" && (
        <View style={{ gap: 12 }}>
          {(s.data?.groups ?? []).map((g) => (
            <View key={g.id} style={{ borderRadius: 20, overflow: "hidden", backgroundColor: t.surface, borderWidth: 1, borderColor: t.line }}>
              <View style={{ flexDirection: "row", paddingHorizontal: 12, paddingVertical: 10 }}>
                <Eyebrow style={{ flex: 1 }}>{g.name}</Eyebrow>
                <Eyebrow style={{ width: 52, textAlign: "right" }}>{isTies ? "Ties" : "W–L"}</Eyebrow>
                {isTies && <Eyebrow style={{ width: 62, textAlign: "right" }}>Rubbers</Eyebrow>}
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
                    style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderColor: t.line, borderLeftWidth: 3, borderLeftColor: q ? t.skinA : "transparent", backgroundColor: pressed ? t.chip : "transparent" })}
                  >
                    <Num size={14} tone="ink3" style={{ width: 20 }}>{r.rank}</Num>
                    <View style={{ flex: 1, flexDirection: "row", gap: 8, alignItems: "center" }}>
                      <Flag iso2={team?.iso2} code={team?.code} />
                      <Body weight="semi" size={14} numberOfLines={1}>{isTies ? team?.code : team?.name}</Body>
                    </View>
                    <Num size={15} style={{ width: 52, textAlign: "right" }}>{`${r.won}–${r.lost}`}</Num>
                    {isTies && <Num size={15} style={{ width: 62, textAlign: "right" }}>{`${r.rubbersWon ?? 0}–${r.rubbersLost ?? 0}`}</Num>}
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

      {current === "nations" && (
        <View style={{ gap: 8 }}>
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

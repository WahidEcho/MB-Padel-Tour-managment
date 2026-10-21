import { useMemo, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import type { MTeam } from "@core";
import { useBundle, useLive } from "../api/queries";
import { finishedMatches, isOnCourt, makeView, needsDay, upcomingMatches } from "../api/model";
import { toggleFollow, useFollowsOf } from "../state/follows";
import { openPlayer, openTournament } from "../nav/links";
import { Body, Eyebrow } from "./Text";
import { Card, SectionHeader, ToggleButton } from "./Bits";
import { MatchMini, TieCard, TieRow } from "./Cards";
import { useT } from "../i18n";

/**
 * One team (a nation, or a team of a club event) inside one tournament: its
 * ties or matches (live, next, results) and its players. Renders nothing when
 * the team is not in that tournament, so a nation page can stack one per event.
 */
export function TeamSection({ slug, pick }: { slug: string; pick: (t: MTeam) => boolean }) {
  const tr = useT();
  const b = useBundle(slug);
  const l = useLive(slug, 10_000);
  const followingPlayers = useFollowsOf("player");
  const v = useMemo(() => (b.data ? makeView(b.data, l.data) : null), [b.data, l.data]);
  const team = b.data?.teams.find(pick);
  if (!b.data || !v || !team) return null;
  const trn = b.data.tournament;
  const tz = trn.timezone;
  const mine = (x: { a: string | null; b: string | null }) => x.a === team.id || x.b === team.id;

  let fixtures: ReactNode;
  if (trn.isTies) {
    const ties = (l.data?.ties ?? []).filter(mine);
    const live = ties.filter((x) => x.status === "live");
    const next = ties.filter((x) => x.status === "scheduled").sort((x, y) => (x.scheduledTime ?? "9").localeCompare(y.scheduledTime ?? "9"));
    const done = ties.filter((x) => x.status === "completed").reverse();
    const withDay = needsDay(next.map((x) => x.scheduledTime), tz);
    fixtures = ties.length ? (
      <View style={{ gap: 8 }}>
        {live.map((x) => <TieCard key={x.id} tie={x} v={v} linkTie />)}
        {next.length > 0 && <Eyebrow style={{ marginTop: live.length ? 6 : 0 }}>{tr("hero.next")}</Eyebrow>}
        {next.map((x) => <TieRow key={x.id} tie={x} v={v} withDay={withDay} />)}
        {done.length > 0 && <Eyebrow style={{ marginTop: 6 }}>{tr("hero.results")}</Eyebrow>}
        {done.map((x) => <TieRow key={x.id} tie={x} v={v} />)}
      </View>
    ) : (
      <Body tone="ink2" size={13}>{tr("hero.tiesAppear")}</Body>
    );
  } else {
    const all = (l.data?.matches ?? []).filter(mine);
    const live = all.filter(isOnCourt);
    const next = upcomingMatches(l.data).filter(mine);
    const done = finishedMatches(l.data).filter(mine);
    const withDay = needsDay(next.map((m) => m.scheduledTime), tz);
    fixtures = all.length ? (
      <View style={{ gap: 8 }}>
        {live.map((m) => <MatchMini key={m.id} m={m} v={v} />)}
        {next.map((m) => <MatchMini key={m.id} m={m} v={v} withDay={withDay} />)}
        {done.map((m) => <MatchMini key={m.id} m={m} v={v} />)}
      </View>
    ) : (
      <Body tone="ink2" size={13}>{tr("hero.matchesAppear")}</Body>
    );
  }

  return (
    <View>
      <SectionHeader title={trn.name} onTitlePress={() => openTournament(slug)} titleLabel={tr("hero.openName", { name: trn.name })} />
      {fixtures}
      {team.players.length > 0 && (
        <>
          <Eyebrow style={{ marginTop: 16, marginBottom: 8 }}>{tr("hero.playersCount", { count: team.players.length })}</Eyebrow>
          <View style={{ gap: 12 }}>
            {team.players.map((p) => (
              <Card key={p.id} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingRight: 10 }}>
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel={typeof p.itfRank === "number" ? tr("hero.playerRankPage", { name: p.name, rank: p.itfRank }) : tr("hero.playerPage", { name: p.name })}
                  onPress={() => openPlayer(p.id, slug)}
                  style={({ pressed }) => [{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minHeight: 40 }, pressed && { opacity: 0.6 }]}
                >
                  <View style={{ flexShrink: 1 }}>
                    <Body weight="semi" numberOfLines={1}>{p.name}</Body>
                    {typeof p.itfRank === "number" ? <Body tone="ink2" size={12}>{tr("hero.itfJunior", { rank: p.itfRank })}</Body> : null}
                  </View>
                  <Body tone="ink3" weight="bold">›</Body>
                </Pressable>
                <ToggleButton compact on={followingPlayers.includes(p.id)} onLabel={tr("hero.followingBtn")} offLabel={tr("hero.followBtn")} onPress={() => void toggleFollow("player", p.id, trn.id)} />
              </Card>
            ))}
          </View>
        </>
      )}
      {team.status !== "active" && (
        <Body tone="ink3" size={12} style={{ marginTop: 8 }}>{team.status === "withdrawn" ? tr("hero.withdrawn") : tr("hero.disqualified")}</Body>
      )}
    </View>
  );
}

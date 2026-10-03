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

/**
 * One team (a nation, or a team of a club event) inside one tournament: its
 * ties or matches (live, next, results) and its players. Renders nothing when
 * the team is not in that tournament, so a nation page can stack one per event.
 */
export function TeamSection({ slug, pick }: { slug: string; pick: (t: MTeam) => boolean }) {
  const b = useBundle(slug);
  const l = useLive(slug, 10_000);
  const followingPlayers = useFollowsOf("player");
  const v = useMemo(() => (b.data ? makeView(b.data, l.data) : null), [b.data, l.data]);
  const team = b.data?.teams.find(pick);
  if (!b.data || !v || !team) return null;
  const tr = b.data.tournament;
  const tz = tr.timezone;
  const mine = (x: { a: string | null; b: string | null }) => x.a === team.id || x.b === team.id;

  let fixtures: ReactNode;
  if (tr.isTies) {
    const ties = (l.data?.ties ?? []).filter(mine);
    const live = ties.filter((x) => x.status === "live");
    const next = ties.filter((x) => x.status === "scheduled").sort((x, y) => (x.scheduledTime ?? "9").localeCompare(y.scheduledTime ?? "9"));
    const done = ties.filter((x) => x.status === "completed").reverse();
    const withDay = needsDay(next.map((x) => x.scheduledTime), tz);
    fixtures = ties.length ? (
      <View style={{ gap: 8 }}>
        {live.map((x) => <TieCard key={x.id} tie={x} v={v} linkTie />)}
        {next.length > 0 && <Eyebrow style={{ marginTop: live.length ? 6 : 0 }}>Next</Eyebrow>}
        {next.map((x) => <TieRow key={x.id} tie={x} v={v} withDay={withDay} />)}
        {done.length > 0 && <Eyebrow style={{ marginTop: 6 }}>Results</Eyebrow>}
        {done.map((x) => <TieRow key={x.id} tie={x} v={v} />)}
      </View>
    ) : (
      <Body tone="ink2" size={13}>Ties appear here once the order of play is out.</Body>
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
      <Body tone="ink2" size={13}>Matches appear here once the order of play is out.</Body>
    );
  }

  return (
    <View>
      <SectionHeader title={tr.name} onTitlePress={() => openTournament(slug)} titleLabel={`Open ${tr.name}`} />
      {fixtures}
      {team.players.length > 0 && (
        <>
          <Eyebrow style={{ marginTop: 16, marginBottom: 8 }}>{`Players · ${team.players.length}`}</Eyebrow>
          <View style={{ gap: 8 }}>
            {team.players.map((p) => (
              <Card key={p.id} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingRight: 10 }}>
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel={`${p.name}, player page`}
                  onPress={() => openPlayer(p.id, slug)}
                  style={({ pressed }) => [{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minHeight: 40 }, pressed && { opacity: 0.6 }]}
                >
                  <Body weight="semi" numberOfLines={1} style={{ flexShrink: 1 }}>{p.name}</Body>
                  <Body tone="ink3" weight="bold">›</Body>
                </Pressable>
                <ToggleButton compact on={followingPlayers.includes(p.id)} onLabel="✓ Following" offLabel="+ Follow" onPress={() => void toggleFollow("player", p.id, tr.id)} />
              </Card>
            ))}
          </View>
        </>
      )}
      {team.status !== "active" && (
        <Body tone="ink3" size={12} style={{ marginTop: 8 }}>{team.status === "withdrawn" ? "Withdrawn from this event." : "Disqualified from this event."}</Body>
      )}
    </View>
  );
}

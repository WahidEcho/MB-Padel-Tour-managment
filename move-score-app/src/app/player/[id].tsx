import { useMemo } from "react";
import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { isDoneStatus } from "@core";
import { useBundle, useLive } from "../../api/queries";
import { isOnCourt, makeView, needsDay } from "../../api/model";
import { SkinScope } from "../../theme/ThemeProvider";
import { Screen } from "../../ui/Screen";
import { BackHeader } from "../../ui/Header";
import { Body, Display, Eyebrow, Num } from "../../ui/Text";
import { Card, Empty, Flag, LinkChip, SectionHeader, ToggleButton } from "../../ui/Bits";
import { MatchMini } from "../../ui/Cards";
import { OfflineState, StaleBanner, failedOffline } from "../../ui/Offline";
import { toggleFollow, useFollowing } from "../../state/follows";
import { isNation, openTeam, openTournament } from "../../nav/links";
import { useMyPlayer } from "../../player/me";
import { PlayerAvatar } from "../../player/ui";

function PlayerScreen({ id, slug }: { id: string; slug: string }) {
  const b = useBundle(slug);
  const l = useLive(slug, 10_000);
  const following = useFollowing("player", id);
  // A player looking at their own page sees their own photo, whatever the event shows everyone else.
  const me = useMyPlayer().data;
  const ownPhoto = me?.entries.some((e) => e.playerId === id) ? me.photoUrl : null;
  const v = useMemo(() => (b.data ? makeView(b.data, l.data) : null), [b.data, l.data]);
  const p = v?.player(id);
  if (!v || !p || !b.data) {
    // Still loading, or nothing to show (an old link, or a player no longer in the tournament).
    const offline = Boolean(slug) && !b.data && failedOffline(b);
    const missing = !slug || b.isError || (b.data && l.data && !p);
    return (
      <Screen tabs={false}>
        <BackHeader label="Players" fallback="/players" />
        {offline ? (
          <OfflineState what="this player" onRetry={() => Promise.all([b.refetch(), l.refetch()])} />
        ) : missing ? (
          <Empty title="Player not found" body="Open the player again from the tournament's Players list." />
        ) : (
          <Body tone="ink2">Loading…</Body>
        )}
      </Screen>
    );
  }
  const ms = (l.data?.matches ?? []).filter((m) => m.aPlayers.includes(id) || m.bPlayers.includes(id) || (!m.tieId && (m.a === p.teamId || m.b === p.teamId)));
  const mySide = (m: (typeof ms)[number]) => (m.a === p.teamId ? m.a : m.b);
  const done = ms.filter((m) => isDoneStatus(m.status));
  const won = done.filter((m) => m.winner === mySide(m)).length;
  const sets = done.reduce(
    (acc, m) => {
      const isA = m.a === p.teamId;
      for (const s of m.score?.sets ?? []) {
        if ((isA ? s.a : s.b) > (isA ? s.b : s.a)) acc.w++;
        else acc.l++;
      }
      return acc;
    },
    { w: 0, l: 0 },
  );
  const singles = ms.filter((m) => m.rubberType && m.rubberType !== "D").length;
  const doubles = ms.filter((m) => m.rubberType === "D").length;
  const next = ms.filter((m) => !isDoneStatus(m.status) && m.status !== "cancelled").sort((a, c) => (a.scheduledTime ?? "9").localeCompare(c.scheduledTime ?? "9"));
  const nextWithDay = needsDay(next.slice(0, 3).filter((m) => !isOnCourt(m)).map((m) => m.scheduledTime), b.data.tournament.timezone);
  return (
    <Screen tabs={false} onRefresh={() => l.refetch()}>
      <BackHeader label="Players" fallback="/players" right={<ToggleButton compact on={following} onLabel="✓ Following" offLabel="+ Follow" onPress={() => void toggleFollow("player", id, b.data!.tournament.id)} />} />
      <StaleBanner queries={[l]} live />
      <View style={{ flexDirection: "row", gap: 12, alignItems: "center", marginTop: 4 }}>
        {ownPhoto || p.photoUrl ? <PlayerAvatar player={{ name: p.name, photoUrl: ownPhoto ?? p.photoUrl }} size={56} /> : <Flag iso2={p.team.iso2} code={p.team.code} size={40} />}
        <View style={{ flex: 1 }}>
          <Display size={24}>{p.name}</Display>
          <Body tone="ink2" size={13}>{`${p.team.name} · ${b.data.tournament.name}`}</Body>
        </View>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
        <LinkChip
          label={p.team.name}
          accessibilityLabel={`${p.team.name}, ${isNation(p.team, b.data.tournament.isTies) ? "nation" : "team"} page`}
          onPress={() => openTeam(p.team, slug, b.data!.tournament.isTies)}
          leading={<Flag iso2={p.team.iso2} code={p.team.code} size={18} />}
        />
        <LinkChip label={b.data.tournament.name} accessibilityLabel={`${b.data.tournament.name}, tournament page`} onPress={() => openTournament(slug)} />
      </View>
      <View style={{ flexDirection: "row", gap: 8, marginTop: 18 }}>
        {[
          [String(done.length), "Played"],
          [`${won}–${done.length - won}`, "Won–lost"],
          [`${sets.w}–${sets.l}`, "Sets"],
        ].map(([n, label]) => (
          <Card key={label} style={{ flex: 1, gap: 2 }}>
            <Num size={26}>{n}</Num>
            <Eyebrow size={10}>{label}</Eyebrow>
          </Card>
        ))}
      </View>
      {b.data.tournament.isTies && (
        <Body tone="ink2" size={12.5} style={{ marginTop: 8 }}>{`${singles} singles · ${doubles} doubles`}</Body>
      )}
      {next.length > 0 && <SectionHeader title={isOnCourt(next[0]!) ? "On court now" : "Next match"} />}
      <View style={{ gap: 8 }}>{next.slice(0, 3).map((m) => <MatchMini key={m.id} m={m} v={v} withDay={nextWithDay} />)}</View>
      {done.length > 0 && <SectionHeader title="Results" />}
      <View style={{ gap: 8 }}>{done.map((m) => <MatchMini key={m.id} m={m} v={v} />)}</View>
    </Screen>
  );
}

export default function PlayerRoute() {
  const { id, slug } = useLocalSearchParams<{ id: string; slug: string }>();
  const b = useBundle(slug);
  return (
    <SkinScope skin={b.data?.tournament.skin}>
      <PlayerScreen id={id} slug={slug} />
    </SkinScope>
  );
}

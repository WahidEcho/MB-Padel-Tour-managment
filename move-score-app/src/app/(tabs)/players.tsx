import { useMemo, useState } from "react";
import { TextInput, View } from "react-native";
import { router } from "expo-router";
import type { MPlayer, MTeam } from "@core";
import { refetchOnScreen, useBundle, useLive } from "../../api/queries";
import { makeView, needsDay, whenIn } from "../../api/model";
import { useFeaturedNeeds, useFeaturedSlugs } from "../../api/featured";
import { LoadState } from "../../ui/LoadState";
import { useTheme } from "../../theme/ThemeProvider";
import { Screen } from "../../ui/Screen";
import { Body, Display, Eyebrow, Num } from "../../ui/Text";
import { Card, Empty, Flag, SectionHeader, ToggleButton } from "../../ui/Bits";
import { toggleFollow, useFollowsOf } from "../../state/follows";

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

function PlayerList({ slug, query }: { slug: string; query: string }) {
  const { t } = useTheme();
  const b = useBundle(slug);
  const l = useLive(slug, 15_000);
  const following = useFollowsOf("player");
  const v = useMemo(() => (b.data ? makeView(b.data, l.data) : null), [b.data, l.data]);
  if (!b.data || !v) return null;
  const tz = b.data.tournament.timezone;
  const q = query.trim().toLowerCase();
  const rows: { p: MPlayer; team: MTeam }[] = b.data.teams
    .flatMap((team) => team.players.map((p) => ({ p, team })))
    .filter(({ p, team }) => !q || p.name.toLowerCase().includes(q) || team.name.toLowerCase().includes(q) || team.code.toLowerCase() === q)
    .sort((x, y) => x.p.name.localeCompare(y.p.name));
  if (!rows.length) return null;
  const next = (id: string) => {
    const ms = (l.data?.matches ?? []).filter((m) => m.aPlayers.includes(id) || m.bPlayers.includes(id) || (!m.tieId && (m.a === v.player(id)?.teamId || m.b === v.player(id)?.teamId)));
    const live = ms.find((m) => m.status === "live" || m.status === "paused");
    if (live) return `Live now${v.court(live.courtId) ? ` · ${v.court(live.courtId)}` : ""}`;
    const up = ms.filter((m) => m.status === "scheduled" || m.status === "ready").sort((a, c) => (a.scheduledTime ?? "9").localeCompare(c.scheduledTime ?? "9"))[0];
    return up ? `Next · ${whenIn(up.scheduledTime, tz, needsDay([up.scheduledTime], tz))}${v.court(up.courtId) ? ` · ${v.court(up.courtId)}` : ""}` : "";
  };
  return (
    <View>
      <SectionHeader title={b.data.tournament.name} />
      {rows.map(({ p, team }) => (
        <Card key={p.id} onPress={() => router.push({ pathname: "/player/[id]", params: { id: p.id, slug } })} style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: t.surface2, alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
            <View style={{ position: "absolute", opacity: 0.4 }}>
              <Flag iso2={team.iso2} code={team.code} size={60} />
            </View>
            <Num size={15}>{initials(p.name)}</Num>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Body weight="bold" numberOfLines={1}>{p.name}</Body>
            <Body tone="ink2" size={12} numberOfLines={1}>{[team.code, next(p.id)].filter(Boolean).join(" · ")}</Body>
          </View>
          <ToggleButton compact on={following.includes(p.id)} onLabel="✓ Following" offLabel="+ Follow" onPress={() => void toggleFollow("player", p.id, b.data!.tournament.id)} />
        </Card>
      ))}
    </View>
  );
}

export default function Players() {
  const { t } = useTheme();
  const slugs = useFeaturedSlugs();
  const [query, setQuery] = useState("");
  const { needs, waiting } = useFeaturedNeeds({ live: false });
  return (
    <Screen onRefresh={refetchOnScreen}>
      <Display size={26} style={{ marginTop: 8 }}>Players</Display>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search a player or nation"
        placeholderTextColor={t.ink3}
        accessibilityLabel="Search players"
        autoCorrect={false}
        style={{ marginTop: 14, backgroundColor: t.chip, borderColor: t.line, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, color: t.ink, fontSize: 15 }}
      />
      <Card style={{ marginTop: 14, gap: 6, backgroundColor: t.surface2 }}>
        <Eyebrow tone="ink">Never miss their next match</Eyebrow>
        <Body tone="ink2" size={13}>Follow a player and Move Score tells you when their match is set, moved, starting and finished.</Body>
      </Card>
      {slugs.map((s) => (
        <PlayerList key={s.slug} slug={s.slug} query={query} />
      ))}
      {waiting ? <LoadState queries={needs} what="the players" /> : !slugs.length && <Empty title="No players yet" body="Players appear when the featured event publishes its line-ups." />}
    </Screen>
  );
}

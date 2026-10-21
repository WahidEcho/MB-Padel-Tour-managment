import { useMemo, useState } from "react";
import { TextInput, View } from "react-native";
import { Image } from "expo-image";
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
import { openPlayer, openTournament } from "../../nav/links";
import { FollowedPlayers } from "../../ui/FollowedPlayers";
import { useT } from "../../i18n";

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
  const tr = useT();
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
    if (live) return [tr("screens.liveNow"), v.court(live.courtId)].filter(Boolean).join(" · ");
    const up = ms.filter((m) => m.status === "scheduled" || m.status === "ready").sort((a, c) => (a.scheduledTime ?? "9").localeCompare(c.scheduledTime ?? "9"))[0];
    return up ? [tr("screens.nextShort"), whenIn(up.scheduledTime, tz, needsDay([up.scheduledTime], tz)), v.court(up.courtId)].filter(Boolean).join(" · ") : "";
  };
  return (
    <View>
      <SectionHeader title={b.data.tournament.name} onTitlePress={() => openTournament(slug)} />
      {!q && <FollowedPlayers bundle={b.data} slug={slug} title={tr("screens.youFollow")} />}
      {!q && following.length > 0 && rows.some(({ p }) => following.includes(p.id)) && <Eyebrow style={{ marginBottom: 8 }}>{tr("screens.allPlayers")}</Eyebrow>}
      {rows.map(({ p, team }) => (
        <Card key={p.id} onPress={() => openPlayer(p.id, slug)} accessibilityLabel={[p.name, team.name, next(p.id)].filter(Boolean).join(", ")} style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: t.surface2, alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
            <View style={{ position: "absolute", opacity: 0.4 }}>
              <Flag iso2={team.iso2} code={team.code} size={60} />
            </View>
            <Num size={15}>{initials(p.name)}</Num>
            {p.photoUrl ? <Image source={{ uri: p.photoUrl }} style={{ position: "absolute", width: 44, height: 44 }} contentFit="cover" /> : null}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Body weight="bold" numberOfLines={1}>{p.name}</Body>
            <Body tone="ink2" size={12} numberOfLines={1}>{[team.code, typeof p.itfRank === "number" ? tr("screens.itfRank", { n: p.itfRank }) : null, next(p.id)].filter(Boolean).join(" · ")}</Body>
          </View>
          <ToggleButton compact on={following.includes(p.id)} onLabel={tr("screens.followingBtn")} offLabel={tr("screens.followBtn")} onPress={() => void toggleFollow("player", p.id, b.data!.tournament.id)} />
        </Card>
      ))}
    </View>
  );
}

export default function Players() {
  const { t } = useTheme();
  const tr = useT();
  const slugs = useFeaturedSlugs();
  const [query, setQuery] = useState("");
  const { needs, waiting } = useFeaturedNeeds({ live: false });
  return (
    <Screen onRefresh={refetchOnScreen}>
      <Display size={26} style={{ marginTop: 8 }}>{tr("screens.playersTitle")}</Display>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder={tr("screens.searchPlaceholder")}
        placeholderTextColor={t.ink3}
        accessibilityLabel={tr("screens.searchA11y")}
        autoCorrect={false}
        style={{ marginTop: 14, backgroundColor: t.chip, borderColor: t.line, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, color: t.ink, fontSize: 15 }}
      />
      <Card style={{ marginTop: 14, gap: 6, backgroundColor: t.surface2 }}>
        <Eyebrow tone="ink">{tr("screens.neverMiss")}</Eyebrow>
        <Body tone="ink2" size={13}>{tr("screens.neverMissBody")}</Body>
      </Card>
      {slugs.map((s) => (
        <PlayerList key={s.slug} slug={s.slug} query={query} />
      ))}
      {waiting ? <LoadState queries={needs} what={tr("screens.whatPlayers")} /> : !slugs.length && <Empty title={tr("screens.noPlayersTitle")} body={tr("screens.noPlayersBody")} />}
    </Screen>
  );
}

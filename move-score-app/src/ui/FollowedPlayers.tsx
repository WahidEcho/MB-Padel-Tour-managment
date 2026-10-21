import { Pressable, View } from "react-native";
import type { MBundle, MPlayer, MTeam } from "@core";
import { toggleFollow, useFollowsOf } from "../state/follows";
import { openPlayer } from "../nav/links";
import { Body, Eyebrow } from "./Text";
import { Card, Flag, ToggleButton } from "./Bits";
import { useT } from "../i18n";

/**
 * The players of one tournament this phone follows, each a way into their page
 * (and a way to stop following). Renders nothing when none is followed, so a
 * list of nations can carry it at the top.
 */
export function FollowedPlayers({ bundle, slug, title }: { bundle: MBundle; slug: string; title?: string }) {
  const tr = useT();
  const following = useFollowsOf("player");
  const rows: { p: MPlayer; team: MTeam }[] = bundle.teams
    .flatMap((team) => team.players.map((p) => ({ p, team })))
    .filter(({ p }) => following.includes(p.id))
    .sort((x, y) => x.p.name.localeCompare(y.p.name));
  if (!rows.length) return null;
  return (
    <View style={{ marginBottom: 16 }}>
      <Eyebrow style={{ marginBottom: 8 }}>{tr("hero.titleCount", { title: title ?? tr("hero.playersYouFollow"), count: rows.length })}</Eyebrow>
      <View style={{ gap: 12 }}>
        {rows.map(({ p, team }) => (
          <Card key={p.id} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingRight: 10 }}>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={tr("hero.playerTeamPage", { name: p.name, team: team.name })}
              onPress={() => openPlayer(p.id, slug)}
              style={({ pressed }) => [{ flex: 1, flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 }, pressed && { opacity: 0.6 }]}
            >
              <Flag iso2={team.iso2} code={team.code} size={26} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Body weight="semi" numberOfLines={1}>{p.name}</Body>
                <Body tone="ink2" size={12} numberOfLines={1}>
                  {[team.name, typeof p.itfRank === "number" ? tr("hero.itfJunior", { rank: p.itfRank }) : null].filter(Boolean).join(" · ")}
                </Body>
              </View>
              <Body tone="ink3" weight="bold">›</Body>
            </Pressable>
            <ToggleButton compact on onLabel={tr("hero.followingBtn")} offLabel={tr("hero.followBtn")} onPress={() => void toggleFollow("player", p.id, bundle.tournament.id)} />
          </Card>
        ))}
      </View>
    </View>
  );
}

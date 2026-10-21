import { useState } from "react";
import { View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import Animated, { ZoomIn } from "react-native-reanimated";
import { useBundle, useDiscover } from "../../api/queries";
import { useFeaturedGroup, useFeaturedSlugs } from "../../api/featured";
import { usePass } from "../../pass/usePass";
import { toggleFollow, useFollowing } from "../../state/follows";
import { useTheme } from "../../theme/ThemeProvider";
import { Screen } from "../../ui/Screen";
import { BackHeader } from "../../ui/Header";
import { Body, Display, Eyebrow } from "../../ui/Text";
import { Button, Card, Chip, Empty, Flag } from "../../ui/Bits";
import { LoadState } from "../../ui/LoadState";
import { TeamSection } from "../../ui/TeamSection";
import { useT } from "../../i18n";

/**
 * A nation across the events on now: follow it (alerts for every tie, and its
 * pin on the event pass), its ties and its players. Opened from a pin, a flag,
 * a standings row or movescore://nation/EGY.
 */
export default function NationScreen() {
  const { t } = useTheme();
  const tr = useT();
  const params = useLocalSearchParams<{ code: string; slug?: string }>();
  const code = (params.code ?? "").toUpperCase();
  const discover = useDiscover();
  const featured = useFeaturedSlugs();
  const group = useFeaturedGroup();
  // The event it was tapped in first, then the featured event's tournaments.
  const slugs = [...new Set([params.slug, ...featured.map((f) => f.slug)].filter((s): s is string => Boolean(s)))].slice(0, 4);
  const b0 = useBundle(slugs[0]);
  const b1 = useBundle(slugs[1]);
  const b2 = useBundle(slugs[2]);
  const b3 = useBundle(slugs[3]);
  const bundles = [b0, b1, b2, b3].slice(0, slugs.length);
  const found = bundles.flatMap((b) => {
    const team = b.data?.teams.find((x) => x.code === code);
    return team && b.data ? [{ tournament: b.data.tournament, team }] : [];
  });
  const first = found[0];
  const following = useFollowing("nation", code);
  const pass = usePass(group?.id);
  // A pin belongs to the featured event's pass: only nations playing in it have one.
  const hasPin = Boolean(group && found.some((f) => group.tournaments.some((x) => x.id === f.tournament.id)));
  const pinned = Boolean(pass.pass?.pins.includes(code));
  const [busy, setBusy] = useState(false);

  if (!first) {
    // Not found only once every event it could be in has answered; until then, loading, offline or an error.
    const missing = slugs.length ? bundles.filter((b) => b.data === undefined) : discover.data ? [] : [discover];
    const notFound = <Empty title={tr("screens.nationNotFound")} body={tr("screens.nationNotFoundBody", { code: code || tr("screens.thisNation") })} />;
    return (
      <Screen tabs={false} onRefresh={() => Promise.all([discover.refetch(), ...bundles.map((b) => b.refetch())])}>
        <BackHeader label={tr("common.back")} />
        {missing.length ? <LoadState queries={missing} what={tr("screens.whatNation")} notFound={notFound} /> : notFound}
      </Screen>
    );
  }

  const follow = async () => {
    setBusy(true);
    try {
      // Following also re-reads the pass, which is when the server adds the pin.
      await toggleFollow("nation", code, first.tournament.id);
    } finally {
      setBusy(false);
    }
  };
  const players = found.reduce((n, f) => n + f.team.players.length, 0);
  return (
    <Screen tabs={false} onRefresh={() => Promise.all([...bundles.map((b) => b.refetch()), pass.refetch()])}>
      <BackHeader label={tr("common.back")} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginTop: 4 }}>
        <Flag iso2={first.team.iso2} code={code} size={64} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Eyebrow>{[code, tr("common.players", { count: players })].join(" · ")}</Eyebrow>
          <Display size={26} style={{ marginTop: 4 }}>{first.team.name}</Display>
        </View>
      </View>

      <Card style={{ marginTop: 16, gap: 12, borderColor: following ? t.ball : t.line, borderWidth: following ? 1.5 : 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <Body weight="bold" size={16} style={{ flex: 1 }}>{following ? tr("screens.youFollowName", { name: first.team.name }) : tr("screens.followName", { name: first.team.name })}</Body>
          {hasPin ? (
            pinned ? (
              <Animated.View entering={ZoomIn}>
                <Chip label={tr("screens.pinCollected")} ball />
              </Animated.View>
            ) : (
              <Chip label={tr("screens.pinToCollect")} />
            )
          ) : null}
        </View>
        <Body tone="ink2" size={13}>
          {following
            ? [tr("screens.nationAlertsOn", { code }), hasPin ? tr("screens.pinOnPass") : null].filter(Boolean).join(" ")
            : tr(hasPin ? "screens.nationAlertsOffPin" : "screens.nationAlertsOff", { code })}
        </Body>
        <Button kind={following ? "ghost" : "primary"} label={following ? tr("screens.followingBtn") : tr("screens.followCode", { code })} disabled={busy} onPress={() => void follow()} />
        {hasPin && pinned ? <Button kind="ghost" label={tr("screens.seeOnPass")} onPress={() => router.push("/pass")} /> : null}
      </Card>

      {slugs.map((s) => (
        <TeamSection key={s} slug={s} pick={(x) => x.code === code} />
      ))}
    </Screen>
  );
}

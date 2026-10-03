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

/**
 * A nation across the events on now: follow it (alerts for every tie, and its
 * pin on the event pass), its ties and its players. Opened from a pin, a flag,
 * a standings row or movescore://nation/EGY.
 */
export default function NationScreen() {
  const { t } = useTheme();
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
    const notFound = <Empty title="Nation not found" body={`${code || "This nation"} is not playing in the events on now.`} />;
    return (
      <Screen tabs={false} onRefresh={() => Promise.all([discover.refetch(), ...bundles.map((b) => b.refetch())])}>
        <BackHeader label="Back" />
        {missing.length ? <LoadState queries={missing} what="this nation" notFound={notFound} /> : notFound}
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
      <BackHeader label="Back" />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginTop: 4 }}>
        <Flag iso2={first.team.iso2} code={code} size={64} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Eyebrow>{[code, `${players} ${players === 1 ? "player" : "players"}`].join(" · ")}</Eyebrow>
          <Display size={26} style={{ marginTop: 4 }}>{first.team.name}</Display>
        </View>
      </View>

      <Card style={{ marginTop: 16, gap: 12, borderColor: following ? t.ball : t.line, borderWidth: following ? 1.5 : 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <Body weight="bold" size={16} style={{ flex: 1 }}>{following ? `You follow ${first.team.name}` : `Follow ${first.team.name}`}</Body>
          {hasPin ? (
            pinned ? (
              <Animated.View entering={ZoomIn}>
                <Chip label="Pin collected" ball />
              </Animated.View>
            ) : (
              <Chip label="Pin to collect" />
            )
          ) : null}
        </View>
        <Body tone="ink2" size={13}>
          {following
            ? `Alerts for every ${code} tie: set, moved, starting and the result.${hasPin ? " Its pin is on your pass." : ""}`
            : `Get alerts for every ${code} tie${hasPin ? ` and collect the ${code} pin on your event pass` : ""}.`}
        </Body>
        <Button kind={following ? "ghost" : "primary"} label={following ? "✓ Following" : `+ Follow ${code}`} disabled={busy} onPress={() => void follow()} />
        {hasPin && pinned ? <Button kind="ghost" label="See it on my pass" onPress={() => router.push("/pass")} /> : null}
      </Card>

      {slugs.map((s) => (
        <TeamSection key={s} slug={s} pick={(x) => x.code === code} />
      ))}
    </Screen>
  );
}

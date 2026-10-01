import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withSpring } from "react-native-reanimated";
import { api } from "../../api/client";
import { useBundle, useCheers, useConfig, useLive } from "../../api/queries";
import { dayIn, makeView, timeIn } from "../../api/model";
import { SkinScope, useTheme } from "../../theme/ThemeProvider";
import { Screen } from "../../ui/Screen";
import { BackHeader } from "../../ui/Header";
import { Body, Display, Eyebrow, Num } from "../../ui/Text";
import { Card, Empty, Flag, SectionHeader, ToggleButton } from "../../ui/Bits";
import { TieCard } from "../../ui/Cards";
import { toggleFollow, useFollowing } from "../../state/follows";
import { session } from "../../state/session";

/** Tap-to-cheer: taps are counted on the phone and sent every few seconds. */
function CheerMeter({ tieId, a, b, live }: { tieId: string; a: { code: string; iso2: string | null }; b: { code: string; iso2: string | null }; live: boolean }) {
  const { t } = useTheme();
  const q = useCheers(tieId, live);
  const pending = useRef<Record<string, number>>({});
  const [local, setLocal] = useState<Record<string, number>>({});
  useEffect(() => {
    const id = setInterval(() => {
      for (const [nation, n] of Object.entries(pending.current)) {
        if (!n) continue;
        pending.current[nation] = 0;
        void api(`/api/mobile/v1/ties/${tieId}/cheer`, { who: "me", body: { nation, n } }).catch(() => {});
      }
    }, 3000);
    return () => clearInterval(id);
  }, [tieId]);
  const count = (code: string) => (q.data?.cheers.find((c) => c.nation === code)?.count ?? 0) + (local[code] ?? 0);
  const ca = count(a.code);
  const cb = count(b.code);
  const share = ca + cb ? ca / (ca + cb) : 0.5;
  const scale = useSharedValue(1);
  const pulse = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const cheer = (code: string) => {
    if (!session.get().installToken) return;
    pending.current[code] = Math.min(30, (pending.current[code] ?? 0) + 1);
    setLocal((l) => ({ ...l, [code]: (l[code] ?? 0) + 1 }));
    scale.value = withSequence(withSpring(1.06, { damping: 5 }), withSpring(1));
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  };
  return (
    <Card style={{ gap: 12 }}>
      <Eyebrow>Crowd meter</Eyebrow>
      <Animated.View style={[{ height: 14, borderRadius: 7, overflow: "hidden", flexDirection: "row", backgroundColor: t.chip }, pulse]}>
        <View style={{ flex: share, backgroundColor: t.ball }} />
        <View style={{ flex: 1 - share, backgroundColor: t.skinA }} />
      </Animated.View>
      <View style={{ flexDirection: "row", gap: 10 }}>
        {[a, b].map((n) => (
          <Pressable key={n.code} accessibilityRole="button" accessibilityLabel={`Cheer for ${n.code}`} onPress={() => cheer(n.code)} style={({ pressed }) => ({ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 14, borderRadius: 16, backgroundColor: t.chip, borderWidth: 1, borderColor: t.line, transform: [{ scale: pressed ? 0.96 : 1 }] })}>
            <Flag iso2={n.iso2} code={n.code} />
            <Body weight="bold">Cheer {n.code}</Body>
            <Num size={15} tone="ink2">{count(n.code)}</Num>
          </Pressable>
        ))}
      </View>
    </Card>
  );
}

function TieScreen({ id, slug }: { id: string; slug: string }) {
  const b = useBundle(slug);
  const l = useLive(slug);
  const cfg = useConfig();
  const starred = useFollowing("tie", id);
  if (!b.data) return null;
  const v = makeView(b.data, l.data);
  const tie = l.data?.ties.find((x) => x.id === id);
  if (!tie) return <Empty title="Loading the tie…" />;
  const a = v.team(tie.a);
  const bb = v.team(tie.b);
  const tz = b.data.tournament.timezone;
  return (
    <Screen tabs={false} onRefresh={() => l.refetch()}>
      <BackHeader label={b.data.tournament.name.split(" ").slice(0, 3).join(" ")} right={<ToggleButton compact on={starred} onLabel="★ Following" offLabel="☆ Follow tie" onPress={() => void toggleFollow("tie", id, b.data!.tournament.id)} />} />
      <Eyebrow>{[tie.roundName ?? (tie.stage === "group" ? "Group stage" : "Placement"), v.court(tie.courtId), tie.scheduledTime ? `${dayIn(tie.scheduledTime, tz)} ${timeIn(tie.scheduledTime, tz)}` : null].filter(Boolean).join(" · ")}</Eyebrow>
      <Display size={24} style={{ marginTop: 6, marginBottom: 14 }}>{`${a?.name ?? "TBD"} v ${bb?.name ?? "TBD"}`}</Display>
      <TieCard tie={tie} v={v} />
      {cfg.data?.flags.supporter_mode && a && bb && tie.status !== "completed" && (
        <>
          <SectionHeader title="Support" />
          <CheerMeter tieId={id} a={a} b={bb} live={tie.status === "live"} />
        </>
      )}
    </Screen>
  );
}

export default function TieRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const where = useQuery({ queryKey: ["tie-where", id], queryFn: () => api<{ tournamentSlug: string }>(`/api/mobile/v1/ties/${id}`), staleTime: Infinity });
  const b = useBundle(where.data?.tournamentSlug);
  if (!where.data) return <Screen tabs={false}><BackHeader label="Back" />{where.isError ? <Empty title="This tie is not available" /> : null}</Screen>;
  return (
    <SkinScope skin={b.data?.tournament.skin}>
      <TieScreen id={id} slug={where.data.tournamentSlug} />
    </SkinScope>
  );
}

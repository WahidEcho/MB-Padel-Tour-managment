import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { isDoneStatus, isLiveStatus, type MMatch } from "@core";
import { useBundle, useLive } from "../../api/queries";
import { dayIn, makeView, timeIn, type View as Model } from "../../api/model";
import { useFeaturedSlugs } from "../../api/featured";
import { Screen } from "../../ui/Screen";
import { Body, Display, Eyebrow, Num } from "../../ui/Text";
import { Button, Card, Chip, Empty, SectionHeader } from "../../ui/Bits";
import { MatchMini } from "../../ui/Cards";
import { follows } from "../../state/follows";

function useMine(slug: string) {
  const b = useBundle(slug);
  const l = useLive(slug, 10_000);
  const list = follows.use((f) => f);
  return useMemo(() => {
    if (!b.data) return null;
    const v = makeView(b.data, l.data);
    const has = (kind: string, key: string | null | undefined) => Boolean(key) && list.some((f) => f.kind === kind && f.key === key);
    const why = (m: MMatch): string | null => {
      if (has("match", m.id)) return "Starred";
      const p = [...m.aPlayers, ...m.bPlayers, ...(m.tieId ? [] : [...(v.team(m.a)?.players ?? []), ...(v.team(m.b)?.players ?? [])].map((x) => x.id))].find((id) => has("player", id));
      if (p) return v.player(p)?.name ?? "A player you follow";
      if (has("tie", m.tieId)) return "A tie you follow";
      const n = [v.team(m.a)?.code, v.team(m.b)?.code].find((c) => has("nation", c));
      return n ? `Supporting ${n}` : null;
    };
    const mine = (l.data?.matches ?? []).filter((m) => m.a && m.b && why(m)).map((m) => ({ m, why: why(m)! }));
    return { v, mine };
  }, [b.data, l.data, list]);
}

function NextCard({ m, v, why }: { m: MMatch; v: Model; why: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const tz = v.bundle.tournament.timezone;
  const left = m.scheduledTime ? Math.max(0, Date.parse(m.scheduledTime) - now) : null;
  const hms = left === null ? null : [Math.floor(left / 3600000), Math.floor((left % 3600000) / 60000), Math.floor((left % 60000) / 1000)].map((x) => String(x).padStart(2, "0")).join(":");
  return (
    <Card onPress={() => router.push({ pathname: "/match/[id]", params: { id: m.id } })} style={{ gap: 12, padding: 18 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Chip label="Next for you" ball />
        <Eyebrow>{[v.court(m.courtId), timeIn(m.scheduledTime, tz)].filter(Boolean).join(" · ")}</Eyebrow>
      </View>
      <Display size={22}>{`${v.sideLabel(m, "A")}\nv ${v.sideLabel(m, "B")}`}</Display>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
        <Body tone="ink2" size={13}>{why}</Body>
        {hms && left! < 24 * 3600000 ? (
          <Body tone="ink2" size={13}>
            Starts in <Num size={20}>{hms}</Num>
          </Body>
        ) : (
          <Body tone="ink2" size={13}>{dayIn(m.scheduledTime, tz)}</Body>
        )}
      </View>
    </Card>
  );
}

function Section({ slug, part }: { slug: string; part: "next" | "live" | "done" }) {
  const r = useMine(slug);
  if (!r) return null;
  const { v, mine } = r;
  if (part === "live") return <>{mine.filter((x) => isLiveStatus(x.m.status)).map((x) => <MatchMini key={x.m.id} m={x.m} v={v} />)}</>;
  if (part === "done") return <>{mine.filter((x) => isDoneStatus(x.m.status)).slice(0, 8).map((x) => <MatchMini key={x.m.id} m={x.m} v={v} />)}</>;
  const next = mine.filter((x) => x.m.status === "scheduled" || x.m.status === "ready").sort((a, b) => (a.m.scheduledTime ?? "9").localeCompare(b.m.scheduledTime ?? "9"));
  if (!next.length) return null;
  return (
    <View style={{ gap: 8 }}>
      <NextCard m={next[0]!.m} v={v} why={next[0]!.why} />
      {next.slice(1, 5).map((x) => <MatchMini key={x.m.id} m={x.m} v={v} />)}
    </View>
  );
}

export default function Following() {
  const slugs = useFeaturedSlugs();
  const count = follows.use((f) => f.length);
  return (
    <Screen>
      <Display size={26} style={{ marginTop: 8, marginBottom: 14 }}>Following</Display>
      {count === 0 ? (
        <>
          <Empty title="Follow players, nations and matches" body="Their next match lands here, with an alert when it is set, moved, starting or finished." />
          <Button label="Find players" onPress={() => router.push("/players")} style={{ marginTop: 14 }} />
        </>
      ) : (
        <>
          {slugs.map((s) => <Section key={`n${s.slug}`} slug={s.slug} part="next" />)}
          <SectionHeader title="Live now" />
          <View style={{ gap: 8 }}>{slugs.map((s) => <Section key={`l${s.slug}`} slug={s.slug} part="live" />)}</View>
          <SectionHeader title="Results" />
          <View style={{ gap: 8 }}>{slugs.map((s) => <Section key={`d${s.slug}`} slug={s.slug} part="done" />)}</View>
          <Button kind="ghost" label="Alert settings" onPress={() => router.push("/account")} style={{ marginTop: 20 }} />
        </>
      )}
    </Screen>
  );
}

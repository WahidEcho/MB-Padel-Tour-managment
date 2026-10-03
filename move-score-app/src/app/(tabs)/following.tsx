import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { isDoneStatus, type MFollow, type MMatch } from "@core";
import { refetchOnScreen, useBundle, useLive } from "../../api/queries";
import { dayIn, isOnCourt, makeView, needsDay, timeIn, type View as Model } from "../../api/model";
import { useFeaturedNeeds, useFeaturedSlugs } from "../../api/featured";
import { LoadState } from "../../ui/LoadState";
import { Screen } from "../../ui/Screen";
import { Body, Display, Eyebrow, Num } from "../../ui/Text";
import { Button, Card, Chip, Empty, Flag, LinkChip, SectionHeader } from "../../ui/Bits";
import { MatchMini } from "../../ui/Cards";
import { follows } from "../../state/follows";
import { openNation, openPlayer, openTie, openTournament } from "../../nav/links";

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
    <Card onPress={() => router.push({ pathname: "/match/[id]", params: { id: m.id } })} accessibilityLabel={`Next for you: ${v.sideLabel(m, "A")} against ${v.sideLabel(m, "B")}. ${why}. ${[v.court(m.courtId), dayIn(m.scheduledTime, tz), timeIn(m.scheduledTime, tz)].filter(Boolean).join(", ")}`} style={{ gap: 12, padding: 18 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Chip label="Next for you" ball />
        <Eyebrow>{[v.court(m.courtId), timeIn(m.scheduledTime, tz)].filter(Boolean).join(" · ")}</Eyebrow>
      </View>
      <Display size={22}>{`${v.sideLabel(m, "A")}\nv ${v.sideLabel(m, "B")}`}</Display>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
        <Body tone="ink2" size={13}>{why}</Body>
        {left === 0 ? (
          // The start time has passed but the match has not begun (the order of play runs late).
          <Body tone="ink2" size={13} weight="semi">Starting soon</Body>
        ) : hms && left! < 24 * 3600000 ? (
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
  if (part === "live") return <>{mine.filter((x) => isOnCourt(x.m)).map((x) => <MatchMini key={x.m.id} m={x.m} v={v} />)}</>;
  if (part === "done") return <>{mine.filter((x) => isDoneStatus(x.m.status)).slice(0, 8).map((x) => <MatchMini key={x.m.id} m={x.m} v={v} />)}</>;
  const next = mine.filter((x) => x.m.status === "scheduled" || x.m.status === "ready").sort((a, b) => (a.m.scheduledTime ?? "9").localeCompare(b.m.scheduledTime ?? "9"));
  if (!next.length) return null;
  const rest = next.slice(1, 5);
  const withDay = needsDay(rest.map((x) => x.m.scheduledTime), v.bundle.tournament.timezone);
  return (
    <View style={{ gap: 8 }}>
      <NextCard m={next[0]!.m} v={v} why={next[0]!.why} />
      {rest.map((x) => <MatchMini key={x.m.id} m={x.m} v={v} withDay={withDay} />)}
    </View>
  );
}

/** Everything followed in the featured event, each a way into its page. */
function FollowedChips({ slugs }: { slugs: string[] }) {
  const b0 = useBundle(slugs[0]);
  const b1 = useBundle(slugs[1]);
  const b2 = useBundle(slugs[2]);
  const b3 = useBundle(slugs[3]);
  const l0 = useLive(slugs[0], 10_000);
  const l1 = useLive(slugs[1], 10_000);
  const l2 = useLive(slugs[2], 10_000);
  const l3 = useLive(slugs[3], 10_000);
  const list = follows.use((f) => f);
  const bundles = [b0, b1, b2, b3];
  const lives = [l0, l1, l2, l3];
  const events = slugs.slice(0, 4).flatMap((slug, i) => {
    const b = bundles[i]!.data;
    return b ? [{ slug, b, v: makeView(b, lives[i]!.data) }] : [];
  });
  type FollowChip = { key: string; label: string; iso2?: string | null; code?: string; open: () => void };
  const chipIn = (f: MFollow, e: (typeof events)[number]): FollowChip | null => {
    const key = `${f.kind}:${f.key}`;
    if (f.kind === "nation") {
      const team = e.b.teams.find((x) => x.code === f.key);
      return team ? { key, label: team.name, iso2: team.iso2, code: team.code, open: () => openNation(team.code, e.slug) } : null;
    }
    if (f.kind === "player") {
      const p = e.v.player(f.key);
      return p ? { key, label: p.name, iso2: p.team.iso2, code: p.team.code, open: () => openPlayer(p.id, e.slug) } : null;
    }
    if (f.kind === "tie") {
      const tie = e.v.live?.ties.find((x) => x.id === f.key);
      return tie ? { key, label: `${e.v.team(tie.a)?.code ?? "TBD"} v ${e.v.team(tie.b)?.code ?? "TBD"}`, open: () => openTie(tie.id) } : null;
    }
    // Starred matches already show in the lists above.
    return null;
  };
  const chips = list.flatMap((f) => {
    for (const e of events) {
      const c = chipIn(f, e);
      if (c) return [c];
    }
    return [];
  });
  if (!chips.length) return null;
  return (
    <>
      <SectionHeader title="You follow" />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {chips.map((c) => (
          <LinkChip key={c.key} label={c.label} onPress={c.open} leading={c.code ? <Flag iso2={c.iso2} code={c.code} size={18} /> : undefined} />
        ))}
      </View>
    </>
  );
}

export default function Following() {
  const slugs = useFeaturedSlugs();
  const count = follows.use((f) => f.length);
  const { needs, waiting } = useFeaturedNeeds({ live: 10_000 });
  return (
    <Screen onRefresh={refetchOnScreen}>
      <Display size={26} style={{ marginTop: 8, marginBottom: 14 }}>Following</Display>
      {count === 0 ? (
        <>
          <Empty title="Follow players, nations and matches" body="Their next match lands here, with an alert when it is set, moved, starting or finished." />
          <Button label="Find players" onPress={() => router.push("/players")} style={{ marginTop: 14 }} />
          {slugs[0] ? <Button kind="ghost" label="Pick a nation" onPress={() => openTournament(slugs[0]!.slug, "nations")} style={{ marginTop: 8 }} /> : null}
        </>
      ) : waiting ? (
        <LoadState queries={needs} what="the matches you follow" />
      ) : (
        <>
          {slugs.map((s) => <Section key={`n${s.slug}`} slug={s.slug} part="next" />)}
          <FollowedChips slugs={slugs.map((s) => s.slug)} />
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

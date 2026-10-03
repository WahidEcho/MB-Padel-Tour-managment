import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming } from "react-native-reanimated";
import { RUBBER_LABELS, isDoneStatus, isLiveStatus, type MMatch, type MTimelinePoint } from "@core";
import { useBundle, useConfig, useLive, useMatch, useTimeline } from "../../api/queries";
import { dayIn, isAwaitingResult, makeView, matchA11y, timeIn } from "../../api/model";
import { SkinScope, useTheme } from "../../theme/ThemeProvider";
import { Screen } from "../../ui/Screen";
import { BackHeader } from "../../ui/Header";
import { Body, Eyebrow, Num } from "../../ui/Text";
import { Button, Card, Chip, Empty, Flag, LinkChip, LivePill, ToggleButton } from "../../ui/Bits";
import { StaleBanner } from "../../ui/Offline";
import { LoadState } from "../../ui/LoadState";
import { Rolling } from "../../ui/Rolling";
import { Momentum } from "../../ui/Momentum";
import { Takeover, type TakeoverMoment } from "../../ui/Takeover";
import { toggleFollow, useFollowing } from "../../state/follows";
import { startLockScreen, lockScreenSupported } from "../../live/lockScreen";
import { openPlayer, openTeam, openTie, openTournament } from "../../nav/links";

const ROW_H = 58;
/** Doubles: both names, one per line. */
const ROW_H_DOUBLES = 72;

/** Which side just won a point, comparing two scores. */
function scorer(prev: MMatch["score"], next: MMatch["score"]): "A" | "B" | null {
  if (!prev || !next || prev.lastEventNumber === next.lastEventNumber || next.lastUndo > prev.lastUndo) return null;
  const val = (s: NonNullable<MMatch["score"]>, side: "a" | "b") => s.setsWon[side] * 10000 + (s.games?.[side] ?? 0) * 100 + (["0", "15", "30", "40", "AD"].indexOf(s.points?.[side] ?? "0") + (s.tiebreak ? Number(s.points?.[side] ?? 0) : 0));
  const da = val(next, "a") - val(prev, "a");
  const db = val(next, "b") - val(prev, "b");
  if (da > db) return "A";
  if (db > da) return "B";
  return null;
}

function Board({ m, v, aNames, bNames, scoredBy }: { m: MMatch; v: ReturnType<typeof makeView>; aNames: string[]; bNames: string[]; scoredBy: "A" | "B" | null }) {
  const { t, calm } = useTheme();
  const s = m.score;
  const live = isLiveStatus(m.status);
  const sets = s?.sets ?? [];
  const rowH = Math.max(aNames.length, bNames.length) > 1 ? ROW_H_DOUBLES : ROW_H;
  const serveY = useSharedValue(s?.serving === "B" ? 1 : 0);
  const hop = useSharedValue(0);
  useEffect(() => {
    const target = s?.serving === "B" ? 1 : 0;
    if (target === serveY.value) return;
    serveY.value = calm ? target : withSpring(target, { damping: 9, stiffness: 120 });
    if (!calm) hop.value = withSequence(withTiming(-14, { duration: 180 }), withSpring(0, { damping: 6 }));
  }, [s?.serving, serveY, hop, calm]);
  const ball = useAnimatedStyle(() => ({ transform: [{ translateY: serveY.value * rowH + hop.value }], opacity: live && s?.serving ? 1 : 0 }));
  const row = (side: "A" | "B") => {
    const team = v.team(side === "A" ? m.a : m.b);
    const k = side === "A" ? "a" : "b";
    const won = isDoneStatus(m.status) && m.winner === (side === "A" ? m.a : m.b);
    return (
      <View style={{ height: rowH, flexDirection: "row", alignItems: "center", gap: 6, borderTopWidth: side === "B" ? 1 : 0, borderColor: t.line }}>
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 10, minWidth: 0, paddingLeft: 24 }}>
          <Flag iso2={team?.iso2} code={team?.code} size={32} />
          <View style={{ flex: 1, minWidth: 0 }}>
            {(side === "A" ? aNames : bNames).map((n, i) => (
              <Body key={i} weight="bold" size={rowH === ROW_H ? 15 : 14} numberOfLines={1}>{n}</Body>
            ))}
            <Eyebrow size={10} tone={won ? "ink" : "ink3"}>{won ? `${team?.code ?? ""} · WON` : (team?.code ?? "")}</Eyebrow>
          </View>
        </View>
        {sets.map((x, i) => (
          <View key={i} style={{ width: 28, alignItems: "center" }}>
            <Rolling value={x[k]} size={22} tone={x[k] > x[k === "a" ? "b" : "a"] ? "ink" : "ink2"} />
          </View>
        ))}
        {live && s?.games ? (
          <View style={{ width: 28, alignItems: "center" }}>
            <Rolling value={s.games[k]} size={22} />
          </View>
        ) : null}
        {live && s?.points ? (
          <View style={{ width: 54, height: 42, borderRadius: 10, backgroundColor: t.chip, alignItems: "center", justifyContent: "center", marginLeft: 4 }}>
            <Rolling value={s.points[k]} size={26} sweep={scoredBy === side} />
          </View>
        ) : null}
      </View>
    );
  };
  return (
    <View>
      <Animated.View pointerEvents="none" style={[{ position: "absolute", left: 4, top: rowH / 2 - 6, width: 12, height: 12, borderRadius: 6, backgroundColor: t.ball, shadowColor: t.ball, shadowOpacity: 0.9, shadowRadius: 8, borderWidth: t.scheme === "light" ? 1.5 : 0, borderColor: t.ballInk, zIndex: 2 }, ball]} />
      {row("A")}
      {row("B")}
    </View>
  );
}

function Feed({ points, aCode, bCode }: { points: MTimelinePoint[]; aCode: string; bCode: string }) {
  const games = points.filter((p) => p.game).slice(-6).reverse();
  if (!games.length) return <Body tone="ink2" size={13}>Games appear here as they finish.</Body>;
  return (
    <View style={{ gap: 9 }}>
      {games.map((g, i) => (
        <View key={i} style={{ flexDirection: "row", gap: 12 }}>
          <Num size={14} tone="ink3" style={{ width: 42 }}>{g.game!.replace("-", "–")}</Num>
          <Body size={13.5}>
            <Body weight="semi" size={13.5}>{g.w === "A" ? aCode : bCode}</Body> took the game · set {g.set}
          </Body>
        </View>
      ))}
    </View>
  );
}

/** Everyone and everything this match belongs to, each opening its own page. */
function MatchLinks({ m, v, slug }: { m: MMatch; v: ReturnType<typeof makeView>; slug: string }) {
  const tr = v.bundle.tournament;
  const tie = v.tieOf(m);
  const sides = (["A", "B"] as const).map((side) => ({ team: v.team(side === "A" ? m.a : m.b), players: v.sidePlayers(m, side) }));
  const players = sides.flatMap((s) => s.players.map((p) => ({ p, team: s.team })));
  return (
    <Card style={{ marginTop: 12, gap: 10 }}>
      <Eyebrow>In this match</Eyebrow>
      {players.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {players.map(({ p, team }) => (
            <LinkChip key={p.id} label={p.name} accessibilityLabel={`${p.name}, player page`} onPress={() => openPlayer(p.id, slug)} leading={team ? <Flag iso2={team.iso2} code={team.code} size={18} /> : undefined} />
          ))}
        </View>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {sides.map(({ team }) =>
          team ? <LinkChip key={team.id} label={team.name} accessibilityLabel={`${team.name}, ${tr.isTies ? "nation" : "team"} page`} onPress={() => openTeam(team, slug, tr.isTies)} leading={<Flag iso2={team.iso2} code={team.code} size={18} />} /> : null,
        )}
        {tie ? <LinkChip label={`${v.team(tie.a)?.code ?? "TBD"} v ${v.team(tie.b)?.code ?? "TBD"} · the tie`} accessibilityLabel="The whole tie" onPress={() => openTie(tie.id)} /> : null}
        <LinkChip label={tr.name} accessibilityLabel={`${tr.name}, tournament page`} onPress={() => openTournament(slug)} />
      </View>
    </Card>
  );
}

function MatchScreen({ id, slug }: { id: string; slug: string }) {
  const { t, calm } = useTheme();
  const cfg = useConfig();
  const flags = cfg.data?.flags ?? {};
  const q = useMatch(id);
  const b = useBundle(slug);
  const l = useLive(slug, 10_000);
  const m = q.data?.match;
  const live = m ? isLiveStatus(m.status) : false;
  // Fetched again whenever the match moves, so the last point lands after the match leaves "live".
  const tl = useTimeline(id, live, m ? `${m.status}:${m.score?.lastEventNumber ?? 0}` : undefined);
  const starred = useFollowing("match", id);
  const [moment, setMoment] = useState<TakeoverMoment | null>(null);
  const closeMoment = useCallback(() => setMoment(null), []);
  const played = useRef(new Set<string>());
  const [scoredBy, setScoredBy] = useState<"A" | "B" | null>(null);
  const prevScore = useRef<MMatch["score"]>(null);
  const prevSituation = useRef<string>("");
  const prevStatus = useRef<string>("");
  const spot = useSharedValue(0);
  const spotStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${spot.value * 16}deg` }] }));
  const v = useMemo(() => (b.data ? makeView(b.data, l.data) : null), [b.data, l.data]);
  const aLabel = m && v ? v.sideLabel(m, "A") : "";
  const bLabel = m && v ? v.sideLabel(m, "B") : "";
  // Doubles show both players in full, one per line; everyone else gets one line.
  const names = (side: "A" | "B") => {
    if (!m || !v) return [];
    const ps = m.tieId ? v.sidePlayers(m, side) : [];
    return ps.length > 1 ? ps.map((p) => p.name) : [v.sideLabel(m, side)];
  };
  const aCode = (m && v?.team(m.a)?.code) || "A";
  const bCode = (m && v?.team(m.b)?.code) || "B";

  // A point lands: the stage light swings to the side that won it, with a tick.
  useEffect(() => {
    if (!m?.score) return;
    const who = scorer(prevScore.current, m.score);
    prevScore.current = m.score;
    if (!who) return;
    setScoredBy(who);
    void Haptics.selectionAsync().catch(() => {});
    if (!calm) spot.value = withSequence(withSpring(who === "A" ? -1 : 1, { damping: 10 }), withTiming(0, { duration: 900 }));
    const id2 = setTimeout(() => setScoredBy(null), 900);
    return () => clearTimeout(id2);
  }, [m?.score, spot, calm]);

  // Big moments: set point, match point, and the result.
  useEffect(() => {
    if (!m || !q.data || flags.takeovers === false) return;
    // Each moment plays once, however often the screen polls or re-renders.
    const play = (mo: TakeoverMoment) => {
      if (played.current.has(mo.key)) return;
      played.current.add(mo.key);
      setMoment(mo);
    };
    const sit = q.data.situation;
    const key = sit.kind ? `${sit.kind}:${sit.side}:${m.score?.lastEventNumber}` : "none";
    // The first look only records where the match stands: a moment plays when it happens, not on opening the screen.
    const seen = prevSituation.current !== "";
    if (seen && sit.kind && (sit.kind === "match" || sit.kind === "set") && prevSituation.current.split(":").slice(0, 2).join(":") !== `${sit.kind}:${sit.side}`) {
      const team = v?.team(sit.side === "A" ? m.a : m.b);
      play({ key, kicker: `${v?.court(m.courtId) ?? "Court"} · LIVE`, words: sit.kind === "match" ? ["Match", "point"] : ["Set", "point"], who: `${team?.code ?? ""} · ${sit.side === "A" ? aLabel : bLabel}`, final: false });
    }
    prevSituation.current = key;
    if (prevStatus.current && ["live", "paused", "pending_sync"].includes(prevStatus.current) && isDoneStatus(m.status) && m.winner) {
      const tie = v?.tieOf(m);
      const winnerTeam = v?.team(m.winner);
      const tieWon = tie && tie.status === "completed" && tie.winner === m.winner;
      play({
        key: `final:${m.id}`,
        kicker: b.data?.tournament.name.toUpperCase() ?? "",
        words: tieWon ? ["Tie", "won"] : m.tieId ? ["Rubber", "won"] : ["Match", "won"],
        who: tieWon && tie ? `${winnerTeam?.name} ${tie.winner === tie.a ? `${tie.rubbersA}–${tie.rubbersB}` : `${tie.rubbersB}–${tie.rubbersA}`}` : `${winnerTeam?.code ?? ""} · ${m.winner === m.a ? aLabel : bLabel}`,
        final: true,
      });
    }
    prevStatus.current = m.status;
  }, [q.data, m, v, aLabel, bLabel, b.data, flags.takeovers]);

  const share = useCallback(() => {
    setMoment(null);
    router.push({ pathname: "/share/[matchId]", params: { matchId: id } });
  }, [id]);

  if (!m || !v || !b.data) {
    return (
      <Screen tabs={false} onRefresh={() => b.refetch()}>
        <BackHeader label="Back" />
        <LoadState queries={[b]} what="this match" notFound={<Empty title="This match is not available" />} />
      </Screen>
    );
  }
  const tz = b.data.tournament.timezone;
  const tie = v.tieOf(m);
  const sit = q.data!.situation;
  const awaiting = isAwaitingResult(m);
  const callText = isDoneStatus(m.status)
    ? "Final"
    : awaiting
      ? "Match over · awaiting confirmation"
      : m.status === "paused"
      ? "Play suspended"
      : sit.kind === "match" || sit.kind === "set"
        ? `${sit.kind === "match" ? "Match" : "Set"} point ${sit.side === "A" ? aCode : bCode}`
        : sit.kind === "break"
          ? `Break point ${sit.side === "A" ? aCode : bCode}`
          : m.score?.tiebreak
            ? "Tie-break"
            : live && m.score?.serving
              ? `${m.score.serving === "A" ? aCode : bCode} to serve`
              : m.scheduledTime
                ? `${dayIn(m.scheduledTime, tz)} · ${timeIn(m.scheduledTime, tz)}`
                : "Not started";
  const hot = !awaiting && (sit.kind === "match" || sit.kind === "set");
  const summary = `${matchA11y(m, v)}${hot || sit.kind === "break" ? `. ${callText}` : ""}`;
  return (
    <View style={{ flex: 1 }}>
      <Screen tabs={false} stage={false} onRefresh={() => Promise.all([q.refetch(), tl.refetch()])}>
        <BackHeader
          label={tie ? `${v.team(tie.a)?.code ?? ""} v ${v.team(tie.b)?.code ?? ""}` : b.data.tournament.name.split(" ").slice(0, 2).join(" ")}
          fallback={tie ? { pathname: "/tie/[id]", params: { id: tie.id } } : { pathname: "/t/[slug]", params: { slug } }}
          right={<ToggleButton compact on={starred} onLabel="★ Starred" offLabel="☆ Star" onPress={() => void toggleFollow("match", id, b.data!.tournament.id)} />}
        />
        <StaleBanner queries={[q, l]} live={live || m.status === "pending_sync"} />
        <View style={{ marginHorizontal: -18, paddingHorizontal: 18, paddingBottom: 18, overflow: "hidden" }}>
          <Animated.View pointerEvents="none" style={[{ position: "absolute", top: -220, left: "50%", marginLeft: -150, width: 300, height: 560, transformOrigin: "50% 0%" }, spotStyle]}>
            <LinearGradient colors={[t.glowA, "transparent"]} style={{ flex: 1, borderBottomLeftRadius: 150, borderBottomRightRadius: 150 }} />
          </Animated.View>
          <View accessible accessibilityLabel={summary} style={{ borderRadius: 26, backgroundColor: t.scheme === "dark" ? "rgba(10,16,34,0.88)" : "rgba(255,255,255,0.94)", borderWidth: 1, borderColor: t.line, paddingVertical: 14, paddingRight: 12 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingLeft: 18, marginBottom: 6 }}>
              {live && !awaiting ? <LivePill label={m.status === "paused" ? "PAUSED" : `LIVE${m.rubberType ? ` · ${m.rubberType}` : ""}`} /> : <Chip label={isDoneStatus(m.status) ? "Final" : awaiting ? "Match over" : m.status === "cancelled" ? "Not played" : "Up next"} />}
              <Chip label={[v.court(m.courtId), m.rubberType ? RUBBER_LABELS[m.rubberType as keyof typeof RUBBER_LABELS] : m.round].filter(Boolean).join(" · ")} />
            </View>
            <Board m={m} v={v} aNames={names("A")} bNames={names("B")} scoredBy={scoredBy} />
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingLeft: 18, marginTop: 8 }}>
              <Body tone="ink2" size={12}>{tie ? `${v.team(tie.a)?.code} ${tie.rubbersA}–${tie.rubbersB} ${v.team(tie.b)?.code} in the tie` : (m.round ?? "")}</Body>
              <View style={{ backgroundColor: hot ? t.ball : "transparent", borderRadius: 6, paddingHorizontal: hot ? 7 : 0, paddingVertical: 3 }}>
                <Eyebrow size={11} tone={hot ? "onBall" : "ink"}>{callText}</Eyebrow>
              </View>
            </View>
          </View>
        </View>
        {flags.momentum !== false && (tl.data?.points.length ?? 0) > 1 && (
          <Card style={{ marginTop: 4 }}>
            <Eyebrow style={{ marginBottom: 10 }}>Momentum</Eyebrow>
            <Momentum points={tl.data!.points} aLabel={aCode} bLabel={bCode} />
          </Card>
        )}
        <Card style={{ marginTop: 12 }}>
          <Eyebrow style={{ marginBottom: 10 }}>Game by game</Eyebrow>
          <Feed points={tl.data?.points ?? []} aCode={aCode} bCode={bCode} />
        </Card>
        <MatchLinks m={m} v={v} slug={slug} />
        <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
          <Button kind="ghost" label="Share card" onPress={share} style={{ flex: 1 }} />
          {live && flags.live_activity && lockScreenSupported() ? (
            <Button
              label="Lock screen"
              onPress={() => void startLockScreen(m, { a: aCode, b: bCode, court: v.court(m.courtId) ?? "" })}
              style={{ flex: 1 }}
            />
          ) : (
            <Button label="My pass" onPress={() => router.push("/pass")} style={{ flex: 1 }} />
          )}
        </View>
        {Platform.OS === "web" ? null : <View style={{ height: 10 }} />}
      </Screen>
      <Takeover moment={moment} calm={calm} onDone={closeMoment} onShare={share} />
    </View>
  );
}

export default function MatchRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useMatch(id);
  const b = useBundle(q.data?.tournamentSlug);
  if (!q.data) {
    return (
      <Screen tabs={false} onRefresh={() => q.refetch()}>
        <BackHeader label="Back" />
        <LoadState queries={[q]} what="this match" notFound={<Empty title="This match is not available" body="It may have been removed from the order of play." />} />
      </Screen>
    );
  }
  return (
    <SkinScope skin={b.data?.tournament.skin}>
      <MatchScreen id={id} slug={q.data.tournamentSlug} />
    </SkinScope>
  );
}

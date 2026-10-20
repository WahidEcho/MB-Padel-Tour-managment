/**
 * The live courts hero: the top of Discover on a live day. One card per court of
 * the featured event and of every live tournament, in the Discover order Move
 * Beyond sets, swiped court by court: the match called to court, each side's
 * walk-on, the live score, the result and what is next on the court. The
 * person's own match (or a starred one) comes first.
 *
 * One read (useCourtsLive). Which scene a court is in is decided by the shared
 * showcase module (src/lib/tv/showcase.ts) on this phone's clock between polls,
 * with the same timings as the court TVs. Every card has the same fixed height,
 * so a scene changing never moves the page; with Reduce Motion (or the app's calm
 * switch) every change still shows, without the movement.
 *
 * Hidden when the platform flag is off, when no tournament has the showcase on
 * today (Match day tab), or when nothing is happening on any court.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { Image } from "expo-image";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import {
  RUBBER_SHORT,
  WALKON,
  heroCards,
  isDoneStatus,
  scoreLine,
  sideIdentity,
  sideName,
  sidePlayers,
  type HeroCard,
  type MCourtPlayer,
  type MCourtsEvent,
  type MCourtsLive,
  type MMatch,
  type MTie,
  type ShowcaseScene,
  type SideIdentity,
  type SideKey,
} from "@core";
import { useConfig, useCourtsLive, useScreenFocused, useVenue } from "../api/queries";
import { isAwaitingResult, timeIn } from "../api/model";
import { useMyPlayer } from "../player/me";
import { isMine, mySide } from "../player/mine";
import { ImAtCourtPill } from "../player/ImAtCourt";
import { useFollowsOf } from "../state/follows";
import { openMatch, openTie, openTournament, openVenueMap } from "../nav/links";
import { SkinScope, useTheme } from "../theme/ThemeProvider";
import { Body, Display, Eyebrow, Num } from "./Text";
import { Chip, Flag, LivePill } from "./Bits";
import { Rolling } from "./Rolling";
import { StageLight } from "./StageLight";
import { Takeover, type TakeoverMoment } from "./Takeover";
import { CONTENT_MAX_WIDTH } from "./Screen";

/** Every card is this tall, whatever its scene. */
const HERO_H = 272;
/** A saved answer older than this is yesterday's news: no hero until a fresh one arrives. */
const STALE_MS = 3 * 60_000;
const NO_EVENTS: MCourtsEvent[] = [];

/** Results already played as a moment this session: each plays once, however often Discover is opened. */
const played = new Set<string>();

function useClock(ms: number, on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms, on]);
  return now;
}

function freshEvents(data: MCourtsLive | undefined, now: number): MCourtsEvent[] {
  if (!data) return NO_EVENTS;
  const at = Date.parse(data.generatedAt);
  return Number.isFinite(at) && now - at < STALE_MS ? data.events : NO_EVENTS;
}

export function LiveCourtsHero() {
  const cfg = useConfig();
  const enabled = cfg.data?.flags?.live_courts !== false;
  const q = useCourtsLive(enabled);
  const focused = useScreenFocused();
  const now = useClock(1_000, focused && enabled);
  const me = useMyPlayer().data ?? null;
  const starred = useFollowsOf("match");
  const events = freshEvents(q.data, now);
  // Empty unless something is on (a result stays on its court for minutes, so the hero does not blink between matches).
  const cards = useMemo(() => heroCards(events, now, (m) => isMine(m, me, starred)), [events, now, me, starred]);
  if (!enabled || !cards.length) return null;
  return <Pager cards={cards} />;
}

function Pager({ cards }: { cards: HeroCard[] }) {
  const { calm } = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  // The page's own width (Screen pads 18 a side); measured once laid out.
  const [w, setW] = useState(Math.min(windowWidth, CONTENT_MAX_WIDTH) - 36);
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null);
  const found = cards.findIndex((c) => c.key === currentKey);
  const index = found >= 0 ? found : 0;
  const shown = useRef({ index: 0, w });
  // The card being looked at stays in view when the order changes under it (or the width does).
  useEffect(() => {
    if (shown.current.index === index && shown.current.w === w) return;
    scroll.current?.scrollTo({ x: index * w, animated: false });
    shown.current = { index, w };
  }, [index, w]);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const width = Math.round(e.nativeEvent.layout.width);
    if (width > 0) setW((old) => (old === width ? old : width));
  }, []);
  const onEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.max(0, Math.min(cards.length - 1, Math.round(e.nativeEvent.contentOffset.x / w)));
    shown.current = { index: i, w };
    setCurrentKey(cards[i]?.key ?? null);
  };
  const liveCount = cards.filter((c) => c.live).length;
  return (
    <Animated.View entering={calm ? undefined : FadeIn.duration(260)} style={{ marginBottom: 18 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", height: 22, marginBottom: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }} accessibilityRole="header" accessibilityLabel={`Live courts, ${liveCount} on now`}>
          <LivePill label="LIVE COURTS" />
        </View>
        {cards.length > 1 ? (
          <Eyebrow tone="ink3" size={10.5} accessibilityLabel={`Court ${index + 1} of ${cards.length}. Swipe for the other courts.`}>
            {`${index + 1} / ${cards.length}`}
          </Eyebrow>
        ) : null}
      </View>
      <View onLayout={onLayout} style={{ height: HERO_H }}>
        <ScrollView
          ref={scroll}
          horizontal
          pagingEnabled
          decelerationRate="fast"
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={onEnd}
          style={{ width: w, height: HERO_H }}
        >
          {cards.map((c, i) => (
            <View key={c.key} style={{ width: w, height: HERO_H }}>
              <SkinScope skin={{ seedA: c.event.tournament.skin.seedA, seedB: c.event.tournament.skin.seedB }}>
                <CourtCard card={c} active={i === index} />
              </SkinScope>
            </View>
          ))}
        </ScrollView>
      </View>
      {cards.length > 1 && cards.length <= 12 ? <Dots n={cards.length} index={index} /> : null}
    </Animated.View>
  );
}

function Dots({ n, index }: { n: number; index: number }) {
  const { t } = useTheme();
  return (
    <View style={{ flexDirection: "row", justifyContent: "center", gap: 6, height: 6, marginTop: 10 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: n }, (_, i) => (
        <View key={i} style={{ width: i === index ? 16 : 6, height: 6, borderRadius: 3, backgroundColor: i === index ? t.ink : t.ink3, opacity: i === index ? 1 : 0.5 }} />
      ))}
    </View>
  );
}

/* ---------- one court ---------- */

const matchOf = (ev: MCourtsEvent, id: string | null | undefined) => (id ? ev.matches.find((m) => m.id === id) : undefined);
const tieOf = (ev: MCourtsEvent, id: string | null | undefined) => (id ? ev.ties.find((x) => x.id === id) : undefined);
const teamOf = (ev: MCourtsEvent, id: string | null | undefined) => (id ? ev.teams.find((x) => x.id === id) : undefined);
const idOf = (ev: MCourtsEvent, teamId: string | null | undefined, side: SideKey) => sideIdentity(teamOf(ev, teamId), side, ev.sides, ev.tournament.skin);

/** Changes only when the scene does (not on every tick), so its entrance plays once. */
function sceneKey(s: ShowcaseScene): string {
  switch (s.kind) {
    case "idle":
      return "idle";
    case "next":
      return `next:${s.tieId ?? s.matchId}`;
    case "walkon":
      return `walkon:${s.matchId}:${s.side}`;
    case "tie_score":
      return `tie:${s.tieId}:${s.final}`;
    case "result":
      return `result:${s.matchId}`;
    default:
      return `${s.kind}:${s.matchId}`;
  }
}

function CourtCard({ card, active }: { card: HeroCard; active: boolean }) {
  const { t, calm } = useTheme();
  const cfg = useConfig();
  const takeovers = cfg.data?.flags?.takeovers !== false;
  const ev = card.event;
  const s = card.scene;
  const m = "matchId" in s ? matchOf(ev, s.matchId) : undefined;
  const tie = "tieId" in s ? tieOf(ev, s.tieId) : undefined;
  // The result as a moment, once, on the card in view, while the result is fresh.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const resultKey = s.kind === "result" && s.fresh ? s.matchId : null;
  const r = matchOf(ev, resultKey);
  const moment: TakeoverMoment | null =
    resultKey && r?.winner && active && takeovers && dismissed !== resultKey && !played.has(resultKey)
      ? {
          key: `hero:${resultKey}`,
          kicker: `${card.court.name} · ${ev.tournament.name}`.toUpperCase(),
          words: r.tieId ? ["Rubber", "won"] : ["Match", "won"],
          who: `${teamOf(ev, r.winner)?.code ?? ""} · ${sideName(ev, r, r.winner === r.a ? "A" : "B")}`,
          final: false,
        }
      : null;
  const closeMoment = useCallback(() => {
    if (resultKey) played.add(resultKey);
    setDismissed(resultKey);
  }, [resultKey]);

  const open = () => {
    if (m) openMatch(m.id);
    else if (tie) openTie(tie.id);
    else openTournament(ev.tournament.slug);
  };

  return (
    <Pressable
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={cardA11y(card)}
      accessibilityHint={m ? "Opens the match" : tie ? "Opens the tie" : "Opens the tournament"}
      style={({ pressed }) => [styles.card, { backgroundColor: t.surface, borderColor: t.line }, pressed && { opacity: 0.9 }]}
    >
      {s.kind === "live" || s.kind === "walkon" ? <StageLight height={HERO_H} /> : null}
      <View style={{ flex: 1, padding: 16 }}>
        <CardHeader card={card} />
        <Animated.View key={sceneKey(s)} entering={calm ? undefined : FadeIn.duration(300)} style={{ flex: 1, justifyContent: "center" }}>
          <SceneBody ev={ev} s={s} m={m} tie={tie} />
        </Animated.View>
        <NextLine card={card} />
      </View>
      {moment ? <Takeover moment={moment} onDone={closeMoment} onShare={closeMoment} calm={calm} /> : null}
    </Pressable>
  );
}

function SceneBody({ ev, s, m, tie }: { ev: MCourtsEvent; s: ShowcaseScene; m: MMatch | undefined; tie: MTie | undefined }) {
  switch (s.kind) {
    case "walkon":
      return m ? <WalkOn ev={ev} m={m} side={s.side} elapsedMs={s.elapsedMs} /> : null;
    case "live":
      return m ? <LiveScore ev={ev} m={m} /> : null;
    case "called":
      return m ? <Called ev={ev} m={m} msLeft={s.msLeft} overdue={s.overdue} presentA={s.presentA} presentB={s.presentB} canSayHere={ev.tournament.imAtCourt === true} /> : null;
    case "result":
      return m ? <Result ev={ev} m={m} /> : null;
    case "tie_score":
      return tie ? <TieScore ev={ev} tie={tie} final={s.final} /> : null;
    case "next":
      return <Next ev={ev} m={m} tie={tie} />;
    default:
      return null;
  }
}

function CardHeader({ card }: { card: HeroCard }) {
  const s = card.scene;
  const m = "matchId" in s ? matchOf(card.event, s.matchId) : undefined;
  const pill =
    s.kind === "walkon" ? (
      <LivePill label="WALK-ON" />
    ) : s.kind === "live" ? (
      <LivePill label={m?.status === "paused" ? "PAUSED" : "LIVE"} />
    ) : s.kind === "called" ? (
      <Chip label={s.overdue ? "CALLED · DUE" : "CALLED"} />
    ) : s.kind === "result" ? (
      <Chip label="FINAL" />
    ) : s.kind === "tie_score" ? (
      s.final ? <Chip label="TIE FINAL" /> : <LivePill label="TIE LIVE" />
    ) : (
      <Chip label="NEXT" />
    );
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, height: 24 }}>
      <Eyebrow size={10.5} numberOfLines={1} style={{ flexShrink: 1 }}>
        {`${card.court.name} · ${card.event.tournament.name}`}
      </Eyebrow>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {card.mine ? <Chip ball label="YOUR MATCH" /> : null}
        <MapButton slug={card.event.tournament.slug} courtId={card.court.id} courtName={card.court.name} />
        {pill}
      </View>
    </View>
  );
}

/** "Show on map": the venue map focused on this court, when the organiser has published one. */
function MapButton({ slug, courtId, courtName }: { slug: string; courtId: string; courtName: string }) {
  const { t } = useTheme();
  const venue = useVenue(slug);
  if (!venue.data) return null;
  return (
    <Pressable
      onPress={() => openVenueMap(slug, courtId)}
      accessibilityRole="button"
      accessibilityLabel={`Show ${courtName} on the venue map`}
      hitSlop={8}
      testID="hero-show-on-map"
      style={({ pressed }) => [{ height: 22, paddingHorizontal: 8, borderRadius: 999, borderWidth: 1, borderColor: t.line, backgroundColor: t.chip, justifyContent: "center" }, pressed && { opacity: 0.7 }]}
    >
      <Eyebrow size={9.5}>MAP</Eyebrow>
    </Pressable>
  );
}

/** A side's flag, logo or colour (with RED / BLUE written on it: never colour alone). */
function Identity({ id, size = 24 }: { id: SideIdentity; size?: number }) {
  if (id.kind === "flag") return <Flag iso2={id.iso2} code={id.code} size={size} />;
  if (id.kind === "logo") return <Image source={{ uri: id.url }} style={{ width: size, height: size, borderRadius: 6 }} contentFit="contain" alt={id.label} accessibilityLabel={id.label} />;
  return (
    <View style={{ minWidth: size, height: Math.round(size * 0.68), borderRadius: 4, paddingHorizontal: id.word ? 5 : 0, backgroundColor: id.hex, alignItems: "center", justifyContent: "center" }}>
      {id.word ? (
        <Eyebrow size={8.5} style={{ color: "#FFFFFF", letterSpacing: 0.8 }}>
          {id.word}
        </Eyebrow>
      ) : null}
    </View>
  );
}

function ServeDot() {
  const { t } = useTheme();
  return <View accessibilityLabel="serving" style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.ball, borderWidth: t.scheme === "light" ? 1.5 : 0, borderColor: t.ballInk }} />;
}

function LiveScore({ ev, m }: { ev: MCourtsEvent; m: MMatch }) {
  const { t } = useTheme();
  const awaiting = isAwaitingResult(m);
  const sc = m.score;
  const row = (side: SideKey) => {
    const id = idOf(ev, side === "A" ? m.a : m.b, side);
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Identity id={id} size={26} />
        <Body weight="bold" size={16} numberOfLines={1} style={{ flex: 1 }}>
          {sideName(ev, m, side)}
        </Body>
        {!awaiting && sc?.serving === side ? <ServeDot /> : null}
        {(sc?.sets ?? []).map((set, i) => (
          <Num key={i} size={18} tone="ink2">
            {side === "A" ? set.a : set.b}
          </Num>
        ))}
        {sc?.games ? <Rolling value={side === "A" ? sc.games.a : sc.games.b} size={26} /> : null}
        {sc?.points ? (
          <View style={{ backgroundColor: t.chip, borderRadius: 8, minWidth: 44, alignItems: "center" }}>
            <Rolling value={side === "A" ? sc.points.a : sc.points.b} size={26} sweep />
          </View>
        ) : null}
      </View>
    );
  };
  const line = awaiting ? "Match over · awaiting confirmation" : m.status === "paused" ? "Play suspended" : sc?.tiebreak ? "Tie-break" : m.rubberType ? RUBBER_SHORT[m.rubberType as keyof typeof RUBBER_SHORT] ?? m.rubberType : (m.round ?? "");
  return (
    <View style={{ gap: 14 }}>
      {row("A")}
      {row("B")}
      <Eyebrow size={10} tone="ink3" numberOfLines={1}>
        {line}
      </Eyebrow>
    </View>
  );
}

function Portrait({ p, size }: { p: MCourtPlayer; size: number }) {
  const { t, calm } = useTheme();
  const h = Math.round(size * 1.18);
  if (!p.photoUrl) {
    const initials = p.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((x) => x[0]!.toUpperCase())
      .join("");
    return (
      <View style={{ width: size, height: h, borderRadius: 18, backgroundColor: t.surface2, borderWidth: 1, borderColor: t.line, alignItems: "center", justifyContent: "center" }}>
        <Num size={size * 0.34} tone="ink2">{initials}</Num>
      </View>
    );
  }
  return (
    <Image
      source={{ uri: p.photoUrl }}
      style={{ width: size, height: h, borderRadius: 18, backgroundColor: t.chip }}
      contentFit="cover"
      contentPosition={{ left: `${Math.round(p.focalX * 100)}%`, top: `${Math.round(p.focalY * 100)}%` }}
      transition={calm ? 0 : 200}
      cachePolicy="disk"
      alt={`Photo of ${p.name}`}
      accessibilityLabel={`Photo of ${p.name}`}
    />
  );
}

function WalkOn({ ev, m, side, elapsedMs }: { ev: MCourtsEvent; m: MMatch; side: SideKey; elapsedMs: number }) {
  const { t, calm } = useTheme();
  const players = sidePlayers(ev, m, side).slice(0, 2);
  const team = teamOf(ev, side === "A" ? m.a : m.b);
  const id = idOf(ev, team?.id, side);
  const size = players.length > 1 ? 86 : 104;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
        <Animated.View entering={calm ? undefined : FadeInDown.duration(420)} style={{ flexDirection: "row", gap: 8 }}>
          {players.length ? players.map((p) => <Portrait key={p.id} p={p} size={size} />) : <Identity id={id} size={72} />}
        </Animated.View>
        <View style={{ flex: 1, gap: 6, minWidth: 0 }}>
          <Eyebrow size={10} tone="ink2">
            {side === "A" ? "Walking on" : "And facing them"}
          </Eyebrow>
          <Display size={20} numberOfLines={3}>
            {sideName(ev, m, side)}
          </Display>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Identity id={id} size={20} />
            <Body tone="ink2" size={13} numberOfLines={1} style={{ flexShrink: 1 }}>
              {team?.name ?? ""}
            </Body>
          </View>
        </View>
      </View>
      <View style={{ height: 3, borderRadius: 3, backgroundColor: t.chip, overflow: "hidden" }}>
        <View style={{ height: 3, width: `${Math.min(100, Math.round((elapsedMs / WALKON.perSideMs) * 100))}%`, backgroundColor: t.ball }} />
      </View>
    </View>
  );
}

function mmss(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Called({ ev, m, msLeft, overdue, presentA, presentB, canSayHere }: { ev: MCourtsEvent; m: MMatch; msLeft: number; overdue: boolean; presentA: boolean; presentB: boolean; canSayHere: boolean }) {
  const { t } = useTheme();
  // The player's own side gets "I'm at court" right on the card (the card itself opens the match).
  const me = useMyPlayer().data ?? null;
  const mine = canSayHere ? mySide(m, me) : null;
  const row = (side: SideKey, here: boolean) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <Identity id={idOf(ev, side === "A" ? m.a : m.b, side)} size={24} />
      <Body weight="semi" size={15} numberOfLines={1} style={{ flex: 1 }}>
        {sideName(ev, m, side)}
      </Body>
      {!here && mine === side ? (
        <ImAtCourtPill matchId={m.id} />
      ) : (
        <Eyebrow size={10} style={{ color: here ? t.success : t.ink3 }}>
          {here ? "✓ At court" : "On the way"}
        </Eyebrow>
      )}
    </View>
  );
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" }}>
        <View style={{ gap: 2 }}>
          <Eyebrow size={10} tone="live">Called to court</Eyebrow>
          <Body tone="ink2" size={12.5}>{overdue ? "Deadline passed" : "Players to the court"}</Body>
        </View>
        <Num size={40} tone={overdue ? "live" : "ink"}>{mmss(msLeft)}</Num>
      </View>
      {row("A", presentA)}
      {row("B", presentB)}
    </View>
  );
}

function Result({ ev, m }: { ev: MCourtsEvent; m: MMatch }) {
  const row = (side: SideKey) => {
    const teamId = side === "A" ? m.a : m.b;
    const won = Boolean(m.winner && m.winner === teamId);
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Identity id={idOf(ev, teamId, side)} size={26} />
        <Body weight={won ? "bold" : "regular"} tone={won ? "ink" : "ink2"} size={16} numberOfLines={1} style={{ flex: 1 }}>
          {sideName(ev, m, side)}
        </Body>
        {(m.score?.sets ?? []).map((set, i) => (
          <Num key={i} size={20} tone={won ? "ink" : "ink2"}>
            {side === "A" ? set.a : set.b}
          </Num>
        ))}
        {won ? <Chip ball label="WON" /> : null}
      </View>
    );
  };
  const how = m.status === "walkover" ? "Walkover" : m.status === "retired" ? "Retired" : m.status === "disqualified" ? "Disqualification" : m.tieId ? "Rubber result" : "Match result";
  return (
    <View style={{ gap: 14 }}>
      <Eyebrow size={10} tone="ink2">{how}</Eyebrow>
      {row("A")}
      {row("B")}
    </View>
  );
}

function TieScore({ ev, tie, final }: { ev: MCourtsEvent; tie: MTie; final: boolean }) {
  const { t } = useTheme();
  const rubbers = ev.matches.filter((r) => r.tieId === tie.id).sort((a, b) => (a.rubberNo ?? 0) - (b.rubberNo ?? 0));
  let a = 0;
  let b = 0;
  for (const r of rubbers) {
    if (!isDoneStatus(r.status) || !r.winner) continue;
    if (r.winner === tie.a) a++;
    else b++;
  }
  const side = (teamId: string | null, key: SideKey) => {
    const team = teamOf(ev, teamId);
    return (
      <View style={{ flex: 1, alignItems: "center", gap: 6 }}>
        <Identity id={idOf(ev, teamId, key)} size={38} />
        <Body weight="bold" size={14} numberOfLines={1}>{team?.code ?? "TBD"}</Body>
      </View>
    );
  };
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        {side(tie.a, "A")}
        <View style={{ alignItems: "center", minWidth: 96 }}>
          <Rolling value={`${a}–${b}`} size={42} />
          <Eyebrow size={9.5} tone="ink3">{final ? "Tie final" : "Tie score"}</Eyebrow>
        </View>
        {side(tie.b, "B")}
      </View>
      <View style={{ flexDirection: "row", justifyContent: "center", gap: 6 }}>
        {rubbers.map((r) => {
          const done = isDoneStatus(r.status);
          const label = `${RUBBER_SHORT[r.rubberType as keyof typeof RUBBER_SHORT] ?? r.rubberType ?? ""} ${done ? (r.winner === tie.a ? teamOf(ev, tie.a)?.code : teamOf(ev, tie.b)?.code) ?? "" : r.status === "live" || r.status === "paused" ? "LIVE" : r.status === "cancelled" ? "—" : "NEXT"}`;
          return <Chip key={r.id} label={label.trim()} style={done ? undefined : { backgroundColor: t.chip, opacity: 0.8 }} />;
        })}
      </View>
    </View>
  );
}

function Next({ ev, m, tie }: { ev: MCourtsEvent; m: MMatch | undefined; tie: MTie | undefined }) {
  const tz = ev.tournament.timezone;
  const aId = tie ? tie.a : m?.a;
  const bId = tie ? tie.b : m?.b;
  const name = (teamId: string | null | undefined, side: SideKey) => (m && !tie ? sideName(ev, m, side) : (teamOf(ev, teamId)?.name ?? "TBD"));
  const when = (tie ? tie.scheduledTime : m?.scheduledTime) ?? null;
  const row = (teamId: string | null | undefined, side: SideKey) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <Identity id={idOf(ev, teamId, side)} size={26} />
      <Body weight="semi" size={16} numberOfLines={1} style={{ flex: 1 }}>
        {name(teamId, side)}
      </Body>
    </View>
  );
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Eyebrow size={10} tone="ink2">{tie ? "Next tie on court" : "Next on court"}</Eyebrow>
        <Num size={22} tone="ink2">{when ? timeIn(when, tz) : "Time TBC"}</Num>
      </View>
      {row(aId, "A")}
      {row(bId, "B")}
    </View>
  );
}

/** "Next: EGY v JPN · 15:30". Always takes its line, so the card never changes height. */
function NextLine({ card }: { card: HeroCard }) {
  return (
    <View style={{ height: 18, justifyContent: "flex-end" }}>
      <Eyebrow size={9.5} tone="ink3" numberOfLines={1}>
        {nextText(card) ?? " "}
      </Eyebrow>
    </View>
  );
}

function nextText(card: HeroCard): string | null {
  const ev = card.event;
  const n = card.next;
  if (!n) return null;
  const tz = ev.tournament.timezone;
  const m = matchOf(ev, n.matchId);
  const tie = tieOf(ev, n.tieId);
  if (m && m.tieId) {
    const kind = RUBBER_SHORT[m.rubberType as keyof typeof RUBBER_SHORT] ?? m.rubberType ?? "Next rubber";
    return `Next: ${kind} · ${sideName(ev, m, "A", true)} v ${sideName(ev, m, "B", true)}`;
  }
  if (m) return `Next: ${sideName(ev, m, "A", true)} v ${sideName(ev, m, "B", true)}${m.scheduledTime ? ` · ${timeIn(m.scheduledTime, tz)}` : ""}`;
  if (tie) return `Next: ${teamOf(ev, tie.a)?.code ?? "TBD"} v ${teamOf(ev, tie.b)?.code ?? "TBD"}${tie.scheduledTime ? ` · ${timeIn(tie.scheduledTime, tz)}` : ""}`;
  return null;
}

/** One sentence per card for VoiceOver and TalkBack. */
function cardA11y(card: HeroCard): string {
  const ev = card.event;
  const s = card.scene;
  const m = "matchId" in s ? matchOf(ev, s.matchId) : undefined;
  const tie = "tieId" in s ? tieOf(ev, s.tieId) : undefined;
  const vs = m ? `${sideName(ev, m, "A")} against ${sideName(ev, m, "B")}` : tie ? `${teamOf(ev, tie.a)?.name ?? "TBD"} against ${teamOf(ev, tie.b)?.name ?? "TBD"}` : "";
  const parts = [`${card.court.name}, ${ev.tournament.name}`];
  if (card.mine) parts.push("Your match");
  switch (s.kind) {
    case "walkon":
      if (m) parts.push(`Walking on: ${sideName(ev, m, s.side)}`, vs);
      break;
    case "live": {
      parts.push(m?.status === "paused" ? "Play suspended" : "Live", vs);
      const sc = m?.score;
      if (sc?.sets.length) parts.push(`Sets ${sc.sets.map((x) => `${x.a}–${x.b}`).join(", ")}`);
      if (sc?.games) parts.push(`Games ${sc.games.a}–${sc.games.b}`);
      if (sc?.points) parts.push(`${sc.tiebreak ? "Tie-break points" : "Points"} ${sc.points.a}–${sc.points.b}`);
      break;
    }
    case "called": {
      parts.push("Called to court", vs, s.overdue ? "Deadline passed" : `${Math.ceil(s.msLeft / 60_000)} minutes left`);
      if (m) parts.push(`${sideName(ev, m, "A")} ${s.presentA ? "at court" : "on the way"}`, `${sideName(ev, m, "B")} ${s.presentB ? "at court" : "on the way"}`);
      break;
    }
    case "result": {
      const winner = m?.winner ? (m.winner === m.a ? sideName(ev, m, "A") : sideName(ev, m, "B")) : null;
      parts.push("Final", vs);
      if (winner) parts.push(`${winner} won`);
      if (m?.score) parts.push(scoreLine(m.score));
      break;
    }
    case "tie_score": {
      const rubbers = ev.matches.filter((r) => r.tieId === s.tieId);
      const a = rubbers.filter((r) => isDoneStatus(r.status) && r.winner && r.winner === tie?.a).length;
      const b = rubbers.filter((r) => isDoneStatus(r.status) && r.winner && r.winner !== tie?.a).length;
      parts.push(s.final ? "Tie final" : "Tie in progress", vs, `Rubbers ${a}–${b}`);
      break;
    }
    case "next": {
      const when = (tie ? tie.scheduledTime : m?.scheduledTime) ?? null;
      parts.push("Next on court", vs, when ? `at ${timeIn(when, ev.tournament.timezone)}` : "time to be confirmed");
      break;
    }
  }
  const then = nextText(card);
  if (then) parts.push(then.replace(/^Next:/, "Then"));
  return parts.filter(Boolean).join(". ");
}

const styles = StyleSheet.create({
  card: { height: HERO_H, borderRadius: 24, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth * 2 },
});

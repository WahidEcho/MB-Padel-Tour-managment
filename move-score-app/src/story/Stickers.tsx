/**
 * What goes over the photo. Every size is in design units (a 360-wide canvas)
 * times `u`, so the same sticker is drawn crisp on the phone and at 1080×1920.
 * No blur views or blend modes: those do not survive a capture on every platform.
 * Fonts never scale with the system text size here: the story is a picture.
 */
import type { ReactNode } from "react";
import { Text, View, type TextStyle } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Line, Path } from "react-native-svg";
import { BALL, BALL_INK } from "../theme/palette";
import { F } from "../theme/type";
import { config } from "../config";
import { PASS_H, PASS_W, PassCard } from "../ui/PassCard";
import { useGatedImage } from "./LoadGate";
import { appLink, scoreText, shortEvent, type LayoutId, type StoryInfo, type StorySide, type Tone } from "./model";

const WORDMARK = require("../../assets/brand/movescore-wordmark.png");
const WORDMARK_RATIO = 997 / 74;
const LIVE = "#FF2D55";

/** Holographic edge: the pass foil's colours, run round the glass. */
const HOLO = ["rgba(255,255,255,0.85)", "rgba(0,255,230,0.75)", "rgba(252,252,0,0.85)", "rgba(255,0,180,0.7)", "rgba(30,107,255,0.8)", "rgba(255,255,255,0.85)"] as const;

function T({ style, children, lines }: { style: TextStyle; children: ReactNode; lines?: number }) {
  return (
    <Text allowFontScaling={false} numberOfLines={lines} style={style}>
      {children}
    </Text>
  );
}

const shadow = (u: number, a = 0.45): TextStyle => ({ textShadowColor: `rgba(0,0,0,${a})`, textShadowOffset: { width: 0, height: 1 * u }, textShadowRadius: 10 * u });

function FlagImage({ iso2, w, h, r }: { iso2: string; w: number; h: number; r: number }) {
  const gate = useGatedImage();
  return <Image source={{ uri: `${config.apiBaseUrl}/flags/${iso2}.svg` }} style={{ width: w, height: h, borderRadius: r }} contentFit="cover" cachePolicy="disk" transition={0} {...gate} />;
}

export function flagUrl(iso2: string | null): string | null {
  return iso2 && /^[a-z]{2}$/.test(iso2) ? `${config.apiBaseUrl}/flags/${iso2}.svg` : null;
}

export function StoryFlag({ iso2, code, size, u, dark = true }: { iso2: string | null; code: string; size: number; u: number; dark?: boolean }) {
  const h = Math.round(size * 0.68 * 100) / 100;
  if (flagUrl(iso2)) return <FlagImage iso2={iso2!} w={size} h={h} r={3 * u} />;
  return (
    <View style={{ width: size, height: h, borderRadius: 3 * u, backgroundColor: dark ? "rgba(255,255,255,0.14)" : "rgba(5,6,10,0.08)", alignItems: "center", justifyContent: "center" }}>
      <T style={{ fontFamily: F.data, fontSize: size * 0.36, color: dark ? "#E8ECF4" : BALL_INK }}>{code.slice(0, 3)}</T>
    </View>
  );
}

export function Wordmark({ height }: { height: number }) {
  const gate = useGatedImage();
  return <Image source={WORDMARK} style={{ height, width: height * WORDMARK_RATIO }} contentFit="contain" transition={0} accessibilityLabel="Move Score" {...gate} />;
}

function statusLabel(info: StoryInfo): string {
  switch (info.status) {
    case "live":
      return "Live";
    case "final":
      return "Final";
    case "upcoming":
      return "Up next";
    default:
      return "I'm here";
  }
}

function inks(tone: Tone) {
  return tone === "dark"
    ? { ink: "#F4F6FB", ink2: "rgba(232,236,244,0.72)", line: "rgba(255,255,255,0.16)", accent: BALL, glass: ["rgba(12,22,60,0.80)", "rgba(1,4,26,0.66)"] as const }
    : { ink: BALL_INK, ink2: "#4A5468", line: "rgba(5,6,10,0.12)", accent: BALL_INK, glass: ["rgba(255,255,255,0.90)", "rgba(236,241,255,0.78)"] as const };
}

/* ---------------- Scoreboard: frosted glass with a holographic edge ---------------- */

function ScoreLine({ side, u, tone }: { side: StorySide; u: number; tone: Tone }) {
  const c = inks(tone);
  const sets = side.sets.join("  ");
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 * u }}>
      <StoryFlag iso2={side.iso2} code={side.code} size={28 * u} u={u} dark={tone === "dark"} />
      <T lines={1} style={{ flex: 1, fontFamily: F.bodyBold, fontSize: 17 * u, color: side.won ? (tone === "dark" ? BALL : c.ink) : c.ink }}>
        {side.label}
        {side.won ? "  ✓" : ""}
      </T>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 * u }}>
        {sets ? <T style={{ fontFamily: F.data, fontSize: 28 * u, letterSpacing: 1 * u, color: c.ink }}>{sets}</T> : null}
        {side.games !== null ? (
          <View style={{ minWidth: 30 * u, paddingHorizontal: 6 * u, height: 32 * u, borderRadius: 8 * u, backgroundColor: BALL, alignItems: "center", justifyContent: "center" }}>
            <T style={{ fontFamily: F.data, fontSize: 24 * u, color: BALL_INK }}>{side.games}</T>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function Pill({ info, u, tone }: { info: StoryInfo; u: number; tone: Tone }) {
  const live = info.status === "live";
  const bg = live ? LIVE : info.status === "final" || info.status === "here" ? BALL : tone === "dark" ? "rgba(255,255,255,0.14)" : "rgba(5,6,10,0.08)";
  const ink = live ? "#FFFFFF" : info.status === "final" || info.status === "here" ? BALL_INK : tone === "dark" ? "#F4F6FB" : BALL_INK;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 * u, backgroundColor: bg, borderRadius: 6 * u, paddingHorizontal: 7 * u, paddingVertical: 3.5 * u }}>
      {live ? <View style={{ width: 6 * u, height: 6 * u, borderRadius: 3 * u, backgroundColor: "#FFFFFF" }} /> : null}
      <T style={{ fontFamily: F.bodyBold, fontSize: 9.5 * u, letterSpacing: 1.6 * u, color: ink, textTransform: "uppercase" }}>{statusLabel(info)}</T>
    </View>
  );
}

export function ScoreSticker({ info, u, tone }: { info: StoryInfo; u: number; tone: Tone }) {
  const c = inks(tone);
  const W = 304 * u;
  return (
    <LinearGradient colors={HOLO} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ width: W, borderRadius: 24 * u, padding: 1.5 * u, boxShadow: `0 ${14 * u}px ${36 * u}px rgba(0,0,0,0.35)` }}>
      <View style={{ borderRadius: 22.5 * u, overflow: "hidden" }}>
        <LinearGradient colors={c.glass} start={{ x: 0.2, y: 0 }} end={{ x: 0.8, y: 1 }} style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }} />
        {/* A soft diagonal sheen, like light on glass. */}
        <LinearGradient
          colors={["rgba(255,255,255,0)", tone === "dark" ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.6)", "rgba(255,255,255,0)"]}
          locations={[0.3, 0.45, 0.6]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}
        />
        <View style={{ padding: 16 * u, gap: 12 * u }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 * u }}>
            <Pill info={info} u={u} tone={tone} />
            <T lines={1} style={{ flex: 1, fontFamily: F.bodyBold, fontSize: 9.5 * u, letterSpacing: 1.5 * u, color: c.ink2, textTransform: "uppercase", textAlign: "right" }}>
              {info.kind === "pass" ? info.place : info.round}
            </T>
          </View>
          {info.sides ? (
            <View style={{ gap: 10 * u }}>
              <ScoreLine side={info.sides[0]} u={u} tone={tone} />
              <ScoreLine side={info.sides[1]} u={u} tone={tone} />
            </View>
          ) : (
            <View style={{ gap: 6 * u }}>
              <T lines={2} style={{ fontFamily: F.display, fontSize: 22 * u, lineHeight: 22 * u, color: c.ink, textTransform: "uppercase" }}>
                {shortEvent(info.event)}
              </T>
              {info.holder ? <T style={{ fontFamily: F.bodySemi, fontSize: 13 * u, color: c.ink2 }}>{info.holder}</T> : null}
            </View>
          )}
          {info.note ? <T style={{ fontFamily: F.bodySemi, fontSize: 12 * u, color: c.ink2 }}>{info.note}</T> : null}
          <View style={{ height: 1 * u, backgroundColor: c.line }} />
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", gap: 8 * u }}>
            <View style={{ flexShrink: 1, gap: 2 * u }}>
              {info.kind !== "pass" ? (
                <T lines={1} style={{ fontFamily: F.bodyBold, fontSize: 11.5 * u, color: c.ink }}>
                  {shortEvent(info.event)}
                </T>
              ) : null}
              <T lines={1} style={{ fontFamily: F.bodySemi, fontSize: 11 * u, color: c.ink2 }}>
                {info.kind === "pass" ? info.date : [info.place, info.when ?? info.date].filter(Boolean).join(" · ")}
              </T>
            </View>
            {info.kind === "pass" ? <T style={{ fontFamily: F.bodyBold, fontSize: 9.5 * u, letterSpacing: 1.2 * u, color: c.ink2 }}>{info.serial}</T> : null}
          </View>
        </View>
        {/* A thin foil strip along the top edge. */}
        <LinearGradient colors={["#FF00B4", "#00FFE6", BALL, "#1E6BFF"]} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={{ position: "absolute", left: 0, right: 0, top: 0, height: 2.5 * u, opacity: 0.85 }} />
      </View>
    </LinearGradient>
  );
}

/* ---------------- Pass: the collectible pass as a sticker ---------------- */

export function PassSticker({ info, u }: { info: StoryInfo; u: number }) {
  if (!info.pass) return null;
  const k = 0.9 * u;
  return (
    <View style={{ width: PASS_W * k, height: PASS_H * k }}>
      <View style={{ width: PASS_W, height: PASS_H, transformOrigin: "0 0", transform: [{ scale: k }], borderRadius: 24, boxShadow: "0 18px 44px rgba(0,0,0,0.5)" }}>
        <PassCard pass={info.pass.pass} event={info.pass.event} nationIso2={info.pass.nationIso2} pose={{ x: -0.35, y: 0.15 }} />
      </View>
      <View style={{ position: "absolute", top: -12 * u, left: -10 * u, backgroundColor: BALL, borderRadius: 8 * u, paddingHorizontal: 10 * u, paddingVertical: 6 * u, transform: [{ rotate: "-8deg" }], boxShadow: `0 ${6 * u}px ${16 * u}px rgba(0,0,0,0.35)` }}>
        <T style={{ fontFamily: F.display, fontSize: 13 * u, color: BALL_INK, textTransform: "uppercase" }}>{info.status === "here" ? info.headline.join(" ") : "I'm here"}</T>
      </View>
    </View>
  );
}

/* ---------------- Minimal: just big words over the photo ---------------- */

export function MinimalSticker({ info, u, tone }: { info: StoryInfo; u: number; tone: Tone }) {
  const big = tone === "dark" ? BALL : "#FFFFFF";
  return (
    <View style={{ width: 312 * u, gap: 10 * u }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 * u }}>
        <View style={{ width: 7 * u, height: 7 * u, borderRadius: 4 * u, backgroundColor: info.status === "live" ? LIVE : BALL }} />
        <T lines={1} style={{ flex: 1, fontFamily: F.bodyBold, fontSize: 11 * u, letterSpacing: 2 * u, color: "#FFFFFF", textTransform: "uppercase", ...shadow(u) }}>
          {["I'm here", info.city].filter(Boolean).join(" · ")}
        </T>
      </View>
      <T style={{ fontFamily: F.display, fontSize: 62 * u, lineHeight: 56 * u, color: big, textTransform: "uppercase", ...shadow(u, 0.35) }}>{`${info.headline[0]}\n${info.headline[1]}`}</T>
      {info.sides ? (
        <View style={{ gap: 4 * u }}>
          {info.sides.map((s) => (
            <View key={s.code + s.label} style={{ flexDirection: "row", alignItems: "center", gap: 10 * u }}>
              <StoryFlag iso2={s.iso2} code={s.code} size={24 * u} u={u} />
              <T lines={1} style={{ flex: 1, fontFamily: F.bodyBold, fontSize: 17 * u, color: "#FFFFFF", ...shadow(u) }}>
                {s.label}
              </T>
              <T style={{ fontFamily: F.data, fontSize: 30 * u, color: s.won ? big : "#FFFFFF", letterSpacing: 1 * u, ...shadow(u) }}>{scoreText(s)}</T>
            </View>
          ))}
        </View>
      ) : null}
      <T lines={2} style={{ fontFamily: F.bodySemi, fontSize: 12 * u, color: "rgba(255,255,255,0.86)", ...shadow(u) }}>
        {[shortEvent(info.event), info.date].join(" · ")}
      </T>
    </View>
  );
}

/* ---------------- Ticket stub: a torn ticket with a perforation ---------------- */

/** Stripes from the serial's digits: it reads like a barcode and is the same every time. */
function Barcode({ seed, w, h, ink }: { seed: string; w: number; h: number; ink: string }) {
  const digits = seed.replace(/\D/g, "").padEnd(6, "7");
  const bars: number[] = [];
  for (let i = 0; bars.length < 22; i++) bars.push(1 + (Number(digits[i % digits.length]) % 3));
  const unit = w / bars.reduce((a, b) => a + b + 1, 0);
  return (
    <View style={{ flexDirection: "row", width: w, height: h, gap: unit }}>
      {bars.map((b, i) => (
        <View key={i} style={{ width: b * unit, height: h, backgroundColor: ink, opacity: i % 5 === 0 ? 0.55 : 1 }} />
      ))}
    </View>
  );
}

export function TicketSticker({ info, u, tone }: { info: StoryInfo; u: number; tone: Tone }) {
  const W = 316 * u;
  const H = 140 * u;
  const cut = 222 * u; // where the stub tears off
  const r = 14 * u;
  const n = 9 * u; // notch radius
  const fill = tone === "dark" ? BALL : "#FFFFFF";
  const ink = BALL_INK;
  const path = [
    `M ${r} 0`,
    `H ${cut - n}`,
    `A ${n} ${n} 0 0 0 ${cut + n} 0`,
    `H ${W - r}`,
    `A ${r} ${r} 0 0 1 ${W} ${r}`,
    `V ${H - r}`,
    `A ${r} ${r} 0 0 1 ${W - r} ${H}`,
    `H ${cut + n}`,
    `A ${n} ${n} 0 0 0 ${cut - n} ${H}`,
    `H ${r}`,
    `A ${r} ${r} 0 0 1 0 ${H - r}`,
    `V ${r}`,
    `A ${r} ${r} 0 0 1 ${r} 0`,
    "Z",
  ].join(" ");
  const sides = info.sides;
  return (
    <View style={{ width: W, height: H, boxShadow: `0 ${12 * u}px ${30 * u}px rgba(0,0,0,0.4)`, borderRadius: r }}>
      <Svg width={W} height={H} style={{ position: "absolute", left: 0, top: 0 }}>
        <Path d={path} fill={fill} />
        <Line x1={cut} y1={n + 4 * u} x2={cut} y2={H - n - 4 * u} stroke={ink} strokeOpacity={0.35} strokeWidth={1.4 * u} strokeDasharray={`${4 * u} ${4 * u}`} />
      </Svg>
      <View style={{ position: "absolute", left: 0, top: 0, width: cut, height: H, padding: 14 * u, justifyContent: "space-between" }}>
        <T lines={1} style={{ fontFamily: F.bodyBold, fontSize: 8.5 * u, letterSpacing: 1.8 * u, color: ink, opacity: 0.7, textTransform: "uppercase" }}>
          {info.kind === "pass" ? "Admit one · event pass" : `Admit one · ${info.round ?? "Match"}`}
        </T>
        <T lines={2} style={{ fontFamily: F.display, fontSize: 15 * u, lineHeight: 15 * u, color: ink, textTransform: "uppercase" }}>
          {shortEvent(info.event)}
        </T>
        {sides ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 * u }}>
            <StoryFlag iso2={sides[0].iso2} code={sides[0].code} size={20 * u} u={u} dark={false} />
            <T style={{ fontFamily: F.data, fontSize: 20 * u, color: ink }}>{`${sides[0].code}  ${sides[0].sets.length ? `${sides[0].sets.at(-1)}–${sides[1].sets.at(-1)}` : "v"}  ${sides[1].code}`}</T>
            <StoryFlag iso2={sides[1].iso2} code={sides[1].code} size={20 * u} u={u} dark={false} />
          </View>
        ) : (
          <T lines={1} style={{ fontFamily: F.bodyBold, fontSize: 13 * u, color: ink }}>
            {info.holder ?? "Move Score fan"}
          </T>
        )}
        <T lines={1} style={{ fontFamily: F.bodySemi, fontSize: 9.5 * u, color: ink, opacity: 0.75 }}>
          {[info.place, info.date].filter(Boolean).join(" · ")}
        </T>
      </View>
      <View style={{ position: "absolute", left: cut, top: 0, width: W - cut, height: H, paddingVertical: 14 * u, paddingHorizontal: 11 * u, justifyContent: "space-between", alignItems: "center" }}>
        <T style={{ fontFamily: F.display, fontSize: 13 * u, lineHeight: 13 * u, color: ink, textTransform: "uppercase", textAlign: "center" }}>{`${info.headline[0]}\n${info.headline[1]}`}</T>
        <Barcode seed={info.serial} w={W - cut - 22 * u} h={26 * u} ink={ink} />
        <T style={{ fontFamily: F.bodyBold, fontSize: 7.5 * u, letterSpacing: 0.8 * u, color: ink, opacity: 0.75 }}>{info.serial}</T>
      </View>
    </View>
  );
}

export function Sticker({ layout, info, u, tone }: { layout: LayoutId; info: StoryInfo; u: number; tone: Tone }) {
  switch (layout) {
    case "pass":
      return <PassSticker info={info} u={u} />;
    case "minimal":
      return <MinimalSticker info={info} u={u} tone={tone} />;
    case "ticket":
      return <TicketSticker info={info} u={u} tone={tone} />;
    default:
      return <ScoreSticker info={info} u={u} tone={tone} />;
  }
}

/* ---------------- The canvas around the sticker ---------------- */

/** Dark gradients top and bottom so white type reads on any photo. */
export function Scrims({ W, H, layout }: { W: number; H: number; layout: LayoutId }) {
  const strong = layout === "minimal";
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, width: W, height: H }}>
      <LinearGradient colors={["rgba(0,0,0,0.5)", "rgba(0,0,0,0)"]} style={{ position: "absolute", left: 0, top: 0, width: W, height: H * 0.22 }} />
      <LinearGradient
        colors={["rgba(0,0,0,0)", strong ? "rgba(0,0,0,0.55)" : "rgba(0,0,0,0.35)", strong ? "rgba(0,0,0,0.85)" : "rgba(0,0,0,0.7)"]}
        locations={[0, 0.5, 1]}
        style={{ position: "absolute", left: 0, bottom: 0, width: W, height: H * (strong ? 0.62 : 0.5) }}
      />
    </View>
  );
}

/** "● I'm here · Cairo" at the top, the wordmark and the app's address at the bottom. */
export function Chrome({ W, H, u, info, layout }: { W: number; H: number; u: number; info: StoryInfo; layout: LayoutId }) {
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, width: W, height: H }}>
      {layout !== "minimal" ? (
        <View style={{ position: "absolute", top: H * 0.085, left: 20 * u, flexDirection: "row", alignItems: "center", gap: 6 * u, backgroundColor: "rgba(0,0,0,0.38)", borderRadius: 20 * u, borderWidth: 1 * u, borderColor: "rgba(255,255,255,0.22)", paddingHorizontal: 10 * u, paddingVertical: 5 * u }}>
          <View style={{ width: 7 * u, height: 7 * u, borderRadius: 4 * u, backgroundColor: info.status === "live" ? LIVE : BALL }} />
          <T style={{ fontFamily: F.bodyBold, fontSize: 10.5 * u, letterSpacing: 1.6 * u, color: "#FFFFFF", textTransform: "uppercase" }}>{["I'm here", info.city].filter(Boolean).join(" · ")}</T>
        </View>
      ) : null}
      <View style={{ position: "absolute", left: 0, right: 0, bottom: H * 0.045, alignItems: "center", gap: 5 * u }}>
        <Wordmark height={11 * u} />
        <T style={{ fontFamily: F.bodySemi, fontSize: 9 * u, letterSpacing: 0.4 * u, color: "rgba(255,255,255,0.78)" }}>{appLink()}</T>
      </View>
    </View>
  );
}

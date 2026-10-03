import { useCallback, useEffect, useState } from "react";
import { Platform, View, useWindowDimensions } from "react-native";
import { useFocusEffect } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { Image } from "expo-image";
import Svg, { Defs, Ellipse, RadialGradient, Stop } from "react-native-svg";
import Animated, { SensorType, useAnimatedReaction, useAnimatedSensor, useAnimatedStyle, useFrameCallback, useSharedValue, type SharedValue } from "react-native-reanimated";
import type { MPass } from "@core";
import { BALL, BALL_INK } from "../theme/palette";
import { F } from "../theme/type";
import { Body, Eyebrow } from "./Text";
import { QR } from "./QR";
import { Flag } from "./Bits";
import { useTheme } from "../theme/ThemeProvider";
import { CONTENT_MAX_WIDTH } from "./Screen";

/**
 * The design prototype's pass (design/prototype.src.html, `.pass`) is 270 × 400;
 * every measure inside the card is that layout scaled by the card's width.
 */
export const PASS_W = 270;
export const PASS_H = 400;
/** Taller than the prototype, so the pass fills the screen: height = width × PASS_RATIO. */
export const PASS_RATIO = 1.58;
const GUTTER = 18; // Screen's side padding
const BORDER = 1;

/**
 * The pass's size for a window: as wide as the screen allows (minus the gutters),
 * up to 420pt on a phone and 460pt on a tablet, and PASS_RATIO tall.
 */
export function passSize(window: { width: number; height: number }): { w: number; h: number } {
  const tablet = Math.min(window.width, window.height) >= 600;
  const room = Math.min(window.width, CONTENT_MAX_WIDTH) - GUTTER * 2;
  const w = Math.round(Math.max(240, Math.min(tablet ? 460 : 420, room)));
  return { w, h: Math.round(w * PASS_RATIO) };
}

export function usePassSize() {
  const win = useWindowDimensions();
  return passSize(win);
}

/** Every inner measure for a card `w` wide. Seven day circles always fill one row. */
export function passLayout(w: number) {
  const k = w / PASS_W;
  const pad = Math.round(18 * k);
  const gap = Math.round(4 * k);
  const day = Math.floor((w - BORDER * 2 - pad * 2 - gap * 6) / 7);
  return { k, pad, gap, day, s: (n: number) => Math.round(n * k * 10) / 10 };
}

export interface PassEvent {
  name: string;
  venue: string | null;
  city: string | null;
  days: string[]; // YYYY-MM-DD
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2–8 Nov", or "29 Sep – 5 Oct" when the event crosses a month. */
export function dateRange(days: string[]): string | null {
  if (!days.length) return null;
  const [a, b] = [days[0], days[days.length - 1]];
  const d = (s: string) => Number(s.slice(8));
  const m = (s: string) => MONTHS[Number(s.slice(5, 7)) - 1];
  if (a === b) return `${d(a)} ${m(a)}`;
  return m(a) === m(b) ? `${d(a)}–${d(b)} ${m(b)}` : `${d(a)} ${m(a)} – ${d(b)} ${m(b)}`;
}

// The prototype's foil: a 115° rainbow band, colour-dodged over the card.
const RAINBOW = ["rgba(255,0,180,0)", "rgba(255,0,180,0.55)", "rgba(0,255,230,0.55)", "rgba(252,252,0,0.6)", "rgba(30,107,255,0.55)", "rgba(30,107,255,0)"] as const;
const RAINBOW_AT = [0.2, 0.32, 0.44, 0.56, 0.68, 0.8] as const;

/** Soft light pools on the card, drawn as radial gradients (the prototype's CSS backgrounds). */
function Glows({ w, h, k }: { w: number; h: number; k: number }) {
  return (
    <Svg width={w} height={h} style={{ position: "absolute", left: 0, top: 0 }} pointerEvents="none">
      <Defs>
        <RadialGradient id="g1" cx={w * 0.2} cy={0} rx={160 * k} ry={220 * k} fx={w * 0.2} fy={0} gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#1E6BFF" stopOpacity={0.55} />
          <Stop offset="0.7" stopColor="#1E6BFF" stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id="g2" cx={w} cy={h} rx={200 * k} ry={240 * k} fx={w} fy={h} gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#FCFC00" stopOpacity={0.22} />
          <Stop offset="0.7" stopColor="#FCFC00" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Ellipse cx={w * 0.2} cy={0} rx={160 * k} ry={220 * k} fill="url(#g1)" />
      <Ellipse cx={w} cy={h} rx={200 * k} ry={240 * k} fill="url(#g2)" />
    </Svg>
  );
}

function Glare({ size }: { size: number }) {
  return (
    <Svg width={size} height={size}>
      <Defs>
        <RadialGradient id="gl" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.28} />
          <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Ellipse cx={size / 2} cy={size / 2} rx={size / 2} ry={size / 2} fill="url(#gl)" />
    </Svg>
  );
}

const clamp = (v: number) => {
  "worklet";
  return Math.max(-1, Math.min(1, v));
};

/**
 * The rotation sensor, mounted only while the card is on screen and moving:
 * unmounting unregisters it, so a hidden or still card costs no sensor events.
 */
function TiltSensor({ gx, gy, base, gyro }: { gx: SharedValue<number>; gy: SharedValue<number>; base: SharedValue<number | null>; gyro: SharedValue<boolean> }) {
  const sensor = useAnimatedSensor(SensorType.ROTATION, { interval: 30 });
  useAnimatedReaction(
    () => sensor.sensor.value,
    (s) => {
      if (Platform.OS === "web" || (!s.roll && !s.pitch)) return;
      gyro.value = true;
      if (base.value === null) base.value = s.pitch;
      base.value += (s.pitch - base.value) * 0.004; // a new way of holding the phone slowly becomes "flat"
      gx.value = clamp(s.roll / 0.5);
      gy.value = clamp((s.pitch - base.value) / 0.5);
    },
  );
  return null;
}

/**
 * The attendee's collectible pass. It tilts with the phone's gyroscope (not the
 * finger): the light and the foil slide across it as the phone moves. Whatever
 * angle the phone is held at counts as flat. Where there is no gyroscope (a
 * desktop browser) it sways on its own as if held in a hand. Reduce Motion keeps
 * it still, with the sensor and the frame loop off; so does leaving the screen.
 *
 * It is always the fan's pass: staff accreditation lives in the referee console.
 */
export function PassCard({ pass, event, nationIso2, today, width, pose }: { pass: MPass; event: PassEvent; nationIso2?: string | null; today?: string; width?: number; pose?: { x: number; y: number } }) {
  const { calm } = useTheme();
  const auto = usePassSize();
  const w = width ?? auto.w;
  const h = Math.round(w * PASS_RATIO);
  const { k, pad, gap, day: DAY, s } = passLayout(w);
  const glareSize = Math.round(240 * k);
  const onsite = Boolean(pass.onsiteUnlockedAt);
  const attended = pass.attendance?.matches ?? 0;
  const points = pass.attendance?.points ?? 0;
  const [focused, setFocused] = useState(true);
  // `pose` holds the card flat with the foil and light frozen at that tilt (the story
  // sticker, which is captured as an image): no sensor and no frame loop.
  const still = Boolean(pose);
  const moving = focused && !calm && !still;
  const x = useSharedValue(pose?.x ?? 0);
  const y = useSharedValue(pose?.y ?? 0);
  const gx = useSharedValue(0);
  const gy = useSharedValue(0);
  const base = useSharedValue<number | null>(null);
  const gyro = useSharedValue(false);

  const frame = useFrameCallback((f) => {
    let tx = gx.value;
    let ty = gy.value;
    if (!gyro.value) {
      const t = f.timeSinceFirstFrame / 1000;
      tx = Math.sin(t * 0.9) * 0.75 + Math.sin(t * 2.3) * 0.12;
      ty = Math.cos(t * 0.7) * 0.5 + Math.sin(t * 1.7) * 0.1;
    }
    const kk = 0.12; // smoothing so sensor noise never jitters
    x.value += (tx - x.value) * kk;
    y.value += (ty - y.value) * kk;
  }, false);
  // Runs only while the pass is on screen.
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  useEffect(() => {
    frame.setActive(moving);
    if (calm && !still) {
      x.value = 0;
      y.value = 0;
    }
  }, [moving, calm, still, frame, x, y]);

  // A bigger card tilts a little less, so its far edge doesn't swing out of the screen.
  const tilt = 13 * Math.min(1, 1.25 / k);
  const card = useAnimatedStyle(() => (still ? {} : { transform: [{ perspective: 1100 * k }, { rotateY: `${x.value * tilt}deg` }, { rotateX: `${-y.value * tilt}deg` }] }));
  const foil = useAnimatedStyle(() => ({ transform: [{ translateX: x.value * w * 0.7 }, { translateY: y.value * h * 0.35 }, { rotate: "25deg" }] }));
  const glare = useAnimatedStyle(() => ({ transform: [{ translateX: w * (0.5 + x.value * 0.45) - glareSize / 2 }, { translateY: h * (0.35 + y.value * 0.45) - glareSize / 2 }] }));

  const sub = [event.venue, event.city, dateRange(event.days)].filter(Boolean).join(" · ");
  const stat = (label: string, value: number, ball: boolean) => (
    <View style={{ flex: 1 }}>
      <Eyebrow size={s(8.5)} style={{ color: "#9AA4B8", letterSpacing: s(1.5) }}>{label}</Eyebrow>
      <Animated.Text style={{ fontFamily: F.display, fontSize: s(30), lineHeight: s(31), marginTop: s(3), color: ball ? BALL : "#E8ECF4", fontVariant: ["tabular-nums"] }}>{String(value)}</Animated.Text>
    </View>
  );
  return (
    <Animated.View
      style={[{ width: w, height: h, borderRadius: s(24), overflow: "hidden", borderWidth: BORDER, borderColor: "rgba(255,255,255,0.14)" }, card]}
      accessible
      accessibilityLabel={`${onsite ? "On-site pass" : "Event pass"} for ${event.name}, number ${pass.serial}. ${attended} ${attended === 1 ? "match" : "matches"} attended, ${points} points.`}
    >
      {moving && <TiltSensor gx={gx} gy={gy} base={base} gyro={gyro} />}
      <LinearGradient colors={["#0a1438", "#01041A"]} locations={[0, 0.7]} start={{ x: 0.41, y: 0 }} end={{ x: 0.59, y: 1 }} style={{ position: "absolute", inset: 0 }} />
      <Glows w={w} h={h} k={k} />
      <View style={{ flex: 1, padding: pad }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <Image source={require("../../assets/brand/movescore-wordmark.png")} style={{ height: s(10), width: s(10) * (997 / 74) }} contentFit="contain" accessibilityLabel="Move Score" />
          <View style={{ backgroundColor: onsite ? BALL : "rgba(255,255,255,0.08)", borderRadius: s(6), paddingHorizontal: s(7), paddingVertical: s(4) }}>
            <Eyebrow size={s(9.5)} style={{ color: onsite ? BALL_INK : "#E8ECF4", letterSpacing: s(1.9), fontFamily: F.bodyBold }}>{onsite ? "ON-SITE" : "SPECTATOR"}</Eyebrow>
          </View>
        </View>
        <View style={{ marginTop: s(26) }}>
          <Animated.Text style={{ fontFamily: F.display, fontSize: s(25), lineHeight: s(24), color: "#E8ECF4", textTransform: "uppercase" }}>{event.name}</Animated.Text>
          {sub ? <Body size={s(12)} style={{ color: "#9AA4B8", marginTop: s(8), lineHeight: s(16) }}>{sub}</Body> : null}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap, marginTop: s(16) }}>
          {event.days.map((d) => {
            const stamped = pass.stamps.includes(d);
            // Today (the event's day, in its own time zone) gets a solid ring until it is stamped.
            const isToday = d === today && !stamped;
            return (
              <View key={d} style={{ width: DAY, height: DAY, borderRadius: DAY / 2, alignItems: "center", justifyContent: "center", backgroundColor: stamped ? BALL : "transparent", borderWidth: stamped ? 0 : isToday ? 1.5 : 1, borderStyle: isToday ? "solid" : "dashed", borderColor: isToday ? BALL : "rgba(255,255,255,0.22)" }}>
                <Body size={s(10)} weight="bold" style={{ color: stamped ? BALL_INK : isToday ? "#E8ECF4" : "#6B7590", lineHeight: s(13) }}>{Number(d.slice(8))}</Body>
              </View>
            );
          })}
        </View>
        <View style={{ marginTop: "auto", flexDirection: "row", gap: s(12), paddingTop: s(12), marginBottom: s(14), borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.10)", width: "62%" }}>
          {stat("Matches", attended, false)}
          {stat("Score", points, true)}
        </View>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", gap: 8 }}>
          <View style={{ flexShrink: 1 }}>
            <Eyebrow size={s(9.5)} style={{ color: "#9AA4B8", letterSpacing: s(1.7) }}>Holder</Eyebrow>
            <View style={{ flexDirection: "row", gap: s(6), alignItems: "center", marginTop: s(3) }}>
              <Body weight="bold" size={s(15)} numberOfLines={1} style={{ color: "#E8ECF4", flexShrink: 1, lineHeight: s(20) }}>{pass.holderName ?? "Move Score fan"}</Body>
              {pass.nationCode ? <Flag iso2={nationIso2} code={pass.nationCode} size={Math.round(s(22))} /> : null}
            </View>
            <Body size={s(11)} style={{ color: "#9AA4B8", lineHeight: s(15) }}>{`No. ${String(pass.serial).padStart(6, "0")}`}</Body>
          </View>
          <View style={{ width: s(54), height: s(54), borderRadius: s(8), backgroundColor: "#FFFFFF", padding: s(5) }}>
            <QR value={`movescore://pass/${pass.id}`} size={s(44)} />
          </View>
        </View>
      </View>
      {onsite && (
        <Animated.View style={[{ position: "absolute", left: -w, top: -h / 2, width: w * 3, height: h * 2, opacity: 0.55, mixBlendMode: "color-dodge" }, foil]} pointerEvents="none">
          <LinearGradient colors={RAINBOW} locations={RAINBOW_AT} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={{ flex: 1 }} />
        </Animated.View>
      )}
      <Animated.View style={[{ position: "absolute", left: 0, top: 0, mixBlendMode: "overlay" }, glare]} pointerEvents="none">
        <Glare size={glareSize} />
      </Animated.View>
      {onsite && (
        <View style={{ position: "absolute", right: s(16), top: Math.round(h * 0.43), width: s(86), height: s(86), borderRadius: s(43), borderWidth: s(3), borderColor: BALL, alignItems: "center", justifyContent: "center", opacity: 0.95, transform: [{ rotate: "-14deg" }] }}>
          <Animated.Text style={{ fontFamily: F.display, fontSize: s(10), lineHeight: s(11), letterSpacing: 0.6, color: BALL, textAlign: "center" }}>{`ON-SITE\n${(event.city ?? "").toUpperCase()}\n${event.days[0]?.slice(0, 4) ?? ""}`}</Animated.Text>
        </View>
      )}
    </Animated.View>
  );
}

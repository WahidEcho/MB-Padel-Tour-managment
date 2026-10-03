import { useCallback, useEffect, useState } from "react";
import { Platform, View } from "react-native";
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

/** Same size and layout as the pass in the design prototype (design/prototype.src.html, `.pass`). */
export const PASS_W = 270;
export const PASS_H = 400;
const PAD = 18;
const BORDER = 1;
// Seven day circles fill the row exactly (the card's border takes a pixel each side).
const DAY = Math.floor((PASS_W - BORDER * 2 - PAD * 2 - 6 * 4) / 7);

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
function Glows({ staff }: { staff: boolean }) {
  return (
    <Svg width={PASS_W} height={PASS_H} style={{ position: "absolute", left: 0, top: 0 }} pointerEvents="none">
      <Defs>
        <RadialGradient id="g1" cx={staff ? 0 : PASS_W * 0.2} cy={0} rx={staff ? 200 : 160} ry={staff ? 240 : 220} fx={staff ? 0 : PASS_W * 0.2} fy={0} gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={staff ? "#FCFC00" : "#1E6BFF"} stopOpacity={staff ? 0.35 : 0.55} />
          <Stop offset="0.7" stopColor={staff ? "#FCFC00" : "#1E6BFF"} stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id="g2" cx={PASS_W} cy={PASS_H} rx={200} ry={240} fx={PASS_W} fy={PASS_H} gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#FCFC00" stopOpacity={0.22} />
          <Stop offset="0.7" stopColor="#FCFC00" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Ellipse cx={staff ? 0 : PASS_W * 0.2} cy={0} rx={staff ? 200 : 160} ry={staff ? 240 : 220} fill="url(#g1)" />
      {!staff && <Ellipse cx={PASS_W} cy={PASS_H} rx={200} ry={240} fill="url(#g2)" />}
    </Svg>
  );
}

const GLARE = 240;
function Glare() {
  return (
    <Svg width={GLARE} height={GLARE}>
      <Defs>
        <RadialGradient id="gl" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.28} />
          <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Ellipse cx={GLARE / 2} cy={GLARE / 2} rx={GLARE / 2} ry={GLARE / 2} fill="url(#gl)" />
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
 * The collectible pass. It tilts with the phone's gyroscope (not the finger): the
 * light and the foil slide across it as the phone moves. Whatever angle the phone
 * is held at counts as flat. Where there is no gyroscope (a desktop browser) it
 * sways on its own as if held in a hand. Reduce Motion keeps it still, with the
 * sensor and the frame loop off; so does leaving the screen.
 */
export function PassCard({ pass, event, nationIso2, today, pose }: { pass: MPass; event: PassEvent; nationIso2?: string | null; today?: string; pose?: { x: number; y: number } }) {
  const { calm } = useTheme();
  const onsite = Boolean(pass.onsiteUnlockedAt);
  const staff = pass.edition === "staff";
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
    const k = 0.12; // smoothing so sensor noise never jitters
    x.value += (tx - x.value) * k;
    y.value += (ty - y.value) * k;
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

  const card = useAnimatedStyle(() => (still ? {} : { transform: [{ perspective: 1100 }, { rotateY: `${x.value * 13}deg` }, { rotateX: `${-y.value * 13}deg` }] }));
  const foil = useAnimatedStyle(() => ({ transform: [{ translateX: x.value * PASS_W * 0.7 }, { translateY: y.value * PASS_H * 0.35 }, { rotate: "25deg" }] }));
  const glare = useAnimatedStyle(() => ({ transform: [{ translateX: PASS_W * (0.5 + x.value * 0.45) - GLARE / 2 }, { translateY: PASS_H * (0.35 + y.value * 0.45) - GLARE / 2 }] }));

  const sub = [event.venue, event.city, dateRange(event.days)].filter(Boolean).join(" · ");
  return (
    <Animated.View
      style={[{ width: PASS_W, height: PASS_H, borderRadius: 24, overflow: "hidden", borderWidth: BORDER, borderColor: "rgba(255,255,255,0.14)" }, card]}
      accessible
      accessibilityLabel={`${staff ? "Accreditation" : onsite ? "On-site pass" : "Event pass"} for ${event.name}, number ${pass.serial}`}
    >
      {moving && <TiltSensor gx={gx} gy={gy} base={base} gyro={gyro} />}
      <LinearGradient colors={staff ? ["#1a1a06", "#05060A"] : ["#0a1438", "#01041A"]} locations={[0, 0.7]} start={{ x: 0.41, y: 0 }} end={{ x: 0.59, y: 1 }} style={{ position: "absolute", inset: 0 }} />
      <Glows staff={staff} />
      {staff && <View style={{ position: "absolute", top: 10, left: PASS_W / 2 - 23, width: 46, height: 8, borderRadius: 6, backgroundColor: "rgba(0,0,0,0.6)", borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.2)" }} />}
      <View style={{ flex: 1, padding: PAD }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <Image source={require("../../assets/brand/movescore-wordmark.png")} style={{ height: 10, width: 10 * (997 / 74) }} contentFit="contain" accessibilityLabel="Move Score" />
          <View style={{ backgroundColor: onsite || staff ? BALL : "rgba(255,255,255,0.08)", borderRadius: 6, paddingHorizontal: 7, paddingVertical: 4 }}>
            <Eyebrow size={9.5} style={{ color: onsite || staff ? BALL_INK : "#E8ECF4", letterSpacing: 1.9, fontFamily: F.bodyBold }}>{staff ? "ACCREDITED" : onsite ? "ON-SITE" : "SPECTATOR"}</Eyebrow>
          </View>
        </View>
        <View style={{ marginTop: 26 }}>
          <Animated.Text style={{ fontFamily: F.display, fontSize: 25, lineHeight: 24, color: "#E8ECF4", textTransform: "uppercase" }}>{event.name}</Animated.Text>
          {sub ? <Body size={12} style={{ color: "#9AA4B8", marginTop: 8 }}>{sub}</Body> : null}
        </View>
        {staff && (
          <View style={{ marginTop: 14 }}>
            <Animated.Text style={{ fontFamily: F.display, fontSize: 34, lineHeight: 31, color: BALL, textTransform: "uppercase" }}>{pass.staffRole ?? "Staff"}</Animated.Text>
            <Eyebrow size={13} style={{ color: "#E8ECF4", letterSpacing: 1.8 }}>All courts</Eyebrow>
          </View>
        )}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 16 }}>
          {event.days.map((d) => {
            const stamped = pass.stamps.includes(d);
            // Today (the event's day, in its own time zone) gets a solid ring until it is stamped.
            const isToday = d === today && !stamped;
            return (
              <View key={d} style={{ width: DAY, height: DAY, borderRadius: DAY / 2, alignItems: "center", justifyContent: "center", backgroundColor: stamped ? BALL : "transparent", borderWidth: stamped ? 0 : isToday ? 1.5 : 1, borderStyle: isToday ? "solid" : "dashed", borderColor: isToday ? BALL : "rgba(255,255,255,0.22)" }}>
                <Body size={10} weight="bold" style={{ color: stamped ? BALL_INK : isToday ? "#E8ECF4" : "#6B7590" }}>{Number(d.slice(8))}</Body>
              </View>
            );
          })}
        </View>
        <View style={{ marginTop: "auto", flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", gap: 8 }}>
          <View style={{ flexShrink: 1 }}>
            <Eyebrow size={9.5} style={{ color: "#9AA4B8", letterSpacing: 1.7 }}>Holder</Eyebrow>
            <View style={{ flexDirection: "row", gap: 6, alignItems: "center", marginTop: 3 }}>
              <Body weight="bold" numberOfLines={1} style={{ color: "#E8ECF4", flexShrink: 1 }}>{pass.holderName ?? "Move Score fan"}</Body>
              {pass.nationCode ? <Flag iso2={nationIso2} code={pass.nationCode} size={22} /> : null}
            </View>
            <Body size={11} style={{ color: "#9AA4B8" }}>{`No. ${String(pass.serial).padStart(6, "0")}`}</Body>
          </View>
          <View style={{ width: 54, height: 54, borderRadius: 8, backgroundColor: "#FFFFFF", padding: 5 }}>
            <QR value={`movescore://pass/${pass.id}`} size={44} />
          </View>
        </View>
      </View>
      {onsite && (
        <Animated.View style={[{ position: "absolute", left: -PASS_W, top: -PASS_H / 2, width: PASS_W * 3, height: PASS_H * 2, opacity: 0.55, mixBlendMode: "color-dodge" }, foil]} pointerEvents="none">
          <LinearGradient colors={RAINBOW} locations={RAINBOW_AT} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={{ flex: 1 }} />
        </Animated.View>
      )}
      <Animated.View style={[{ position: "absolute", left: 0, top: 0, mixBlendMode: "overlay" }, glare]} pointerEvents="none">
        <Glare />
      </Animated.View>
      {onsite && (
        <View style={{ position: "absolute", right: 16, top: 178, width: 86, height: 86, borderRadius: 43, borderWidth: 3, borderColor: BALL, alignItems: "center", justifyContent: "center", opacity: 0.95, transform: [{ rotate: "-14deg" }] }}>
          <Animated.Text style={{ fontFamily: F.display, fontSize: 10, lineHeight: 11, letterSpacing: 0.6, color: BALL, textAlign: "center" }}>{`ON-SITE\n${(event.city ?? "").toUpperCase()}\n${event.days[0]?.slice(0, 4) ?? ""}`}</Animated.Text>
        </View>
      )}
    </Animated.View>
  );
}

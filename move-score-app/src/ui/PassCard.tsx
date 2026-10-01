import { useEffect } from "react";
import { Platform, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Image } from "expo-image";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { SensorType, interpolate, useAnimatedSensor, useAnimatedStyle, useSharedValue, withRepeat, withSpring, withTiming, Easing } from "react-native-reanimated";
import type { MPass } from "@core";
import { BALL, BALL_INK } from "../theme/palette";
import { F } from "../theme/type";
import { Body, Eyebrow } from "./Text";
import { QR } from "./QR";
import { Flag } from "./Bits";
import { useTheme } from "../theme/ThemeProvider";

export const PASS_W = 280;
export const PASS_H = 420;

export interface PassEvent {
  name: string;
  venue: string | null;
  city: string | null;
  days: string[]; // YYYY-MM-DD
}

const RAINBOW = ["rgba(255,0,180,0)", "rgba(255,0,180,0.55)", "rgba(0,255,230,0.55)", "rgba(252,252,0,0.6)", "rgba(30,107,255,0.55)", "rgba(30,107,255,0)"] as const;

/**
 * The collectible pass. It tilts with the phone (gyroscope, or your finger), and
 * once unlocked at the venue it turns holographic and carries the ON-SITE stamp.
 */
export function PassCard({ pass, event, nationIso2 }: { pass: MPass; event: PassEvent; nationIso2?: string | null }) {
  const { calm } = useTheme();
  const onsite = Boolean(pass.onsiteUnlockedAt);
  const staff = pass.edition === "staff";
  const native = Platform.OS !== "web";
  const sensor = useAnimatedSensor(SensorType.ROTATION, { interval: 30 });
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const drift = useSharedValue(0);
  useEffect(() => {
    if (!calm) drift.value = withRepeat(withTiming(1, { duration: 5200, easing: Easing.inOut(Easing.sin) }), -1, true);
  }, [drift, calm]);
  const pan = Gesture.Pan()
    .onChange((e) => {
      tx.value = Math.max(-1, Math.min(1, e.translationX / 140));
      ty.value = Math.max(-1, Math.min(1, e.translationY / 200));
    })
    .onEnd(() => {
      tx.value = withSpring(0);
      ty.value = withSpring(0);
    });
  const tilt = () => {
    "worklet";
    const s = native && !calm ? sensor.sensor.value : { roll: 0, pitch: 0 };
    const x = Math.max(-1, Math.min(1, tx.value + (s.roll ?? 0) * 1.4 + (calm ? 0 : (drift.value - 0.5) * 0.25)));
    const y = Math.max(-1, Math.min(1, ty.value + ((s.pitch ?? 0) - 0.6) * 1.1));
    return { x, y };
  };
  const card = useAnimatedStyle(() => {
    const { x, y } = tilt();
    return { transform: [{ perspective: 900 }, { rotateY: `${x * 12}deg` }, { rotateX: `${-y * 12}deg` }] };
  });
  const foil = useAnimatedStyle(() => {
    const { x, y } = tilt();
    return { opacity: onsite ? 0.55 : 0, transform: [{ translateX: interpolate(x, [-1, 1], [-160, 160]) }, { translateY: interpolate(y, [-1, 1], [-120, 120]) }, { rotate: "25deg" }] };
  });
  const glare = useAnimatedStyle(() => {
    const { x, y } = tilt();
    return { transform: [{ translateX: x * 90 }, { translateY: y * 120 }] };
  });
  const today = new Date().toISOString().slice(0, 10);
  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[{ width: PASS_W, height: PASS_H, borderRadius: 24, overflow: "hidden", backgroundColor: "#01041A" }, card]} accessible accessibilityLabel={`${staff ? "Accreditation" : onsite ? "On-site pass" : "Event pass"} for ${event.name}, number ${pass.serial}`}>
        <LinearGradient colors={staff ? ["#2a2a06", "#05060A"] : ["#0a1438", "#01041A"]} style={{ position: "absolute", inset: 0 }} />
        <View style={{ position: "absolute", left: -80, top: -120, width: 260, height: 300, borderRadius: 150, backgroundColor: staff ? "rgba(252,252,0,0.28)" : "rgba(30,107,255,0.45)" }} />
        <View style={{ position: "absolute", right: -90, bottom: -110, width: 260, height: 260, borderRadius: 130, backgroundColor: "rgba(252,252,0,0.16)" }} />
        {staff && <View style={{ position: "absolute", top: 10, left: PASS_W / 2 - 23, width: 46, height: 8, borderRadius: 6, backgroundColor: "rgba(0,0,0,0.6)" }} />}
        <View style={{ flex: 1, padding: 18 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: staff ? 8 : 0 }}>
            <Image source={require("../../assets/brand/movescore-wordmark.png")} style={{ height: 11, width: 11 * (997 / 74) }} contentFit="contain" />
            <View style={{ backgroundColor: onsite || staff ? BALL : "rgba(255,255,255,0.08)", borderRadius: 6, paddingHorizontal: 7, paddingVertical: 4 }}>
              <Eyebrow size={9} style={{ color: onsite || staff ? BALL_INK : "#E8ECF4", letterSpacing: 1.8 }}>{staff ? "ACCREDITED" : onsite ? "ON-SITE" : "SPECTATOR"}</Eyebrow>
            </View>
          </View>
          <Animated.Text style={{ fontFamily: F.display, fontSize: 24, lineHeight: 24, color: "#E8ECF4", textTransform: "uppercase", marginTop: 26 }}>{event.name}</Animated.Text>
          <Body size={12} style={{ color: "#9AA4B8", marginTop: 8 }}>{[event.venue, event.city].filter(Boolean).join(" · ")}</Body>
          {staff && (
            <View style={{ marginTop: 14 }}>
              <Animated.Text style={{ fontFamily: F.display, fontSize: 34, lineHeight: 32, color: BALL, textTransform: "uppercase" }}>{pass.staffRole ?? "Staff"}</Animated.Text>
              <Eyebrow size={11} style={{ color: "#E8ECF4" }}>All courts</Eyebrow>
            </View>
          )}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 16 }}>
            {event.days.map((d) => {
              const stamped = pass.stamps.includes(d);
              return (
                <View key={d} style={{ width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: stamped ? BALL : "transparent", borderWidth: stamped ? 0 : 1, borderStyle: "dashed", borderColor: d === today ? "#E8ECF4" : "rgba(255,255,255,0.22)" }}>
                  <Body size={10} weight="bold" style={{ color: stamped ? BALL_INK : "#6B7590" }}>{Number(d.slice(8))}</Body>
                </View>
              );
            })}
          </View>
          <View style={{ marginTop: "auto", flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" }}>
            <View style={{ gap: 3 }}>
              <Eyebrow size={9} style={{ color: "#9AA4B8" }}>Holder</Eyebrow>
              <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
                <Body weight="bold" style={{ color: "#E8ECF4" }}>{pass.holderName ?? "Move Score fan"}</Body>
                {pass.nationCode ? <Flag iso2={nationIso2} code={pass.nationCode} size={18} /> : null}
              </View>
              <Body size={11} style={{ color: "#9AA4B8" }}>{`No. ${String(pass.serial).padStart(6, "0")}`}</Body>
            </View>
            <View style={{ borderRadius: 8, overflow: "hidden" }}>
              <QR value={`movescore://pass/${pass.id}`} size={58} />
            </View>
          </View>
        </View>
        {onsite && (
          <View style={{ position: "absolute", right: 16, top: 150, width: 86, height: 86, borderRadius: 43, borderWidth: 3, borderColor: BALL, alignItems: "center", justifyContent: "center", transform: [{ rotate: "-14deg" }] }}>
            <Eyebrow size={10} style={{ color: BALL, textAlign: "center", letterSpacing: 0.6 }}>{`ON-SITE\n${(event.city ?? "").toUpperCase()}\n${event.days[0]?.slice(0, 4) ?? ""}`}</Eyebrow>
          </View>
        )}
        <Animated.View pointerEvents="none" style={[{ position: "absolute", left: -PASS_W, top: -PASS_H / 2, width: PASS_W * 3, height: PASS_H * 2 }, foil]}>
          <LinearGradient colors={RAINBOW} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={{ flex: 1 }} />
        </Animated.View>
        <Animated.View pointerEvents="none" style={[{ position: "absolute", left: PASS_W / 2 - 160, top: PASS_H / 3 - 160, width: 320, height: 320, borderRadius: 160, backgroundColor: "rgba(255,255,255,0.08)" }, glare]} />
      </Animated.View>
    </GestureDetector>
  );
}

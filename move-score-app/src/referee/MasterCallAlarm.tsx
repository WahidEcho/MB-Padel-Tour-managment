/**
 * A master referee's emergency call, made to feel like an incoming phone call (owner, 22 Oct
 * 2026): when a chair umpire calls for assistance, a master referee signed in on this phone
 * gets a full-screen incoming-call screen (the caller, Decline / Coming) on top of
 * whatever they are looking at, with the alarm sound looping (even with the phone on silent)
 * and the phone vibrating, until they answer Coming or Decline or the call ends. Mounted
 * once in the root layout. The lock screen and the background have the server's
 * time-sensitive push with the same alarm sound (channel `assistance_alarm`), repeated every
 * 30 seconds until answered (src/lib/referees/assistance.ts).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, AppState, Easing, Modal, Platform, Pressable, Vibration, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";
import { api } from "../api/client";
import { session } from "../state/session";
import { Body, Display, Eyebrow } from "../ui/Text";
import { Glyph } from "../ui/Glyph";
import { ct } from "./callText";

interface RingingCall {
  id: string;
  court: string;
  status: string;
  requestedBy: string;
  requestedAt: string;
  mine?: "coming" | "declined" | null;
}

const ALARM = require("../../assets/sounds/master_alarm.wav");
// Vibrate 1 s, pause 0.5 s, for as long as the call rings (Android repeats the pattern; iOS
// vibrates once per call, so the effect below repeats it).
const PATTERN = [0, 1000, 500];

function clock(fromIso: string, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - Date.parse(fromIso)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function MasterCallAlarm() {
  const staff = session.use((s) => s.staff);
  const isMaster = staff?.referee?.role === "master_referee";
  const qc = useQueryClient();
  const [active, setActive] = useState(AppState.currentState === "active");
  const [answered, setAnswered] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setActive(s === "active"));
    return () => sub.remove();
  }, []);

  // The same list as the master desk (shared cache): fast while the app is open.
  const calls = useQuery({
    queryKey: ["assistance", staff?.token],
    queryFn: () => api<{ open?: RingingCall[] }>("/api/mobile/v1/referee/assistance", { who: "staff" }),
    enabled: Boolean(isMaster),
    refetchInterval: isMaster && active ? 4_000 : false,
  });

  // A call's push arriving while the app is open: check at once instead of waiting for the poll.
  useEffect(() => {
    if (!isMaster || Platform.OS === "web") return;
    const sub = Notifications.addNotificationReceivedListener((n) => {
      const kind = (n.request.content.data as { kind?: unknown } | undefined)?.kind;
      if (kind === "assistance") void qc.invalidateQueries({ queryKey: ["assistance"] });
    });
    return () => sub.remove();
  }, [isMaster, qc]);

  const ringing = useMemo(
    () => (calls.data?.open ?? []).filter((c) => c.status === "open" && !c.mine && !answered.has(c.id)),
    [calls.data, answered],
  );
  const call = ringing[0] ?? null;
  const ringingNow = Boolean(isMaster && call && active);

  // The alarm: loops even on silent, with the phone vibrating, until answered or ended.
  const player = useRef<AudioPlayer | null>(null);
  useEffect(() => {
    if (!ringingNow) return;
    let stopped = false;
    void (async () => {
      try {
        await setAudioModeAsync({ playsInSilentMode: true, interruptionMode: "doNotMix", shouldPlayInBackground: false });
        if (stopped) return;
        const p = createAudioPlayer(ALARM);
        p.loop = true;
        p.volume = 1;
        p.play();
        player.current = p;
      } catch {
        /* no sound: the screen and the vibration still ring */
      }
    })();
    Vibration.vibrate(PATTERN, true);
    const buzz = Platform.OS === "ios" ? setInterval(() => Vibration.vibrate(), 1500) : null;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    return () => {
      stopped = true;
      if (buzz) clearInterval(buzz);
      Vibration.cancel();
      try {
        player.current?.pause();
        player.current?.remove();
      } catch {
        /* already gone */
      }
      player.current = null;
    };
  }, [ringingNow, call?.id]);

  // The ringing clock.
  useEffect(() => {
    if (!ringingNow) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ringingNow]);

  // Rings spreading from the caller's badge, and a breathing answer button: an incoming call.
  const ring = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!ringingNow) return;
    ring.setValue(0);
    const loop = Animated.loop(Animated.timing(ring, { toValue: 1, duration: 1600, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [ringingNow, ring]);
  const ringStyle = (delay: number) => {
    const v = ring.interpolate({ inputRange: [0, 1], outputRange: [delay, 1 + delay] });
    const p = Animated.modulo(v, 1);
    return { opacity: p.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }), transform: [{ scale: p.interpolate({ inputRange: [0, 1], outputRange: [1, 2.1] }) }] };
  };
  const breathe = ring.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 1.08, 1] });

  const respond = async (answer: "coming" | "declined") => {
    if (!call || busy) return;
    setBusy(true);
    setAnswered((s) => new Set(s).add(call.id));
    try {
      await api("/api/mobile/v1/referee/assistance", { who: "staff", body: { action: "respond", callId: call.id, answer } });
    } catch {
      /* the master desk still shows the call and its buttons */
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ["assistance"] });
    }
    if (answer === "coming") router.push({ pathname: "/referee/master", params: { call: call.id } });
  };

  if (!ringingNow || !call) return null;
  const round = (color: string) => ({ width: 78, height: 78, borderRadius: 39, backgroundColor: color, alignItems: "center" as const, justifyContent: "center" as const });
  return (
    <Modal visible transparent={false} animationType="slide" presentationStyle="fullScreen" statusBarTranslucent onRequestClose={() => undefined}>
      <View style={{ flex: 1, backgroundColor: "#0A0E1A", paddingHorizontal: 28, paddingTop: 84, paddingBottom: 56, justifyContent: "space-between" }} accessibilityViewIsModal>
        {/* The caller, as a phone shows an incoming call. */}
        <View style={{ alignItems: "center", gap: 8 }}>
          <Eyebrow size={12} style={{ color: "#9FB0D0", letterSpacing: 2.5 }} numberOfLines={1}>{`Move Score · ${ct("alarmTitle")}`}</Eyebrow>
          <Display size={44} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5} style={{ color: "#FFFFFF", textAlign: "center", lineHeight: 48, marginTop: 6 }}>
            {call.court}
          </Display>
          <Body size={18} style={{ color: "#E6EBF5", textAlign: "center" }} numberOfLines={2}>{call.requestedBy}</Body>
          <Body size={15} style={{ color: "#9FB0D0" }}>{ct("alarmFor", { clock: clock(call.requestedAt, now) })}</Body>
          {ringing.length > 1 ? <Body size={13} weight="semi" style={{ color: "#FFB3BF" }}>{`+${ringing.length - 1}`}</Body> : null}
        </View>

        <View style={{ alignItems: "center", justifyContent: "center", height: 220 }}>
          {[0, 0.33, 0.66].map((d) => (
            <Animated.View key={d} style={[{ position: "absolute", width: 120, height: 120, borderRadius: 60, backgroundColor: "#E0102E" }, ringStyle(d)]} />
          ))}
          <View style={{ width: 120, height: 120, borderRadius: 60, backgroundColor: "#E0102E", alignItems: "center", justifyContent: "center" }}>
            <Glyph name="phone" color="#FFFFFF" size={54} />
          </View>
        </View>

        {/* Decline on the left, answer on the right, like a phone call. */}
        <View style={{ gap: 22 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-around", alignItems: "flex-start" }}>
            <View style={{ alignItems: "center", gap: 10 }}>
              <Pressable accessibilityRole="button" accessibilityLabel={ct("decline")} disabled={busy} onPress={() => void respond("declined")} style={({ pressed }) => [round("#FF3B30"), { opacity: pressed || busy ? 0.7 : 1 }]}>
                <View style={{ transform: [{ rotate: "135deg" }] }}>
                  <Glyph name="phone" color="#FFFFFF" size={34} />
                </View>
              </Pressable>
              <Body size={15} weight="semi" style={{ color: "#FFFFFF" }}>{ct("decline")}</Body>
            </View>
            <View style={{ alignItems: "center", gap: 10 }}>
              <Animated.View style={{ transform: [{ scale: breathe }] }}>
                <Pressable accessibilityRole="button" accessibilityLabel={ct("coming")} disabled={busy} onPress={() => void respond("coming")} style={({ pressed }) => [round("#34C759"), { opacity: pressed || busy ? 0.7 : 1 }]}>
                  <Glyph name="phone" color="#FFFFFF" size={34} />
                </Pressable>
              </Animated.View>
              <Body size={15} weight="semi" style={{ color: "#FFFFFF" }}>{ct("coming")}</Body>
            </View>
          </View>
          <Body size={14} weight="semi" style={{ color: "#9FB0D0", textAlign: "center", textDecorationLine: "underline" }} onPress={() => router.push({ pathname: "/referee/master", params: { call: call.id } })}>
            {ct("alarmDesk")}
          </Body>
        </View>
      </View>
    </Modal>
  );
}

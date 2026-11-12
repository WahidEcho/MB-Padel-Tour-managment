/**
 * A player's call to court, made to feel like an incoming phone call (owner, 12 Nov 2026): when
 * the chair umpire calls the match, every player of it signed in on their phone gets a full-screen
 * incoming-call screen (the court, the match, the time left, Decline / I'm coming) over whatever
 * they are looking at, with the Move Score ringtone looping (even with the phone on silent) and the
 * phone vibrating, until they answer, are marked at the court, or the call ends. The answer shows on
 * the chair umpire's call card. Outside the app the server's alert rings with the same ringtone and
 * carries the same two buttons (callActions.ts). Mounted once in the root layout.
 *
 * Asks GET /me/calls when the app opens or comes back, when a call alert arrives, and every few
 * seconds only while a call is open: an account with nothing called costs one request per visit.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, AppState, Easing, Modal, Platform, Pressable, Vibration, View } from "react-native";
import { router } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import * as Haptics from "expo-haptics";
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";
import { api } from "../api/client";
import { session } from "../state/session";
import { Body, Display, Eyebrow } from "../ui/Text";
import { Glyph } from "../ui/Glyph";
import { useT } from "../i18n";
import { answerCall, registerPlayerCallCategory } from "./callActions";
import { registerAssistanceCategory } from "../push/assistanceActions";

export interface RingingPlayerCall {
  matchId: string;
  tournamentName: string;
  court: string | null;
  label: string | null;
  calledAt: string;
  deadlineAt: string;
  mySide: "A" | "B";
  aName: string;
  bName: string;
  myAnswer: "coming" | "declined" | null;
  present: boolean;
}

const ALARM = require("../../assets/sounds/master_alarm.wav");
const PATTERN = [0, 1000, 500];
const KINDS = new Set(["called_to_court", "call_reminder"]);

/** m:ss until the deadline, never negative; null once it has passed. */
function left(deadlineIso: string, nowMs: number): string | null {
  const s = Math.ceil((Date.parse(deadlineIso) - nowMs) / 1000);
  if (!Number.isFinite(s) || s <= 0) return null;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function PlayerCallAlarm() {
  const tr = useT();
  const signedIn = session.use((s) => Boolean(s.user));
  const qc = useQueryClient();
  const [active, setActive] = useState(AppState.currentState === "active");
  const [answered, setAnswered] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now());

  // The lock-screen buttons of a call alert (and of a master referee's call), in the app's language.
  useEffect(() => {
    void registerPlayerCallCategory();
    void registerAssistanceCategory();
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setActive(s === "active"));
    return () => sub.remove();
  }, []);

  const calls = useQuery({
    queryKey: ["my-calls"],
    queryFn: async () => (await api<{ calls?: RingingPlayerCall[] }>("/api/mobile/v1/me/calls", { who: "me" })).calls ?? [],
    enabled: signedIn && active,
    // Only while a call is open; otherwise on opening the app and on a call alert.
    refetchInterval: (q) => ((q.state.data?.length ?? 0) > 0 ? 5_000 : false),
    refetchOnMount: true,
    retry: 0,
  });

  // Back in the app: look again (the alert may have rung while it was closed).
  useEffect(() => {
    if (signedIn && active) void qc.invalidateQueries({ queryKey: ["my-calls"] });
  }, [signedIn, active, qc]);

  // A call alert arriving while the app is open: check at once.
  useEffect(() => {
    if (!signedIn || Platform.OS === "web") return;
    const sub = Notifications.addNotificationReceivedListener((n) => {
      const kind = (n.request.content.data as { kind?: unknown } | undefined)?.kind;
      if (typeof kind === "string" && KINDS.has(kind)) void qc.invalidateQueries({ queryKey: ["my-calls"] });
    });
    return () => sub.remove();
  }, [signedIn, qc]);

  const ringing = useMemo(() => (calls.data ?? []).filter((c) => !c.myAnswer && !c.present && !answered.has(c.matchId)), [calls.data, answered]);
  const call = ringing[0] ?? null;
  const ringingNow = Boolean(signedIn && call && active);

  // The ringtone: loops even on silent, with the phone vibrating, until answered or ended.
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
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
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
  }, [ringingNow, call?.matchId]);

  useEffect(() => {
    if (!ringingNow) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ringingNow]);

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
    setFailed(false);
    setAnswered((s) => new Set(s).add(call.matchId));
    const ok = await answerCall(call.matchId, answer);
    setBusy(false);
    if (!ok) setFailed(true);
    if (answer === "coming") router.push({ pathname: "/match/[id]", params: { id: call.matchId } });
  };

  if (!ringingNow || !call) return null;
  const clock = left(call.deadlineAt, now);
  const round = (color: string) => ({ width: 78, height: 78, borderRadius: 39, backgroundColor: color, alignItems: "center" as const, justifyContent: "center" as const });
  return (
    <Modal visible transparent={false} animationType="slide" presentationStyle="fullScreen" statusBarTranslucent onRequestClose={() => undefined}>
      <View style={{ flex: 1, backgroundColor: "#0A0E1A", paddingHorizontal: 28, paddingTop: 84, paddingBottom: 56, justifyContent: "space-between" }} accessibilityViewIsModal testID="player-call-alarm">
        <View style={{ alignItems: "center", gap: 8 }}>
          <Eyebrow size={12} style={{ color: "#9FB0D0", letterSpacing: 2.5 }} numberOfLines={1}>{`Move Score · ${tr("player.callRingTitle")}`}</Eyebrow>
          <Display size={40} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.5} style={{ color: "#FFFFFF", textAlign: "center", lineHeight: 46, marginTop: 6 }}>
            {call.court ? tr("player.callRingCourt", { court: call.court }) : tr("player.callRingTitle")}
          </Display>
          <Body size={18} weight="semi" style={{ color: "#E6EBF5", textAlign: "center" }} numberOfLines={2}>
            {tr("player.callRingVs", { a: call.aName, b: call.bName })}
          </Body>
          <Body size={14} style={{ color: "#9FB0D0", textAlign: "center" }} numberOfLines={2}>
            {[call.label, call.tournamentName].filter(Boolean).join(" · ")}
          </Body>
          <Body size={16} weight="bold" style={{ color: clock ? "#FCFC00" : "#FFB3BF", marginTop: 4 }}>
            {clock ? tr("player.callRingDeadline", { clock }) : tr("player.callRingLate")}
          </Body>
          {ringing.length > 1 ? <Body size={13} weight="semi" style={{ color: "#FFB3BF" }}>{`+${ringing.length - 1}`}</Body> : null}
        </View>

        <View style={{ alignItems: "center", justifyContent: "center", height: 220 }}>
          {[0, 0.33, 0.66].map((d) => (
            <Animated.View key={d} style={[{ position: "absolute", width: 120, height: 120, borderRadius: 60, backgroundColor: "#16A34A" }, ringStyle(d)]} />
          ))}
          <View style={{ width: 120, height: 120, borderRadius: 60, backgroundColor: "#16A34A", alignItems: "center", justifyContent: "center" }}>
            <Glyph name="phone" color="#FFFFFF" size={54} />
          </View>
        </View>

        <View style={{ gap: 22 }}>
          {failed ? (
            <Body size={13} style={{ color: "#FFB3BF", textAlign: "center" }} accessibilityLiveRegion="polite">
              {tr("player.callAnswerFailed")}
            </Body>
          ) : null}
          <View style={{ flexDirection: "row", justifyContent: "space-around", alignItems: "flex-start" }}>
            <View style={{ alignItems: "center", gap: 10 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={tr("player.callDecline")}
                disabled={busy}
                onPress={() => void respond("declined")}
                style={({ pressed }) => [round("#FF3B30"), { opacity: pressed || busy ? 0.7 : 1 }]}
                testID="player-call-decline"
              >
                <View style={{ transform: [{ rotate: "135deg" }] }}>
                  <Glyph name="phone" color="#FFFFFF" size={34} />
                </View>
              </Pressable>
              <Body size={15} weight="semi" style={{ color: "#FFFFFF" }}>{tr("player.callDecline")}</Body>
            </View>
            <View style={{ alignItems: "center", gap: 10 }}>
              <Animated.View style={{ transform: [{ scale: breathe }] }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={tr("player.callComing")}
                  disabled={busy}
                  onPress={() => void respond("coming")}
                  style={({ pressed }) => [round("#34C759"), { opacity: pressed || busy ? 0.7 : 1 }]}
                  testID="player-call-coming"
                >
                  <Glyph name="phone" color="#FFFFFF" size={34} />
                </Pressable>
              </Animated.View>
              <Body size={15} weight="semi" style={{ color: "#FFFFFF" }}>{tr("player.callComing")}</Body>
            </View>
          </View>
          <Body
            size={14}
            weight="semi"
            style={{ color: "#9FB0D0", textAlign: "center", textDecorationLine: "underline" }}
            onPress={() => {
              setAnswered((s) => new Set(s).add(call.matchId));
              router.push({ pathname: "/match/[id]", params: { id: call.matchId } });
            }}
          >
            {tr("player.callOpenMatch")}
          </Body>
        </View>
      </View>
    </Modal>
  );
}

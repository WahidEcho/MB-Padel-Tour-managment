import { useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { captureRef } from "react-native-view-shot";
import * as Sharing from "expo-sharing";
import { useQuery } from "@tanstack/react-query";
import { isDoneStatus, isLiveStatus, type MPass } from "@core";
import { api } from "../../api/client";
import { isOffline, useBundle, useConfig, useLive, useMatch } from "../../api/queries";
import { isAwaitingResult, makeView, whenIn } from "../../api/model";
import { useFeaturedGroup } from "../../api/featured";
import { BALL } from "../../theme/palette";
import { F } from "../../theme/type";
import { Body, Eyebrow, Num } from "../../ui/Text";
import { Button, Flag } from "../../ui/Bits";
import { config } from "../../config";

const W = 270;
const H = 480;

function Story({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ width: W, height: H, borderRadius: 22, overflow: "hidden", backgroundColor: "#000" }}>
      <LinearGradient colors={["#0a1438", "#01041A", "#000000"]} style={StyleSheet.absoluteFill} />
      <View style={{ position: "absolute", top: -60, left: 40, width: 180, height: 380, borderBottomLeftRadius: 90, borderBottomRightRadius: 90, backgroundColor: "rgba(252,252,0,0.18)" }} />
      <View style={{ position: "absolute", top: -40, right: -60, width: 160, height: 340, borderBottomLeftRadius: 80, borderBottomRightRadius: 80, backgroundColor: "rgba(30,107,255,0.25)" }} />
      <View style={{ flex: 1, padding: 18 }}>{children}</View>
    </View>
  );
}

function MatchStory({ id }: { id: string }) {
  const q = useMatch(id);
  const b = useBundle(q.data?.tournamentSlug);
  const l = useLive(q.data?.tournamentSlug, 20_000);
  if (!q.data || !b.data) {
    const failed = q.isError ? q : b.isError ? b : null;
    if (!failed) return <Story><Body style={{ color: "#9AA4B8" }}>Loading…</Body></Story>;
    const offline = isOffline(failed.error);
    return (
      <Story>
        <View style={{ flex: 1, justifyContent: "center", gap: 10 }}>
          <Body weight="bold" style={{ color: "#E8ECF4" }}>{offline ? "You're offline" : "This match is not available"}</Body>
          <Body size={13} style={{ color: "#9AA4B8" }}>{offline ? "The card needs the latest score. Check your connection and try again." : "It may have been removed from the order of play."}</Body>
          {offline ? (
            <Pressable accessibilityRole="button" onPress={() => void Promise.all([q.refetch(), b.refetch()])} style={{ alignSelf: "flex-start", marginTop: 6, backgroundColor: BALL, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 10 }}>
              <Body weight="bold" style={{ color: "#01041A" }}>Retry</Body>
            </Pressable>
          ) : null}
        </View>
      </Story>
    );
  }
  const v = makeView(b.data, l.data);
  const m = q.data.match;
  const tie = v.tieOf(m);
  const done = isDoneStatus(m.status);
  const tieWon = tie?.status === "completed" && tie.winner === m.winner;
  // Only a match on court is "live now"; an upcoming one says so instead.
  const big = done
    ? tieWon
      ? "Tie\nwon"
      : m.tieId
        ? "Rubber\nwon"
        : "Match\nwon"
    : isAwaitingResult(m)
      ? "Match\nover"
      : isLiveStatus(m.status)
        ? "Live\nnow"
        : m.status === "cancelled"
          ? "Not\nplayed"
          : "Coming\nup";
  const line = (side: "A" | "B") => {
    const team = v.team(side === "A" ? m.a : m.b);
    const won = done && m.winner === (side === "A" ? m.a : m.b);
    return (
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flex: 1 }}>
          <Flag iso2={team?.iso2} code={team?.code} size={22} />
          <Body weight="bold" size={14} numberOfLines={1} style={{ color: won ? BALL : "#E8ECF4", flexShrink: 1 }}>{v.sideLabel(m, side, true)}</Body>
        </View>
        <Num size={24} style={{ color: "#E8ECF4", letterSpacing: 2 }}>{(m.score?.sets ?? []).map((s) => (side === "A" ? s.a : s.b)).join(" ")}{m.score?.games ? ` ${side === "A" ? m.score.games.a : m.score.games.b}` : ""}</Num>
      </View>
    );
  };
  return (
    <Story>
      <Image source={require("../../../assets/brand/movescore-wordmark.png")} style={{ height: 10, width: 10 * (997 / 74) }} contentFit="contain" />
      <Eyebrow size={9} style={{ color: "#9AA4B8", marginTop: 26, letterSpacing: 2 }}>{[b.data.tournament.name, m.round].filter(Boolean).join(" · ").toUpperCase()}</Eyebrow>
      <View style={{ gap: 10, marginTop: 14 }}>
        {line("A")}
        {line("B")}
      </View>
      {tie && <Body size={12} style={{ color: "#9AA4B8", marginTop: 10 }}>{`${v.team(tie.a)?.code} ${tie.rubbersA}–${tie.rubbersB} ${v.team(tie.b)?.code} in the tie`}</Body>}
      {(m.status === "scheduled" || m.status === "ready") && m.scheduledTime ? (
        <Body size={12} style={{ color: "#9AA4B8", marginTop: 6 }}>{[whenIn(m.scheduledTime, b.data.tournament.timezone, true), v.court(m.courtId)].filter(Boolean).join(" · ")}</Body>
      ) : null}
      <View style={{ marginTop: "auto" }}>
        <Body style={{ fontFamily: F.display, fontSize: 44, lineHeight: 40, color: BALL, textTransform: "uppercase" }}>{big}</Body>
        <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 12 }}>
          <Eyebrow size={9} style={{ color: "#9AA4B8" }}>{[b.data.tournament.city, new Date().getFullYear()].filter(Boolean).join(" · ")}</Eyebrow>
          <Eyebrow size={9} style={{ color: "#9AA4B8" }}>I WAS THERE</Eyebrow>
        </View>
      </View>
    </Story>
  );
}

function PassStory() {
  const group = useFeaturedGroup();
  const q = useQuery({ queryKey: ["pass", group?.id], queryFn: () => api<{ pass: MPass | null }>(`/api/mobile/v1/me/pass?group=${group!.id}`, { who: "me" }), enabled: Boolean(group) });
  const p = q.data?.pass;
  return (
    <Story>
      <Image source={require("../../../assets/brand/movescore-wordmark.png")} style={{ height: 10, width: 10 * (997 / 74) }} contentFit="contain" />
      <Eyebrow size={9} style={{ color: "#9AA4B8", marginTop: 26, letterSpacing: 2 }}>{p?.edition === "staff" ? "ACCREDITED" : p?.onsiteUnlockedAt ? "ON-SITE PASS" : "EVENT PASS"}</Eyebrow>
      <Body style={{ fontFamily: F.display, fontSize: 26, lineHeight: 26, color: "#E8ECF4", textTransform: "uppercase", marginTop: 10 }}>{group?.name ?? ""}</Body>
      <Body size={12} style={{ color: "#9AA4B8", marginTop: 8 }}>{[group?.venue, group?.city].filter(Boolean).join(" · ")}</Body>
      <View style={{ marginTop: "auto" }}>
        <Body style={{ fontFamily: F.display, fontSize: 40, lineHeight: 38, color: BALL, textTransform: "uppercase" }}>{p?.onsiteUnlockedAt ? `${p.stamps.length} ${p.stamps.length === 1 ? "day" : "days"}\non-site` : "I'm\nfollowing"}</Body>
        <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 12 }}>
          <Eyebrow size={9} style={{ color: "#9AA4B8" }}>{`No. ${String(p?.serial ?? 0).padStart(6, "0")}`}</Eyebrow>
          <Eyebrow size={9} style={{ color: "#9AA4B8" }}>{p?.holderName ?? ""}</Eyebrow>
        </View>
      </View>
    </Story>
  );
}

/** A branded 9:16 card for Stories and messages. */
export default function Share() {
  const { matchId } = useLocalSearchParams<{ matchId: string }>();
  const cfg = useConfig();
  const ref = useRef<View>(null);
  const [busy, setBusy] = useState(false);
  const capture = async () => captureRef(ref, { format: "png", quality: 1, width: 1080, height: 1920, result: "tmpfile" });
  const toStories = async () => {
    setBusy(true);
    try {
      const uri = await capture();
      if (Platform.OS !== "web" && config.metaAppId && cfg.data?.flags.share_stories !== false) {
        const mod = await import("react-native-share");
        await mod.default.shareSingle({ social: mod.Social.InstagramStories, appId: config.metaAppId, backgroundImage: uri, backgroundBottomColor: "#000000", backgroundTopColor: "#0a1438" });
      } else {
        await Sharing.shareAsync(uri, { mimeType: "image/png" });
      }
    } catch {
      /* the person closed the sheet */
    } finally {
      setBusy(false);
    }
  };
  const toAnywhere = async () => {
    setBusy(true);
    try {
      await Sharing.shareAsync(await capture(), { mimeType: "image/png", dialogTitle: "Share" });
    } catch {
      /* closed */
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ flex: 1, backgroundColor: "rgba(0,0,8,0.82)", alignItems: "center", justifyContent: "center", gap: 22 }}>
      <Pressable style={StyleSheet.absoluteFill} onPress={() => router.back()} accessibilityLabel="Close" />
      <View ref={ref} collapsable={false}>
        {matchId === "pass" ? <PassStory /> : <MatchStory id={matchId} />}
      </View>
      <View style={{ flexDirection: "row", gap: 8, width: W + 30 }}>
        <Button kind="ghost" label="Share…" onPress={() => void toAnywhere()} disabled={busy} style={{ flex: 1, backgroundColor: "rgba(255,255,255,0.08)" }} />
        <Button label="To Stories" onPress={() => void toStories()} disabled={busy} style={{ flex: 1 }} />
      </View>
    </View>
  );
}

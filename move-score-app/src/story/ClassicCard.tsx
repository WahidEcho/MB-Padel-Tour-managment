/** The branded 9:16 card without a photo ("Share without photo"): the original share card. */
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { BALL } from "../theme/palette";
import { F } from "../theme/type";
import { Body, Eyebrow, Num } from "../ui/Text";
import { Flag } from "../ui/Bits";
import { LoadState } from "../ui/LoadState";
import { SchemeScope } from "../theme/ThemeProvider";
import type { StoryInfo } from "./model";

export const CARD_W = 270;
export const CARD_H = 480;

function Frame({ children }: { children: ReactNode }) {
  return (
    <View style={{ width: CARD_W, height: CARD_H, borderRadius: 22, overflow: "hidden", backgroundColor: "#000" }}>
      <LinearGradient colors={["#0a1438", "#01041A", "#000000"]} style={StyleSheet.absoluteFill} />
      <View style={{ position: "absolute", top: -60, left: 40, width: 180, height: 380, borderBottomLeftRadius: 90, borderBottomRightRadius: 90, backgroundColor: "rgba(252,252,0,0.18)" }} />
      <View style={{ position: "absolute", top: -40, right: -60, width: 160, height: 340, borderBottomLeftRadius: 80, borderBottomRightRadius: 80, backgroundColor: "rgba(30,107,255,0.25)" }} />
      <View style={{ flex: 1, padding: 18 }}>{children}</View>
    </View>
  );
}

const Wordmark = () => <Image source={require("../../assets/brand/movescore-wordmark.png")} style={{ height: 10, width: 10 * (997 / 74) }} contentFit="contain" accessibilityLabel="Move Score" />;

export function ClassicCard({ info, problem, onRetry }: { info: StoryInfo | null; problem: "offline" | "gone" | null; onRetry: () => void }) {
  if (!info) {
    // The card is dark whatever the theme, so the shared load state is drawn dark too.
    return (
      <Frame>
        <SchemeScope scheme="dark">
          <View style={{ flex: 1, justifyContent: "center" }}>
            <LoadState
              compact
              kind={problem === "offline" ? "offline" : problem === "gone" ? "notFound" : "loading"}
              onRetry={onRetry}
              what="the latest score"
              notFound={
                <View style={{ gap: 10 }}>
                  <Body weight="bold" style={{ color: "#E8ECF4" }}>This is not available</Body>
                  <Body size={13} style={{ color: "#9AA4B8" }}>It may have been removed from the order of play.</Body>
                </View>
              }
            />
          </View>
        </SchemeScope>
      </Frame>
    );
  }
  if (info.kind === "pass") {
    return (
      <Frame>
        <Wordmark />
        <Eyebrow size={9} style={{ color: "#9AA4B8", marginTop: 26, letterSpacing: 2 }}>{(info.round ?? "Event pass").toUpperCase()}</Eyebrow>
        <Body style={{ fontFamily: F.display, fontSize: 26, lineHeight: 26, color: "#E8ECF4", textTransform: "uppercase", marginTop: 10 }}>{info.event}</Body>
        {info.place ? <Body size={12} style={{ color: "#9AA4B8", marginTop: 8 }}>{info.place}</Body> : null}
        <View style={{ marginTop: "auto" }}>
          <Body style={{ fontFamily: F.display, fontSize: 40, lineHeight: 38, color: BALL, textTransform: "uppercase" }}>{info.note ? info.note.replace(" on-site", "\non-site") : info.headline.join("\n")}</Body>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 12 }}>
            <Eyebrow size={9} style={{ color: "#9AA4B8" }}>{info.serial}</Eyebrow>
            <Eyebrow size={9} style={{ color: "#9AA4B8" }}>{info.holder ?? ""}</Eyebrow>
          </View>
        </View>
      </Frame>
    );
  }
  return (
    <Frame>
      <Wordmark />
      <Eyebrow size={9} style={{ color: "#9AA4B8", marginTop: 26, letterSpacing: 2 }}>{[info.event, info.round].filter(Boolean).join(" · ").toUpperCase()}</Eyebrow>
      <View style={{ gap: 10, marginTop: 14 }}>
        {(info.sides ?? []).map((s) => (
          <View key={s.code + s.label} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flex: 1 }}>
              <Flag iso2={s.iso2} code={s.code} size={22} />
              <Body weight="bold" size={14} numberOfLines={1} style={{ color: s.won ? BALL : "#E8ECF4", flexShrink: 1 }}>{s.label}</Body>
            </View>
            <Num size={24} style={{ color: "#E8ECF4", letterSpacing: 2 }}>{[...s.sets, ...(s.games === null ? [] : [s.games])].join(" ")}</Num>
          </View>
        ))}
      </View>
      {info.kind === "match" && info.note ? <Body size={12} style={{ color: "#9AA4B8", marginTop: 10 }}>{info.note}</Body> : null}
      {info.when ? <Body size={12} style={{ color: "#9AA4B8", marginTop: 6 }}>{[info.when, info.place].filter(Boolean).join(" · ")}</Body> : null}
      <View style={{ marginTop: "auto" }}>
        <Body style={{ fontFamily: F.display, fontSize: 44, lineHeight: 40, color: BALL, textTransform: "uppercase" }}>{info.headline.join("\n")}</Body>
        <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 12 }}>
          <Eyebrow size={9} style={{ color: "#9AA4B8" }}>{[info.city, new Date().getFullYear()].filter(Boolean).join(" · ")}</Eyebrow>
          <Eyebrow size={9} style={{ color: "#9AA4B8" }}>I WAS THERE</Eyebrow>
        </View>
      </View>
    </Frame>
  );
}

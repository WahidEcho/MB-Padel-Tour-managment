/**
 * The first time someone opens a live match on an iPhone that can show lock-screen
 * cards, a short guide shows what "Show on lock screen" does: a picture of the lock
 * screen with this match's card, drawn from the match itself, and the choice to
 * show it now. Shown once per phone (`ms.lockGuideSeen`).
 */
import { Image, Modal, View } from "react-native";
import { liveState, type MMatch } from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Display, Eyebrow } from "../ui/Text";
import { Button } from "../ui/Bits";
import { useT } from "../i18n";
import { getJson, setJson } from "../state/kv";

const SEEN = "ms.lockGuideSeen";
const ICON = require("../../assets/brand/icon.png");
const BALL = "#FCFC00";

export const lockGuideSeen = () => getJson<boolean>(SEEN, false);
export const markLockGuideSeen = () => setJson(SEEN, true);

/** The match's lock-screen card, as the phone will show it. */
function CardPreview({ m, a, b, court }: { m: MMatch; a: string; b: string; court: string }) {
  const s = liveState(m.score, { a, b, court, status: "Live" });
  const sets = s.sets.split(" ").filter(Boolean);
  const pts = s.points.split("-");
  const row = (name: string, side: "A" | "B", i: 0 | 1) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: s.serving === side ? BALL : "transparent" }} />
      <Body weight="bold" size={15} style={{ color: "#fff", flex: 1 }} numberOfLines={1}>{name}</Body>
      {sets.map((x, k) => (
        <Body key={k} size={15} weight="semi" style={{ color: "rgba(255,255,255,0.75)", width: 18, textAlign: "center" }}>{x.split("-")[i]}</Body>
      ))}
      <View style={{ minWidth: 34, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 7, backgroundColor: "rgba(255,255,255,0.14)", alignItems: "center" }}>
        <Body weight="bold" size={15} style={{ color: BALL }}>{pts[i] ?? ""}</Body>
      </View>
    </View>
  );
  return (
    <View style={{ backgroundColor: "rgba(20,24,36,0.92)", borderRadius: 22, padding: 14, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Image source={ICON} style={{ width: 20, height: 20, borderRadius: 5 }} />
        <Eyebrow size={10} style={{ color: "rgba(255,255,255,0.7)", flex: 1 }} numberOfLines={1}>{court ? `Move Score · ${court}` : "Move Score"}</Eyebrow>
        <Eyebrow size={10} style={{ color: "#FF5A6E" }}>● LIVE</Eyebrow>
      </View>
      {row(a, "A", 0)}
      {row(b, "B", 1)}
    </View>
  );
}

export function LockScreenGuide({ m, a, b, court, onShow, onClose }: { m: MMatch; a: string; b: string; court: string; onShow: () => void; onClose: () => void }) {
  const { t } = useTheme();
  const tr = useT();
  const done = (show: boolean) => {
    markLockGuideSeen();
    if (show) onShow();
    onClose();
  };
  return (
    <Modal transparent animationType="slide" visible onRequestClose={() => done(false)}>
      <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.55)" }}>
        <View accessibilityViewIsModal style={{ backgroundColor: t.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40, gap: 14 }}>
          {/* A lock screen with this match's card on it. */}
          <View style={{ alignSelf: "center", width: 280, borderRadius: 34, padding: 14, paddingTop: 12, backgroundColor: "#0B1640", overflow: "hidden" }}>
            <View style={{ alignSelf: "center", width: 96, height: 26, borderRadius: 14, backgroundColor: "#000", flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 9 }}>
              <Image source={ICON} style={{ width: 14, height: 14, borderRadius: 4 }} />
              <Body size={11} weight="bold" style={{ color: BALL }}>{(liveState(m.score, { a, b, court, status: "Live" }).points || "0-0").replace("-", " – ")}</Body>
            </View>
            <Display size={46} style={{ color: "#fff", textAlign: "center", marginTop: 10, lineHeight: 50 }}>9:41</Display>
            <View style={{ marginTop: 14 }}>
              <CardPreview m={m} a={a} b={b} court={court} />
            </View>
          </View>
          <Display size={24}>{tr("screens.lockGuideTitle")}</Display>
          <Body tone="ink2">{tr("screens.lockGuideBody")}</Body>
          <Body tone="ink3" size={13}>{tr("screens.lockGuideFollow")}</Body>
          <Button label={tr("screens.lockGuideYes")} onPress={() => done(true)} />
          <Button kind="ghost" label={tr("account.notNow")} onPress={() => done(false)} />
        </View>
      </View>
    </Modal>
  );
}

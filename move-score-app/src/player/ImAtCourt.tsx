/**
 * "I'm at court" on the player's own called match (match screen, and the live
 * courts hero's called card). One big button while the player's side is not
 * marked; then a calm confirmation. The countdown is the call's own deadline.
 */
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import * as Haptics from "expo-haptics";
import { callClock } from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Eyebrow, Num } from "../ui/Text";
import { Button, Card } from "../ui/Bits";
import { markHere, useMyCall } from "./here";
import { useT } from "../i18n";

function useTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

/** The card on the match screen: shown only for the player's own match while it is called. */
export function ImAtCourtCard({ matchId, waiting, sideNames }: { matchId: string; waiting: boolean; sideNames: { A: string; B: string } }) {
  const { t } = useTheme();
  const tr = useT();
  const q = useMyCall(matchId, waiting);
  const c = q.data?.call;
  const open = waiting && c?.status === "called";
  const now = useTick(open);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!open || !q.data || !c) return null;
  const mine = q.data.side;
  const here = mine === "A" ? c.presentA : c.presentB;
  const other: "A" | "B" = mine === "A" ? "B" : "A";
  const otherHere = other === "A" ? c.presentA : c.presentB;
  const left = Date.parse(c.deadlineAt) - now;
  const due = left <= 0;
  const press = async () => {
    setBusy(true);
    setErr(null);
    try {
      await markHere(matchId);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (e) {
      setErr(e instanceof Error ? e.message : tr("player.tryAgain"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card style={{ marginTop: 4, gap: 10, borderWidth: 1, borderColor: here ? t.success : due ? t.live : t.ball }}>
      <View
        accessible
        accessibilityLabel={[tr("player.calledA11y"), due ? tr("player.deadlinePassed") : tr("player.timeLeft", { time: callClock(left) }), here ? tr("player.markedA11y") : ""].filter(Boolean).join(" ")}
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
      >
        <View style={{ gap: 2, flex: 1 }}>
          <Eyebrow size={10.5} tone={due ? "live" : "ink"}>{tr("player.calledToCourt")}</Eyebrow>
          <Body tone="ink2" size={12.5}>{due ? tr("player.deadlineNow") : tr("player.getToCourt")}</Body>
        </View>
        <Num size={34} tone={due ? "live" : "ink"}>{callClock(left)}</Num>
      </View>
      {here ? (
        <Body weight="semi" style={{ color: t.success }} accessibilityLiveRegion="polite">
          {`✓ ${tr("player.marked")}`}
        </Body>
      ) : q.data.imAtCourt ? (
        <Button label={busy ? tr("player.telling") : tr("player.imAtCourt")} disabled={busy} onPress={() => void press()} accessibilityHint={tr("player.imAtCourtHint")} />
      ) : (
        <Body tone="ink2" size={13}>{tr("player.tellReferee")}</Body>
      )}
      <Body tone="ink3" size={12}>{`${sideNames[other]}: ${otherHere ? tr("player.atCourt") : tr("player.notHereYet")}`}</Body>
      {err ? (
        <Body tone="live" size={13} accessibilityLiveRegion="polite">
          {err}
        </Body>
      ) : null}
    </Card>
  );
}

/** The compact button on the live courts hero's called card (the card itself opens the match). */
export function ImAtCourtPill({ matchId }: { matchId: string }) {
  const { t } = useTheme();
  const tr = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={tr("player.imAtCourt")}
      accessibilityHint={err ?? tr("player.imAtCourtHint")}
      hitSlop={10}
      disabled={busy}
      onPress={() => {
        setBusy(true);
        setErr(null);
        void markHere(matchId)
          .then(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}))
          .catch((e: unknown) => setErr(e instanceof Error ? e.message : tr("player.tryAgain")))
          .finally(() => setBusy(false));
      }}
      style={({ pressed }) => ({ minHeight: 34, paddingHorizontal: 12, borderRadius: 999, alignItems: "center", justifyContent: "center", backgroundColor: err ? t.liveFill : t.btnBg, opacity: busy ? 0.6 : pressed ? 0.85 : 1 })}
    >
      <Eyebrow size={10.5} style={{ color: err ? "#FFFFFF" : t.btnInk }}>{busy ? tr("auth.sending") : err ? tr("common.retry") : tr("player.imAtCourt")}</Eyebrow>
    </Pressable>
  );
}

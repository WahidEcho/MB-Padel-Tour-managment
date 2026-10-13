/**
 * The referee's call card (plan Phase 5), above the console until the match
 * starts: "Call to court", the countdown to the deadline, who is at the court
 * (marked by the referee, by the player's own "I'm at court", or by the QR
 * check-in), and once the deadline passes with a side missing, the no-show
 * question (NoShowSheet). Same model as the web console (callCardModel).
 */
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import type { NoShowOption, TeamKey } from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Eyebrow, Num } from "../ui/Text";
import { Button, Card } from "../ui/Bits";
import { Sheet } from "./Sheet";
import type { CallControls } from "./useCall";

function spoken(countdown: string): string {
  const [m, s] = countdown.split(":").map(Number);
  return `${m} minute${m === 1 ? "" : "s"} ${s} second${s === 1 ? "" : "s"} left`;
}

export function CallCard({ c, readOnly }: { c: CallControls; readOnly: boolean }) {
  const { t, calm } = useTheme();
  const m = c.model;
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  // The no-show question opens on its own once per deadline; closing it keeps a button to reopen it.
  const askedFor = useRef<string | null>(null);
  const deadline = c.call?.deadlineAt ?? null;
  const asking = Boolean(m.noShow?.length) && !readOnly;
  useEffect(() => {
    if (!asking || !deadline || askedFor.current === deadline) return;
    askedFor.current = deadline;
    setSheetOpen(true);
  }, [asking, deadline]);
  useEffect(() => {
    if (!asking) setSheetOpen(false);
  }, [asking]);

  if (!m.show) return null;
  const busy = c.busy !== null;
  const border = m.urgent ? t.live : m.phase === "all_present" ? t.success : t.line;
  const summary = [m.title, m.countdown ? spoken(m.countdown) : null, ...m.sides.map((s) => `${s.name}: ${s.present ? "at the court" : "not here yet"}`)].filter(Boolean).join(". ");

  return (
    <Animated.View entering={calm ? undefined : FadeIn.duration(220)}>
      <Card style={{ marginTop: 10, gap: 10, borderColor: border, borderWidth: 1 }}>
        <View accessible accessibilityLabel={summary} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Eyebrow size={10.5} tone={m.urgent ? "live" : "ink2"}>{m.title}</Eyebrow>
            {m.detail ? <Body tone="ink2" size={12.5}>{m.detail}</Body> : null}
          </View>
          {m.countdown ? (
            <Num size={36} tone={m.urgent ? "live" : "ink"}>
              {m.countdown}
            </Num>
          ) : null}
        </View>

        {m.phase !== "not_called" &&
          m.sides.map((s) => (
            <View key={s.key} style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 }}>
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: s.present ? t.success : t.ink3 }} />
              <Body weight="semi" size={15} numberOfLines={1} style={{ flex: 1 }}>
                {s.name}
              </Body>
              {s.present ? (
                <Eyebrow size={10.5} style={{ color: t.success }}>✓ At court</Eyebrow>
              ) : s.canMark && !readOnly ? (
                <Button kind="ghost" label={c.busy === "present" ? "…" : "Mark here"} disabled={busy} onPress={() => void c.present(s.key as TeamKey)} style={{ minWidth: 112, paddingVertical: 10 }} />
              ) : (
                <Eyebrow size={10.5} tone="ink3">Not here</Eyebrow>
              )}
            </View>
          ))}

        {c.error ? (
          <Body tone="live" size={12.5} accessibilityLiveRegion="polite" onPress={c.clearError}>
            {c.error}
          </Body>
        ) : null}

        {!readOnly && m.canCall && !c.courtBusy ? <Button label={c.busy === "call" ? "Calling…" : "Call to court"} disabled={busy} onPress={() => void c.callNow()} /> : null}
        {!readOnly && c.courtBusy ? (
          <View style={{ gap: 8 }} accessibilityLiveRegion="polite">
            <Body tone="live" size={13}>{c.courtBusy}</Body>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button kind="ghost" label="Not now" onPress={c.clearError} style={{ flex: 1 }} />
              <Button kind="danger" label="Call anyway" disabled={busy} onPress={() => void c.callNow(true)} style={{ flex: 1 }} />
            </View>
          </View>
        ) : null}

        {!readOnly && asking && !sheetOpen ? <Button kind="danger" label="Answer the no-show" onPress={() => setSheetOpen(true)} /> : null}

        {!readOnly && m.canCancel ? (
          confirmCancel ? (
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button kind="ghost" label="Keep the call" onPress={() => setConfirmCancel(false)} style={{ flex: 1 }} />
              <Button
                kind="danger"
                label={c.busy === "cancel" ? "Withdrawing…" : "Withdraw it"}
                disabled={busy}
                onPress={() => void c.cancel().then(() => setConfirmCancel(false))}
                style={{ flex: 1 }}
              />
            </View>
          ) : (
            <Body tone="blue" weight="semi" size={13} accessibilityRole="button" accessibilityHint="Asks before the call is withdrawn" onPress={() => setConfirmCancel(true)} style={{ paddingVertical: 8 }}>
              Wrong match? Withdraw the call
            </Body>
          )
        ) : null}
      </Card>
      <NoShowSheet open={sheetOpen && asking} c={c} onClose={() => setSheetOpen(false)} />
    </Animated.View>
  );
}

/**
 * The no-show question at the deadline: keep waiting, +N min (up to the maximum),
 * or the walkover to the side that is here. Both sides absent never offers a
 * walkover. Anything that ends the match is asked a second time.
 */
export function NoShowSheet({ open, c, onClose }: { open: boolean; c: CallControls; onClose: () => void }) {
  const m = c.model;
  const [confirming, setConfirming] = useState<NoShowOption | null>(null);
  const busy = c.busy !== null;
  const close = () => {
    setConfirming(null);
    onClose();
  };
  const pick = async (o: NoShowOption) => {
    if (o.danger && confirming?.choice !== o.choice) {
      setConfirming(o);
      return;
    }
    const r = o.choice === "extend" ? await c.extend() : await c.answer(o.choice);
    if (r) close();
  };
  const absent = m.sides.filter((s) => !s.present);
  return (
    <Sheet open={open} onClose={close} title={m.title || "No-show"}>
      {confirming ? (
        <>
          <Body size={17} weight="semi">{confirming.confirm}</Body>
          {c.error ? <Body tone="live" size={13}>{c.error}</Body> : null}
          <Button kind="danger" label={busy ? "Recording…" : "Yes, record it"} disabled={busy} onPress={() => void pick(confirming)} />
          <Button kind="ghost" label="Back" disabled={busy} onPress={() => setConfirming(null)} />
        </>
      ) : (
        <>
          <Body tone="ink2" size={13.5}>{m.detail}</Body>
          {absent.map((s) =>
            s.canMark ? (
              <Button key={s.key} kind="ghost" label={`${s.name} is here now`} disabled={busy} onPress={() => void c.present(s.key).then((r) => r && close())} />
            ) : null,
          )}
          {(m.noShow ?? []).map((o) => (
            <View key={o.choice} style={{ gap: 4 }}>
              <Button kind={o.danger ? "danger" : o.choice === "extend" ? "primary" : "ghost"} label={o.label} disabled={busy} onPress={() => void pick(o)} />
              <Body tone="ink3" size={12}>{o.detail}</Body>
            </View>
          ))}
          {c.error ? <Body tone="live" size={13}>{c.error}</Body> : null}
        </>
      )}
    </Sheet>
  );
}

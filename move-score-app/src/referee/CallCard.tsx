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
import type { CallCardModel, NoShowOption, TeamKey } from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Eyebrow, Num } from "../ui/Text";
import { Button, Card } from "../ui/Bits";
import { Sheet } from "./Sheet";
import type { CallControls } from "./useCall";
import { tr as trNow, useT } from "../i18n";

function spoken(countdown: string): string {
  const [m, s] = countdown.split(":").map(Number);
  return trNow("referee.spokenLeft", { minutes: trNow("referee.minutesWord", { count: m }), seconds: trNow("referee.secondsWord", { count: s }) });
}

/**
 * The card's headline, detail and no-show answers in the app's language. The shared
 * model (callCardModel, also the web console's) writes them in English; the phase, the
 * view and the rules say everything needed to say them again here.
 */
function localModel(c: CallControls): Pick<CallCardModel, "title" | "detail" | "noShow"> {
  const m = c.model;
  const names = { A: m.sides.find((s) => s.key === "A")?.name ?? trNow("referee.sideA"), B: m.sides.find((s) => s.key === "B")?.name ?? trNow("referee.sideB") };
  const and = ` ${trNow("common.and")} `;
  const v = m.view;
  if (!m.show) return m;
  if (m.phase === "not_called" || !v) {
    const before = c.call?.status === "cancelled" ? `${trNow("referee.withdrawnBefore")} ` : "";
    return {
      title: trNow("referee.notCalledTitle"),
      detail: `${before}${m.canCall ? trNow("referee.callGives", { count: c.rules.courtCall.minutes }) : trNow("referee.needCourt")}`,
      noShow: m.noShow,
    };
  }
  const missing = v.absent.map((k) => names[k]);
  switch (v.phase) {
    case "all_present":
      return { title: trNow("referee.bothHere"), detail: trNow("referee.startWhenReady"), noShow: m.noShow };
    case "called":
    case "reminder":
      return {
        title: v.phase === "reminder" ? trNow("referee.calledReminder") : trNow("referee.calledToCourt"),
        detail: missing.length ? trNow("referee.waitingFor", { names: missing.join(and) }) : "",
        noShow: m.noShow,
      };
    case "overdue":
      return { title: trNow("referee.deadlinePassed"), detail: trNow("referee.notAtCourtYet", { names: missing.join(and) }), noShow: m.noShow };
    case "no_show": {
      const both = v.prompt?.kind === "both_absent";
      return {
        title: both ? trNow("referee.neitherHere") : trNow("referee.isNotHere", { name: missing[0] ?? "" }),
        detail: both
          ? v.actions.includes("both_no_show")
            ? trNow("referee.detBothRecord")
            : trNow("referee.detBothNoWalkover")
          : v.canExtend
            ? trNow("referee.detExtend")
            : trNow("referee.detNoMoreExt"),
        noShow: (m.noShow ?? []).map((o) => localOption(o, names, c.rules.noShow.extensionMinutes, v.extensionsLeft)),
      };
    }
    default:
      return m;
  }
}

function localOption(o: NoShowOption, names: Record<TeamKey, string>, minutes: number, left: number): NoShowOption {
  switch (o.choice) {
    case "wait":
      return { ...o, label: trNow("referee.keepWaiting"), detail: trNow("referee.keepWaitingDetail") };
    case "extend":
      return { ...o, label: trNow("referee.extendLabel", { n: minutes }), detail: trNow("referee.extendDetail", { count: left }) };
    case "walkover_to_a":
    case "walkover_to_b": {
      const winner = o.choice === "walkover_to_a" ? names.A : names.B;
      const loser = o.choice === "walkover_to_a" ? names.B : names.A;
      return {
        ...o,
        label: trNow("referee.walkoverTo", { name: winner }),
        detail: trNow("referee.walkoverDetail", { winner, loser }),
        confirm: trNow("referee.walkoverConfirm", { winner }),
      };
    }
    case "both_no_show":
      return { ...o, label: trNow("referee.neitherCame"), detail: trNow("referee.neitherDetail"), confirm: trNow("referee.neitherConfirm") };
    default:
      return o;
  }
}

export function CallCard({ c, readOnly }: { c: CallControls; readOnly: boolean }) {
  const { t, calm } = useTheme();
  const tr = useT();
  const m = { ...c.model, ...localModel(c) };
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
  const summary = [m.title, m.countdown ? spoken(m.countdown) : null, ...m.sides.map((s) => (s.present ? tr("referee.sideAtCourt", { name: s.name }) : tr("referee.sideNotYet", { name: s.name })))].filter(Boolean).join(". ");

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
                <Eyebrow size={10.5} style={{ color: t.success }}>{tr("referee.atCourt")}</Eyebrow>
              ) : s.canMark && !readOnly ? (
                <Button kind="ghost" label={c.busy === "present" ? "…" : tr("referee.markHere")} disabled={busy} onPress={() => void c.present(s.key as TeamKey)} style={{ minWidth: 112, paddingVertical: 10 }} />
              ) : (
                <Eyebrow size={10.5} tone="ink3">{tr("referee.notHere")}</Eyebrow>
              )}
            </View>
          ))}

        {c.error ? (
          <Body tone="live" size={12.5} accessibilityLiveRegion="polite" onPress={c.clearError}>
            {c.error}
          </Body>
        ) : null}

        {!readOnly && m.canCall && !c.courtBusy ? <Button label={c.busy === "call" ? tr("referee.calling") : tr("referee.callToCourt")} disabled={busy} onPress={() => void c.callNow()} /> : null}
        {!readOnly && c.courtBusy ? (
          <View style={{ gap: 8 }} accessibilityLiveRegion="polite">
            <Body tone="live" size={13}>{c.courtBusy}</Body>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button kind="ghost" label={tr("referee.notNow")} onPress={c.clearError} style={{ flex: 1 }} />
              <Button kind="danger" label={tr("referee.callAnyway")} disabled={busy} onPress={() => void c.callNow(true)} style={{ flex: 1 }} />
            </View>
          </View>
        ) : null}

        {!readOnly && asking && !sheetOpen ? <Button kind="danger" label={tr("referee.answerNoShow")} onPress={() => setSheetOpen(true)} /> : null}

        {!readOnly && m.canCancel ? (
          confirmCancel ? (
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button kind="ghost" label={tr("referee.keepCall")} onPress={() => setConfirmCancel(false)} style={{ flex: 1 }} />
              <Button
                kind="danger"
                label={c.busy === "cancel" ? tr("referee.withdrawing") : tr("referee.withdrawIt")}
                disabled={busy}
                onPress={() => void c.cancel().then(() => setConfirmCancel(false))}
                style={{ flex: 1 }}
              />
            </View>
          ) : (
            <Body tone="blue" weight="semi" size={13} accessibilityRole="button" accessibilityHint={tr("referee.withdrawHint")} onPress={() => setConfirmCancel(true)} style={{ paddingVertical: 8 }}>
              {tr("referee.wrongMatch")}
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
  const tr = useT();
  const m = { ...c.model, ...localModel(c) };
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
    <Sheet open={open} onClose={close} title={m.title || tr("referee.noShow")}>
      {confirming ? (
        <>
          <Body size={17} weight="semi">{confirming.confirm}</Body>
          {c.error ? <Body tone="live" size={13}>{c.error}</Body> : null}
          <Button kind="danger" label={busy ? tr("referee.recording") : tr("referee.yesRecord")} disabled={busy} onPress={() => void pick(confirming)} />
          <Button kind="ghost" label={tr("common.back")} disabled={busy} onPress={() => setConfirming(null)} />
        </>
      ) : (
        <>
          <Body tone="ink2" size={13.5}>{m.detail}</Body>
          {absent.map((s) =>
            s.canMark ? (
              <Button key={s.key} kind="ghost" label={tr("referee.isHereNow", { name: s.name })} disabled={busy} onPress={() => void c.present(s.key).then((r) => r && close())} />
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

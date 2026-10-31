/**
 * "Call for assistance" on the chair umpire's console (migrations 0035 and 0042): one
 * big button, then the call's live status, polled every five seconds while the console
 * is open: the running time and the reminders while nobody has answered ("Organiser
 * alerted" after two minutes), every master referee on duty with their answer (Coming /
 * Declined / No answer yet), a green "Sara is coming to Court 2" once one takes it (the
 * declines still listed), and "Resolved by Sara" or "Call cancelled" for a minute after it
 * closes. More taps join the open call (the server dedupes them). Older servers send no
 * answers: the card then shows the status line only.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import * as Haptics from "expo-haptics";
import { closedCallShown, elapsedClock, reasonText, type AssistanceReason, type CallStatus, type MasterAnswerRow } from "@core";
import { api, ApiError } from "../api/client";
import { useTheme } from "../theme/ThemeProvider";
import { Body } from "../ui/Text";
import { Button, Card } from "../ui/Bits";
import { Glyph } from "../ui/Glyph";
import { useT } from "../i18n";
import { callLangNow, callTime, ct } from "./callText";
import { ReasonPicker } from "./ReasonPicker";

interface Call {
  id: string;
  court: string;
  status: CallStatus;
  acknowledgedBy: string | null;
  resolvedBy: string | null;
  resolvedAt?: string | null;
  requestedAt: string;
  // 0042
  going?: string | null;
  responses?: MasterAnswerRow[];
  remindersSent?: number;
  escalatedAt?: string | null;
  // 0044
  reason?: AssistanceReason | null;
}

const PATH = "/api/mobile/v1/referee/assistance";

/** Scoring v2's More → "Call master referee": the same call as the card's button. */
export async function requestAssistance(matchId?: string, reason?: AssistanceReason): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await api(PATH, { who: "staff", body: { action: "request", matchId, reason } });
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof ApiError && e.status !== 0 ? e.message : ct("noConnection") };
  }
}

/** `statusOnly`: the call is made from More (scoring v2); the card shows only an open (or just closed) call. */
export function AssistanceCard({ matchId, statusOnly = false }: { matchId?: string; statusOnly?: boolean }) {
  const { t } = useTheme();
  useT(); // re-render when the app language changes
  const [call, setCall] = useState<Call | null>(null);
  // The server says whether Call master referee is on for this court's events (it refuses
  // a call with 409 feature_off otherwise); older servers say nothing: shown as before.
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const acked = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ call?: Call | null; enabled?: boolean }>(PATH, { who: "staff", timeoutMs: 8_000 });
      setCall(r.call ?? null);
      setEnabled(r.enabled !== false);
    } catch {
      /* offline: keep what is shown */
    }
  }, []);
  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const id = setInterval(() => void load(), 5_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [load]);
  // The running clock (and a closed call hiding after a minute).
  useEffect(() => {
    if (!call) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [call]);
  useEffect(() => {
    if (call?.status === "acknowledged" && acked.current !== call.id) {
      acked.current = call.id;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    }
  }, [call]);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ call: Call }>(PATH, { who: "staff", body });
      setCall(r.call);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    } catch (e) {
      setErr(e instanceof ApiError && e.status !== 0 ? e.message : ct("noConnection"));
    } finally {
      setBusy(false);
    }
  };

  const open = Boolean(call && (call.status === "open" || call.status === "acknowledged"));
  const closedShown = Boolean(call && !open && closedCallShown({ status: call.status, resolvedAt: call.resolvedAt ?? null }, now));
  if (!open && !closedShown && (statusOnly || !enabled)) return null;
  if (!open) {
    return (
      <View style={{ gap: 4 }}>
        {!statusOnly && enabled ? <ReasonPicker busy={busy} onSend={(reason) => void post({ action: "request", matchId, reason })} /> : null}
        {call && closedShown ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Glyph name={call.status === "resolved" ? "check" : "cross"} color={call.status === "resolved" ? t.success : t.ink3} size={16} />
            <Body tone="ink2" weight="semi" size={13}>
              {call.status === "resolved" ? (call.resolvedBy ? ct("resolvedBy", { name: call.resolvedBy }) : ct("resolved")) : ct("cancelled")}
            </Body>
          </View>
        ) : null}
        {err ? <Body tone="live" size={12}>{err}</Body> : null}
      </View>
    );
  }
  const c = call!;
  const going = c.going ?? (c.status === "acknowledged" ? c.acknowledgedBy : null);
  const reminders = c.remindersSent ?? 0;
  const answers = c.responses ?? [];
  const color = going ? t.success : t.warning;
  return (
    <Card style={{ gap: 8, borderWidth: 2, borderColor: color }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <Glyph name={going ? "check" : "hourglass"} color={color} size={20} />
        <Body weight="bold" size={going ? 17 : 15} accessibilityRole="alert" style={{ color, flex: 1 }}>
          {going ? ct("isComing", { name: going, court: c.court }) : ct("callingNoAnswer", { clock: elapsedClock(c.requestedAt, now) })}
        </Body>
      </View>
      {c.reason ? (
        <Body weight="semi" size={14} testID="call-reason">
          {reasonText(callLangNow(), c.reason)}
        </Body>
      ) : null}
      <Body tone="ink3" size={12}>
        {[c.court, ct("calledAt", { time: callTime(c.requestedAt) }), !going && reminders > 0 ? (reminders === 1 ? ct("remindersSent") : ct("remindersSentMany", { n: reminders })) : null].filter(Boolean).join(" · ")}
      </Body>
      {!going && c.escalatedAt ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Glyph name="warning" color={t.live} size={16} />
          <Body tone="live" weight="semi" size={13}>{ct("organiserAlerted")}</Body>
        </View>
      ) : null}
      {answers.length > 0 ? (
        <View style={{ gap: 4 }}>
          {answers.map((a) => (
            <View key={`${a.name}-${a.answer}`} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Glyph name={a.answer === "coming" ? "check" : a.answer === "declined" ? "cross" : "dots"} color={a.answer === "coming" ? t.success : a.answer === "declined" ? t.live : t.ink3} size={16} />
              <Body weight="semi" size={13}>{a.name}</Body>
              <Body tone="ink3" size={12} style={{ flex: 1 }}>
                {a.answer === "coming" ? ct("answerComing", { time: callTime(a.at) }) : a.answer === "declined" ? ct("answerDeclined", { time: callTime(a.at) }) : ct("answerNone")}
              </Body>
            </View>
          ))}
        </View>
      ) : c.responses && !going ? (
        <Body tone="ink3" size={12}>{ct("noMastersOnDuty")}</Body>
      ) : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button kind="ghost" label={ct("callAgain")} disabled={busy} onPress={() => void post({ action: "request", matchId, reason: c.reason ?? undefined })} style={{ flex: 1 }} />
        {c.status === "open" && <Button kind="ghost" label={ct("cancel")} disabled={busy} onPress={() => void post({ action: "cancel", callId: c.id })} style={{ flex: 1 }} />}
      </View>
      {err ? <Body tone="live" size={12}>{err}</Body> : null}
    </Card>
  );
}

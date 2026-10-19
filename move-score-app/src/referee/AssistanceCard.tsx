/**
 * "Call for assistance" on the court referee's console (migration 0035): one big
 * button. Every master referee on duty gets an alert; when one taps "On my way" the
 * card shows their name. More taps join the open call (the server dedupes them).
 * Polls every five seconds while the console is open.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import * as Haptics from "expo-haptics";
import { callStatusLine, type CallStatus } from "@core";
import { api, ApiError } from "../api/client";
import { useTheme } from "../theme/ThemeProvider";
import { Body } from "../ui/Text";
import { Button, Card } from "../ui/Bits";

interface Call {
  id: string;
  court: string;
  status: CallStatus;
  acknowledgedBy: string | null;
  resolvedBy: string | null;
  requestedAt: string;
}

const PATH = "/api/mobile/v1/referee/assistance";

/** Scoring v2's More → "Call master referee": the same call as the card's button. */
export async function requestAssistance(matchId?: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await api(PATH, { who: "staff", body: { action: "request", matchId } });
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof ApiError && e.status !== 0 ? e.message : "No connection: call the desk." };
  }
}

/** `statusOnly`: the call is made from More (scoring v2); the card shows only an open call. */
export function AssistanceCard({ matchId, statusOnly = false }: { matchId?: string; statusOnly?: boolean }) {
  const { t } = useTheme();
  const [call, setCall] = useState<Call | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const acked = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ call?: Call | null }>(PATH, { who: "staff", timeoutMs: 8_000 });
      setCall(r.call ?? null);
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
      setErr(e instanceof ApiError && e.status !== 0 ? e.message : "No connection: call the desk.");
    } finally {
      setBusy(false);
    }
  };

  const open = call && (call.status === "open" || call.status === "acknowledged");
  if (!open && statusOnly) return null;
  if (!open) {
    return (
      <View style={{ gap: 4 }}>
        <Button kind="danger" label={busy ? "Calling…" : "🆘 Call for assistance"} disabled={busy} onPress={() => void post({ action: "request", matchId })} accessibilityLabel="Call for assistance" />
        {call?.status === "resolved" ? <Body tone="ink3" size={12}>Last call: {callStatusLine({ status: call.status, resolved_by_name: call.resolvedBy })}</Body> : null}
        {err ? <Body tone="live" size={12}>{err}</Body> : null}
      </View>
    );
  }
  const ack = call.status === "acknowledged";
  return (
    <Card style={{ gap: 8, borderWidth: 1, borderColor: ack ? t.success : t.warning }}>
      <Body weight="bold" accessibilityRole="alert" style={{ color: ack ? t.success : t.warning }}>
        {ack ? "✓ " : "⏳ "}
        {callStatusLine({ status: call.status, acknowledged_by_name: call.acknowledgedBy })}
      </Body>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button kind="ghost" label="Call again" disabled={busy} onPress={() => void post({ action: "request", matchId })} style={{ flex: 1 }} />
        {!ack && <Button kind="ghost" label="Cancel" disabled={busy} onPress={() => void post({ action: "cancel", callId: call.id })} style={{ flex: 1 }} />}
      </View>
      {err ? <Body tone="live" size={12}>{err}</Body> : null}
    </Card>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import type { CallStatus } from "@core";
import { api, ApiError } from "../../api/client";
import { session } from "../../state/session";
import { useTheme } from "../../theme/ThemeProvider";
import { Screen } from "../../ui/Screen";
import { BackHeader } from "../../ui/Header";
import { Body, Display, Eyebrow } from "../../ui/Text";
import { Button, Card, Chip, Empty, SectionHeader } from "../../ui/Bits";
import { LoadState } from "../../ui/LoadState";
import { openRegulation } from "../../referee/LineupPicker";

interface Call {
  id: string;
  court: string;
  tournamentId: string | null;
  matchId: string | null;
  status: CallStatus;
  requestedBy: string;
  requestedAt: string;
  acknowledgedBy: string | null;
  resolvedBy: string | null;
}
interface PickerMatch {
  id: string;
  court: string | null;
  round: string | null;
  status: string;
  scheduledTime: string | null;
  a: { name: string };
  b: { name: string };
}

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "");
const FINISHED = new Set(["completed", "walkover", "disqualified", "retired", "cancelled"]);

/**
 * The master referee's screen (migration 0035): every court's calls for assistance
 * ("On my way", "Resolved"; a new call vibrates the phone even with the app open, and
 * the push alert reaches it when it is not), and a court picker across both events:
 * any court's matches, any of them to score.
 */
export default function MasterReferee() {
  const { t } = useTheme();
  const staff = session.use((s) => s.staff);
  const [court, setCourt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const known = useRef<Set<string> | null>(null);
  // Sent with the install token, so the server records this phone for the alerts.
  const calls = useQuery({
    queryKey: ["assistance", staff?.token],
    queryFn: () => api<{ role: string; open?: Call[]; recent?: Call[] }>("/api/mobile/v1/referee/assistance", { who: "staff" }),
    enabled: Boolean(staff),
    refetchInterval: 4_000,
  });
  const open = useMemo(() => calls.data?.open ?? [], [calls.data]);
  useEffect(() => {
    const fresh = open.filter((c) => c.status === "open" && known.current && !known.current.has(c.id));
    if (fresh.length) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    known.current = new Set(open.map((c) => c.id));
  }, [open]);
  // Line-up exceptions a court referee accepted (ITF Reg. 43 / 50): told here at once (and by push).
  const notices = useQuery({
    queryKey: ["lineup-notices", staff?.token],
    queryFn: () => api<{ notices: { id: string; at: string; text: string; regs: string[] }[] }>("/api/mobile/v1/referee/notices", { who: "staff" }),
    enabled: Boolean(staff),
    refetchInterval: 8_000,
  });
  const seenNotices = useRef<Set<string> | null>(null);
  useEffect(() => {
    const list = notices.data?.notices ?? [];
    if (seenNotices.current && list.some((n) => !seenNotices.current!.has(n.id))) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    if (notices.data) seenNotices.current = new Set(list.map((n) => n.id));
  }, [notices.data]);
  const tournaments = useQuery({
    queryKey: ["ref-tournaments", staff?.token],
    queryFn: () => api<{ tournaments: { id: string; name: string }[] }>("/api/mobile/v1/referee/tournaments", { who: "staff" }),
    enabled: Boolean(staff),
  });
  const matches = useQuery({
    queryKey: ["master-matches", staff?.token, tournaments.data?.tournaments.map((x) => x.id).join(",")],
    queryFn: async () => {
      const lists = await Promise.all(
        (tournaments.data?.tournaments ?? []).map((x) =>
          api<{ matches: PickerMatch[] }>(`/api/mobile/v1/referee/tournaments/${x.id}/matches`, { who: "staff" }).then((r) => r.matches.map((m) => ({ ...m, event: x.name }))),
        ),
      );
      return lists.flat();
    },
    enabled: Boolean(tournaments.data?.tournaments.length),
    refetchInterval: 20_000,
  });
  const courts = useMemo(() => {
    const names = new Map<string, string>();
    for (const m of matches.data ?? []) if (m.court) names.set(m.court.trim().toLowerCase(), m.court.trim());
    return [...names.values()].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  }, [matches.data]);
  const onCourt = (matches.data ?? [])
    .filter((m) => court && m.court?.trim().toLowerCase() === court.toLowerCase() && !FINISHED.has(m.status))
    .sort((a, b) => Date.parse(a.scheduledTime ?? "9999") - Date.parse(b.scheduledTime ?? "9999"));

  const act = async (callId: string, action: "acknowledge" | "resolve") => {
    setErr(null);
    try {
      await api("/api/mobile/v1/referee/assistance", { who: "staff", body: { action, callId } });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "No connection.");
    }
    void calls.refetch();
  };

  if (!staff || staff.referee?.role !== "master_referee") {
    return (
      <Screen tabs={false}>
        <BackHeader label="Referee" />
        <Empty title="Master referees only" body="Sign in with your master referee code and your PIN on the Referee screen." />
        <Button label="Referee home" onPress={() => router.replace("/referee")} />
      </Screen>
    );
  }
  return (
    <Screen tabs={false} onRefresh={() => Promise.all([calls.refetch(), matches.refetch()])}>
      <BackHeader label="Referee" />
      <Eyebrow tone="live">Master referee</Eyebrow>
      <Display size={28} style={{ marginTop: 6 }}>{staff.referee.name}</Display>

      <SectionHeader title={open.length ? `Calls for assistance (${open.length})` : "Calls for assistance"} />
      <View style={{ gap: 8 }}>
        {open.map((c) => (
          <Card key={c.id} style={{ gap: 8, borderWidth: 2, borderColor: c.status === "open" ? t.live : t.warning }}>
            <Body weight="bold" size={16}>{`Referee ${c.requestedBy} is calling for assistance at ${c.court}`}</Body>
            <Body tone="ink2" size={13}>
              {`Called ${time(c.requestedAt)}`}
              {c.status === "acknowledged" ? ` · ${c.acknowledgedBy} on the way` : ""}
            </Body>
            <View style={{ flexDirection: "row", gap: 8 }}>
              {c.status === "open" && <Button label="On my way" onPress={() => void act(c.id, "acknowledge")} style={{ flex: 1 }} />}
              <Button kind="ghost" label="Resolved" onPress={() => void act(c.id, "resolve")} style={{ flex: 1 }} />
            </View>
            {c.matchId ? <Body tone="blue" size={13} onPress={() => router.push({ pathname: "/referee/score/[matchId]", params: { matchId: c.matchId! } })}>Open the match</Body> : null}
          </Card>
        ))}
        {!calls.data && <LoadState compact queries={[calls]} what="the calls" />}
        {calls.data && open.length === 0 && <Body tone="ink3" size={13}>No court is calling right now.</Body>}
        {err ? <Body tone="live" size={13}>{err}</Body> : null}
      </View>

      {(notices.data?.notices.length ?? 0) > 0 && (
        <>
          <SectionHeader title="Line-up exceptions" />
          <View style={{ gap: 8 }}>
            {notices.data!.notices.slice(0, 8).map((n) => (
              <Card key={n.id} style={{ gap: 6, borderWidth: 2, borderColor: t.warning }}>
                <Body weight="bold" size={15}>{`⚠ ${n.text}`}</Body>
                <Body tone="ink2" size={13}>
                  {time(n.at)}
                  {n.regs.map((r) => (
                    <Body key={r} tone="blue" weight="semi" size={13} onPress={() => openRegulation(r)}>{`  ·  ITF Reg. ${r}`}</Body>
                  ))}
                </Body>
              </Card>
            ))}
          </View>
        </>
      )}

      <SectionHeader title="Courts" />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {courts.map((c) => (
          <Pressable key={c} onPress={() => setCourt(c)} accessibilityRole="button" accessibilityState={{ selected: court === c }}>
            <Chip label={c} ball={court === c} />
          </Pressable>
        ))}
        {matches.data && courts.length === 0 && <Body tone="ink3" size={13}>No courts with matches yet.</Body>}
      </View>
      {court && (
        <View style={{ gap: 8, marginTop: 10 }}>
          {onCourt.map((m) => (
            <Card key={m.id} onPress={() => router.push({ pathname: "/referee/score/[matchId]", params: { matchId: m.id } })} style={{ gap: 4 }}>
              <Eyebrow size={10}>{[time(m.scheduledTime), m.event, m.round, m.status].filter(Boolean).join(" · ")}</Eyebrow>
              <Body weight="bold">{`${m.a.name} vs ${m.b.name}`}</Body>
            </Card>
          ))}
          {onCourt.length === 0 && <Body tone="ink3" size={13}>{`Nothing left to play on ${court}.`}</Body>}
        </View>
      )}
    </Screen>
  );
}

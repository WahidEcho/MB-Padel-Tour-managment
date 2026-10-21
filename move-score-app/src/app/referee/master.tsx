import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import type { CallAnswer, CallStatus, MasterAnswerRow } from "@core";
import { ct } from "../../referee/callText";
import { api, ApiError } from "../../api/client";
import { session } from "../../state/session";
import { useTheme } from "../../theme/ThemeProvider";
import { Screen } from "../../ui/Screen";
import { BackHeader } from "../../ui/Header";
import { Body, Display, Eyebrow } from "../../ui/Text";
import { Button, Card, Chip, Empty, SectionHeader } from "../../ui/Bits";
import { LoadState } from "../../ui/LoadState";
import { openRegulation } from "../../referee/LineupPicker";
import { Glyph } from "../../ui/Glyph";
import { fmt, useT } from "../../i18n";
import { matchStatusLabel } from "../../referee/words";

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
  // 0042 (older servers send none of these)
  going?: string | null;
  responses?: MasterAnswerRow[];
  mine?: CallAnswer | null;
  escalatedAt?: string | null;
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

const time = (iso: string | null) => (iso ? fmt().time(iso) : "");
const FINISHED = new Set(["completed", "walkover", "disqualified", "retired", "cancelled"]);

/**
 * The master referee's screen (migration 0035): every court's calls for assistance
 * ("On my way", "Resolved"; a new call vibrates the phone even with the app open, and
 * the push alert reaches it when it is not), and a court picker across both events:
 * any court's matches, any of them to score.
 */
export default function MasterReferee() {
  const { t } = useTheme();
  const tr = useT();
  const staff = session.use((s) => s.staff);
  const [court, setCourt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const known = useRef<Set<string> | null>(null);
  // Opened from a call's alert: that call first.
  const { call: focusCall } = useLocalSearchParams<{ call?: string }>();
  // Sent with the install token, so the server records this phone for the alerts.
  const calls = useQuery({
    queryKey: ["assistance", staff?.token],
    queryFn: () => api<{ role: string; open?: Call[]; recent?: Call[] }>("/api/mobile/v1/referee/assistance", { who: "staff" }),
    enabled: Boolean(staff),
    refetchInterval: 4_000,
  });
  const open = useMemo(() => {
    const list = calls.data?.open ?? [];
    return focusCall ? [...list].sort((a, b) => Number(b.id === focusCall) - Number(a.id === focusCall)) : list;
  }, [calls.data, focusCall]);
  useEffect(() => {
    const fresh = open.filter((c) => c.status === "open" && c.mine !== "declined" && known.current && !known.current.has(c.id));
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
    return [...names.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [matches.data]);
  const onCourt = (matches.data ?? [])
    .filter((m) => court && m.court?.trim().toLowerCase() === court.toLowerCase() && !FINISHED.has(m.status))
    .sort((a, b) => Date.parse(a.scheduledTime ?? "9999") - Date.parse(b.scheduledTime ?? "9999"));

  const act = async (callId: string, body: { action: "respond"; answer: CallAnswer } | { action: "resolve" }) => {
    setErr(null);
    try {
      await api("/api/mobile/v1/referee/assistance", { who: "staff", body: { ...body, callId } });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : tr("referee.noConnection"));
    }
    void calls.refetch();
  };

  if (!staff || staff.referee?.role !== "master_referee") {
    return (
      <Screen tabs={false}>
        <BackHeader label={tr("referee.referee")} />
        <Empty title={tr("referee.masterOnly")} body={tr("referee.masterOnlyBody")} />
        <Button label={tr("referee.refereeHome")} onPress={() => router.replace("/referee")} />
      </Screen>
    );
  }
  return (
    <Screen tabs={false} onRefresh={() => Promise.all([calls.refetch(), matches.refetch()])}>
      <BackHeader label={tr("referee.referee")} />
      <Eyebrow tone="live">{tr("referee.masterReferee")}</Eyebrow>
      <Display size={28} style={{ marginTop: 6 }}>{staff.referee.name}</Display>

      <SectionHeader title={open.length ? tr("referee.callsTitleN", { count: open.length }) : tr("referee.callsTitle")} />
      <View style={{ gap: 8 }}>
        {open.map((c) => (
          <Card key={c.id} style={{ gap: 8, borderWidth: 2, borderColor: c.status === "open" ? t.live : t.warning }}>
            <Body weight="bold" size={16}>{ct("calledBy", { name: c.requestedBy, court: c.court })}</Body>
            <Body tone="ink2" size={13}>
              {ct("calledAt", { time: time(c.requestedAt) })}
              {c.status === "open" && c.escalatedAt ? ` · ${ct("organiserAlerted")}` : ""}
            </Body>
            {c.status === "acknowledged" ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Glyph name="check" color={t.success} size={18} />
                <Body weight="bold" size={15} style={{ color: t.success, flex: 1 }}>
                  {ct("goingDesk", { name: c.going ?? c.acknowledgedBy ?? "", court: c.court })}
                </Body>
              </View>
            ) : null}
            {c.status === "open" && c.mine === "declined" ? <Body tone="ink2" weight="semi" size={13}>{ct("youDeclined")}</Body> : null}
            {(c.responses ?? []).some((r) => r.answer === "declined") ? (
              <Body tone="ink3" size={12}>{ct("declinedList", { names: (c.responses ?? []).filter((r) => r.answer === "declined").map((r) => r.name).join(", ") })}</Body>
            ) : null}
            {c.status === "open" ? (
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Button label={ct("coming")} icon={<Glyph name="check" color="#FFFFFF" size={20} />} onPress={() => void act(c.id, { action: "respond", answer: "coming" })} style={{ flex: 1, minHeight: 56 }} />
                {c.mine !== "declined" ? (
                  <Button kind="ghost" label={ct("decline")} icon={<Glyph name="cross" color={t.ink} size={20} />} onPress={() => void act(c.id, { action: "respond", answer: "declined" })} style={{ flex: 1, minHeight: 56 }} />
                ) : null}
              </View>
            ) : null}
            <Button kind="ghost" label={ct("resolve")} onPress={() => void act(c.id, { action: "resolve" })} />
            {c.matchId ? <Body tone="blue" size={13} onPress={() => router.push({ pathname: "/referee/score/[matchId]", params: { matchId: c.matchId! } })}>{tr("referee.openMatch")}</Body> : null}
          </Card>
        ))}
        {!calls.data && <LoadState compact queries={[calls]} what={tr("referee.whatCalls")} />}
        {calls.data && open.length === 0 && <Body tone="ink3" size={13}>{tr("referee.noCalls")}</Body>}
        {err ? <Body tone="live" size={13}>{err}</Body> : null}
      </View>

      {(notices.data?.notices.length ?? 0) > 0 && (
        <>
          <SectionHeader title={tr("referee.lineupExceptions")} />
          <View style={{ gap: 8 }}>
            {notices.data!.notices.slice(0, 8).map((n) => (
              <Card key={n.id} style={{ gap: 6, borderWidth: 2, borderColor: t.warning }}>
                <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
                  <Glyph name="warning" color={t.warning} size={18} />
                  <Body weight="bold" size={15} style={{ flex: 1 }}>{n.text}</Body>
                </View>
                <Body tone="ink2" size={13}>
                  {time(n.at)}
                  {n.regs.map((r) => (
                    <Body key={r} tone="blue" weight="semi" size={13} onPress={() => openRegulation(r)}>{`  ·  ${tr("referee.itfReg", { reg: r })}`}</Body>
                  ))}
                </Body>
              </Card>
            ))}
          </View>
        </>
      )}

      <SectionHeader title={tr("referee.courts")} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {courts.map((c) => (
          <Pressable key={c} onPress={() => setCourt(c)} accessibilityRole="button" accessibilityState={{ selected: court === c }}>
            <Chip label={c} ball={court === c} />
          </Pressable>
        ))}
        {matches.data && courts.length === 0 && <Body tone="ink3" size={13}>{tr("referee.noCourts")}</Body>}
      </View>
      {court && (
        <View style={{ gap: 8, marginTop: 10 }}>
          {onCourt.map((m) => (
            <Card key={m.id} onPress={() => router.push({ pathname: "/referee/score/[matchId]", params: { matchId: m.id } })} style={{ gap: 4 }}>
              <Eyebrow size={10}>{[time(m.scheduledTime), m.event, m.round, matchStatusLabel(m.status)].filter(Boolean).join(" · ")}</Eyebrow>
              <Body weight="bold">{`${m.a.name} ${tr("common.vs")} ${m.b.name}`}</Body>
            </Card>
          ))}
          {onCourt.length === 0 && <Body tone="ink3" size={13}>{tr("referee.nothingLeft", { court })}</Body>}
        </View>
      )}
    </Screen>
  );
}

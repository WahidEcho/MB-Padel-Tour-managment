import { useState } from "react";
import { View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { timeIn } from "../../api/model";
import { session } from "../../state/session";
import { Screen } from "../../ui/Screen";
import { BackHeader } from "../../ui/Header";
import { Segments } from "../../ui/Segments";
import { Body, Display, Eyebrow, Num } from "../../ui/Text";
import { Button, Card, Chip, Empty, Flag, LivePill, SectionHeader } from "../../ui/Bits";
import { LoadState } from "../../ui/LoadState";
import { fmt, useT } from "../../i18n";
import { matchStatusLabel } from "../../referee/words";

interface Row {
  id: string;
  order: number;
  round: string | null;
  court: string | null;
  scheduledTime: string | null;
  status: string;
  tieId: string | null;
  rubberType: string | null;
  a: { name: string; code: string | null; iso2: string | null; checkedIn: boolean };
  b: { name: string; code: string | null; iso2: string | null; checkedIn: boolean };
  lineupsMissing: boolean;
  heldBy: { deviceId: string; deviceLabel: string | null; heldByYou?: boolean } | null;
  /** Court codes only: the sets so far. */
  score?: string | null;
}

export default function Picker() {
  const { tournamentId } = useLocalSearchParams<{ tournamentId: string }>();
  const tr = useT();
  const me = session.use((s) => s.installationId);
  const [f, setF] = useState<"ready" | "live" | "all" | "done">("ready");
  // Court codes: "Show earlier days" asks for the court's past days too (hidden by default).
  const [earlier, setEarlier] = useState(false);
  const q = useQuery({
    queryKey: ["ref-matches", tournamentId, earlier],
    queryFn: () =>
      api<{ tournament: { name: string; timezone: string | null }; court?: { name: string } | null; matches: Row[]; earlier?: { day: string; matches: Row[] }[] }>(
        `/api/mobile/v1/referee/tournaments/${tournamentId}/matches${earlier ? "?earlier=1" : ""}`,
        { who: "staff", headers: me ? { "X-Device-Id": me } : undefined },
      ),
    refetchInterval: 10_000,
  });
  const courtName = q.data?.court?.name ?? null;
  const tz = q.data?.tournament.timezone ?? "Africa/Cairo";
  const done = (s: string) => ["completed", "walkover", "disqualified", "retired"].includes(s);
  const rows = (q.data?.matches ?? []).filter((m) =>
    f === "live" ? ["live", "paused"].includes(m.status) : f === "ready" ? ["scheduled", "ready", "live", "paused"].includes(m.status) && Boolean(m.a.code || m.a.name !== "TBD") : f === "done" ? done(m.status) : true,
  );
  return (
    <Screen tabs={false} onRefresh={() => q.refetch()}>
      <BackHeader label={tr("referee.referee")} />
      <Display size={24}>{q.data?.tournament.name ?? tr("referee.matches")}</Display>
      {courtName ? <Eyebrow tone="live">{tr("referee.courtTodayEyebrow", { court: courtName })}</Eyebrow> : null}
      <Segments value={f} onChange={setF} options={[{ key: "ready", label: tr("referee.filterToScore") }, { key: "live", label: tr("common.live") }, { key: "all", label: tr("referee.filterAll") }, { key: "done", label: tr("referee.filterDone") }]} />
      <View style={{ gap: 8 }}>
        {rows.map((m) => {
          const mine = Boolean(m.heldBy && (m.heldBy.heldByYou || m.heldBy.deviceId === me));
          return (
            <Card key={m.id} onPress={() => router.push({ pathname: "/referee/score/[matchId]", params: { matchId: m.id } })} style={{ gap: 8 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Num size={14} tone="ink2">{[timeIn(m.scheduledTime, tz), m.court].filter(Boolean).join(" · ")}</Num>
                {["live", "paused"].includes(m.status) ? <LivePill label={m.status === "paused" ? tr("referee.pillPaused") : tr("referee.pillLive")} /> : <Chip label={done(m.status) ? tr("referee.chipDone") : m.lineupsMissing ? tr("referee.lineupsMissing") : tr("referee.ready")} />}
              </View>
              {[m.a, m.b].map((s, i) => (
                <View key={i} style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                  <Flag iso2={s.iso2} code={s.code} />
                  <Body weight="semi" numberOfLines={1} style={{ flex: 1 }}>{s.name}</Body>
                  {!s.checkedIn && !m.tieId ? <Eyebrow size={9} tone="live">{tr("referee.notCheckedIn")}</Eyebrow> : null}
                </View>
              ))}
              {m.score ? <Num size={14}>{m.score}</Num> : null}
              <Eyebrow size={10} tone={m.heldBy && !mine ? "live" : "ink3"}>
                {[m.rubberType, m.round, m.heldBy ? (mine ? tr("referee.heldByPhone") : tr("referee.heldBy", { name: m.heldBy.deviceLabel ?? tr("referee.anotherPhone") })) : null].filter(Boolean).join(" · ")}
              </Eyebrow>
            </Card>
          );
        })}
        {!q.data && <LoadState compact queries={[q]} what={tr("referee.whatMatches")} />}
        {q.isError && q.data ? <Body tone="live" size={12}>{tr("referee.refreshFailed")}</Body> : null}
        {q.data && !rows.length && <Empty title={tr("referee.nothingHere")} body={tr("referee.tryFilter")} />}
        {courtName ? <Button kind="ghost" label={earlier ? tr("referee.hideEarlier") : tr("referee.showEarlier")} onPress={() => setEarlier((v) => !v)} /> : null}
        {earlier &&
          (q.data?.earlier ?? []).map((d) => (
            <View key={d.day} style={{ gap: 6 }}>
              <SectionHeader title={fmt().dayLong(`${d.day}T12:00:00Z`, "UTC")} />
              {d.matches.map((m) => (
                <Card key={m.id} onPress={() => router.push({ pathname: "/referee/score/[matchId]", params: { matchId: m.id } })} style={{ gap: 4 }}>
                  <Eyebrow size={10}>{[timeIn(m.scheduledTime, tz), m.rubberType, m.round].filter(Boolean).join(" · ")}</Eyebrow>
                  <Body weight="semi" numberOfLines={1}>{`${m.a.name} ${tr("common.vs")} ${m.b.name}`}</Body>
                  {m.score ? <Num size={14}>{m.score}</Num> : <Body tone="ink3" size={12}>{matchStatusLabel(m.status)}</Body>}
                </Card>
              ))}
            </View>
          ))}
        {earlier && q.data && !(q.data.earlier ?? []).length ? <Body tone="ink3" size={12}>{tr("referee.noEarlier")}</Body> : null}
      </View>
    </Screen>
  );
}

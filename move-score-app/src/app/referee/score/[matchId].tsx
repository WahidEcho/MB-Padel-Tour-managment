import { useEffect, useState, type ReactNode } from "react";
import { Linking, Modal, Pressable, ScrollView, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useKeepAwake } from "expo-keep-awake";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { describeMatchRules, OFFENCE_LABELS, PENALTY_LABELS, currentServer, servingPlayer, type ScoreState, type TeamKey } from "@core";
import { api } from "../../../api/client";
import { config } from "../../../config";
import { session } from "../../../state/session";
import { SchemeScope, useTheme } from "../../../theme/ThemeProvider";
import { getJson, setJson } from "../../../state/kv";
import { useConsole } from "../../../referee/useConsole";
import { useLease } from "../../../referee/useLease";
import type { RefereeBootstrap } from "../../../referee/types";
import type { SyncState } from "../../../referee/sync";
import { Body, Display, Eyebrow, Num } from "../../../ui/Text";
import { Button, Card, Chip, Flag } from "../../../ui/Bits";
import { BackHeader } from "../../../ui/Header";

type Sheet =
  | { kind: "confirm-point"; team: TeamKey; what: string }
  | { kind: "more" }
  | { kind: "violation"; team: TeamKey | null }
  | { kind: "end"; event: "FORCE_END" | "WALKOVER" | "RETIREMENT" | "DISQUALIFICATION" | "SET" }
  | { kind: "handover" }
  | null;

function SyncPill({ s, online }: { s: SyncState; online: boolean }) {
  const { t } = useTheme();
  const n = "pending" in s ? s.pending : 0;
  const [label, color] =
    s.kind === "conflict"
      ? [s.reason === "device_lock" ? "Another phone has control" : "Sync problem", t.live]
      : s.kind === "signed_out"
        ? ["Sign in again to send", t.live]
        : !online || s.kind === "offline"
          ? [`Offline · ${n} on this phone`, t.warning]
          : s.kind === "syncing"
            ? [`Sending ${n}…`, t.blue]
            : n > 0
              ? [`${n} waiting to send`, t.warning]
              : ["Online · all saved", t.success];
  return (
    <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 999, backgroundColor: t.chip }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      <Body weight="bold" size={12} style={{ color }}>{label}</Body>
    </View>
  );
}

function Sheetish({ open, onClose, children, title }: { open: boolean; onClose: () => void; children: ReactNode; title: string }) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)" }} onPress={onClose} accessibilityLabel="Close" />
      <View style={{ backgroundColor: t.surface, borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 18, paddingBottom: insets.bottom + 18, gap: 10, maxHeight: "80%" }}>
        <Eyebrow>{title}</Eyebrow>
        <ScrollView contentContainerStyle={{ gap: 10 }}>{children}</ScrollView>
      </View>
    </Modal>
  );
}

function pointText(s: ScoreState | null, k: TeamKey) {
  if (!s) return "0";
  if (s.isTiebreak) return String(k === "A" ? s.teamA.tiebreakPoints : s.teamB.tiebreakPoints);
  return k === "A" ? s.teamA.points : s.teamB.points;
}

function ConsoleScreen({ boot, deviceId, sunlight, setSunlight }: { boot: RefereeBootstrap; deviceId: string; sunlight: boolean; setSunlight: (v: boolean) => void }) {
  useKeepAwake();
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const [online, setOnline] = useState(true);
  const c = useConsole(boot, deviceId, online);
  const lease = useLease(boot.match.id, deviceId, false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [now, setNow] = useState(Date.now());
  const m = boot.match;
  const A = boot.sideA!;
  const B = boot.sideB!;
  const side = (k: TeamKey) => (k === "A" ? A : B);
  const sync = c.sync;
  useEffect(() => setOnline(sync.kind !== "offline"), [sync.kind]);

  // First claim: offline, trust this phone if it already holds unsent points for the match.
  useEffect(() => {
    if (!c.ready || c.finished && !boot.reopenState) return;
    void lease.claim(sync.kind === "pending" || sync.kind === "offline");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.ready]);

  useEffect(() => {
    if (!c.rest) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [c.rest]);

  const readOnly = !lease.isController;
  const shown: ScoreState | null = readOnly ? ((lease.snapshot?.snapshot_json as ScoreState | null) ?? c.state) : c.state;
  const status = readOnly ? (lease.match?.status ?? c.status) : c.status;
  const finished = ["completed", "walkover", "disqualified", "retired", "cancelled"].includes(status);
  const awaitingConfirm = c.opts.confirmFirst && Boolean(shown?.matchOver) && !finished;
  const server = shown ? currentServer(shown) : null;
  const servingIdx = shown && c.opts.doubles ? servingPlayer(shown) : null;
  const restLeft = c.rest ? Math.max(0, Math.ceil((c.rest.endsAt - now) / 1000)) : 0;

  const tap = (k: TeamKey) => {
    if (readOnly || !c.state || c.finished || c.paused) return;
    const what = c.needsConfirm(k);
    if (what) setSheet({ kind: "confirm-point", team: k, what });
    else void c.point(k);
  };

  const scoreRow = (k: TeamKey) => {
    const s = side(k);
    const sets = shown?.completedSets ?? [];
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, borderTopWidth: k === "B" ? 1 : 0, borderColor: t.line }}>
        <View style={{ width: 12, alignItems: "center" }}>{server === k && !shown?.matchOver ? <View style={{ width: 11, height: 11, borderRadius: 6, backgroundColor: t.ball, borderWidth: t.scheme === "light" ? 1.5 : 0, borderColor: t.ballInk }} /> : null}</View>
        <Flag iso2={s.iso2} code={s.nation} size={28} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Body weight="bold" size={17} numberOfLines={1}>{s.name}</Body>
          {c.opts.doubles && servingIdx?.team === k ? <Eyebrow size={10} tone="ink2">{`Serving: ${s.players[servingIdx.index]?.name ?? ""}`}</Eyebrow> : null}
        </View>
        {sets.map((x, i) => (
          <Num key={i} size={24} tone="ink2" style={{ width: 26, textAlign: "center" }}>{k === "A" ? x.teamAGames : x.teamBGames}</Num>
        ))}
        {!shown?.matchOver && <Num size={26} style={{ width: 28, textAlign: "center" }}>{k === "A" ? (shown?.teamA.games ?? 0) : (shown?.teamB.games ?? 0)}</Num>}
        {!shown?.matchOver && (
          <View style={{ minWidth: 60, height: 50, borderRadius: 12, backgroundColor: t.chip, alignItems: "center", justifyContent: "center" }}>
            <Num size={30}>{pointText(shown, k)}</Num>
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.floor, paddingTop: insets.top + 6, paddingHorizontal: 14, paddingBottom: insets.bottom + 10 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <BackHeader label={boot.courtName} />
        <SyncPill s={sync} online={online} />
      </View>
      <Card style={{ paddingVertical: 8 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Eyebrow size={10} numberOfLines={1} style={{ flex: 1 }}>{[m.round_name, boot.tournament.name].filter(Boolean).join(" · ")}</Eyebrow>
          <Pressable onPress={() => setSunlight(!sunlight)} accessibilityRole="switch" accessibilityState={{ checked: sunlight }} hitSlop={8}>
            <Chip label={sunlight ? "☀ Sunlight on" : "☀ Sunlight"} ball={sunlight} />
          </Pressable>
        </View>
        {scoreRow("A")}
        {scoreRow("B")}
        <Body tone="ink3" size={11}>{describeMatchRules(boot.config)}</Body>
      </Card>

      {/* Control: who is scoring this match */}
      {readOnly && lease.ready && (
        <Card style={{ marginTop: 10, gap: 8, borderColor: t.warning, borderWidth: 1 }}>
          <Body weight="semi">{lease.heldByOther ? `Read-only: ${lease.holderLabel} is scoring` : "Not scoring yet"}</Body>
          {lease.heldByOther ? (
            <Button label={lease.myRequestPending ? "Waiting for a reply… ask again" : "Request control"} kind="ghost" onPress={() => void lease.requestControl()} />
          ) : (
            <Button label="Take control" onPress={() => void lease.claim()} />
          )}
        </Card>
      )}
      {lease.incomingRequest && (
        <Card style={{ marginTop: 10, gap: 8, borderColor: t.ball, borderWidth: 2 }}>
          <Body weight="semi">{`${lease.incomingRequest.deviceLabel ?? "Another phone"} wants to score this match`}</Body>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button kind="ghost" label="Decline" onPress={() => void lease.respond(false)} style={{ flex: 1 }} />
            <Button label="Hand over" onPress={() => void (async () => { c.syncNow(); await lease.respond(true); })()} style={{ flex: 1 }} />
          </View>
        </Card>
      )}
      {sync.kind === "conflict" && (
        <Card style={{ marginTop: 10, gap: 6, borderColor: t.live, borderWidth: 1 }}>
          <Body weight="semi">{sync.message}</Body>
          <Body tone="ink2" size={12.5}>Points on this phone are kept. Ask the tournament desk, or hand over to the web console.</Body>
          <Button kind="ghost" label="Hand over to the web console" onPress={() => setSheet({ kind: "handover" })} />
        </Card>
      )}
      {c.rest && restLeft > 0 && (
        <Card style={{ marginTop: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Body weight="semi">{c.rest.kind === "set_break" ? "Set break" : c.rest.kind === "tiebreak" ? "Change ends" : c.rest.changeEnds ? "Changeover · change ends" : "Changeover"}</Body>
          <Num size={26}>{`${Math.floor(restLeft / 60)}:${String(restLeft % 60).padStart(2, "0")}`}</Num>
          <Body tone="blue" weight="semi" onPress={c.clearRest}>Dismiss</Body>
        </Card>
      )}

      <View style={{ flex: 1, marginTop: 10, gap: 10 }}>
        {boot.chess ? (
          <Card style={{ flex: 1, justifyContent: "center", gap: 10 }}>
            <Display size={20}>Chess is scored on the web</Display>
            <Button label="Open the web console" onPress={() => void Linking.openURL(`${config.apiBaseUrl}/referee/matches/${m.id}/score`)} />
          </Card>
        ) : !c.state && !finished ? (
          <Card style={{ flex: 1, justifyContent: "center", gap: 12 }}>
            <Display size={22}>Who serves first?</Display>
            {(!A.checkedIn || !B.checkedIn) && !m.tie_id ? <Body tone="live" size={13}>{`${!A.checkedIn ? A.name : B.name} is not checked in yet.`}</Body> : null}
            {(["A", "B"] as TeamKey[]).map((k) => (
              <Button key={k} label={side(k).name} disabled={readOnly} onPress={() => void c.start(k)} />
            ))}
          </Card>
        ) : awaitingConfirm ? (
          <Card style={{ flex: 1, justifyContent: "center", gap: 12 }}>
            <Display size={22}>{`${shown?.winner ? side(shown.winner).name : ""} wins?`}</Display>
            <Body tone="ink2">The score is final. Confirm the result to send it to the standings and screens, or undo the last point.</Body>
            <Button label="Confirm result" disabled={readOnly} onPress={() => void c.confirmResult()} />
            <Button kind="ghost" label="Undo last point" disabled={readOnly} onPress={() => void c.undo()} />
          </Card>
        ) : finished ? (
          <Card style={{ flex: 1, justifyContent: "center", gap: 12 }}>
            <Display size={22}>Match finished</Display>
            <Body tone="ink2">{status === "completed" ? "The result is in." : `Ended: ${status}.`}</Body>
            {!readOnly && c.canUndo ? <Button kind="ghost" label="Undo (reopen the match)" onPress={() => void c.undo()} /> : null}
            <Button label="Back to matches" onPress={() => router.back()} />
          </Card>
        ) : (
          (["A", "B"] as TeamKey[]).map((k) => (
            <Pressable
              key={k}
              accessibilityRole="button"
              accessibilityLabel={`Point to ${side(k).name}`}
              disabled={readOnly || c.paused}
              onPress={() => tap(k)}
              style={({ pressed }) => ({
                flex: 1,
                borderRadius: 26,
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                backgroundColor: k === "A" ? t.btnBg : t.surface2,
                borderWidth: k === "B" ? 1 : 0,
                borderColor: t.line,
                opacity: readOnly || c.paused ? 0.4 : 1,
                transform: [{ scale: pressed ? 0.985 : 1 }],
              })}
            >
              <Display size={26} style={{ color: k === "A" ? t.btnInk : t.ink }}>{`Point ${side(k).nation ?? ""}`.trim()}</Display>
              <Eyebrow size={12} style={{ color: k === "A" ? t.btnInk : t.ink2 }}>{`${side(k).name}${server === k ? " · serving" : ""}`}</Eyebrow>
            </Pressable>
          ))
        )}
      </View>

      {c.state && !finished && !boot.chess && (
        <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
          {[
            ["↶", "Undo", () => void c.undo(), !c.canUndo],
            ["❚❚", c.paused ? "Resume" : "Pause", () => void c.pause(), false],
            ["⇄", "Serve", () => void c.switchServer(), c.paused],
            ["⋯", "More", () => setSheet({ kind: "more" }), false],
          ].map(([icon, label, fn, disabled]) => (
            <Pressable key={label as string} onPress={fn as () => void} disabled={readOnly || (disabled as boolean)} accessibilityRole="button" accessibilityLabel={label as string} style={({ pressed }) => ({ flex: 1, alignItems: "center", gap: 3, paddingVertical: 12, borderRadius: 16, backgroundColor: t.chip, borderWidth: 1, borderColor: t.line, opacity: readOnly || disabled ? 0.4 : pressed ? 0.7 : 1 })}>
              <Body size={17}>{icon as string}</Body>
              <Body weight="bold" size={12}>{label as string}</Body>
            </Pressable>
          ))}
        </View>
      )}

      <Sheetish open={sheet?.kind === "confirm-point"} onClose={() => setSheet(null)} title="Check">
        {sheet?.kind === "confirm-point" && (
          <>
            <Body size={17} weight="semi">{`${side(sheet.team).name} is about to win ${sheet.what}.`}</Body>
            <Button label="Yes, point" onPress={() => { void c.point(sheet.team); setSheet(null); }} />
            <Button kind="ghost" label="Cancel" onPress={() => setSheet(null)} />
          </>
        )}
      </Sheetish>

      <Sheetish open={sheet?.kind === "more"} onClose={() => setSheet(null)} title="More">
        {c.opts.doubles &&
          (["A", "B"] as TeamKey[]).map((k) => <Button key={k} kind="ghost" label={`Swap ${side(k).name}'s server`} onPress={() => { void c.swapServer(k); setSheet(null); }} />)}
        {boot.tennis && <Button kind="ghost" label="Code violation" onPress={() => setSheet({ kind: "violation", team: null })} />}
        <Button kind="ghost" label="End the set" onPress={() => setSheet({ kind: "end", event: "SET" })} />
        <Button kind="ghost" label="Retirement" onPress={() => setSheet({ kind: "end", event: "RETIREMENT" })} />
        <Button kind="ghost" label="Walkover" onPress={() => setSheet({ kind: "end", event: "WALKOVER" })} />
        <Button kind="ghost" label="Disqualification" onPress={() => setSheet({ kind: "end", event: "DISQUALIFICATION" })} />
        <Button kind="ghost" label="End the match now" onPress={() => setSheet({ kind: "end", event: "FORCE_END" })} />
        <Button kind="ghost" label="Hand over to another phone or the web" onPress={() => setSheet({ kind: "handover" })} />
      </Sheetish>

      <Sheetish open={sheet?.kind === "violation"} onClose={() => setSheet(null)} title="Code violation">
        {sheet?.kind === "violation" &&
          (sheet.team === null ? (
            (["A", "B"] as TeamKey[]).map((k) => <Button key={k} kind="ghost" label={side(k).name} onPress={() => setSheet({ kind: "violation", team: k })} />)
          ) : (
            (Object.keys(OFFENCE_LABELS) as (keyof typeof OFFENCE_LABELS)[]).map((o) => (
              <Button
                key={o}
                kind="ghost"
                label={`${OFFENCE_LABELS[o]} → ${PENALTY_LABELS[c.penaltyFor(sheet.team!, o)]}`}
                onPress={() => {
                  void c.violation(sheet.team!, o);
                  setSheet(null);
                }}
              />
            ))
          ))}
      </Sheetish>

      <Sheetish open={sheet?.kind === "end"} onClose={() => setSheet(null)} title={sheet?.kind === "end" ? ({ SET: "Who won the set?", FORCE_END: "Who won the match?", WALKOVER: "Who did not turn up?", RETIREMENT: "Who retired?", DISQUALIFICATION: "Who is disqualified?" } as const)[sheet.event] : ""}>
        {sheet?.kind === "end" &&
          (["A", "B"] as TeamKey[]).map((k) => (
            <Button
              key={k}
              kind={sheet.event === "SET" || sheet.event === "FORCE_END" ? "ghost" : "danger"}
              label={side(k).name}
              onPress={() => {
                const other: TeamKey = k === "A" ? "B" : "A";
                if (sheet.event === "SET") void c.endSet(k);
                else if (sheet.event === "RETIREMENT" || sheet.event === "DISQUALIFICATION" || sheet.event === "WALKOVER") void c.endWith(sheet.event, other);
                else void c.endWith(sheet.event, k);
                setSheet(null);
              }}
            />
          ))}
      </Sheetish>

      <Sheetish open={sheet?.kind === "handover"} onClose={() => setSheet(null)} title="Hand over">
        <Body>Send every point first, then release control. The next phone, or the web console, takes over from the server's score.</Body>
        <Button
          label="Send and release"
          onPress={() =>
            void (async () => {
              c.syncNow();
              await new Promise((r) => setTimeout(r, 1500));
              await lease.release();
              setSheet(null);
            })()
          }
        />
        <Button kind="ghost" label="Open the web console" onPress={() => void Linking.openURL(`${config.apiBaseUrl}/referee/matches/${m.id}/score`)} />
        <Body tone="ink3" size={12}>If this phone cannot send its points, release anyway: the points on it are kept, never sent, and must be re-entered on the new device.</Body>
        <Button kind="danger" label="Release without sending" onPress={() => void (async () => { await c.abandonQueue(); await lease.release(); setSheet(null); })()} />
      </Sheetish>
    </View>
  );
}

export default function ScoreRoute() {
  const { matchId } = useLocalSearchParams<{ matchId: string }>();
  const staff = session.use((s) => s.staff);
  const deviceId = session.use((s) => s.installationId) ?? "unknown";
  const [sunlight, setSun] = useState<boolean>(getJson("ms.sunlight", false));
  const setSunlight = (v: boolean) => {
    setSun(v);
    setJson("ms.sunlight", v);
  };
  const boot = useQuery({
    queryKey: ["ref-boot", matchId],
    queryFn: () => api<RefereeBootstrap>(`/api/mobile/v1/referee/matches/${matchId}/bootstrap`, { who: "staff" }),
    enabled: Boolean(staff),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 3,
  });
  if (!staff) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}>
        <Body>Sign in with the referee code first.</Body>
        <Button label="Referee sign-in" onPress={() => router.replace("/referee")} />
      </View>
    );
  }
  if (!boot.data) {
    return (
      <SchemeScope scheme={sunlight ? "light" : "dark"}>
        <Waiting error={boot.isError} />
      </SchemeScope>
    );
  }
  if (boot.data.waitingForLineups || !boot.data.sideA || !boot.data.sideB) {
    return (
      <SchemeScope scheme={sunlight ? "light" : "dark"}>
        <Waiting error={false} message={`${boot.data.waitingForLineups ?? "A nation"}'s captain has not nominated the players for this rubber yet. The tournament desk enters them on the Ties page.`} />
      </SchemeScope>
    );
  }
  return (
    <SchemeScope scheme={sunlight ? "light" : "dark"}>
      <ConsoleScreen boot={boot.data} deviceId={deviceId} sunlight={sunlight} setSunlight={setSunlight} />
    </SchemeScope>
  );
}

function Waiting({ error, message }: { error: boolean; message?: string }) {
  const { t } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: t.floor, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}>
      <Display size={22}>{message ? "Waiting for the line-ups" : error ? "Could not open the match" : "Opening the match…"}</Display>
      <Body tone="ink2" style={{ textAlign: "center" }}>{message ?? (error ? "Check the signal. Points already on this phone are safe." : "")}</Body>
      <Button kind="ghost" label="Back" onPress={() => router.back()} />
    </View>
  );
}
